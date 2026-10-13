// Appearance, proportion and lighting analysis of a detected character.
// Works on a downscaled RGBA frame plus the pose landmarks (and the optional
// person segmentation mask) produced by the pose detector.

import { rgbToLab, deltaE, medianColor, luminance, meanColor } from './color.js';

export const LM = {
  nose: 0, lEyeIn: 1, lEye: 2, lEyeOut: 3, rEyeIn: 4, rEye: 5, rEyeOut: 6, lEar: 7, rEar: 8,
  mouthL: 9, mouthR: 10, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lThumb: 21, rThumb: 22, lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
};

// Leg parameter l: 0 = hip joint, 0.5 = knee, 1 = ankle.
export const LEG_SAMPLES = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];

const SKIN_DELTA = 16;

// Colour distance that tolerates shading differences (lightness weighted down).
function shadeDistance(a, b) {
  const dl = (a[0] - b[0]) * 0.4, da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

export class FrameSampler {
  /**
   * @param {ImageData} image analysis frame
   * @param {Float32Array|null} mask person mask for one pose, same size as image (0..1)
   */
  constructor(image, mask) {
    this.img = image;
    this.w = image.width;
    this.h = image.height;
    this.mask = mask && mask.length === this.w * this.h ? mask : null;
  }

  /**
   * Drops the mask if it does not actually cover the character's torso (some
   * GPU drivers hand back empty masks); sampling then falls back to the
   * landmark geometry alone.
   */
  validateMask(lm) {
    if (!this.mask) return;
    let hit = 0, n = 0;
    for (const [a, b] of [[LM.lShoulder, LM.rHip], [LM.rShoulder, LM.lHip]]) {
      for (const t of [0.3, 0.5, 0.7]) {
        n++;
        if (this.inMask((lm[a].x + (lm[b].x - lm[a].x) * t) * this.w, (lm[a].y + (lm[b].y - lm[a].y) * t) * this.h)) hit++;
      }
    }
    if (hit < n / 2) this.mask = null;
  }

  inMask(px, py) {
    if (!this.mask) return true;
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.mask[y * this.w + x] > 0.5;
  }

  pixel(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const i = (y * this.w + x) * 4;
    const d = this.img.data;
    return [d[i], d[i + 1], d[i + 2]];
  }

  // Median colour of a square patch around a normalised point. Returns
  // { color, std } or null when the patch is off-screen / outside the person.
  patch(nx, ny, radiusPx = 3, requireMask = true) {
    const cx = nx * this.w, cy = ny * this.h;
    const cols = [];
    for (let dy = -radiusPx; dy <= radiusPx; dy++) {
      for (let dx = -radiusPx; dx <= radiusPx; dx++) {
        const x = cx + dx, y = cy + dy;
        if (requireMask && !this.inMask(x, y)) continue;
        const p = this.pixel(x, y);
        if (p) cols.push(p);
      }
    }
    if (cols.length < 4) return null;
    const color = medianColor(cols);
    let s = 0;
    const lc = luminance(color) * 255;
    for (const c of cols) { const d = luminance(c) * 255 - lc; s += d * d; }
    return { color, std: Math.sqrt(s / cols.length) };
  }
}

const lerp2 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });
const vis = (p) => (p.visibility === undefined ? 1 : p.visibility);

export function legPoint(lm, side, l) {
  const hip = lm[side === 'L' ? LM.lHip : LM.rHip];
  const knee = lm[side === 'L' ? LM.lKnee : LM.rKnee];
  const ankle = lm[side === 'L' ? LM.lAnkle : LM.rAnkle];
  return l <= 0.5 ? lerp2(hip, knee, l / 0.5) : lerp2(knee, ankle, (l - 0.5) / 0.5);
}

function legVisible(lm, side, l) {
  const ids = side === 'L' ? [LM.lHip, LM.lKnee, LM.lAnkle] : [LM.rHip, LM.rKnee, LM.rAnkle];
  const need = l <= 0.5 ? [ids[0], ids[1]] : [ids[1], ids[2]];
  return need.every((i) => vis(lm[i]) > 0.5 && lm[i].x > 0 && lm[i].x < 1 && lm[i].y > 0 && lm[i].y < 1);
}

