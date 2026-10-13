// Small colour helpers (sRGB 0-255 <-> CIE Lab) used by feature extraction.

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbToLab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function deltaE(labA, labB) {
  const dl = labA[0] - labB[0], da = labA[1] - labB[1], db = labA[2] - labB[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

export function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Component-wise median of a list of [r,g,b]; robust against stray pixels.
export function medianColor(colors) {
  if (!colors.length) return null;
  const ch = [0, 1, 2].map((i) => colors.map((c) => c[i]).sort((a, b) => a - b));
  const m = Math.floor(colors.length / 2);
  return [ch[0][m], ch[1][m], ch[2][m]];
}

export function meanColor(colors) {
  if (!colors.length) return null;
  const s = [0, 0, 0];
  for (const c of colors) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
  return s.map((v) => v / colors.length);
}

export function toHex([r, g, b]) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function fromHex(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
