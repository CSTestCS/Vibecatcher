// Multi-person tracking: keeps a stable identity for each detected character
// across frames and smooths its landmarks.

import { LM } from './features.js';

let nextTrackId = 1;

function center(lm) {
  return { x: (lm[LM.lHip].x + lm[LM.rHip].x + lm[LM.lShoulder].x + lm[LM.rShoulder].x) / 4,
    y: (lm[LM.lHip].y + lm[LM.rHip].y + lm[LM.lShoulder].y + lm[LM.rShoulder].y) / 4 };
}
function size(lm) {
  return Math.hypot(lm[LM.lShoulder].x - lm[LM.lHip].x, lm[LM.lShoulder].y - lm[LM.lHip].y) + 1e-3;
}

function smoothInto(prev, next, base, speedGain) {
  if (!prev) return next.map((p) => ({ ...p }));
  return next.map((p, i) => {
    const q = prev[i];
    const d = Math.hypot(p.x - q.x, p.y - q.y, (p.z || 0) - (q.z || 0));
    const a = Math.min(1, base + d * speedGain);
    return {
      x: q.x + (p.x - q.x) * a,
      y: q.y + (p.y - q.y) * a,
      z: (q.z || 0) + ((p.z || 0) - (q.z || 0)) * a,
      visibility: p.visibility,
    };
  });
}

export class Tracker {
  constructor() {
    this.tracks = [];
    this.frame = 0;
    this.maxMissing = 30; // ~1 s at 30 fps
  }

  /**
   * @param {Array} poses [{ lm2d, lmW }]
   * @param {number} smoothing 0..1
   * @returns {Array} active tracks (seen this frame)
   */
  update(poses, smoothing) {
    this.frame++;
    const base = 1 - 0.85 * smoothing;
    const unmatched = new Set(this.tracks);
    const pairs = [];
    poses.forEach((p, pi) => {
      const c = center(p.lm2d), s = size(p.lm2d);
      for (const t of this.tracks) {
        const tc = center(t.lm2d), ts = size(t.lm2d);
        const cost = Math.hypot(c.x - tc.x, c.y - tc.y) / Math.max(s, ts) + Math.abs(Math.log(s / ts));
        pairs.push({ pi, t, cost });
      }
    });
    pairs.sort((a, b) => a.cost - b.cost);
    const usedPose = new Set();
    for (const { pi, t, cost } of pairs) {
      if (cost > 1.5 || usedPose.has(pi) || !unmatched.has(t)) continue;
      usedPose.add(pi); unmatched.delete(t);
      const p = poses[pi];
      t.lm2d = smoothInto(t.lm2d, p.lm2d, base, 20);
      t.lmW = smoothInto(t.lmW, p.lmW, base, 6);
      t.poseIndex = pi;
      t.lastSeen = this.frame;
      t.age++;
    }
    poses.forEach((p, pi) => {
      if (usedPose.has(pi)) return;
      this.tracks.push({
        id: nextTrackId++, lm2d: p.lm2d.map((q) => ({ ...q })), lmW: p.lmW.map((q) => ({ ...q })),
        poseIndex: pi, lastSeen: this.frame, age: 1, firstSeen: this.frame,
        samples: [], propSamples: [], character: null, lighting: null,
      });
    });
    const dropped = this.tracks.filter((t) => this.frame - t.lastSeen > this.maxMissing);
    this.tracks = this.tracks.filter((t) => this.frame - t.lastSeen <= this.maxMissing);
    this.dropped = dropped;
    return this.tracks.filter((t) => t.lastSeen === this.frame);
  }
}
