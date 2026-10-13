// Multi-character tracking.
//
// For every frame:
//   - person boxes from the detector are matched to existing tracks (IoU),
//     unmatched boxes start new tracks;
//   - each track runs its own pose landmarker on a crop that follows it;
//   - landmarks are cleaned (left/right label flips undone, implausible limb
//     lengths rejected) and One-Euro filtered;
//   - on a scene cut the filters are reset so poses snap instead of sliding,
//     and tracks that are no longer where they were are dropped.

import { LandmarkFilter } from './filters.js';
import { CROP_SIZE } from './detector.js';
import { LM } from './features.js';

let nextTrackId = 1;

const GROUPS = {
  torso: [[11, 12], [23, 24]],
  arms: [[13, 14], [15, 16], [17, 18], [19, 20], [21, 22]],
  legs: [[25, 26], [27, 28], [29, 30], [31, 32]],
  face: [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10]],
};
const SEGMENTS = [
  // [from, to, distal landmarks to distrust when the length is implausible]
  [LM.lHip, LM.lKnee, [LM.lKnee, LM.lAnkle, LM.lHeel, LM.lFoot]],
  [LM.rHip, LM.rKnee, [LM.rKnee, LM.rAnkle, LM.rHeel, LM.rFoot]],
  [LM.lKnee, LM.lAnkle, [LM.lAnkle, LM.lHeel, LM.lFoot]],
  [LM.rKnee, LM.rAnkle, [LM.rAnkle, LM.rHeel, LM.rFoot]],
  [LM.lShoulder, LM.lElbow, [LM.lElbow, LM.lWrist, LM.lPinky, LM.lIndex, LM.lThumb]],
  [LM.rShoulder, LM.rElbow, [LM.rElbow, LM.rWrist, LM.rPinky, LM.rIndex, LM.rThumb]],
  [LM.lElbow, LM.lWrist, [LM.lWrist, LM.lPinky, LM.lIndex, LM.lThumb]],
  [LM.rElbow, LM.rWrist, [LM.rWrist, LM.rPinky, LM.rIndex, LM.rThumb]],
];

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}

function containment(inner, outer) {
  const x1 = Math.max(inner.x, outer.x), y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.w, outer.x + outer.w), y2 = Math.min(inner.y + inner.h, outer.y + outer.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inner.w * inner.h > 0 ? inter / (inner.w * inner.h) : 0;
}

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function swapPairs(arr, pairs) {
  for (const [a, b] of pairs) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }
}

/** Undo sudden left/right label flips by comparing against the previous pose. */
export function fixLabelFlips(lm, lmW, prev, scale) {
  if (!prev) return;
  const flip = (pairs) => {
    let keep = 0, swap = 0;
    for (const [a, b] of pairs) {
      keep += d2(lm[a], prev[a]) + d2(lm[b], prev[b]);
      swap += d2(lm[b], prev[a]) + d2(lm[a], prev[b]);
    }
    return keep > scale * 0.08 * pairs.length && swap < keep * 0.5;
  };
  if (flip(GROUPS.torso)) {
    const all = Object.values(GROUPS).flat();
    swapPairs(lm, all); swapPairs(lmW, all);
    return;
  }
  for (const g of ['arms', 'legs', 'face']) {
    if (flip(GROUPS[g])) { swapPairs(lm, GROUPS[g]); swapPairs(lmW, GROUPS[g]); }
  }
}

/**
 * True when the pose changed too much between two frames to be real motion:
 * the body centre jumped, or most joints moved a large fraction of the body
 * size at once (e.g. a cut to a mirrored or different shot of the same place).
 */
export function poseJumped(lm, prev, scale) {
  const c = (arr) => [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip].reduce((acc, i) => ({ x: acc.x + arr[i].x / 4, y: acc.y + arr[i].y / 4 }), { x: 0, y: 0 });
  if (d2(c(lm), c(prev)) > scale * 0.45) return true;
  const moves = [];
  for (let i = 11; i < 33; i++) {
    if ((lm[i].visibility ?? 1) < 0.5 || (prev[i].visibility ?? 1) < 0.5) continue;
    moves.push(d2(lm[i], prev[i]));
  }
  if (moves.length < 6) return false;
  moves.sort((a, b) => a - b);
  return moves[Math.floor(moves.length * 0.6)] > scale * 0.15;
}

