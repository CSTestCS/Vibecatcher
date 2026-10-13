// Converts MediaPipe pose landmarks into VRM humanoid bone rotations and a
// camera-space placement, so the rendered model lines up with the on-screen
// character from the same camera angle.

import * as THREE from 'three';
import { LM } from './features.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// MediaPipe world landmarks: x right, y down, z away from camera (metres).
// three.js camera space: x right, y up, z towards the viewer.
export function toCam(p) {
  return new THREE.Vector3(p.x, -p.y, -p.z);
}

function basisQuat(xAxis, yHint) {
  const x = xAxis.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, yHint).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(x, y, z));
}

// Segment chains: bone -> [from landmark(s), to landmark(s)] and the child bone
// used to measure the bone's rest direction.
const LIMBS = [
  ['leftUpperLeg', [LM.lHip], [LM.lKnee], 'leftLowerLeg'],
  ['leftLowerLeg', [LM.lKnee], [LM.lAnkle], 'leftFoot'],
  ['leftFoot', [LM.lAnkle], [LM.lFoot], 'leftToes'],
  ['rightUpperLeg', [LM.rHip], [LM.rKnee], 'rightLowerLeg'],
  ['rightLowerLeg', [LM.rKnee], [LM.rAnkle], 'rightFoot'],
  ['rightFoot', [LM.rAnkle], [LM.rFoot], 'rightToes'],
  ['leftUpperArm', [LM.lShoulder], [LM.lElbow], 'leftLowerArm'],
  ['leftLowerArm', [LM.lElbow], [LM.lWrist], 'leftHand'],
  ['leftHand', [LM.lWrist], [LM.lIndex, LM.lPinky], 'leftMiddleProximal'],
  ['rightUpperArm', [LM.rShoulder], [LM.rElbow], 'rightLowerArm'],
  ['rightLowerArm', [LM.rElbow], [LM.rWrist], 'rightHand'],
  ['rightHand', [LM.rWrist], [LM.rIndex, LM.rPinky], 'rightMiddleProximal'],
];

const PARENT_CHAIN = {
  spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
  leftShoulder: 'upperChest', rightShoulder: 'upperChest',
  leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};

/**
 * Per-model rig information, measured once from the model's rest pose.
 */
export class RigInfo {
  constructor(vrm) {
    this.vrm = vrm;
    const h = vrm.humanoid;
    vrm.scene.updateMatrixWorld(true);
    this.sceneQuat = vrm.scene.getWorldQuaternion(new THREE.Quaternion());
    this.sceneQuatInv = this.sceneQuat.clone().invert();
    const pos = (name) => {
      const n = h.getRawBoneNode(name);
      return n ? n.getWorldPosition(new THREE.Vector3()) : null;
    };
    this.restPos = {};
    for (const name of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperLeg', 'rightUpperLeg',
      'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes', 'leftShoulder', 'rightShoulder',
      'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
      'leftMiddleProximal', 'rightMiddleProximal']) {
      const p = pos(name);
      if (p) this.restPos[name] = p;
    }
    this.restDir = {};
    for (const [bone, , , child] of LIMBS) {
      const a = this.restPos[bone];
      let b = this.restPos[child];
      if (!a) continue;
      if (!b) {
        // Fallbacks for models without toes / finger bones.
        if (bone.endsWith('Foot')) b = a.clone().add(new THREE.Vector3(0, -0.05, 0.12).applyQuaternion(this.sceneQuat));
        else if (bone.endsWith('Hand')) {
          const parentPos = this.restPos[bone.replace('Hand', 'LowerArm')];
          b = a.clone().add(a.clone().sub(parentPos).normalize().multiplyScalar(0.08));
        } else continue;
      }
      this.restDir[bone] = b.clone().sub(a).normalize();
    }
    const lL = this.restPos.leftUpperLeg, rL = this.restPos.rightUpperLeg;
    this.restX = lL.clone().sub(rL).normalize();
    this.restHipsQuat = basisQuat(this.restX, new THREE.Vector3(0, 1, 0));
    const lA = this.restPos.leftUpperArm || lL, rA = this.restPos.rightUpperArm || rL;
    this.restChestQuat = basisQuat(lA.clone().sub(rA), new THREE.Vector3(0, 1, 0));
    // Segment lengths (metres, model scale)
    const d = (a, b) => (this.restPos[a] && this.restPos[b] ? this.restPos[a].distanceTo(this.restPos[b]) : 0);
    const legMid = lL.clone().add(rL).multiplyScalar(0.5);
    const shMid = (this.restPos.leftUpperArm && this.restPos.rightUpperArm)
      ? this.restPos.leftUpperArm.clone().add(this.restPos.rightUpperArm).multiplyScalar(0.5)
      : legMid.clone().add(new THREE.Vector3(0, 0.5, 0));
    this.len = {
      thigh: (d('leftUpperLeg', 'leftLowerLeg') + d('rightUpperLeg', 'rightLowerLeg')) / 2,
      shin: (d('leftLowerLeg', 'leftFoot') + d('rightLowerLeg', 'rightFoot')) / 2,
      torso: legMid.distanceTo(shMid),
      hipWidth: lL.distanceTo(rL),
    };
  }
}

