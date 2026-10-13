// Loading and per-character preparation of VRM models.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { RigInfo } from './retarget.js';
import { PATTERNS } from './bottoms.js';

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

export async function parseVrm(data) {
  // IPC delivers a Uint8Array; GLTFLoader needs a standalone ArrayBuffer.
  const buf = data instanceof ArrayBuffer
    ? data.slice(0)
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const gltf = await loader.parseAsync(buf, '');
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('The file is not a VRM model.');
  vrm.scene.traverse((o) => { o.frustumCulled = false; });
  return vrm;
}

export function surfaceMaterial(mesh) {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}

const LEG_BONES = {
  L: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes'],
  R: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'],
};

function descendantsOf(node) {
  const set = new Set();
  if (node) node.traverse((o) => set.add(o));
  return set;
}

/** Per-vertex skin weight sums for a set of bones. */
function boneSetWeights(mesh, boneSet) {
  const g = mesh.geometry;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const bones = mesh.skeleton.bones;
  const flag = bones.map((b) => boneSet.has(b));
  const out = new Float32Array(si.count);
  for (let v = 0; v < si.count; v++) {
    let s = 0;
    for (let k = 0; k < 4; k++) if (flag[si.getComponent(v, k)]) s += sw.getComponent(v, k);
    out[v] = s;
  }
  return out;
}

/**
 * Removes every triangle that mostly belongs to the upper body (spine and
 * everything below it in the hierarchy). Keeps three-vrm's outline groups.
 */
function cutUpperBody(mesh, upperSet) {
  const g = mesh.geometry;
  if (!g.index) return;
  const up = boneSetWeights(mesh, upperSet);
  const idx = g.index.array;
  const ranges = g.groups.length ? g.groups : [{ start: 0, count: idx.length, materialIndex: 0 }];
  const uniq = new Map();
  for (const r of ranges) uniq.set(`${r.start}:${r.count}`, r);
  const out = [];
  const remap = new Map();
  for (const [key, r] of uniq) {
    const start = out.length;
    for (let i = r.start; i < r.start + r.count; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      if ((up[a] + up[b] + up[c]) / 3 < 0.5) out.push(a, b, c);
    }
    remap.set(key, { start, count: out.length - start });
  }
  const IndexArray = idx.constructor;
  g.setIndex(new THREE.BufferAttribute(new IndexArray(out), 1));
  if (g.groups.length) {
    const groups = g.groups.map((r) => ({ ...remap.get(`${r.start}:${r.count}`), materialIndex: r.materialIndex }));
    g.clearGroups();
    for (const r of groups) g.addGroup(r.start, r.count, r.materialIndex);
  }
  if (out.length === 0) mesh.visible = false;
}

/**
 * Measures the rest-pose leg frame of a model (heights of hip/knee/ankle and
 * the leg axis), in world space.
 */