function boxFromLandmarks(lm) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const p of lm) {
    if ((p.visibility ?? 1) < 0.5) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    n++;
  }
  if (n < 6) return null;
  // the landmarks stop at the eyes/ears: extend for the top of the head
  const nose = lm[LM.nose];
  if ((nose.visibility ?? 1) > 0.5) {
    const shY = (lm[LM.lShoulder].y + lm[LM.rShoulder].y) / 2;
    minY = Math.min(minY, nose.y - Math.abs(shY - nose.y) * 0.9);
  }
  const w = maxX - minX, h = maxY - minY;
  return { x: minX - w * 0.1, y: minY - h * 0.05, w: w * 1.2, h: h * 1.1 };
}

export class Tracker {
  constructor() {
    this.tracks = [];
    this.crop = document.createElement('canvas');
    this.crop.width = this.crop.height = CROP_SIZE;
    this.cropCtx = this.crop.getContext('2d', { willReadFrequently: true });
  }

  /**
   * @param {object} p
   *   video        { el, videoWidth, videoHeight }
   *   dets         person boxes (frame-normalised), or null when the person
   *                detector did not run this frame
   *   cut          scene cut detected this frame
   *   pool         PosePool
   *   dt           seconds since last frame
   *   smoothing    0..1
   *   wantPixels   (track) => bool, whether crop pixels/masks are needed
   *   maxTracks
   * @returns {Array} tracks with a pose this frame (or held from the last frames)
   */
  step({ video, dets, cut, pool, dt, smoothing, wantPixels, maxTracks }) {
    const W = video.videoWidth, H = video.videoHeight;
    const minCutoff = 0.3 + 3.0 * (1 - smoothing);

    const haveDets = dets !== null;
    if (!haveDets) dets = [];
    // 1) associate person boxes with tracks
    if (haveDets) for (const t of this.tracks) t.detBox = null;
    const pairs = [];
    dets.forEach((d, di) => this.tracks.forEach((t) => {
      const v = Math.max(iou(d, t.box), containment(t.box, d) * 0.8);
      if (v > 0.25) pairs.push({ d, di, t, v });
    }));
    pairs.sort((a, b) => b.v - a.v);
    const usedDet = new Set();
    for (const { d, di, t, v } of pairs) {
      if (usedDet.has(di) || t.detBox) continue;
      if (cut && v < 0.4) continue;
      usedDet.add(di); t.detBox = d;
    }

    // 2) scene cut: drop tracks that are no longer backed by a detection
    if (cut) {
      for (const t of this.tracks) {
        if (!t.detBox) t.dead = true;
        else { resetMotion(t); t.box = { ...t.detBox }; }
      }
      this.reap(pool);
    }

    // 3) new tracks for unclaimed boxes (largest first)
    const fresh = dets.filter((d, i) => !usedDet.has(i)).sort((a, b) => b.w * b.h - a.w * a.h);
    for (const d of fresh) {
      if (this.tracks.length >= maxTracks) break;
      if (this.tracks.some((t) => iou(d, t.box) > 0.3 || containment(d, t.box) > 0.7)) continue;
      const t = this.newTrack(d);
      t.slot = pool.acquire(t.id);
      if (t.slot < 0) break;
      this.tracks.push(t);
    }

    // 4) pose per track on its own crop
    const active = [];
    for (const t of this.tracks) {
      t.age++;
      const box = t.poseFrames > 0 && t.missing === 0 ? t.box : (t.detBox || t.box);
      const side = Math.max(96, Math.max(box.w * W, box.h * H) * 1.25);
      const x0 = (box.x + box.w / 2) * W - side / 2, y0 = (box.y + box.h / 2) * H - side / 2;
      const ctx = this.cropCtx;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
      ctx.drawImage(video.el, x0, y0, side, side, 0, 0, CROP_SIZE, CROP_SIZE);
      const want = wantPixels(t);
      const pose = pool.detect(t.slot, this.crop, want);

      if (pose) {
        const toFrame = (p) => ({ x: (x0 + p.x * side) / W, y: (y0 + p.y * side) / H, z: p.z, visibility: p.visibility ?? 1 });
        const lm = pose.lm.map(toFrame);
        const lmW = pose.lmW.map((p, i) => ({ x: p.x, y: p.y, z: p.z, visibility: lm[i].visibility }));
        const scale = Math.max(box.w, box.h);
        // A sudden jump of the whole pose (a cut the cut detector missed, or a
        // re-acquired character) snaps instead of sliding through the filter.
        const jumped = !cut && t.lm2d && poseJumped(lm, t.lm2d, scale);
        if (jumped) resetMotion(t);
        fixLabelFlips(lm, lmW, cut || jumped ? null : t.lm2d, scale);
        this.rejectImplausible(t, lm, lmW);
        // landmarks outside the frame are guesses
        for (const p of lm) if (p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02) p.visibility = Math.min(p.visibility, 0.3);
        for (let i = 0; i < lmW.length; i++) lmW[i].visibility = lm[i].visibility;

        if (t.lm2d && poseJumped(lm, t.lm2d, Math.max(box.w, box.h))) resetMotion(t);
        t.filter2d.configure(minCutoff, 4);
        t.filterW.configure(minCutoff, 0.8);
        t.lm2d = t.filter2d.apply(lm, dt);
        t.lmW = t.filterW.apply(lmW, dt);
        t.missing = 0;
        t.poseFrames++;
        // crop data for appearance / lighting sampling (crop coordinates)
        t.cropLm = pose.lm;
        t.cropMask = pose.mask;
        t.cropImage = want ? ctx.getImageData(0, 0, CROP_SIZE, CROP_SIZE) : null;
        const lb = boxFromLandmarks(lm);
        if (lb) {
          const nb = t.detBox ? blendBox(lb, t.detBox, 0.3) : lb;
          t.box = blendBox(t.box, nb, cut ? 1 : 0.5);
        } else if (t.detBox) t.box = blendBox(t.box, t.detBox, 0.5);
      } else {
        t.missing++;
        t.cropImage = null;
        if (t.detBox) t.box = blendBox(t.box, t.detBox, 0.6);
      }
      if (haveDets) { if (t.detBox) t.noDet = 0; else t.noDet++; }

      // die when neither the detector nor the pose model sees it any more
      if ((t.missing > 8 && t.noDet > 2) || t.missing > 45) t.dead = true;
      // hold the last pose for a few frames so brief misses don't flicker
      if (!t.dead && t.lm2d && t.missing <= 4 && t.poseFrames >= 2) active.push(t);
    }
    this.reap(pool);
    return active;
  }

