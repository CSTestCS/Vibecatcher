// Vibecatcher renderer: capture -> detect -> track -> retarget -> render, 30 fps.

import * as THREE from 'three';
import { mergeSettings } from './lib/settings.js';
import { OverlayUI } from './ui.js';
import { PersonDetector, PosePool } from './lib/detector.js';
import { Tracker } from './lib/tracker.js';
import { SceneCutDetector } from './lib/scenecut.js';
import { OneEuro } from './lib/filters.js';
import { CharacterStore } from './lib/characters.js';
import {
  FrameSampler, extractAppearance, extractProportions, estimateLighting, averageAppearance, LM,
} from './lib/features.js';
import { parseBottomFile, chooseBottoms, loadBottomImage } from './lib/bottoms.js';
import {
  parseVrm, prepareLegsModel, reshapeLegs, measureThighRatio, bakeLegTexture, applyCulling, AvatarInstance,
} from './lib/avatar.js';
import { applyPose, solvePlacement, placeModel, alignToScreen } from './lib/retarget.js';
import { MotionRecorder } from './lib/recorder.js';

const api = window.vibe;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
const APPEARANCE_SAMPLES = 6; // samples needed to create a new character save
const QUICK_MATCH_SAMPLES = 2; // samples needed to recognise a saved character
const AVATAR_CACHE = 6; // built leg models kept for characters that left the screen
const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';

const state = {
  settings: null,
  ui: null,
  persons: new PersonDetector(),
  posePool: new PosePool(),
  tracker: null,
  sceneCut: null,
  store: null,
  recorder: new MotionRecorder(),
  video: null,
  stream: null,
  analysis: document.createElement('canvas'),
  baseVrm: null, // { name, data }
  mocapVrm: null,
  mocapAvatar: null,
  mocapLoading: false,
  avatars: new Map(), // trackId -> AvatarInstance
  avatarCache: new Map(), // characterId -> AvatarInstance (hidden, ready to reuse)
  metrics: { align: 0, jitter: 0, n: 0, cuts: 0 },
  pending: new Set(), // trackIds with an avatar being built
  freeLayers: Array.from({ length: 30 }, (_, i) => i + 1),
  bottoms: [], // parsed texture files from the bottoms folder
  bottomImages: new Map(), // file -> Promise<HTMLImageElement>
  frame: 0,
  lastTick: performance.now(),
  fps: 0,
  detectorReady: false,
  error: '',
  recordStart: null,
};

// ---------------------------------------------------------------------------
// three.js: fully transparent canvas, one camera standing in for the game's.
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;
const scene = new THREE.Scene();
scene.background = null;
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 2000);
const clock = new THREE.Clock();
const debugCanvas = document.getElementById('debug');
const debugCtx = debugCanvas.getContext('2d');

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  debugCanvas.width = window.innerWidth;
  debugCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Screen capture of the chosen display (the overlay itself is excluded from
// capture by the main process).
// ---------------------------------------------------------------------------
async function startCapture() {
  stopCapture();
  // Development hook: ?testSource=<vibe:// image> replaces screen capture with a still image.
  const test = params.get('testSource');
  if (test && /\.(mp4|webm|mkv)$/i.test(test)) {
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.src = test;
    await v.play();
    // slow the test video down to the processing speed so every part of it is
    // seen at an effective 30 fps, even on slow machines
    state.testVideo = v;
    state.testVideoTime = 0;
    document.body.prepend(v);
    Object.assign(v.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', objectFit: 'fill', zIndex: '-1' });
    state.video = { el: v, get videoWidth() { return v.videoWidth; }, get videoHeight() { return v.videoHeight; } };
    return;
  }
  if (test) {
    const img = new Image();
    img.src = test;
    await img.decode();
    document.body.style.background = `url("${test}") 0 0 / 100% 100% no-repeat`;
    state.video = { el: img, videoWidth: img.naturalWidth, videoHeight: img.naturalHeight };
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS }, audio: false });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    state.stream = stream;
    state.video = { el: video, get videoWidth() { return video.videoWidth; }, get videoHeight() { return video.videoHeight; } };
  } catch (e) {
    state.error = `Screen capture failed: ${e.message}`;
  }
}