/**
 * Extracts identity / appearance features for one character.
 * @returns {object|null}
 */
export function extractAppearance(sampler, lm) {
  const patchR = Math.max(2, Math.round(sampler.w / 320));
  // --- skin: cheeks (between eye and mouth corner) and forehead-ish nose bridge
  const skinSamples = [];
  for (const [e, m] of [[LM.lEye, LM.mouthL], [LM.rEye, LM.mouthR]]) {
    const p = lerp2(lm[e], lm[m], 0.55);
    const s = sampler.patch(p.x, p.y, patchR);
    if (s) skinSamples.push(s.color);
  }
  const faceVisible = vis(lm[LM.nose]) > 0.6 && vis(lm[LM.mouthL]) > 0.5 && vis(lm[LM.mouthR]) > 0.5;
  if (!faceVisible) skinSamples.length = 0;
  const nose = faceVisible ? sampler.patch(lm[LM.nose].x, lm[LM.nose].y, patchR) : null;
  if (nose) skinSamples.push(nose.color);
  if (!skinSamples.length) {
    // seen from behind / face hidden: use the backs of the hands instead
    for (const [w, i, p] of [[LM.lWrist, LM.lIndex, LM.lPinky], [LM.rWrist, LM.rIndex, LM.rPinky]]) {
      if (vis(lm[w]) < 0.6 || vis(lm[i]) < 0.5) continue;
      const c = lerp2(lm[w], lerp2(lm[i], lm[p], 0.5), 0.5);
      const s = sampler.patch(c.x, c.y, Math.max(1, patchR - 1));
      if (s) skinSamples.push(s.color);
    }
  }
  const skin = medianColor(skinSamples);
  if (!skin) return null;
  const skinLab = rgbToLab(skin);

  // --- hair: above the eyes, along the face's up direction.
  const eyeMid = mid(lm[LM.lEye], lm[LM.rEye]);
  const mouthMid = mid(lm[LM.mouthL], lm[LM.mouthR]);
  const up = { x: eyeMid.x - mouthMid.x, y: eyeMid.y - mouthMid.y };
  // Background references (beside and far above the head) so that, when no
  // person mask is available, sky/walls are not mistaken for hair.
  const shoulderW = dist2(lm[LM.lShoulder], lm[LM.rShoulder]);
  const bgLabs = [];
  for (const p of [
    { x: eyeMid.x - shoulderW * 1.3, y: eyeMid.y }, { x: eyeMid.x + shoulderW * 1.3, y: eyeMid.y },
    { x: eyeMid.x + up.x * 5, y: eyeMid.y + up.y * 5 },
  ]) {
    const b = sampler.patch(p.x, p.y, patchR, false);
    if (b) bgLabs.push(rgbToLab(b.color));
  }
  const isBackground = (lab) => !sampler.mask && bgLabs.some((b) => deltaE(lab, b) < 14);
  const hairSamples = [];
  for (const k of [1.6, 2.0, 2.4, 2.8]) {
    const p = { x: eyeMid.x + up.x * k, y: eyeMid.y + up.y * k };
    const s = sampler.patch(p.x, p.y, patchR);
    if (!s) continue;
    const lab = rgbToLab(s.color);
    if (deltaE(lab, skinLab) > SKIN_DELTA && !isBackground(lab)) hairSamples.push(s.color);
  }
  const hair = medianColor(hairSamples) || [40, 30, 25];
  const hairLab = rgbToLab(hair);

  // --- hair length: is there hair-coloured mass beside the neck / on the shoulders?
  const earToShoulder = dist2(lm[LM.lEar], lm[LM.lShoulder]);
  let hairBelow = 0, hairChecks = 0;
  for (const [ear, sh] of [[LM.lEar, LM.lShoulder], [LM.rEar, LM.rShoulder]]) {
    for (const t of [0.5, 0.9, 1.3]) {
      const p = lerp2(lm[ear], lm[sh], t * 0.5);
      p.y += earToShoulder * (t - 0.4) * 0.6;
      const s = sampler.patch(p.x, p.y, patchR);
      hairChecks++;
      if (s && deltaE(rgbToLab(s.color), hairLab) < 14) hairBelow += t;
    }
  }
  const hairLength = hairChecks ? (hairBelow < 0.6 ? 'short' : hairBelow < 2.5 ? 'medium' : 'long') : 'short';

  // --- top: torso grid
  const topSamples = [];
  const shL = lm[LM.lShoulder], shR = lm[LM.rShoulder], hipL = lm[LM.lHip], hipR = lm[LM.rHip];
  for (const u of [0.3, 0.5, 0.7]) {
    for (const v of [0.25, 0.5, 0.7]) {
      const a = lerp2(shL, shR, u), b = lerp2(hipL, hipR, u);
      const p = lerp2(a, b, v);
      const s = sampler.patch(p.x, p.y, patchR);
      if (s) topSamples.push(s.color);
    }
  }
  const top = medianColor(topSamples) || [128, 128, 128];

  // --- legs: coverage profile along both legs. Lighting on the legs often
  // differs from the face, so every sample is compared both to the skin tone
  // and to the fabric at the top of the thigh (almost always clothed), using a
  // lightness-tolerant colour distance.
  const legSamples = [];
  for (const l of LEG_SAMPLES) {
    const row = [];
    for (const side of ['L', 'R']) {
      if (!legVisible(lm, side, l)) continue;
      const p = legPoint(lm, side, l);
      const s = sampler.patch(p.x, p.y, patchR);
      if (s) row.push(s);
    }
    legSamples.push(row);
  }
  const fabricRefCol = medianColor(legSamples[0].map((s) => s.color));
  const fabricRef = fabricRefCol ? rgbToLab(fabricRefCol) : null;
  const topIsSkin = !fabricRef || shadeDistance(fabricRef, skinLab) < 12;
  const coverage = [];
  const fabric = [];
  const lowerFabric = [];
  const stds = [];
  legSamples.forEach((row, i) => {
    const l = LEG_SAMPLES[i];
    let covered = 0;
    for (const s of row) {
      const lab = rgbToLab(s.color);
      const dSkin = shadeDistance(lab, skinLab);
      const isSkin = topIsSkin ? dSkin < 18 : dSkin < 32 && dSkin < shadeDistance(lab, fabricRef);
      if (!isSkin) {
        covered++;
        (l < 0.5 ? fabric : lowerFabric).push(s.color);
        stds.push(s.std);
      }
    }
    coverage.push(row.length ? covered / row.length : null);
  });
  const bottomColor = medianColor(fabric.length ? fabric : lowerFabric) || top;
  const bottomLab = rgbToLab(bottomColor);

  // Fabric between the thighs suggests a skirt / dress.
  let between = 0, betweenN = 0;
  for (const l of [0.2, 0.35]) {
    if (!legVisible(lm, 'L', l) || !legVisible(lm, 'R', l)) continue;
    const p = lerp2(legPoint(lm, 'L', l), legPoint(lm, 'R', l), 0.5);
    const gap = dist2(legPoint(lm, 'L', l), legPoint(lm, 'R', l));
    if (gap * sampler.w < patchR * 4) continue; // legs together, can't tell
    betweenN++;
    if (!sampler.inMask(p.x * sampler.w, p.y * sampler.h)) continue;
    const s = sampler.patch(p.x, p.y, patchR, false);
    if (s && deltaE(rgbToLab(s.color), bottomLab) < 18) between++;
  }
  const skirtLike = betweenN > 0 && between / betweenN >= 0.5;
  const texture = stds.length ? stds.reduce((a, b) => a + b, 0) / stds.length : 0;

  return {
    skin, hair, hairLength, top, bottom: bottomColor,
    socks: lowerFabric.length ? medianColor(lowerFabric) : null,
    legwear: classifyLegwear(coverage, skirtLike, texture, bottomColor),
  };
}

