// Library of leg-wear "bottoms" that can be baked onto the base model's body
// texture. Built-in items use procedural patterns; users can add their own
// items (JSON + optional tileable PNG) in the bottoms folder (see README).
//
// Coordinates used by every item:
//   l     leg parameter. -0.35 = waist, 0 = hip joint, 0.5 = knee, 1 = ankle, 1.15 = sole
//   u     position around the limb, 0..1
// Fields:
//   id, name, category, layer ('bottom' | 'legwear'),
//   top (l of the waistband), hem (l of the hem, or "auto" = use measured hem),
//   pattern (plain | denim | knit | ribbed | plaid | pleats | sheer | image),
//   image (PNG file name inside the bottoms folder, for pattern "image"),
//   scale (pattern tiling), opacity (0..1), waistband (bool), cuff (bool)

export const BUILTIN_BOTTOMS = [
  { id: 'jeans', name: 'Jeans', category: 'pants', layer: 'bottom', top: -0.3, hem: 1.02, pattern: 'denim', scale: 1, opacity: 1, waistband: true, cuff: true },
  { id: 'slacks', name: 'Slacks', category: 'pants', layer: 'bottom', top: -0.3, hem: 1.02, pattern: 'plain', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'leggings', name: 'Leggings', category: 'pants', layer: 'bottom', top: -0.32, hem: 1.0, pattern: 'knit', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'plaid-pants', name: 'Plaid pants', category: 'pants', layer: 'bottom', top: -0.3, hem: 1.02, pattern: 'plaid', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'tights', name: 'Sheer tights', category: 'pants', layer: 'bottom', top: -0.32, hem: 1.15, pattern: 'sheer', scale: 1, opacity: 0.65, waistband: false, cuff: false },
  { id: 'capris', name: 'Capris', category: 'capris', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'plain', scale: 1, opacity: 1, waistband: true, cuff: true },
  { id: 'denim-capris', name: 'Denim capris', category: 'capris', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'denim', scale: 1, opacity: 1, waistband: true, cuff: true },
  { id: 'shorts', name: 'Shorts', category: 'shorts', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'plain', scale: 1, opacity: 1, waistband: true, cuff: true },
  { id: 'denim-shorts', name: 'Denim shorts', category: 'shorts', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'denim', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'bike-shorts', name: 'Bike shorts', category: 'shorts', layer: 'bottom', top: -0.32, hem: 'auto', pattern: 'knit', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'short-shorts', name: 'Short shorts', category: 'short-shorts', layer: 'bottom', top: -0.28, hem: 'auto', pattern: 'plain', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'denim-short-shorts', name: 'Denim short shorts', category: 'short-shorts', layer: 'bottom', top: -0.28, hem: 'auto', pattern: 'denim', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'mini-skirt', name: 'Mini skirt', category: 'mini-skirt', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'pleats', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'plaid-mini-skirt', name: 'Plaid mini skirt', category: 'mini-skirt', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'plaid', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'skirt', name: 'Skirt', category: 'skirt', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'pleats', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'plaid-skirt', name: 'Plaid skirt', category: 'skirt', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'plaid', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'midi-skirt', name: 'Midi skirt', category: 'midi-skirt', layer: 'bottom', top: -0.3, hem: 'auto', pattern: 'plain', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'long-skirt', name: 'Long skirt', category: 'long-skirt', layer: 'bottom', top: -0.3, hem: 1.0, pattern: 'pleats', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'briefs', name: 'Briefs', category: 'none', layer: 'bottom', top: -0.22, hem: 0.04, pattern: 'plain', scale: 1, opacity: 1, waistband: true, cuff: false },
  { id: 'thigh-highs', name: 'Thigh-high socks', category: 'thigh-highs', layer: 'legwear', top: 'auto', hem: 1.15, pattern: 'knit', scale: 1, opacity: 1, waistband: false, cuff: true },
  { id: 'knee-socks', name: 'Knee socks', category: 'knee-socks', layer: 'legwear', top: 'auto', hem: 1.15, pattern: 'ribbed', scale: 1, opacity: 1, waistband: false, cuff: true },
  { id: 'socks', name: 'Socks', category: 'socks', layer: 'legwear', top: 'auto', hem: 1.15, pattern: 'ribbed', scale: 1, opacity: 1, waistband: false, cuff: true },
];