/**
 * Applies a pose to the VRM's normalized humanoid.
 * @param {RigInfo} rig
 * @param {Array} w world landmarks (MediaPipe, metres)
 */
export function applyPose(rig, w, opts = {}) {
  const h = rig.vrm.humanoid;
  const MIN_VIS = 0.45;
  const vis = (ids) => Math.min(...ids.map((i) => w[i].visibility ?? 1));
  const P = (ids) => {
    const v = new THREE.Vector3();
    for (const i of ids) v.add(toCam(w[i]));
    return v.multiplyScalar(1 / ids.length);
  };
  // World-space delta rotations (relative to rest) per bone.
  const R = {};
  const S = rig.sceneQuat, Sinv = rig.sceneQuatInv;

  const setLocal = (bone, deltaWorld) => {
    R[bone] = deltaWorld;
    const node = h.getNormalizedBoneNode(bone);
    if (!node) return;
    const parentName = PARENT_CHAIN[bone];
    let parentDelta = new THREE.Quaternion();
    let p = parentName;
    while (p && !R[p]) p = PARENT_CHAIN[p];
    if (p) parentDelta = R[p];
    // local = S^-1 * Rp^-1 * Rb * S
    _q.copy(parentDelta).invert().multiply(deltaWorld);
    node.quaternion.copy(Sinv).multiply(_q).multiply(S);
  };

  const lHip = P([LM.lHip]), rHip = P([LM.rHip]);
  const lSh = P([LM.lShoulder]), rSh = P([LM.rShoulder]);
  const hipMid = lHip.clone().add(rHip).multiplyScalar(0.5);
  const shMid = lSh.clone().add(rSh).multiplyScalar(0.5);
  const up = shMid.clone().sub(hipMid).normalize();

  // Torso: when the shoulders are hidden (e.g. only the legs are on screen)
  // keep the previous up direction instead of trusting guessed landmarks.
  const torsoVisible = vis([LM.lShoulder, LM.rShoulder]) >= MIN_VIS;
  const hipsVisible = vis([LM.lHip, LM.rHip]) >= 0.3;
  if (torsoVisible) rig.lastUp = up.clone();
  const useUp = torsoVisible || !rig.lastUp ? up : rig.lastUp;
  let hipsQ;
  if (hipsVisible || !rig.lastHipsQ) {
    hipsQ = basisQuat(lHip.clone().sub(rHip), useUp).multiply(rig.restHipsQuat.clone().invert());
    rig.lastHipsQ = hipsQ.clone();
  } else hipsQ = rig.lastHipsQ.clone();
  setLocal('hips', hipsQ);

  if (torsoVisible || !rig.lastChestQ) {
    rig.lastChestQ = basisQuat(lSh.clone().sub(rSh), useUp).multiply(rig.restChestQuat.clone().invert());
  }
  const chestQ = rig.lastChestQ.clone();
  const spineQ = hipsQ.clone().slerp(chestQ, 0.4);
  const chest2Q = hipsQ.clone().slerp(chestQ, 0.75);
  setLocal('spine', spineQ);
  setLocal('chest', chest2Q);
  setLocal('upperChest', chestQ.clone());

  // Head from ears + nose.
  const lEar = P([LM.lEar]), rEar = P([LM.rEar]), nose = P([LM.nose]);
  const earMid = lEar.clone().add(rEar).multiplyScalar(0.5);
  const fwd = nose.clone().sub(earMid).add(up.clone().multiplyScalar(0.035));
  const hx = lEar.clone().sub(rEar).normalize();
  const hz = fwd.sub(hx.clone().multiplyScalar(fwd.dot(hx))).normalize();
  const hy = new THREE.Vector3().crossVectors(hz, hx).normalize();
  const headBasis = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(hx, hy, hz));
  const headQ = headBasis.multiply(rig.restChestQuat.clone().invert());
  const chestRef = R.upperChest || chestQ;
  // Limit how far the head can turn from the chest to reject bad frames.
  if (chestRef.angleTo(headQ) < 1.4 && vis([LM.lEar, LM.rEar, LM.nose]) >= MIN_VIS) {
    setLocal('neck', chestRef.clone().slerp(headQ, 0.5));
    setLocal('head', headQ);
  }

  for (const [bone, from, to] of LIMBS) {
    if (!rig.restDir[bone]) continue;
    if (opts.legsOnly && !/Leg|Foot/.test(bone)) continue;
    // Hidden / implausible limb: keep the rotation it already has (last
    // frame's, relative to its parent) instead of following guessed landmarks.
    if (vis([...from, ...to]) < MIN_VIS) {
      const node = h.getNormalizedBoneNode(bone);
      let p = PARENT_CHAIN[bone];
      while (p && !R[p]) p = PARENT_CHAIN[p];
      if (node) R[bone] = (p ? R[p] : new THREE.Quaternion()).clone().multiply(S.clone().multiply(node.quaternion).multiply(Sinv));
      continue;
    }
    const target = P(to).sub(P(from));
    if (target.lengthSq() < 1e-8) continue;
    target.normalize();
    let p = PARENT_CHAIN[bone];
    while (p && !R[p]) p = PARENT_CHAIN[p];
    const parentDelta = p ? R[p] : new THREE.Quaternion();
    const cur = _v.copy(rig.restDir[bone]).applyQuaternion(parentDelta);
    _q2.setFromUnitVectors(cur, target);
    setLocal(bone, _q2.clone().multiply(parentDelta));
  }
}

