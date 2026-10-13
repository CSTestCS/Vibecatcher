// Detects hard camera cuts / big camera jumps by comparing tiny greyscale
// thumbnails and luminance histograms of consecutive frames.

const TW = 64, TH = 36;

export class SceneCutDetector {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = TW; this.canvas.height = TH;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.prevHist = null;
    this.lastCut = -1e9;
  }

  /** @returns {boolean} true when the frame differs drastically from the previous one */
  check(source, frameIndex, sensitivity = 1) {
    this.ctx.drawImage(source, 0, 0, TW, TH);
    const d = this.ctx.getImageData(0, 0, TW, TH).data;
    const g = new Float32Array(TW * TH);
    const hist = new Float32Array(16);
    for (let i = 0; i < g.length; i++) {
      const v = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
      g[i] = v;
      hist[Math.min(15, v >> 4)]++;
    }
    for (let i = 0; i < 16; i++) hist[i] /= g.length;
    let cut = false;
    if (this.prev) {
      let mad = 0;
      for (let i = 0; i < g.length; i++) mad += Math.abs(g[i] - this.prev[i]);
      mad /= g.length;
      let hd = 0;
      for (let i = 0; i < 16; i++) hd += Math.abs(hist[i] - this.prevHist[i]);
      // a cut changes both the layout (mad) and the tonal distribution (hist)
      cut = (mad > 38 / sensitivity && hd > 0.35 / sensitivity) || mad > 60 / sensitivity || hd > 0.8 / sensitivity;
      if (cut && frameIndex - this.lastCut < 3) cut = false; // flashes / fades
      if (cut) this.lastCut = frameIndex;
    }
    this.prev = g;
    this.prevHist = hist;
    return cut;
  }
}
