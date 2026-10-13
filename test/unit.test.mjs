import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnimationFbx } from '../src/renderer/lib/fbx.js';
import { classifyLegwear, appearanceDistance } from '../src/renderer/lib/features.js';
import { parseBottomFile, chooseBottoms } from '../src/renderer/lib/bottoms.js';
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

test('bottom texture names are parsed into categories', () => {
  assert.equal(parseBottomFile('pants_jeans.png').category, 'pants');
  assert.equal(parseBottomFile('Short-Shorts_Denim.PNG').category, 'short-shorts');
  assert.equal(parseBottomFile('mini-skirt.png').category, 'mini-skirt');
  assert.equal(parseBottomFile('skirt_pleated.png').category, 'skirt');
  assert.equal(parseBottomFile('thigh-highs_white.png').layer, 'legwear');
  assert.equal(parseBottomFile('shorts_red_notint.png').tint, false);
  assert.equal(parseBottomFile('shorts.png').tint, true);
  assert.equal(parseBottomFile('shortsy.png'), null);
  assert.equal(parseBottomFile('hat.png'), null);
  assert.equal(parseBottomFile('pants.jpg'), null);
});

test('bottom selection uses the user textures, with hints and fallbacks', () => {
  const lib = ['shorts_plain.png', 'shorts_denim.png', 'skirt.png', 'knee-socks.png'].map(parseBottomFile);
  const lw = { category: 'shorts', hem: 0.4, socksTop: 0.3, skirt: false, texture: 9, denimLike: true };
  const pick = chooseBottoms(lw, lib);
  assert.equal(pick.bottomId, 'shorts_denim.png');
  assert.equal(pick.legwearId, 'knee-socks.png'); // no thigh-highs texture -> nearest kind
  assert.equal(chooseBottoms({ ...lw, category: 'mini-skirt', socksTop: null }, lib).bottomId, 'skirt.png');
  assert.deepEqual(chooseBottoms(lw, []), { bottomId: null, legwearId: null });
});

test('appearance keys are stable and distances are symmetric', () => {
  const a = { skin: [200, 160, 140], hair: [30, 20, 10], hairLength: 'long', top: [200, 30, 30], bottom: [20, 20, 80], legwear: { category: 'skirt' } };
  const b = { ...a, skin: [202, 158, 141] };
  assert.equal(appearanceKey(a).key, appearanceKey(b).key);
  assert.ok(appearanceDistance(a, b) < 2);
  assert.equal(appearanceDistance(a, b), appearanceDistance(b, a));
});

test('One Euro filter removes jitter while still and follows motion', async () => {
  const { OneEuro } = await import('../src/renderer/lib/filters.js');
  const f = new OneEuro(1.0, 4);
  let rnd = 1;
  const noise = () => { rnd = (rnd * 16807) % 2147483647; return (rnd / 2147483647 - 0.5) * 0.01; };
  let dev = 0, raw = 0;
  for (let i = 0; i < 300; i++) {
    const n = noise();
    const y = f.filter(0.5 + n, 1 / 30);
    if (i > 30) { dev += Math.abs(y - 0.5); raw += Math.abs(n); }
  }
  assert.ok(dev < raw * 0.4, `still jitter ${dev / 270} vs raw ${raw / 270}`);
  // a fast move: lag after 10 frames must be small
  let y = 0;
  for (let i = 1; i <= 10; i++) y = f.filter(0.5 + i * 0.03, 1 / 30);
  assert.ok(0.8 - y < 0.05, `lag ${0.8 - y}`);
});

test('sudden left/right leg label flips are undone', async () => {
  globalThis.document ??= { createElement: () => ({ getContext: () => ({}) }) };
  const { fixLabelFlips } = await import('../src/renderer/lib/tracker.js');
  const pose = () => Array.from({ length: 33 }, (_, i) => ({ x: 0.5, y: i / 40, z: 0, visibility: 1 }));
  const prev = pose();
  for (const [l, r] of [[25, 26], [27, 28], [29, 30], [31, 32]]) { prev[l].x = 0.45; prev[r].x = 0.55; }
  const cur = prev.map((p) => ({ ...p }));
  for (const [l, r] of [[25, 26], [27, 28], [29, 30], [31, 32]]) { cur[l].x = 0.55; cur[r].x = 0.45; } // labels swapped
  const curW = cur.map((p) => ({ ...p }));
  fixLabelFlips(cur, curW, prev, 0.5);
  assert.equal(cur[25].x, 0.45);
  assert.equal(cur[26].x, 0.55);
  // genuine small motion is left alone
  const moved = prev.map((p) => ({ ...p, x: p.x + 0.001 }));
  fixLabelFlips(moved, moved.map((p) => ({ ...p })), prev, 0.5);
  assert.equal(moved[25].x, 0.451);
});

test('pose jumps (cuts) are told apart from normal motion', async () => {
  const { poseJumped } = await import('../src/renderer/lib/tracker.js');
  const pose = () => Array.from({ length: 33 }, (_, i) => ({ x: 0.5 + ((i % 2) ? 0.05 : -0.05), y: i / 40, visibility: 1 }));
  const prev = pose();
  const walk = prev.map((p) => ({ ...p, x: p.x + 0.01 })); // whole body moves a bit
  assert.equal(poseJumped(walk, prev, 0.8), false);
  // a cut to a different shot of the same spot: the centre stays, but most joints move far
  const reshot = prev.map((p, i) => (i >= 13 && i !== 23 && i !== 24 ? { ...p, x: p.x + (i % 2 ? 0.2 : -0.2) } : { ...p }));
  assert.equal(poseJumped(reshot, prev, 0.8), true);
  const teleport = prev.map((p) => ({ ...p, x: p.x + 0.5 }));
  assert.equal(poseJumped(teleport, prev, 0.8), true);
});
