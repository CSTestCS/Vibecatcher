// Vibecatcher renderer: capture -> detect -> track -> retarget -> render, 30 fps.

import * as THREE from 'three';
import { mergeSettings } from './lib/settings.js';
import { OverlayUI } from './ui.js';
import { PoseDetector } from './lib/detector.js';
import { Tracker } from './lib/tracker.js';
import { CharacterStore } from './lib/characters.js';
import {
  FrameSampler, extractAppearance, extractProportions, estimateLighting, averageAppearance, LM,
} from './lib/features.js';
import { BUILTIN_BOTTOMS, chooseBottoms, loadImagePattern } from './lib/bottoms.js';
import {
  parseVrm, prepareLegsModel, reshapeLegs, measureThighRatio, bakeLegTexture, applyCulling, AvatarInstance,
} from './lib/avatar.js';
import { applyPose, solvePlacement, placeModel } from './lib/retarget.js';
import { MotionRecorder } from './lib/recorder.js';

const api = window.vibe;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
const APPEARANCE_SAMPLES = 6;

const state = {
  settings: null,
  ui: null,
  detector: new PoseDetector(),
  tracker: new Tracker(),
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
  pending: new Set(), // trackIds with an avatar being built
  freeLayers: Array.from({ length: 30 }, (_, i) => i + 1),
  bottoms: [...BUILTIN_BOTTOMS],
  patterns: {},
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
  const test = new URLSearchParams(location.search).get('testSource');
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
    await state.detector.init({
      variant: state.settings.detectionModel,
      numPoses: state.settings.maxCharacters,
      minConfidence: state.settings.minConfidence,
    });
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
  const user = await api.listUserBottoms();
  const valid = user.filter((u) => u.id && u.category);
  state.bottoms = [...BUILTIN_BOTTOMS.filter((b) => !valid.find((u) => u.id === b.id)), ...valid];
  for (const u of valid) {
    if (u.pattern === 'image' && u.image) {
      try { state.patterns[u.id] = await loadImagePattern(u.image); } catch (e) { console.warn('pattern', u.image, e); }
    }
  }
  document.getElementById('bottoms-count').textContent =
    `${state.bottoms.length} bottoms (${valid.length} from your folder).`;
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------
function takeLayer() { return state.freeLayers.shift() ?? 31; }
function releaseLayer(l) { if (l < 31) state.freeLayers.push(l); }

function disposeAvatar(trackId) {
  const a = state.avatars.get(trackId);
  if (!a) return;
  a.dispose();
  releaseLayer(a.layer);
  state.avatars.delete(trackId);
}

function disposeAllAvatars() {
  for (const id of [...state.avatars.keys()]) disposeAvatar(id);
  if (state.mocapAvatar) { state.mocapAvatar.dispose(); releaseLayer(state.mocapAvatar.layer); state.mocapAvatar = null; }
}

/** Builds the leg model for a resolved character. */
async function buildLegsAvatar(track) {
  if (!state.baseVrm || state.pending.has(track.id)) return;
  state.pending.add(track.id);
  try {
    const c = track.character;
    const vrm = await parseVrm(state.baseVrm.data);
    const { skinMeshes, legSets } = prepareLegsModel(vrm, state.settings);
    if (state.settings.matchProportions && c.proportions) reshapeLegs(vrm, legSets, c.proportions);
    const avatar = new AvatarInstance(vrm, takeLayer());
    if (state.tracker.tracks.find((t) => t.id === track.id) === undefined) { avatar.dispose(); releaseLayer(avatar.layer); return; }
    const bottomItem = state.bottoms.find((b) => b.id === c.bottomId) || null;
    const legItem = state.bottoms.find((b) => b.id === c.legwearId) || null;
    bakeLegTexture(skinMeshes, {
      skin: state.settings.matchSkin ? c.colors.skin : null,
      bottom: bottomItem ? { item: bottomItem, color: c.colors.bottom, hem: c.legwear.hem } : null,
      legwear: legItem ? { item: legItem, color: c.colors.socks || c.colors.bottom, top: c.legwear.socksTop } : null,
      patterns: state.patterns,
    }, avatar.rest);
    applyCulling(vrm, state.settings.backfaceCulling);
    scene.add(avatar.group);
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
function resolveCharacter(track) {
  const appearance = averageAppearance(track.samples);
  let c = state.store.match(appearance);
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
  for (const id of [...state.avatars.keys()]) disposeAvatar(id);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function selectTracks(tracks) {
  const size = (t) => Math.hypot(t.lm2d[LM.lShoulder].x - t.lm2d[LM.lAnkle].x, t.lm2d[LM.lShoulder].y - t.lm2d[LM.lAnkle].y);
  return [...tracks].sort((a, b) => size(b) - size(a)).slice(0, state.settings.maxCharacters);
}

function frameMean(img) {
  const d = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return n ? [r / n, g / n, b / n] : null;
}

function poseAvatar(avatar, track, dt, follow = true) {
  applyPose(avatar.rig, track.lmW);
  avatar.vrm.humanoid.update();
  if (follow) {
    const sol = solvePlacement(avatar.rig, track.lm2d, track.lmW, camera, camera.aspect);
    if (sol) {
      // smooth depth to avoid size popping
      if (track.anchor) sol.anchor.lerp(track.anchor, Math.min(0.8, state.settings.smoothing));
      track.anchor = sol.anchor.clone();
      placeModel(avatar.vrm, sol.anchor);
    }
  } else {
    // fixed preview position in the lower-right corner
    const d = 4;
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    placeModel(avatar.vrm, new THREE.Vector3(0.7 * d * tanH * camera.aspect, -0.35 * d * tanH, -d));
  }
  avatar.vrm.update(dt);
  avatar.group.visible = true;
}

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, clock.getDelta());
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

    const needAppearance = s.mode === 'legs' && state.tracker.tracks.some((t) => !t.character && t.samples.length < APPEARANCE_SAMPLES);
    const lightingTick = s.matchLighting && state.frame % 10 === 0;
    const wantPixels = needAppearance || lightingTick;
    const poses = state.detector.detect(an, wantPixels);
    active = selectTracks(state.tracker.update(poses, s.smoothing));
    for (const t of state.tracker.dropped) { disposeAvatar(t.id); }

    let img = null, mean = null;
    if (wantPixels && active.length) { img = actx.getImageData(0, 0, aw, ah); mean = frameMean(img); }

    for (const track of active) {
      const pose = poses[track.poseIndex];
      const sampler = img ? new FrameSampler(img, pose && pose.mask) : null;
      if (sampler) sampler.validateMask(pose.lm2d);

      if (sampler && lightingTick) {
        const est = estimateLighting(sampler, pose.lm2d, mean);
        if (est) track.lighting = track.lighting ? blendLight(track.lighting, est) : est;
      }

      if (s.mode === 'legs') {
        if (!track.character) {
          if (sampler && track.age >= 3 && track.samples.length < APPEARANCE_SAMPLES) {
            const a = extractAppearance(sampler, pose.lm2d);
                        if (a) track.samples.push(a);
            track.propSamples.push(extractProportions(sampler, pose.lm2d, pose.lmW));
          }
          if (track.samples.length >= APPEARANCE_SAMPLES && state.baseVrm) {
            resolveCharacter(track);
            fitProportions(track.character);
          }
        }
        if (track.character && !state.avatars.has(track.id)) buildLegsAvatar(track);
        const avatar = state.avatars.get(track.id);
        if (avatar) {
          poseAvatar(avatar, track, dt);
          avatar.setLighting(track.lighting, s.lightingStrength, s.matchLighting);
        }
      }
      if (s.showSkeleton) drawSkeleton(track);
    }

    if (s.mode === 'mocap' && state.mocapAvatar) {
      const target = mocapTarget(active);
      const av = state.mocapAvatar;
      if (target) {
        poseAvatar(av, target, dt, s.mocapFollowCharacter);
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
  const spent = performance.now() - now;
  setTimeout(tick, Math.max(0, FRAME_MS - spent));
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
  if (t === 'largest') return active[0];
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
  if (['detectionModel', 'maxCharacters', 'minConfidence'].includes(key)) initDetector();
  if (key === 'displayId') setTimeout(startCapture, 300);
  if (key === 'backfaceCulling') {
    for (const a of state.avatars.values()) applyCulling(a.vrm, s.backfaceCulling);
    if (state.mocapAvatar) applyCulling(state.mocapAvatar.vrm, s.backfaceCulling);
  }
  if (['hideBaseClothing', 'showShoes', 'matchSkin', 'matchProportions'].includes(key)) {
    for (const id of [...state.avatars.keys()]) disposeAvatar(id);
  }
  if (key === 'mode') {
    if (state.recorder.recording) toggleRecord();
    if (s.mode === 'mocap') for (const id of [...state.avatars.keys()]) disposeAvatar(id);
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
  document.getElementById('open-bottoms').addEventListener('click', async () => {
    await api.openBottomsFolder();
    setTimeout(loadBottoms, 1000);
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