function legFrame(vrm) {
  const h = vrm.humanoid;
  const wp = (n) => { const b = h.getRawBoneNode(n); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  const f = {};
  for (const s of ['L', 'R']) {
    const [hip, knee, foot, toes] = LEG_BONES[s].map(wp);
    f[s] = { hip, knee, ankle: foot, toes };
  }
  f.center = f.L.hip.clone().add(f.R.hip).multiplyScalar(0.5);
  return f;
}

// Leg parameter of a rest-pose height: 0 hip joint, 0.5 knee, 1 ankle, 1.15 sole.
function legParam(y, leg) {
  const hy = leg.hip.y, ky = leg.knee.y, ay = leg.ankle.y;
  if (y >= hy) return -0.5 * (y - hy) / Math.max(1e-4, hy - ky);
  if (y >= ky) return 0.5 * (hy - y) / Math.max(1e-4, hy - ky);
  if (y >= ay) return 0.5 + 0.5 * (ky - y) / Math.max(1e-4, ky - ay);
  return 1 + 0.15 * Math.min(1, (ay - y) / Math.max(1e-4, ay));
}

function axisAt(y, leg) {
  // Leg axis position (x,z) at a given rest height.
  const seg = y >= leg.knee.y ? [leg.hip, leg.knee] : [leg.knee, leg.ankle];
  const t = THREE.MathUtils.clamp((seg[0].y - y) / Math.max(1e-4, seg[0].y - seg[1].y), 0, 1);
  return new THREE.Vector3().lerpVectors(seg[0], seg[1], t);
}

/**
 * Prepares a freshly parsed VRM for "legs" mode: hides the upper body and
 * (optionally) the base clothing. Must run before rotateVRM0 / any posing.
 */
export function prepareLegsModel(vrm, settings) {
  const h = vrm.humanoid;
  vrm.scene.updateMatrixWorld(true);
  const upperSet = descendantsOf(h.getRawBoneNode('spine'));
  const legSets = {
    L: new Set(LEG_BONES.L.map((n) => h.getRawBoneNode(n)).filter(Boolean)),
    R: new Set(LEG_BONES.R.map((n) => h.getRawBoneNode(n)).filter(Boolean)),
  };
  const skinMeshes = [];
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const name = (surfaceMaterial(o).name || '') + ' ' + o.name;
    if (settings.hideBaseClothing && /(tops|onepiece|accessory|bottoms|cloth|skirt|pants)/i.test(name) && !/shoe/i.test(name)) {
      o.visible = false; return;
    }
    if (!settings.showShoes && /shoe/i.test(name)) { o.visible = false; return; }
    if (/face|hair|eye|brow|lash|mouth|teeth|tongue/i.test(name)) { o.visible = false; return; }
    cutUpperBody(o, upperSet);
    if (o.visible) skinMeshes.push(o);
  });
  return { skinMeshes, legSets };
}

/**
 * Reshapes the rest pose of the legs (length of thigh/shin, thickness) and
 * rebinds the skeleton so posing stays artefact-free.
 */
export function reshapeLegs(vrm, legSets, { thighScale = 1, shinScale = 1, thickness = 1 }) {
  if (Math.abs(thighScale - 1) < 0.01 && Math.abs(shinScale - 1) < 0.01 && Math.abs(thickness - 1) < 0.01) return;
  vrm.scene.updateMatrixWorld(true);
  const frame = legFrame(vrm);
  const meshes = [];
  vrm.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });

  const newY = (y, leg) => {
    const hy = leg.hip.y, ky = leg.knee.y, ay = leg.ankle.y;
    if (y >= hy) return y;
    const k2 = hy - (hy - ky) * thighScale;
    if (y >= ky) return hy - (hy - y) * thighScale;
    const a2 = k2 - (ky - ay) * shinScale;
    if (y >= ay) return k2 - (ky - y) * shinScale;
    return y + (a2 - ay);
  };

  const done = new Set();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    if (done.has(g)) continue;
    done.add(g);
    const wL = boneSetWeights(mesh, legSets.L), wR = boneSetWeights(mesh, legSets.R);
    const pos = g.attributes.position;
    const mw = mesh.matrixWorld, inv = mw.clone().invert();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const wl = wL[i], wr = wR[i];
      const wsum = Math.min(1, wl + wr);
      if (wsum < 1e-3) continue;
      const leg = wl >= wr ? frame.L : frame.R;
      v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      const y0 = v.y;
      const ax = axisAt(y0, leg);
      const l = legParam(y0, leg);
      // thickness fades in below the hip joint and out at the ankle
      const tw = THREE.MathUtils.smoothstep(l, -0.05, 0.12) * (1 - THREE.MathUtils.smoothstep(l, 0.92, 1.02));
      const t = 1 + (thickness - 1) * tw;
      const nx = ax.x + (v.x - ax.x) * t;
      const nz = ax.z + (v.z - ax.z) * t;
      const ny = newY(y0, leg);
      v.set(
        THREE.MathUtils.lerp(v.x, nx, wsum),
        THREE.MathUtils.lerp(v.y, ny, wsum),
        THREE.MathUtils.lerp(v.z, nz, wsum),
      );
      v.applyMatrix4(inv);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }

  // Move knee / ankle / toe bones to the new heights.
  for (const s of ['L', 'R']) {
    const leg = frame[s];
    for (const name of LEG_BONES[s].slice(1)) {
      const b = vrm.humanoid.getRawBoneNode(name);
      if (!b) continue;
      b.parent.updateMatrixWorld(true);
      const wpos = b.getWorldPosition(new THREE.Vector3());
      wpos.y = newY(wpos.y, leg);
      b.position.copy(b.parent.worldToLocal(wpos));
      b.updateMatrixWorld(true);
    }
  }
  vrm.scene.updateMatrixWorld(true);
  const skeletons = new Set();
  for (const mesh of meshes) {
    if (!skeletons.has(mesh.skeleton)) { mesh.skeleton.calculateInverses(); skeletons.add(mesh.skeleton); }
    mesh.bindMatrix.copy(mesh.matrixWorld);
    mesh.bindMatrixInverse.copy(mesh.matrixWorld).invert();
  }
}