  rejectImplausible(t, lm, lmW) {
    SEGMENTS.forEach(([a, b, distal], i) => {
      if ((lm[a].visibility ?? 1) < 0.5 || (lm[b].visibility ?? 1) < 0.5) return;
      const len = d3(lmW[a], lmW[b]);
      const ref = t.segLen[i];
      // a short burst of odd lengths is a bad estimate; a lasting change is real
      // (e.g. a new shot), so re-baseline after a few frames
      if (ref && t.segN[i] > 8 && Math.abs(len - ref) / ref > 0.4 && t.segReject[i] < 5) {
        t.segReject[i]++;
        for (const k of distal) lm[k].visibility = Math.min(lm[k].visibility, 0.15);
        return;
      }
      if (t.segReject[i] >= 5) { t.segLen[i] = len; t.segN[i] = 1; }
      t.segReject[i] = 0;
      t.segLen[i] = ref && t.segN[i] > 1 ? ref + (len - ref) * 0.1 : len;
      t.segN[i]++;
    });
  }

  newTrack(box) {
    return {
      id: nextTrackId++, slot: -1, box: { ...box }, detBox: box,
      lm2d: null, lmW: null, cropLm: null, cropMask: null, cropImage: null,
      filter2d: new LandmarkFilter(33, 1, 4), filterW: new LandmarkFilter(33, 1, 0.8),
      segLen: new Array(SEGMENTS.length).fill(0), segN: new Array(SEGMENTS.length).fill(0),
      segReject: new Array(SEGMENTS.length).fill(0),
      age: 0, poseFrames: 0, missing: 0, noDet: 0, dead: false,
      samples: [], propSamples: [], character: null, lighting: null,
    };
  }

  reap(pool) {
    this.dropped = (this.dropped || []).concat(this.tracks.filter((t) => t.dead));
    for (const t of this.tracks) if (t.dead) pool.release(t.slot);
    this.tracks = this.tracks.filter((t) => !t.dead);
  }

  takeDropped() { const d = this.dropped || []; this.dropped = []; return d; }

  reset(pool) { for (const t of this.tracks) t.dead = true; this.reap(pool); }
}

/** Forget motion history so the next pose is taken as-is (cuts, jumps). */
function resetMotion(t) {
  t.filter2d.reset();
  t.filterW.reset();
  t.resetPlacement = true;
  t.segN.fill(0);
  t.segReject.fill(0);
}

function blendBox(a, b, k) {
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
}