/**
 * Turns a coverage profile into a leg-wear description:
 *   { category, hem, socksTop, skirt, texture, denimLike }
 */
export function classifyLegwear(coverage, skirtLike, texture, bottomColor) {
  const c = coverage.map((v) => (v === null ? null : v >= 0.5));
  // hem: walk down from the hip while covered (unknown samples continue the run)
  let hem = 0;
  let topCovered = c[0] !== false;
  if (topCovered) {
    hem = 1.0;
    for (let i = 0; i < c.length; i++) {
      if (c[i] === false) { hem = i === 0 ? 0 : (LEG_SAMPLES[i - 1] + LEG_SAMPLES[i]) / 2; break; }
    }
  }
  // socks: walk up from the ankle while covered, only meaningful with a skin gap.
  let socksTop = null;
  if (hem < 0.95 && c[c.length - 1] === true) {
    let i = c.length - 1;
    while (i > 0 && c[i - 1] !== false) i--;
    const top = (LEG_SAMPLES[i] + (i > 0 ? LEG_SAMPLES[i - 1] : 0)) / 2;
    if (top > hem + 0.05) socksTop = top;
  }
  let category;
  if (!topCovered || hem < 0.08) category = 'none';
  else if (hem >= 0.95) category = skirtLike ? 'long-skirt' : 'pants';
  else if (hem >= 0.6) category = skirtLike ? 'midi-skirt' : 'capris';
  else if (hem >= 0.3) category = skirtLike ? 'skirt' : 'shorts';
  else category = skirtLike ? 'mini-skirt' : 'short-shorts';

  const lab = rgbToLab(bottomColor);
  const denimLike = lab[2] < -8 && lab[0] > 20 && lab[0] < 65 && texture > 3;
  return { category, hem, socksTop, skirt: skirtLike, texture, denimLike };
}