/** Thigh width / thigh length of the model's left leg, for proportion matching. */
export function measureThighRatio(vrm, legSets) {
  vrm.scene.updateMatrixWorld(true);
  const frame = legFrame(vrm);
  const leg = frame.L;
  const yMid = leg.hip.y - (leg.hip.y - leg.knee.y) * 0.5;
  let minX = Infinity, maxX = -Infinity;
  const v = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.visible) return;
    const wL = boneSetWeights(o, legSets.L);
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (wL[i] < 0.5) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (Math.abs(v.y - yMid) > 0.015) continue;
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    }
  });
  const len = leg.hip.distanceTo(leg.knee);
  return Number.isFinite(minX) && len > 0 ? (maxX - minX) / len : 0.35;
}

/**
 * Picks the body-skin material meshes of a VRoid model.
 */
export function findSkinMeshes(skinMeshes) {
  const named = (re) => skinMeshes.filter((m) => re.test(surfaceMaterial(m).name || ''));
  let r = named(/body.*skin|skin.*body/i);
  if (!r.length) r = named(/skin/i);
  if (!r.length) r = named(/body/i);
  return r;
}

function textureImageData(tex, maxSize = 2048) {
  const img = tex.image;
  const w0 = img.width, h0 = img.height;
  const sc = Math.min(1, maxSize / Math.max(w0, h0));
  const w = Math.round(w0 * sc), h = Math.round(h0 * sc);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas: c, ctx, data: ctx.getImageData(0, 0, w, h) };
}

function makeCanvasTexture(canvas, like) {
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = like.flipY;
  t.colorSpace = like.colorSpace;
  t.wrapS = like.wrapS; t.wrapT = like.wrapT;
  t.offset.copy(like.offset); t.repeat.copy(like.repeat);
  t.center.copy(like.center); t.rotation = like.rotation;
  t.magFilter = like.magFilter; t.minFilter = like.minFilter;
  t.anisotropy = like.anisotropy;
  t.channel = like.channel;
  t.needsUpdate = true;
  return t;
}

/**
 * Bakes skin tone + chosen bottoms onto the body-skin texture.
 * @param {object} look { skin:[r,g,b]|null, bottom:{item,color,hem}|null, legwear:{item,color,top}|null, patterns }
 */