// ---------------------------------------------------------------------------
// Screen-space alignment ("skin" fitting)
// ---------------------------------------------------------------------------
// After the 3D pose is applied, every chain is re-aimed so that each joint of
// the model projects exactly onto the character's landmark on screen. Depth
// comes from the 3D pose: of the two points on the landmark's camera ray at
// bone-length distance from the parent joint, the one nearest the 3D estimate
// is used. Hidden landmarks are skipped, so those joints keep the 3D pose.

const CHAINS = {
  legs: [
    ['leftUpperLeg', 'leftLowerLeg', [LM.lKnee], 1],
    ['leftLowerLeg', 'leftFoot', [LM.lAnkle], 1],
    ['leftFoot', 'leftToes', [LM.lFoot], 1.35],
    ['rightUpperLeg', 'rightLowerLeg', [LM.rKnee], 1],
    ['rightLowerLeg', 'rightFoot', [LM.rAnkle], 1],
    ['rightFoot', 'rightToes', [LM.rFoot], 1.35],
  ],
  arms: [
    ['leftUpperArm', 'leftLowerArm', [LM.lElbow], 1],
    ['leftLowerArm', 'leftHand', [LM.lWrist], 1],
    ['leftHand', 'leftMiddleProximal', [LM.lIndex, LM.lPinky], 1.6],
    ['rightUpperArm', 'rightLowerArm', [LM.rElbow], 1],
    ['rightLowerArm', 'rightHand', [LM.rWrist], 1],
    ['rightHand', 'rightMiddleProximal', [LM.rIndex, LM.rPinky], 1.6],
  ],
};