/** Body measurements from world landmarks (metres) + mask-based leg width. */
export function extractProportions(sampler, lm2d, lmW) {
  const thigh = (dist3(lmW[LM.lHip], lmW[LM.lKnee]) + dist3(lmW[LM.rHip], lmW[LM.rKnee])) / 2;
  const shin = (dist3(lmW[LM.lKnee], lmW[LM.lAnkle]) + dist3(lmW[LM.rKnee], lmW[LM.rAnkle])) / 2;
  const torso = dist3(mid(lmW[LM.lShoulder], lmW[LM.rShoulder]), mid(lmW[LM.lHip], lmW[LM.rHip]));
  const hipWidth = dist3(lmW[LM.lHip], lmW[LM.rHip]);
  let legWidth = null;
  if (sampler && sampler.mask) {
    const widths = [];
    for (const side of ['L', 'R']) {
      if (!legVisible(lm2d, side, 0.25)) continue;
      const hip = lm2d[side === 'L' ? LM.lHip : LM.rHip];
      const knee = lm2d[side === 'L' ? LM.lKnee : LM.rKnee];
      const c = legPoint(lm2d, side, 0.25);
      const dx = (knee.x - hip.x) * sampler.w, dy = (knee.y - hip.y) * sampler.h;
      const len = Math.hypot(dx, dy);
      if (len < 8) continue;
      const nx = -dy / len, ny = dx / len;
      const cx = c.x * sampler.w, cy = c.y * sampler.h;
      let a = 0, b = 0;
      while (a < len && sampler.inMask(cx + nx * a, cy + ny * a)) a++;
      while (b < len && sampler.inMask(cx - nx * b, cy - ny * b)) b++;
      if (a < len && b < len) widths.push((a + b) / len); // width relative to 2D thigh length
    }
    if (widths.length) legWidth = widths.reduce((x, y) => x + y, 0) / widths.length;
  }
  return { thigh, shin, torso, hipWidth, legWidth };
}

/**
 * Estimates the scene light falling on a character from the pixels inside its
 * silhouette (or bounding box when no mask is available).
 */