export function bakeLegTexture(skinMeshes, look, rest) {
  const meshes = findSkinMeshes(skinMeshes);
  if (!meshes.length) return;
  const frame = rest.frame;
  const byTexture = new Map();
  for (const m of meshes) {
    const mat = surfaceMaterial(m);
    if (!mat.map || !mat.map.image) continue;
    if (!byTexture.has(mat.map)) byTexture.set(mat.map, []);
    byTexture.get(mat.map).push(m);
  }
  for (const [tex, ms] of byTexture) {
    if (!tex.userData.vibeOriginal) tex.userData.vibeOriginal = tex;
    const { canvas, ctx, data } = textureImageData(tex.userData.vibeOriginal);
    const W = data.width, H = data.height, px = data.data;

    // Per-vertex leg parameter and around-limb angle (rest pose, world space).
    const tris = [];
    const refSkin = [];
    for (const m of ms) {
      const g = m.geometry;
      const pos = g.attributes.position, uv = g.attributes.uv;
      if (!uv || !g.index) continue;
      const n = pos.count;
      const L = new Float32Array(n), C = new Float32Array(n), Sn = new Float32Array(n);
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(rest.meshMatrix.get(m) || m.matrixWorld);
        const side = (v.x - frame.center.x) * (frame.L.hip.x - frame.center.x) >= 0 ? frame.L : frame.R;
        const l = legParam(v.y, side);
        const ax = l < 0 ? frame.center : axisAt(v.y, side);
        const a = Math.atan2(v.z - ax.z, v.x - ax.x);
        L[i] = l; C[i] = Math.cos(a); Sn[i] = Math.sin(a);
      }
      const idx = g.index.array;
      const count = g.groups.length ? g.groups[0].count : idx.length;
      const start = g.groups.length ? g.groups[0].start : 0;
      for (let i = start; i < start + count; i += 3) {
        const t = [idx[i], idx[i + 1], idx[i + 2]].map((k) => ({
          x: uv.getX(k) * W, y: uv.getY(k) * H, l: L[k], c: C[k], s: Sn[k],
        }));
        tris.push(t);
        if (t[0].l > 0.1 && t[0].l < 0.9 && refSkin.length < 4000) {
          const x = Math.floor(((t[0].x % W) + W) % W), y = Math.floor(((t[0].y % H) + H) % H);
          const o = (y * W + x) * 4;
          refSkin.push([px[o], px[o + 1], px[o + 2]]);
        }
      }
    }

    // 1) skin tone: multiply the whole skin texture towards the target colour.
    if (look.skin && refSkin.length) {
      const med = [0, 1, 2].map((k) => refSkin.map((c) => c[k]).sort((a, b) => a - b)[Math.floor(refSkin.length / 2)]);
      const gain = med.map((m, k) => THREE.MathUtils.clamp(look.skin[k] / Math.max(8, m), 0.25, 2.5));
      for (let i = 0; i < px.length; i += 4) {
        px[i] = Math.min(255, px[i] * gain[0]);
        px[i + 1] = Math.min(255, px[i + 1] * gain[1]);
        px[i + 2] = Math.min(255, px[i + 2] * gain[2]);
      }
    }

    // 2) clothing layers rasterised in UV space.
    const layers = [];
    if (look.bottom && look.bottom.item) layers.push(layerSpec(look.bottom, 'bottom', look.patterns));
    if (look.legwear && look.legwear.item) layers.push(layerSpec(look.legwear, 'legwear', look.patterns));
    if (layers.length) rasterize(tris, W, H, px, layers);

    ctx.putImageData(data, 0, 0);
    const baked = makeCanvasTexture(canvas, tex.userData.vibeOriginal);
    baked.userData.vibeOriginal = tex.userData.vibeOriginal;
    for (const m of ms) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat.map === tex) mat.map = baked;
        if (mat.shadeMultiplyTexture && (mat.shadeMultiplyTexture === tex || mat.shadeMultiplyTexture.userData.vibeShadeOf === tex)) {
          mat.shadeMultiplyTexture = baked;
        }
      }
    }
  }
}

function layerSpec(layer, kind, patterns) {
  const it = layer.item;
  let top = it.top, hem = it.hem;
  if (kind === 'bottom' && hem === 'auto') hem = THREE.MathUtils.clamp((layer.hem ?? 0.5) + 0.02, 0.05, 1.05);
  if (kind === 'legwear' && top === 'auto') top = THREE.MathUtils.clamp(layer.top ?? 0.75, 0.1, 1.0);
  const fn = it.pattern === 'image' ? (patterns && patterns[it.id]) || PATTERNS.plain : PATTERNS[it.pattern] || PATTERNS.plain;
  return {
    top, hem, color: layer.color, fn, scale: it.scale || 1, opacity: it.opacity ?? 1,
    sheer: it.pattern === 'sheer', waistband: !!it.waistband, cuff: !!it.cuff,
  };
}