const _wq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

function rayThrough(camera, lm, aspect) {
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  return new THREE.Vector3((lm.x * 2 - 1) * tanH * aspect, (1 - lm.y * 2) * tanH, -1).normalize();
}

/** Rotates a normalized bone so its world direction `from` becomes `to`. */
function aimNode(node, from, to) {
  _q.setFromUnitVectors(from, to);
  node.getWorldQuaternion(_wq);
  node.parent.getWorldQuaternion(_pq);
  node.quaternion.copy(_pq.invert().multiply(_q.multiply(_wq)));
}

function refresh(vrm) {
  vrm.humanoid.update();
  vrm.scene.updateMatrixWorld(true);
}

/**
 * @param {object} rig RigInfo
 * @param {Array} lm2d filtered landmarks (frame-normalised)
 * @param {THREE.PerspectiveCamera} camera (at the origin, looking down -Z)
 * @param {object} opts { legs: bool, arms: bool, hips: bool, minVis }
 */
export function alignToScreen(rig, lm2d, camera, opts = {}) {
  const vrm = rig.vrm;
  const h = vrm.humanoid;
  const aspect = camera.aspect;
  const minVis = opts.minVis ?? 0.5;
  const visible = (ids) => ids.every((i) => (lm2d[i].visibility ?? 1) >= minVis);
  const target2d = (ids) => {
    const p = { x: 0, y: 0 };
    for (const i of ids) { p.x += lm2d[i].x; p.y += lm2d[i].y; }
    return { x: p.x / ids.length, y: p.y / ids.length };
  };
  refresh(vrm);

  // Hips: turn the pelvis so both hip joints line up with the hip landmarks.
  if (opts.hips !== false && visible([LM.lHip, LM.rHip])) {
    const hipsNode = h.getNormalizedBoneNode('hips');
    const L = h.getRawBoneNode('leftUpperLeg').getWorldPosition(new THREE.Vector3());
    const Rp = h.getRawBoneNode('rightUpperLeg').getWorldPosition(new THREE.Vector3());
    const rl = rayThrough(camera, lm2d[LM.lHip], aspect), rr = rayThrough(camera, lm2d[LM.rHip], aspect);
    const TL = rl.multiplyScalar(-L.z / -rl.z), TR = rr.multiplyScalar(-Rp.z / -rr.z);
    const cur = L.clone().sub(Rp).normalize(), want = TL.sub(TR).normalize();
    if (cur.angleTo(want) < 1.2) {
      aimNode(hipsNode, cur, want);
      refresh(vrm);
      if (opts.anchor) placeModel(vrm, opts.anchor);
    }
  }

  const chains = [];
  if (opts.legs !== false) chains.push(...CHAINS.legs);
  if (opts.arms) chains.push(...CHAINS.arms);
  for (const [bone, child, ids, reach] of chains) {
    if (!visible(ids)) continue;
    const bNode = h.getRawBoneNode(bone), cNode = h.getRawBoneNode(child);
    const nNode = h.getNormalizedBoneNode(bone);
    if (!bNode || !cNode || !nNode) continue;
    const P = bNode.getWorldPosition(new THREE.Vector3());
    const C = cNode.getWorldPosition(new THREE.Vector3());
    const L = P.distanceTo(C) * reach;
    if (L < 1e-4) continue;
    const D = rayThrough(camera, target2d(ids), aspect);
    // |t*D - P|^2 = L^2  ->  t^2 - 2t(D.P) + |P|^2 - L^2 = 0
    const b = D.dot(P);
    const disc = b * b - (P.lengthSq() - L * L);
    let T;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = b - sq, t2 = b + sq;
      // reach point C' = P + (C-P)*reach is the 3D estimate of the target
      const est = P.clone().add(C.clone().sub(P).multiplyScalar(reach));
      const p1 = D.clone().multiplyScalar(t1), p2 = D.clone().multiplyScalar(t2);
      T = (t1 > 0 && p1.distanceTo(est) <= p2.distanceTo(est)) || t2 <= 0 ? p1 : p2;
    } else {
      T = D.clone().multiplyScalar(Math.max(0.01, b)); // closest reachable direction
    }
    const cur = C.clone().sub(P).normalize();
    const want = T.sub(P).normalize();
    if (cur.angleTo(want) < 1e-4) continue;
    aimNode(nNode, cur, want);
    refresh(vrm);
  }
}

