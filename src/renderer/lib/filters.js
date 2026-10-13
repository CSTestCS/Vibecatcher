// One Euro filter (Casiez et al. 2012): strong smoothing while still, low lag
// while moving. Used for every landmark coordinate and the model placement.

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  constructor(minCutoff = 1, beta = 0, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }

  reset() { this.x = null; this.dx = 0; }

  filter(value, dt, cutoffScale = 1) {
    if (this.x === null || !Number.isFinite(this.x)) { this.x = value; this.dx = 0; return value; }
    dt = Math.max(1e-3, dt);
    const d = (value - this.x) / dt;
    this.dx += (d - this.dx) * alpha(this.dCutoff, dt);
    const cutoff = (this.minCutoff + this.beta * Math.abs(this.dx)) * cutoffScale;
    this.x += (value - this.x) * alpha(cutoff, dt);
    return this.x;
  }
}

/** Filters an array of {x,y,z,visibility} points. */
export class LandmarkFilter {
  constructor(count, minCutoff, beta) {
    this.f = Array.from({ length: count * 3 }, () => new OneEuro(minCutoff, beta));
    this.vis = new Float32Array(count);
    this.init = false;
  }

  configure(minCutoff, beta) {
    for (const f of this.f) { f.minCutoff = minCutoff; f.beta = beta; }
  }

  reset() { for (const f of this.f) f.reset(); this.init = false; }

  apply(points, dt) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const v = p.visibility ?? 1;
      // visibility is itself smoothed so a single bad frame doesn't drop a limb
      this.vis[i] = this.init ? this.vis[i] + (v - this.vis[i]) * 0.35 : v;
      // uncertain points are smoothed harder (they jitter most)
      const scale = 0.25 + 0.75 * Math.min(1, Math.max(0, v));
      out[i] = {
        x: this.f[i * 3].filter(p.x, dt, scale),
        y: this.f[i * 3 + 1].filter(p.y, dt, scale),
        z: this.f[i * 3 + 2].filter(p.z || 0, dt, scale),
        visibility: this.vis[i],
      };
    }
    this.init = true;
    return out;
  }
}