export function estimateLighting(sampler, lm2d, frameMean) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm2d) {
    if (vis(p) < 0.3) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const padX = (maxX - minX) * 0.15, padY = (maxY - minY) * 0.08;
  minX = Math.max(0, minX - padX); maxX = Math.min(1, maxX + padX);
  minY = Math.max(0, minY - padY); maxY = Math.min(1, maxY + padY);
  if (maxX - minX < 0.01 || maxY - minY < 0.01) return null;
  const pts = [];
  const steps = 40;
  for (let j = 0; j < steps * 2; j++) {
    for (let i = 0; i < steps; i++) {
      const nx = minX + (maxX - minX) * (i + 0.5) / steps;
      const ny = minY + (maxY - minY) * (j + 0.5) / (steps * 2);
      const px = nx * sampler.w, py = ny * sampler.h;
      if (!sampler.inMask(px, py)) continue;
      const c = sampler.pixel(px, py);
      if (c) pts.push({ u: (nx - minX) / (maxX - minX) - 0.5, v: (ny - minY) / (maxY - minY) - 0.5, c, l: luminance(c) });
    }
  }
  if (pts.length < 30) return null;
  pts.sort((a, b) => a.l - b.l);
  const n = pts.length;
  const bright = pts.slice(Math.floor(n * 0.85));
  const dark = pts.slice(0, Math.floor(n * 0.3));
  const meanL = pts.reduce((s, p) => s + p.l, 0) / n;
  // Direction: where on the body the bright pixels concentrate.
  let du = 0, dv = 0;
  for (const p of bright) { du += p.u; dv += p.v; }
  du /= bright.length; dv /= bright.length;
  const dir = [du * 4, -dv * 4 + 0.3, 1.0];
  const dl = Math.hypot(...dir);
  const norm = (c) => { const m = Math.max(1, ...c); return c.map((v) => v / m); };
  const keyCol = norm(meanColor(bright.map((p) => p.c)));
  const ambCol = norm(meanColor(dark.map((p) => p.c)));
  const brightL = bright.reduce((s, p) => s + p.l, 0) / bright.length;
  const darkL = dark.reduce((s, p) => s + p.l, 0) / dark.length;
  // Exposure: how bright the character is overall; contrast: how much of that
  // comes from a directional key light versus soft ambient light.
  const exposure = Math.min(1.25, Math.max(0.3, meanL * 1.7));
  const contrast = Math.min(0.85, Math.max(0.2, (brightL - darkL) * 1.6));
  return {
    dir: dir.map((v) => v / dl),
    color: keyCol,
    intensity: exposure * contrast * 1.15,
    ambientColor: ambCol,
    ambientIntensity: exposure * (1 - contrast),
    skyColor: frameMean ? norm(frameMean) : keyCol,
  };
}

/** Distance between two appearance records (lower = more similar). */
export function appearanceDistance(a, b) {
  const d = (x, y) => deltaE(rgbToLab(x), rgbToLab(y));
  let s = d(a.skin, b.skin) * 1.2 + d(a.hair, b.hair) * 1.0 + d(a.top, b.top) * 0.8 + d(a.bottom, b.bottom) * 0.8;
  if (a.hairLength !== b.hairLength) s += 12;
  if (a.legwear && b.legwear && a.legwear.category !== b.legwear.category) s += 15;
  return s / 3.8;
}

/** Averages several appearance samples of the same character. */
export function averageAppearance(samples) {
  const pick = (k) => medianColor(samples.map((s) => s[k]).filter(Boolean));
  const vote = (f) => {
    const counts = new Map();
    for (const s of samples) { const k = f(s); counts.set(k, (counts.get(k) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const category = vote((s) => s.legwear.category);
  const same = samples.filter((s) => s.legwear.category === category);
  const avg = (f) => { const v = same.map(f).filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const socksVotes = same.filter((s) => s.legwear.socksTop !== null).length;
  return {
    skin: pick('skin'), hair: pick('hair'), top: pick('top'), bottom: pick('bottom'),
    socks: pick('socks'),
    hairLength: vote((s) => s.hairLength),
    legwear: {
      category,
      hem: avg((s) => s.legwear.hem),
      socksTop: socksVotes > same.length / 2 ? avg((s) => s.legwear.socksTop) : null,
      skirt: same.filter((s) => s.legwear.skirt).length > same.length / 2,
      texture: avg((s) => s.legwear.texture) || 0,
      denimLike: same.filter((s) => s.legwear.denimLike).length > same.length / 2,
    },
  };
}
