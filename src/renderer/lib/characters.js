// Persistent "leg saves": remembers each character (by appearance key) and the
// legs that were generated for it, so they stay consistent across appearances.

import { appearanceDistance } from './features.js';
import { toHex } from './color.js';

const MATCH_THRESHOLD = 13;

function quant(c) { return toHex(c.map((v) => Math.round(v / 24) * 24)); }

export function appearanceKey(a) {
  const parts = [
    `skin${quant(a.skin)}`, `hair${quant(a.hair)}`, a.hairLength,
    `top${quant(a.top)}`, `bottom${quant(a.bottom)}`, a.legwear.category,
  ];
  const s = parts.join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return { key: s, hash: (h >>> 0).toString(16).padStart(8, '0') };
}

export class CharacterStore {
  constructor(api) {
    this.api = api;
    this.data = { version: 1, characters: [] };
    this.saveTimer = null;
    this.listeners = new Set();
  }

  async load() {
    try {
      const d = await this.api.getCharacters();
      if (d && Array.isArray(d.characters)) this.data = d;
    } catch { /* first run */ }
  }

  onChange(fn) { this.listeners.add(fn); }
  changed() {
    for (const fn of this.listeners) fn();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.api.setCharacters(this.data), 500);
  }

  get list() { return this.data.characters; }

  /** Finds the stored character closest to `appearance`, or null. */
  match(appearance) {
    let best = null, bestD = Infinity;
    for (const c of this.data.characters) {
      const d = appearanceDistance(appearance, c.appearance);
      if (d < bestD) { bestD = d; best = c; }
    }
    return bestD < MATCH_THRESHOLD ? best : null;
  }

  create(appearance, generated) {
    const { key, hash } = appearanceKey(appearance);
    const now = Date.now();
    const c = {
      id: `${hash}-${now.toString(36)}`,
      key, hash,
      appearance,
      ...generated,
      loadCount: 0,
      firstSeen: now,
      lastSeen: now,
    };
    this.data.characters.push(c);
    this.changed();
    return c;
  }

  markLoaded(c) {
    c.loadCount = (c.loadCount || 0) + 1;
    c.lastSeen = Date.now();
    this.changed();
  }

  remove(ids) {
    const set = new Set(ids);
    this.data.characters = this.data.characters.filter((c) => !set.has(c.id));
    this.changed();
  }

  /** Removes every save loaded fewer than `minLoads` times. Returns count. */
  cleanup(minLoads) {
    const before = this.data.characters.length;
    this.data.characters = this.data.characters.filter((c) => (c.loadCount || 0) >= minLoads);
    this.changed();
    return before - this.data.characters.length;
  }
}
