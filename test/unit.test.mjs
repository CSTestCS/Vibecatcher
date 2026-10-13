import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnimationFbx } from '../src/renderer/lib/fbx.js';
import { classifyLegwear, appearanceDistance } from '../src/renderer/lib/features.js';
import { BUILTIN_BOTTOMS, chooseBottoms } from '../src/renderer/lib/bottoms.js';
import { appearanceKey } from '../src/renderer/lib/characters.js';

// Walks the binary FBX node tree and checks every record's offsets.
function parseFbx(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  assert.equal(dec.decode(bytes.slice(0, 20)), 'Kaydara FBX Binary  ');
  assert.equal(dv.getUint32(23, true), 7400);
  const sizes = { f: 4, d: 8, l: 8, i: 4, b: 1 };
  function prop(o) {
    const t = String.fromCharCode(bytes[o++]);
    if (t === 'C') return o + 1;
    if (t === 'Y') return o + 2;
    if (t === 'I' || t === 'F') return o + 4;
    if (t === 'D' || t === 'L') return o + 8;
    if (t === 'S' || t === 'R') return o + 4 + dv.getUint32(o, true);
    if (sizes[t]) {
      const n = dv.getUint32(o, true), len = dv.getUint32(o + 8, true);
      assert.equal(len, n * sizes[t]);
      return o + 12 + len;
    }
    throw new Error(`bad property type ${t}`);
  }
  function node(o) {
    const end = dv.getUint32(o, true);
    if (end === 0) return [null, o + 13];
    const np = dv.getUint32(o + 4, true), pl = dv.getUint32(o + 8, true), nl = bytes[o + 12];
    const name = dec.decode(bytes.slice(o + 13, o + 13 + nl));
    let p = o + 13 + nl;
    const ps = p;
    for (let i = 0; i < np; i++) p = prop(p);
    assert.equal(p - ps, pl, `${name} property length`);
    const kids = [];
    while (p < end) {
      const [k, q] = node(p);
      p = q;
      if (!k) break;
      kids.push(k);
    }
    assert.equal(p, end, `${name} end offset`);
    return [{ name, kids }, end];
  }
  const top = [];
  let o = 27;
  for (;;) {
    const [n, q] = node(o);
    o = q;
    if (!n) break;
    top.push(n);
  }
  return top;
}

test('FBX writer produces a structurally valid binary file', () => {
  const nodes = [
    { name: 'Hips', parent: -1, restPos: [0, 1, 0], restQuat: [0, 0, 0, 1], restScale: [1, 1, 1] },
    { name: 'Spine', parent: 0, restPos: [0, 0.1, 0], restQuat: [0, 0, 0, 1], restScale: [1, 1, 1] },
  ];
  const frames = [];
  for (let i = 0; i < 10; i++) {
    const a = i * 0.2;
    frames.push({
      pos: Float32Array.from([0, 1 + i * 0.01, 0, 0, 0.1, 0]),
      quat: Float32Array.from([0, 0, 0, 1, Math.sin(a / 2), 0, 0, Math.cos(a / 2)]),
      scale: Float32Array.from([1, 1, 1, 1, 1, 1]),
    });
  }
  const bytes = buildAnimationFbx({ nodes, frames, fps: 30 });
  const top = parseFbx(bytes);
  const names = top.map((n) => n.name);
  for (const n of ['FBXHeaderExtension', 'GlobalSettings', 'Definitions', 'Objects', 'Connections', 'Takes']) assert.ok(names.includes(n), n);
  const objects = top.find((n) => n.name === 'Objects').kids;
  assert.equal(objects.filter((k) => k.name === 'Model').length, 2);
  assert.ok(objects.filter((k) => k.name === 'AnimationCurve').length >= 6);
});

test('leg-wear classification', () => {
  const blue = [40, 60, 120];
  assert.equal(classifyLegwear(Array(10).fill(1), false, 4, blue).category, 'pants');
  assert.equal(classifyLegwear(Array(10).fill(1), true, 4, blue).category, 'long-skirt');
  assert.equal(classifyLegwear([1, 1, 1, 1, 0, 0, 0, 0, 0, 0], false, 4, blue).category, 'shorts');
  assert.equal(classifyLegwear([1, 1, 0, 0, 0, 0, 0, 0, 0, 0], true, 4, blue).category, 'mini-skirt');
  assert.equal(classifyLegwear(Array(10).fill(0), false, 4, blue).category, 'none');
  const socks = classifyLegwear([1, 1, 0, 0, 0, 0, 0, 1, 1, 1], false, 4, blue);
  assert.equal(socks.category, 'short-shorts');
  assert.ok(socks.socksTop > 0.6 && socks.socksTop < 0.8);
});

test('bottom selection prefers a matching pattern and adds socks', () => {
  const lw = { category: 'shorts', hem: 0.4, socksTop: 0.3, skirt: false, texture: 9, denimLike: true };
  const pick = chooseBottoms(lw, BUILTIN_BOTTOMS);
  assert.equal(pick.bottomId, 'denim-shorts');
  assert.equal(pick.legwearId, 'thigh-highs');
});

test('appearance keys are stable and distances are symmetric', () => {
  const a = { skin: [200, 160, 140], hair: [30, 20, 10], hairLength: 'long', top: [200, 30, 30], bottom: [20, 20, 80], legwear: { category: 'skirt' } };
  const b = { ...a, skin: [202, 158, 141] };
  assert.equal(appearanceKey(a).key, appearanceKey(b).key);
  assert.ok(appearanceDistance(a, b) < 2);
  assert.equal(appearanceDistance(a, b), appearanceDistance(b, a));
});