function stopCapture() {
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  state.video = null;
}

async function initDetector() {
  state.detectorReady = false;
  try {
    const s = state.settings;
    if (state.tracker) state.tracker.reset(state.posePool);
    const poseDelegate = s.processing === 'cpu' ? 'CPU' : 'GPU';
    await state.persons.init({ variant: s.personModel, threshold: s.personThreshold, maxResults: s.maxCharacters * 2 + 2, delegate: 'CPU' });
    await state.posePool.init({ variant: s.detectionModel, count: s.maxCharacters, minConfidence: s.minConfidence, delegate: poseDelegate });
    state.detectorReady = true;
    state.error = '';
  } catch (e) {
    state.error = `Detector failed: ${e.message || e}`;
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// Bottoms library (built-in + user folder)
// ---------------------------------------------------------------------------
async function loadBottoms() {
  const files = await api.listUserBottoms();
  const parsed = files.map(parseBottomFile);
  state.bottoms = parsed.filter(Boolean);
  state.bottomImages.clear();
  const ignored = files.filter((f, i) => !parsed[i]);
  const el = document.getElementById('bottoms-count');
  el.textContent = state.bottoms.length
    ? `${state.bottoms.length} texture${state.bottoms.length === 1 ? '' : 's'}: ${state.bottoms.map((b) => b.file).join(', ')}`
    : 'No textures yet. Add PNGs named like pants_jeans.png, shorts.png, skirt_pleated.png, thigh-highs.png.';
  if (ignored.length) el.textContent += ` · ignored (unknown name): ${ignored.join(', ')}`;
}

function bottomImage(file) {
  if (!state.bottomImages.has(file)) state.bottomImages.set(file, loadBottomImage(file));
  return state.bottomImages.get(file);
}

/** Re-picks a saved character's textures if its files were removed or renamed. */
function ensureBottoms(c) {
  const has = (id) => !id || state.bottoms.some((b) => b.id === id);
  const missingBottom = !c.bottomId || !has(c.bottomId);
  const missingSocks = !has(c.legwearId) || (!c.legwearId && c.legwear.socksTop != null);
  if (!missingBottom && !missingSocks) return;
  const pick = chooseBottoms({ ...c.appearance.legwear, ...c.legwear }, state.bottoms);
  if (missingBottom) c.bottomId = pick.bottomId;
  if (missingSocks) c.legwearId = pick.legwearId;
  const item = state.bottoms.find((b) => b.id === c.bottomId);
  c.bottomName = item ? item.name : '';
  state.store.changed();
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------
function takeLayer() { return state.freeLayers.shift() ?? 31; }
function releaseLayer(l) { if (l < 31) state.freeLayers.push(l); }

function destroyAvatar(a) {
  a.dispose();
  releaseLayer(a.layer);
}

function disposeAvatar(trackId) {
  const a = state.avatars.get(trackId);
  if (!a) return;
  state.avatars.delete(trackId);
  retireAvatar(a);
}

function retireAvatar(a) {
  a.group.visible = false;
  // Keep leg models of known characters so they reappear instantly (e.g. after a camera cut).
  if (a.characterId && a.baseName === (state.baseVrm && state.baseVrm.name)) {
    const old = state.avatarCache.get(a.characterId);
    if (old && old !== a) destroyAvatar(old);
    state.avatarCache.delete(a.characterId);
    state.avatarCache.set(a.characterId, a);
    while (state.avatarCache.size > AVATAR_CACHE) {
      const [k, v] = state.avatarCache.entries().next().value;
      state.avatarCache.delete(k);
      destroyAvatar(v);
    }
  } else destroyAvatar(a);
}

function clearAvatarCache() {
  for (const a of state.avatarCache.values()) destroyAvatar(a);
  state.avatarCache.clear();
}

/** Drops every leg model (live and cached) so they are rebuilt with new options. */
function rebuildLegs() {
  for (const id of [...state.avatars.keys()]) { const a = state.avatars.get(id); state.avatars.delete(id); destroyAvatar(a); }
  clearAvatarCache();
}

function disposeAllAvatars() {
  for (const id of [...state.avatars.keys()]) disposeAvatar(id);
  if (state.mocapAvatar) { state.mocapAvatar.dispose(); releaseLayer(state.mocapAvatar.layer); state.mocapAvatar = null; }
}

/** Builds the leg model for a resolved character. */
async function buildLegsAvatar(track) {
  if (!state.baseVrm || state.pending.has(track.id)) return;
  const cached = state.avatarCache.get(track.character.id);
  if (cached) {
    state.avatarCache.delete(track.character.id);
    state.avatars.set(track.id, cached);
    return;
  }
  state.pending.add(track.id);
  try {
    const c = track.character;
    const vrm = await parseVrm(state.baseVrm.data);
    const { skinMeshes, legSets } = prepareLegsModel(vrm, state.settings);
    if (state.settings.matchProportions && c.proportions) reshapeLegs(vrm, legSets, c.proportions);
    const avatar = new AvatarInstance(vrm, takeLayer());
    ensureBottoms(c);
    const layers = [];
    for (const [id, color] of [[c.bottomId, c.colors.bottom], [c.legwearId, c.colors.socks || c.colors.bottom]]) {
      const item = id && state.bottoms.find((b) => b.id === id);
      if (!item) continue;
      try {
        layers.push({ image: await bottomImage(item.file), color: item.tint ? color : null });
      } catch (e) { console.warn('bottom texture', item.file, e); }
    }
    bakeLegTexture(skinMeshes, { skin: state.settings.matchSkin ? c.colors.skin : null, layers }, avatar.rest);
    applyCulling(vrm, state.settings.backfaceCulling);
    avatar.characterId = c.id;
    avatar.baseName = state.baseVrm.name;
    scene.add(avatar.group);
    // the character left while its legs were being built: keep them for later
    if (!state.tracker.tracks.find((t) => t.id === track.id)) { retireAvatar(avatar); return; }
    disposeAvatar(track.id);
    state.avatars.set(track.id, avatar);
  } catch (e) {
    state.error = `Leg model failed: ${e.message}`;
    console.error(e);
  } finally {
    state.pending.delete(track.id);
  }
}

async function buildMocapAvatar() {
  if (!state.mocapVrm || state.mocapLoading) return;
  state.mocapLoading = true;
  try {
    const vrm = await parseVrm(state.mocapVrm.data);
    const avatar = new AvatarInstance(vrm, takeLayer());
    applyCulling(vrm, state.settings.backfaceCulling);
    if (state.mocapAvatar) { state.mocapAvatar.dispose(); releaseLayer(state.mocapAvatar.layer); }
    state.mocapAvatar = avatar;
    scene.add(avatar.group);
  } catch (e) {
    state.error = `Could not load VRM: ${e.message}`;
    state.ui.toast(state.error, 4000);
  } finally {
    state.mocapLoading = false;
  }
}

// ---------------------------------------------------------------------------
// Character identification (mode 1)
// ---------------------------------------------------------------------------
function resolveCharacter(track, allowCreate = true) {
  const appearance = averageAppearance(track.samples);
  let c = state.store.match(appearance);
  if (!c && !allowCreate) return;
  if (!c) {
    const prop = averageProportions(track.propSamples);
    const pick = chooseBottoms(appearance.legwear, state.bottoms);
    const bottomItem = state.bottoms.find((b) => b.id === pick.bottomId);
    c = state.store.create(appearance, {
      bottomId: pick.bottomId,
      bottomName: bottomItem ? bottomItem.name : '',
      legwearId: pick.legwearId,
      legwear: { hem: appearance.legwear.hem, socksTop: appearance.legwear.socksTop, category: appearance.legwear.category },
      colors: { skin: appearance.skin, bottom: appearance.bottom, socks: appearance.socks },
      proportions: prop,
    });
  }
  state.store.markLoaded(c);
  track.character = c;
}

function averageProportions(samples) {
  if (!samples.length) return { thighScale: 1, shinScale: 1, thickness: 1, humanThighWidth: null };
  const avg = (f) => { const v = samples.map(f).filter((x) => x !== null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return {
    thigh: avg((s) => s.thigh), shin: avg((s) => s.shin), torso: avg((s) => s.torso),
    legWidth: avg((s) => s.legWidth),
    // filled in against the base model once known
    thighScale: 1, shinScale: 1, thickness: 1,
  };
}

/** Converts human measurements into scale factors for the loaded base model. */
function fitProportions(c) {
  if (!state.baseRig || !c.proportions || c.proportions.fitted === state.baseVrm.name) return;
  const p = c.proportions, m = state.baseRig;
  if (p.thigh && p.shin && p.torso) {
    p.thighScale = THREE.MathUtils.clamp((p.thigh / p.torso) / (m.thigh / m.torso), 0.75, 1.35);
    p.shinScale = THREE.MathUtils.clamp((p.shin / p.torso) / (m.shin / m.torso), 0.75, 1.35);
  }
  if (p.legWidth && m.thighRatio) p.thickness = THREE.MathUtils.clamp(p.legWidth / m.thighRatio, 0.75, 1.4);
  p.fitted = state.baseVrm.name;
  state.store.changed();
}

async function loadBaseFromBuffer(file) {
  state.baseVrm = file;
  document.getElementById('base-name').textContent = file.name;
  try {
    // Measure the base model once (rest pose) for proportion fitting.
    const vrm = await parseVrm(file.data);
    const { legSets } = prepareLegsModel(vrm, { ...state.settings, hideBaseClothing: false });
    const inst = new AvatarInstance(vrm, 31);
    state.baseRig = { ...inst.rig.len, thighRatio: measureThighRatio(vrm, legSets) };
    inst.dispose();
  } catch (e) {
    state.baseVrm = null;
    document.getElementById('base-name').textContent = 'No base model loaded.';
    state.ui.toast(`Could not load VRM: ${e.message}`, 4000);
    return;
  }
  for (const c of state.store.list) if (c.proportions) c.proportions.fitted = null;
  rebuildLegs();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function boxArea(t) { return t.box.w * t.box.h; }

function frameMean(img) {
  const d = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return n ? [r / n, g / n, b / n] : null;
}

/** One-Euro filtered model placement (stops size / depth pumping). */
function filteredAnchor(track, anchor, dt) {
  const s = state.settings;
  if (!track.anchorF || track.resetPlacement) {
    const c = 0.25 + 2.0 * (1 - s.smoothing);
    track.anchorF = [new OneEuro(c, 1.5), new OneEuro(c, 1.5), new OneEuro(c * 0.5, 0.6)];
    track.resetPlacement = false;
  }
  const [fx, fy, fz] = track.anchorF;
  // filter depth, then keep the anchor exactly on the hip landmark's camera ray
  const z = fz.filter(anchor.z, dt);
  const x = fx.filter(anchor.x / anchor.z, dt), y = fy.filter(anchor.y / anchor.z, dt);
  return new THREE.Vector3(x * z, y * z, z);
}

function poseAvatar(avatar, track, dt, { follow = true, mode }) {
  const s = state.settings;
  applyPose(avatar.rig, track.lmW);
  avatar.vrm.humanoid.update();
  if (follow) {
    const sol = solvePlacement(avatar.rig, track.lm2d, track.lmW, camera, camera.aspect);
    if (sol) track.anchor = filteredAnchor(track, sol.anchor, dt);
    if (track.anchor) {
      placeModel(avatar.vrm, track.anchor);
      if (s.alignToScreen) {
        alignToScreen(avatar.rig, track.lm2d, camera, { legs: true, arms: mode === 'mocap', hips: true, anchor: track.anchor });
      }
    }
  } else {
    // fixed preview position in the lower-right corner
    const d = 4;
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    placeModel(avatar.vrm, new THREE.Vector3(0.7 * d * tanH * camera.aspect, -0.35 * d * tanH, -d));
  }
  avatar.vrm.update(dt);
  avatar.group.visible = true;
  if (DEBUG && follow) measureAlignment(avatar, track);
}

// Debug metrics: screen distance between model joints and landmarks, and
// frame-to-frame jitter of the model's projected joints (pixels).
function measureAlignment(avatar, track) {
  const h = avatar.vrm.humanoid;
  const W = window.innerWidth, H = window.innerHeight;
  const joints = [['leftLowerLeg', LM.lKnee], ['rightLowerLeg', LM.rKnee], ['leftFoot', LM.lAnkle], ['rightFoot', LM.rAnkle]];
  const cur = [];
  let err = 0, n = 0;
  for (const [bone, lmi] of joints) {
    const p = h.getRawBoneNode(bone).getWorldPosition(new THREE.Vector3()).project(camera);
    const px = { x: (p.x + 1) / 2 * W, y: (1 - p.y) / 2 * H };
    cur.push(px);
    if ((track.lm2d[lmi].visibility ?? 1) < 0.5) continue;
    err += Math.hypot(px.x - track.lm2d[lmi].x * W, px.y - track.lm2d[lmi].y * H); n++;
  }
  const m = state.metrics;
  if (n) { m.align += err / n; m.n++; }
  if (n && err / n > 2 && DEBUG) {
    const v = [LM.lKnee, LM.rKnee, LM.lAnkle, LM.rAnkle].map((i) => (track.lm2d[i].visibility ?? 1).toFixed(2)).join(',');
    console.info(`[align] frame=${state.frame} err=${(err / n).toFixed(1)} vis=${v} joints=${n}`);
  }
  if (track.lastJoints) {
    let j = 0;
    cur.forEach((p, i) => { j += Math.hypot(p.x - track.lastJoints[i].x, p.y - track.lastJoints[i].y); });
    m.jitter += j / cur.length;
  }
  track.lastJoints = cur;
}

// The loop must survive any single bad frame.
function tick() {
  const now = performance.now();
  try {
    frame(now);
  } catch (e) {
    console.error('[frame error]', e && e.stack ? e.stack : e);
    state.error = `Frame error: ${e.message}`;
  }
  const spent = performance.now() - now;
  setTimeout(tick, Math.max(0, FRAME_MS - spent));
}

function frame(now) {
  let dt = Math.min(0.1, clock.getDelta());
  if (state.testVideo) {
    const v = state.testVideo;
    const rate = Math.min(1, Math.max(1 / 16, state.fps / FPS));
    if (Math.abs(v.playbackRate - rate) > 0.02) v.playbackRate = rate;
    let vdt = v.currentTime - state.testVideoTime;
    if (vdt < 0) vdt += v.duration; // looped
    state.testVideoTime = v.currentTime;
    dt = Math.min(0.1, Math.max(1 / 240, vdt));
  }
  state.fps = state.fps * 0.9 + (1000 / Math.max(1, now - state.lastTick)) * 0.1;
  state.lastTick = now;
  state.frame++;
  const s = state.settings;
  camera.fov = s.cameraFov;
  camera.updateProjectionMatrix();

  for (const a of state.avatars.values()) a.group.visible = false;
  if (state.mocapAvatar) state.mocapAvatar.group.visible = false;
  debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);

  let active = [];
  const video = state.video;
  if (s.enabled && state.detectorReady && video && video.videoWidth) {
    const aw = s.analysisWidth;
    const ah = Math.round(aw * video.videoHeight / video.videoWidth);
    const an = state.analysis;
    if (an.width !== aw || an.height !== ah) { an.width = aw; an.height = ah; }
    const actx = an.getContext('2d', { willReadFrequently: true });
    actx.drawImage(video.el, 0, 0, aw, ah);

    const T0 = performance.now();
    const cut = state.sceneCut.check(an, state.frame, s.cutSensitivity);
    if (cut) state.metrics.cuts++;
    // Person detection finds new characters and re-anchors tracks. Tracks are
    // followed by their pose models in between, so it runs every few frames,
    // and immediately after a cut or while looking for more characters.
    const tracked = state.tracker.tracks.filter((t) => t.missing === 0).length;
    const runDet = cut || tracked === 0 || state.frame % (tracked < s.maxCharacters ? 3 : 6) === 0;
    const dets = runDet ? state.persons.detect(an) : null;
    if (dets) state.lastDets = dets.map((d) => `${d.score.toFixed(2)}@${(d.w * d.h).toFixed(3)}`).join('|');
    const T1 = performance.now();
    const lightingTick = s.matchLighting && state.frame % 10 === 0;
    const needsAppearance = (t) => s.mode === 'legs' && !t.character && t.samples.length < APPEARANCE_SAMPLES;
    active = state.tracker.step({
      video, dets, cut, pool: state.posePool, dt, smoothing: s.smoothing,
      wantPixels: (t) => needsAppearance(t) || lightingTick || !t.lighting,
      maxTracks: s.maxCharacters,
    }).sort((a, b) => boxArea(b) - boxArea(a)).slice(0, s.maxCharacters);
    for (const t of state.tracker.takeDropped()) disposeAvatar(t.id);
    const T2 = performance.now();
    if (DEBUG) { state.metrics.tDet = (state.metrics.tDet || 0) + T1 - T0; state.metrics.tPose = (state.metrics.tPose || 0) + T2 - T1; state.metrics.frames = (state.metrics.frames || 0) + 1; }

    for (const track of active) {
      // appearance / lighting are sampled on the track's high-resolution crop
      let sampler = null;
      if (track.cropImage && track.cropLm) {
        sampler = new FrameSampler(track.cropImage, track.cropMask);
        sampler.validateMask(track.cropLm);
      }
      if (sampler && (lightingTick || !track.lighting)) {
        const est = estimateLighting(sampler, track.cropLm, frameMean(track.cropImage));
        if (est) track.lighting = track.lighting ? blendLight(track.lighting, est) : est;
      }

      if (s.mode === 'legs') {
        if (!track.character) {
          if (sampler && track.poseFrames >= 3 && track.samples.length < APPEARANCE_SAMPLES) {
            const a = extractAppearance(sampler, track.cropLm);
            if (a) {
              track.samples.push(a);
              track.propSamples.push(extractProportions(sampler, track.cropLm, track.lmW));
            }
          }
          if (state.baseVrm && track.samples.length >= QUICK_MATCH_SAMPLES) {
            // a saved character is recognised from a couple of samples; a new
            // one waits for enough samples to describe it reliably
            resolveCharacter(track, track.samples.length >= APPEARANCE_SAMPLES);
            if (track.character) fitProportions(track.character);
          }
        }
        if (track.character && !state.avatars.has(track.id)) buildLegsAvatar(track);
        const avatar = state.avatars.get(track.id);
        if (avatar) {
          poseAvatar(avatar, track, dt, { mode: 'legs' });
          avatar.setLighting(track.lighting, s.lightingStrength, s.matchLighting);
        }
      }
      if (s.showSkeleton) drawSkeleton(track);
    }

    if (s.mode === 'mocap' && state.mocapAvatar) {
      const target = mocapTarget(active);
      const av = state.mocapAvatar;
      if (target) {
        if (state.mocapTrackId !== target.id) { state.mocapTrackId = target.id; target.resetPlacement = true; }
        poseAvatar(av, target, dt, { follow: s.mocapFollowCharacter, mode: 'mocap' });
        av.setLighting(target.lighting, s.lightingStrength, s.matchLighting);
        if (state.recorder.recording) {
          let root = null;
          if (s.recordRootMotion && target.anchor) {
            if (!state.recordStart) state.recordStart = target.anchor.clone();
            const hips = av.vrm.humanoid.getRawBoneNode('hips');
            const qInv = hips.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
            root = target.anchor.clone().sub(state.recordStart).applyQuaternion(qInv);
          }
          state.recorder.capture(root);
        }
      } else if (state.recorder.recording && state.recorder.frames.length) {
        // character briefly lost: hold the last pose so the timeline stays 30 fps
        state.recorder.capture(null);
      }
    }
  }

  // Render each model in its own pass so it only receives its own lights.
  renderer.clear();
  const draw = (a) => {
    if (!a.group.visible) return;
    camera.layers.set(a.layer);
    renderer.render(scene, camera);
  };
  for (const a of state.avatars.values()) draw(a);
  if (state.mocapAvatar) draw(state.mocapAvatar);

  if (state.frame % 15 === 0) updateStatus(active.length);
  if (DEBUG && state.frame % 15 === 0) {
    const m = state.metrics;
    const vt = state.video && state.video.el.currentTime !== undefined ? ` t=${state.video.el.currentTime.toFixed(1)}` : '';
    console.info(`[metrics]${vt} tracks=${active.length} all=${state.tracker.tracks.map((t) => `#${t.id}:pf${t.poseFrames}/m${t.missing}/nd${t.noDet}/${t.character ? 'C' : 's' + t.samples.length}`).join(',')} dets=${state.lastDets} align_px=${m.n ? (m.align / m.n).toFixed(2) : '-'} jitter_px=${m.n ? (m.jitter / m.n).toFixed(2) : '-'} cuts=${m.cuts} frames=${m.frames || 0} det_ms=${m.frames ? (m.tDet / m.frames).toFixed(0) : '-'} pose_ms=${m.frames ? (m.tPose / m.frames).toFixed(0) : '-'} total_ms=${(performance.now() - now).toFixed(0)}`);
    state.metrics = { align: 0, jitter: 0, n: 0, cuts: 0 };
  }
}

function blendLight(a, b) {
  const mix = (x, y) => x.map((v, i) => v * 0.7 + y[i] * 0.3);
  return {
    dir: mix(a.dir, b.dir), color: mix(a.color, b.color), intensity: a.intensity * 0.7 + b.intensity * 0.3,
    ambientColor: mix(a.ambientColor, b.ambientColor), ambientIntensity: a.ambientIntensity * 0.7 + b.ambientIntensity * 0.3,
    skyColor: mix(a.skyColor, b.skyColor),
  };
}

function mocapTarget(active) {
  if (!active.length) return null;
  const t = state.settings.mocapTarget;
  if (t === 'largest') {
    // stay on the current character unless another is clearly larger
    const cur = active.find((a) => a.id === state.mocapTrackId);
    return cur && boxArea(cur) > boxArea(active[0]) * 0.6 ? cur : active[0];
  }
  const byX = [...active].sort((a, b) => a.lm2d[LM.lHip].x - b.lm2d[LM.lHip].x);
  return byX[Number(t)] || null;
}

const BONES_2D = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32]];
function drawSkeleton(track) {
  const W = debugCanvas.width, H = debugCanvas.height;
  debugCtx.strokeStyle = 'rgba(124,156,255,0.9)';
  debugCtx.lineWidth = 2;
  for (const [a, b] of BONES_2D) {
    debugCtx.beginPath();
    debugCtx.moveTo(track.lm2d[a].x * W, track.lm2d[a].y * H);
    debugCtx.lineTo(track.lm2d[b].x * W, track.lm2d[b].y * H);
    debugCtx.stroke();
  }
  debugCtx.fillStyle = '#fff';
  debugCtx.font = '12px sans-serif';
  const label = track.character ? `#${track.id} ${track.character.hash}` : `#${track.id} analysing…`;
  debugCtx.fillText(label, track.lm2d[0].x * W + 8, track.lm2d[0].y * H - 8);
}

function updateStatus(n) {
  const s = state.settings;
  let txt;
  if (state.error) txt = state.error;
  else if (!state.video) txt = 'waiting for screen capture…';
  else if (!state.detectorReady) txt = 'loading detector…';
  else txt = `${state.fps.toFixed(0)} fps · ${n} character${n === 1 ? '' : 's'}`;
  if (s.mode === 'legs' && !state.baseVrm) txt += ' · load a base VRoid model';
  if (s.mode === 'mocap' && !state.mocapAvatar) txt += ' · import a VRM';
  if (txt !== state.lastStatus) { console.info(`[status] ${txt}`); state.lastStatus = txt; }
  state.ui.status(txt);
  if (state.recorder.recording) {
    document.getElementById('rec-info').textContent = `Recording… ${state.recorder.frames.length} frames (${state.recorder.duration.toFixed(1)} s)`;
  }
}

// ---------------------------------------------------------------------------
// Settings changes
// ---------------------------------------------------------------------------
function onSettingsChanged(key) {
  const s = state.settings;
  if (['detectionModel', 'maxCharacters', 'minConfidence', 'personModel', 'personThreshold', 'processing'].includes(key)) initDetector();
  if (key === 'displayId') setTimeout(startCapture, 300);
  if (key === 'backfaceCulling') {
    for (const a of state.avatars.values()) applyCulling(a.vrm, s.backfaceCulling);
    if (state.mocapAvatar) applyCulling(state.mocapAvatar.vrm, s.backfaceCulling);
  }
  if (['hideBaseClothing', 'showShoes', 'matchSkin', 'matchProportions'].includes(key)) rebuildLegs();
  if (key === 'mode') {
    if (state.recorder.recording) toggleRecord();
    if (s.mode === 'mocap') rebuildLegs();
  }
}

function toggleRecord() {
  const btn = document.getElementById('record');
  const dot = document.getElementById('rec-dot');
  if (!state.recorder.recording) {
    if (!state.mocapAvatar) { state.ui.toast('Import a VRM first.'); return; }
    state.recorder.start(state.mocapAvatar.vrm);
    state.recordStart = null;
    btn.textContent = '■ Stop';
    btn.classList.add('recording');
    dot.hidden = false;
    document.getElementById('export').disabled = true;
  } else {
    state.recorder.stop();
    btn.textContent = '● Record';
    btn.classList.remove('recording');
    dot.hidden = true;
    const n = state.recorder.frames.length;
    document.getElementById('export').disabled = n === 0;
    document.getElementById('rec-info').textContent = `Recorded ${n} frames (${state.recorder.duration.toFixed(1)} s at 30 fps).`;
  }
}

async function exportFbx() {
  const bytes = state.recorder.exportFbx();
  if (!bytes) return;
  const base = (state.mocapVrm && state.mocapVrm.name.replace(/\.[^.]+$/, '')) || 'vibecatcher';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const saved = await api.saveFbx(bytes, `${base}_motion_${stamp}.fbx`);
  if (saved) state.ui.toast(`Saved ${saved}`, 4000);
}

function bindButtons() {
  document.getElementById('load-base').addEventListener('click', async () => {
    const f = await api.openVrm();
    if (!f) return;
    state.settings.baseVrmPath = f.path;
    state.ui.save();
    await loadBaseFromBuffer(f);
  });
  document.getElementById('load-mocap').addEventListener('click', async () => {
    const f = await api.openVrm();
    if (!f) return;
    state.settings.mocapVrmPath = f.path;
    state.ui.save();
    state.mocapVrm = f;
    document.getElementById('mocap-name').textContent = f.name;
    await buildMocapAvatar();
  });
  document.getElementById('open-bottoms').addEventListener('click', () => api.openBottomsFolder());
  document.getElementById('reload-bottoms').addEventListener('click', async () => {
    await loadBottoms();
    // rebuild the legs so new / changed textures show up
    rebuildLegs();
    state.ui.toast('Bottoms library reloaded.');
  });
  document.getElementById('cleanup').addEventListener('click', () => {
    const n = state.store.cleanup(state.settings.cleanupMinLoads);
    state.ui.toast(`Removed ${n} rarely used character save${n === 1 ? '' : 's'}.`);
  });
  document.getElementById('delete-selected').addEventListener('click', () => {
    const ids = [...state.ui.selected];
    state.store.remove(ids);
    state.ui.selected.clear();
    state.ui.toast(`Deleted ${ids.length} save${ids.length === 1 ? '' : 's'}.`);
  });
  document.getElementById('record').addEventListener('click', toggleRecord);
  document.getElementById('export').addEventListener('click', exportFbx);
}

// ---------------------------------------------------------------------------
async function main() {
  state.settings = mergeSettings(await api.getSettings());
  state.tracker = new Tracker();
  state.sceneCut = new SceneCutDetector();
  state.ui = new OverlayUI({ api, settings: state.settings, onSettingsChanged });
  state.ui.setDisplays(await api.listDisplays());
  state.store = new CharacterStore(api);
  await state.store.load();
  state.store.onChange(() => state.ui.renderCharacters(state.store.list));
  state.ui.renderCharacters(state.store.list);
  bindButtons();
  await loadBottoms();

  if (state.settings.baseVrmPath) {
    const f = await api.readVrm(state.settings.baseVrmPath);
    if (f) await loadBaseFromBuffer(f);
  }
  if (state.settings.mocapVrmPath) {
    const f = await api.readVrm(state.settings.mocapVrmPath);
    if (f) {
      state.mocapVrm = f;
      document.getElementById('mocap-name').textContent = f.name;
      await buildMocapAvatar();
    }
  }
  tick();
  await Promise.all([startCapture(), initDetector()]);
}

main().catch((e) => {
  console.error(e);
  document.getElementById('status').textContent = `Startup error: ${e.message}`;
});