/**
 * Solves where the model has to sit (camera space) so its hips land on the
 * character's on-screen hips at the matching apparent size.
 * @returns {{ anchor: THREE.Vector3, scaleRatio: number }}
 */
export function solvePlacement(rig, lm2d, w, camera, aspect) {
  const segs = [
    [LM.lShoulder, LM.rShoulder], [LM.lHip, LM.rHip], [LM.lShoulder, LM.lHip], [LM.rShoulder, LM.rHip],
    [LM.lHip, LM.lKnee], [LM.rHip, LM.rKnee], [LM.lKnee, LM.lAnkle], [LM.rKnee, LM.rAnkle],
  ];
  let len2d = 0, lenW = 0;
  for (const [a, b] of segs) {
    const wa = w[a], wb = w[b];
    const conf = Math.min(lm2d[a].visibility ?? 1, lm2d[b].visibility ?? 1);
    if (conf < 0.4) continue;
    len2d += Math.hypot((lm2d[a].x - lm2d[b].x) * aspect, lm2d[a].y - lm2d[b].y) * conf;
    lenW += Math.hypot(wa.x - wb.x, wa.y - wb.y) * conf;
  }
  if (lenW < 1e-4 || len2d < 1e-4) return null;
  const s = len2d / lenW; // image heights per human metre (weak perspective)
  const dist3 = (a, b) => Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y, w[a].z - w[b].z);
  const humanThigh = (dist3(LM.lHip, LM.lKnee) + dist3(LM.rHip, LM.rKnee)) / 2;
  const humanShin = (dist3(LM.lKnee, LM.lAnkle) + dist3(LM.rKnee, LM.rAnkle)) / 2;
  const sh = { x: (w[LM.lShoulder].x + w[LM.rShoulder].x) / 2, y: (w[LM.lShoulder].y + w[LM.rShoulder].y) / 2, z: (w[LM.lShoulder].z + w[LM.rShoulder].z) / 2 };
  const hp = { x: (w[LM.lHip].x + w[LM.rHip].x) / 2, y: (w[LM.lHip].y + w[LM.rHip].y) / 2, z: (w[LM.lHip].z + w[LM.rHip].z) / 2 };
  const humanTorso = Math.hypot(sh.x - hp.x, sh.y - hp.y, sh.z - hp.z);
  const human = humanThigh + humanShin + humanTorso;
  const model = rig.len.thigh + rig.len.shin + rig.len.torso;
  const k = model / Math.max(0.2, human);
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const f = 0.5 / tanHalf;
  const depth = (f * k) / s;
  const hx = (lm2d[LM.lHip].x + lm2d[LM.rHip].x) / 2;
  const hy = (lm2d[LM.lHip].y + lm2d[LM.rHip].y) / 2;
  const ndcX = hx * 2 - 1, ndcY = 1 - hy * 2;
  const anchor = new THREE.Vector3(ndcX * depth * tanHalf * aspect, ndcY * depth * tanHalf, -depth);
  return { anchor, scaleRatio: k };
}

/** Moves the model so that its hip-joint midpoint lands on `anchor`. */
export function placeModel(vrm, anchor) {
  const h = vrm.humanoid;
  vrm.scene.updateMatrixWorld(true);
  const l = h.getRawBoneNode('leftUpperLeg').getWorldPosition(_v);
  const r = h.getRawBoneNode('rightUpperLeg').getWorldPosition(_v2);
  const mid = l.add(r).multiplyScalar(0.5);
  vrm.scene.position.add(anchor.clone().sub(mid));
  vrm.scene.updateMatrixWorld(true);
}