function rasterize(tris, W, H, px, layers) {
  const edge = 0.012;
  for (const t of tris) {
    const [a, b, c] = t;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x) - 1));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x) + 1));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y) - 1));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y) + 1));
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 1e-6 || maxX - minX > W / 2 || maxY - minY > H / 2) continue;
    const lmin = Math.min(a.l, b.l, c.l), lmax = Math.max(a.l, b.l, c.l);
    if (!layers.some((ly) => lmax >= ly.top - edge && lmin <= ly.hem + edge)) continue;
    // ~1px conservative expansion to avoid seams
    const tol = 1.2 / Math.sqrt(Math.abs(area));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const qx = x + 0.5, qy = y + 0.5;
        const w0 = ((b.x - qx) * (c.y - qy) - (b.y - qy) * (c.x - qx)) / area;
        const w1 = ((c.x - qx) * (a.y - qy) - (c.y - qy) * (a.x - qx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -tol || w1 < -tol || w2 < -tol) continue;
        const l = a.l * w0 + b.l * w1 + c.l * w2;
        const u = (Math.atan2(a.s * w0 + b.s * w1 + c.s * w2, a.c * w0 + b.c * w1 + c.c * w2) / (Math.PI * 2)) + 0.5;
        const o = (y * W + x) * 4;
        for (const ly of layers) {
          const cov = THREE.MathUtils.smoothstep(l, ly.top - edge, ly.top + edge) * (1 - THREE.MathUtils.smoothstep(l, ly.hem - edge, ly.hem + edge));
          if (cov <= 0) continue;
          let shade = ly.fn(u * ly.scale, l * ly.scale);
          if (ly.waistband && l < ly.top + 0.045) shade *= 0.82;
          if (ly.cuff && l > ly.hem - 0.035) shade *= 0.88;
          const k = cov * ly.opacity;
          for (let ch = 0; ch < 3; ch++) {
            const base = px[o + ch];
            const fab = ly.sheer ? base * (ly.color[ch] / 255) * 1.1 * shade : ly.color[ch] * shade;
            px[o + ch] = Math.max(0, Math.min(255, base + (fab - base) * k));
          }
        }
      }
    }
  }
}

/** Snapshot of the rest pose used later for texture baking. */
export function captureRest(vrm) {
  vrm.scene.updateMatrixWorld(true);
  const meshMatrix = new Map();
  vrm.scene.traverse((o) => { if (o.isSkinnedMesh) meshMatrix.set(o, o.matrixWorld.clone()); });
  return { frame: legFrame(vrm), meshMatrix };
}

/** Applies the back-face culling toggle to every surface material. */
export function applyCulling(vrm, culling) {
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.isOutline) continue;
      if (m.userData.vibeSide === undefined) m.userData.vibeSide = m.side;
      const side = culling ? THREE.FrontSide : THREE.DoubleSide;
      if (m.side !== side) { m.side = side; m.needsUpdate = true; }
    }
  });
}

/** Puts every object of the model (and its lights) on one render layer. */
export function setLayer(root, layer) {
  root.traverse((o) => o.layers.set(layer));
}

/**
 * A rendered model + its private lights. One instance per tracked character.
 */
export class AvatarInstance {
  constructor(vrm, layer, extras = {}) {
    this.vrm = vrm;
    this.layer = layer;
    this.extras = extras;
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.updateMatrixWorld(true);
    this.rig = new RigInfo(vrm);
    this.rest = captureRest(vrm);
    this.key = new THREE.DirectionalLight(0xffffff, Math.PI);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    this.key.target = new THREE.Object3D();
    this.group = new THREE.Group();
    this.group.add(vrm.scene, this.key, this.key.target, this.hemi);
    setLayer(this.group, layer);
    this.visible = false;
    this.group.visible = false;
  }

  setLighting(est, strength, enabled) {
    const anchor = this.vrm.scene.position;
    if (!enabled || !est) {
      this.key.color.setRGB(1, 1, 1);
      this.key.intensity = Math.PI * 0.75;
      this.key.position.set(anchor.x + 1, anchor.y + 2, anchor.z + 3);
      this.hemi.color.setRGB(1, 1, 1); this.hemi.groundColor.setRGB(0.4, 0.4, 0.45);
      this.hemi.intensity = Math.PI * 0.35;
    } else {
      this.key.color.setRGB(...est.color);
      // MToon outputs light * albedo / PI, so PI == "lit exactly at albedo".
      this.key.intensity = Math.PI * est.intensity * strength;
      this.key.position.set(anchor.x + est.dir[0] * 5, anchor.y + est.dir[1] * 5, anchor.z + est.dir[2] * 5);
      this.hemi.color.setRGB(...est.skyColor);
      this.hemi.groundColor.setRGB(...est.ambientColor);
      this.hemi.intensity = Math.PI * est.ambientIntensity * strength;
    }
    this.key.target.position.copy(anchor);
    this.key.target.updateMatrixWorld();
  }

  dispose() {
    this.group.removeFromParent();
    VRMUtils.deepDispose(this.vrm.scene);
  }
}