const CATEGORY_FALLBACK = {
  'pants': ['long-skirt', 'capris'],
  'long-skirt': ['pants', 'midi-skirt'],
  'capris': ['pants', 'midi-skirt'],
  'midi-skirt': ['skirt', 'capris'],
  'skirt': ['mini-skirt', 'shorts'],
  'shorts': ['short-shorts', 'skirt'],
  'mini-skirt': ['skirt', 'short-shorts'],
  'short-shorts': ['shorts', 'mini-skirt'],
  'none': ['short-shorts'],
};

function patternPreference(legwear) {
  if (legwear.denimLike) return ['denim'];
  if (legwear.texture > 14) return ['plaid', 'pleats', 'image'];
  if (legwear.texture > 7) return ['pleats', 'knit', 'denim', 'image'];
  return ['plain', 'knit', 'sheer'];
}

function pickFromCategory(items, category, prefs) {
  const c = items.filter((i) => i.category === category);
  if (!c.length) return null;
  for (const p of prefs) {
    const hit = c.find((i) => i.pattern === p);
    if (hit) return hit;
  }
  return c[0];
}

/** Chooses the bottom (and optional socks layer) for a leg-wear description. */
export function chooseBottoms(legwear, items) {
  const bottoms = items.filter((i) => i.layer !== 'legwear');
  const prefs = patternPreference(legwear);
  let bottom = pickFromCategory(bottoms, legwear.category, prefs);
  for (const alt of CATEGORY_FALLBACK[legwear.category] || []) {
    if (bottom) break;
    bottom = pickFromCategory(bottoms, alt, prefs);
  }
  if (!bottom) bottom = bottoms[0] || null;
  let legwearItem = null;
  if (legwear.socksTop !== null && legwear.socksTop !== undefined) {
    const cat = legwear.socksTop < 0.4 ? 'thigh-highs' : legwear.socksTop < 0.75 ? 'knee-socks' : 'socks';
    const socks = items.filter((i) => i.layer === 'legwear');
    legwearItem = socks.find((i) => i.category === cat) || socks[0] || null;
  }
  return { bottomId: bottom ? bottom.id : null, legwearId: legwearItem ? legwearItem.id : null };
}

// ---------------------------------------------------------------------------
// Procedural patterns. Each returns a brightness multiplier around 1.
// ---------------------------------------------------------------------------
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export const PATTERNS = {
  plain: () => 1,
  denim: (u, v) => {
    // diagonal twill + fine noise
    const t = Math.sin((u * 220 + v * 220) * Math.PI) * 0.06;
    const n = (hash(Math.floor(u * 400), Math.floor(v * 400)) - 0.5) * 0.16;
    return 1 + t + n;
  },
  knit: (u, v) => 1 + Math.sin(u * 160 * Math.PI) * 0.04 + (hash(Math.floor(u * 300), Math.floor(v * 300)) - 0.5) * 0.05,
  ribbed: (u) => 1 + Math.sin(u * 60 * Math.PI) * 0.12,
  pleats: (u) => {
    const f = (u * 14) % 1;
    return 0.86 + 0.24 * (f < 0.5 ? f * 2 : 2 - f * 2);
  },
  plaid: (u, v) => {
    const a = Math.floor(u * 10) % 2, b = Math.floor(v * 12) % 2;
    const thin = ((u * 40) % 1 < 0.08) || ((v * 48) % 1 < 0.08) ? 0.75 : 1;
    return (a && b ? 0.7 : a || b ? 0.85 : 1.05) * thin;
  },
  sheer: (u, v) => 1 + (hash(Math.floor(u * 500), Math.floor(v * 500)) - 0.5) * 0.04,
};

/** Loads a user PNG pattern into a sampler function (u,v)->multiplier. */
export async function loadImagePattern(fileName) {
  const img = new Image();
  img.src = `vibe://user/${encodeURIComponent(fileName)}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const w = c.width, h = c.height;
  // Average luminance so the image acts as a detail map around 1.0.
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
  const avg = Math.max(1, sum / (w * h));
  return (u, v) => {
    const x = ((Math.floor(u * w * 4) % w) + w) % w;
    const y = ((Math.floor(v * h * 4) % h) + h) % h;
    const i = (y * w + x) * 4;
    return (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / avg;
  };
}
