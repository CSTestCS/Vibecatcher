// The bottoms library is a folder of PNG textures that are UV-mapped to the
// VRoid body texture. Each file is laid over the skin texture with the
// standard UV layout. Its file name says what kind of leg wear it is:
//
//   <category>[_<anything>].png
//
//   pants_jeans.png   shorts.png   mini-skirt_plaid.png   thigh-highs_white.png
//
// Bottom categories: pants, capris, shorts, short-shorts, skirt, mini-skirt,
// midi-skirt, long-skirt, none (e.g. briefs).
// Leg-wear categories (layered on top of the bottom): socks, knee-socks, thigh-highs.
//
// Add "_notint" anywhere in the name to keep the texture's own colours;
// otherwise it is recoloured with the average colour the character wears.

export const BOTTOM_CATEGORIES = ['pants', 'capris', 'shorts', 'short-shorts', 'skirt', 'mini-skirt', 'midi-skirt', 'long-skirt', 'none'];
export const LEGWEAR_CATEGORIES = ['socks', 'knee-socks', 'thigh-highs'];

const ALL = [...BOTTOM_CATEGORIES, ...LEGWEAR_CATEGORIES].sort((a, b) => b.length - a.length);

/** Parses a library file name, or returns null if it is not a valid bottom. */
export function parseBottomFile(file) {
  const m = /^(.*)\.png$/i.exec(file);
  if (!m) return null;
  const base = m[1].toLowerCase();
  const category = ALL.find((c) => base === c || base.startsWith(`${c}_`) || base.startsWith(`${c} `));
  if (!category) return null;
  const variant = base.slice(category.length).replace(/^[_ ]/, '');
  return {
    id: file,
    file,
    category,
    layer: LEGWEAR_CATEGORIES.includes(category) ? 'legwear' : 'bottom',
    name: variant ? `${category} (${variant.replace(/_?notint/, '').replace(/_/g, ' ').trim() || 'original'})` : category,
    variant,
    tint: !/notint/.test(base),
  };
}

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

const SOCKS_FALLBACK = {
  'thigh-highs': ['knee-socks', 'socks'],
  'knee-socks': ['socks', 'thigh-highs'],
  'socks': ['knee-socks', 'thigh-highs'],
};

// Words in the variant name that hint at the material seen on the character.
function variantHints(legwear) {
  if (legwear.denimLike) return ['denim', 'jean'];
  if (legwear.texture > 14) return ['plaid', 'check', 'print', 'pattern', 'pleat'];
  if (legwear.texture > 7) return ['pleat', 'knit', 'rib', 'denim'];
  return ['plain', 'solid', 'basic', 'knit'];
}

function pickFromCategory(items, category, hints) {
  const c = items.filter((i) => i.category === category);
  if (!c.length) return null;
  for (const h of hints) {
    const hit = c.find((i) => i.variant.includes(h));
    if (hit) return hit;
  }
  return c[0];
}

function pick(items, category, fallbacks, hints) {
  for (const cat of [category, ...(fallbacks[category] || [])]) {
    const hit = pickFromCategory(items, cat, hints);
    if (hit) return hit;
  }
  return null;
}

/** Chooses the bottom texture (and optional socks texture) for a leg-wear description. */
export function chooseBottoms(legwear, items) {
  const hints = variantHints(legwear);
  const bottom = pick(items.filter((i) => i.layer === 'bottom'), legwear.category, CATEGORY_FALLBACK, hints);
  let socks = null;
  if (legwear.socksTop !== null && legwear.socksTop !== undefined) {
    const cat = legwear.socksTop < 0.4 ? 'thigh-highs' : legwear.socksTop < 0.75 ? 'knee-socks' : 'socks';
    socks = pick(items.filter((i) => i.layer === 'legwear'), cat, SOCKS_FALLBACK, hints);
  }
  return { bottomId: bottom ? bottom.id : null, legwearId: socks ? socks.id : null };
}

/** Loads a library texture's pixels. */
export async function loadBottomImage(file) {
  const img = new Image();
  img.src = `vibe://user/${encodeURIComponent(file)}`;
  await img.decode();
  return img;
}
