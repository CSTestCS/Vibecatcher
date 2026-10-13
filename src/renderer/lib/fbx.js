// Minimal binary FBX 7.4 writer for skeletal animation (bones + keyframes).
// Output imports into Blender, Unity, Unreal and Maya as an animation-only FBX
// (the skeleton is the VRM's own bone hierarchy, so it retargets 1:1).

import * as THREE from 'three';

const KTIME_PER_SECOND = 46186158000n;

// Fixed header values used by many writers (Blender's exporter uses the same);
// the FBX SDK validates the footer against them.
const FILE_ID = new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]);
const TIME_ID = '1970-01-01 10:00:00:000';
const FOOT_ID = new Uint8Array([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]);
const FOOT_MAGIC = new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]);
const ALWAYS_SENTINEL = new Set(['AnimationStack', 'AnimationLayer']);

// ---- property constructors -------------------------------------------------
const P = {
  C: (v) => ({ t: 'C', v: v ? 1 : 0 }),
  I: (v) => ({ t: 'I', v }),
  F: (v) => ({ t: 'F', v }),
  D: (v) => ({ t: 'D', v }),
  L: (v) => ({ t: 'L', v: BigInt(v) }),
  S: (v) => ({ t: 'S', v }),
  R: (v) => ({ t: 'R', v }),
  fa: (v) => ({ t: 'f', v: Float32Array.from(v) }),
  da: (v) => ({ t: 'd', v: Float64Array.from(v) }),
  ia: (v) => ({ t: 'i', v: Int32Array.from(v) }),
  la: (v) => ({ t: 'l', v: BigInt64Array.from(v.map((x) => BigInt(x))) }),
};
const N = (name, props = [], children = []) => ({ name, props, children });

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 16); this.dv = new DataView(this.buf.buffer); this.pos = 0; }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.pos + n) size *= 2;
    const nb = new Uint8Array(size); nb.set(this.buf); this.buf = nb; this.dv = new DataView(nb.buffer);
  }
  u8(v) { this.ensure(1); this.dv.setUint8(this.pos, v); this.pos += 1; }
  i16(v) { this.ensure(2); this.dv.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v, true); this.pos += 4; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v, true); this.pos += 4; }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; }
  f64(v) { this.ensure(8); this.dv.setFloat64(this.pos, v, true); this.pos += 8; }
  i64(v) { this.ensure(8); this.dv.setBigInt64(this.pos, v, true); this.pos += 8; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  patchU32(at, v) { this.dv.setUint32(at, v, true); }
  result() { return this.buf.slice(0, this.pos); }
}

const enc = new TextEncoder();
function strBytes(s) {
  // FBX uses "\x00\x01" separators inside names; TextEncoder keeps them.
  return enc.encode(s);
}

function writeProp(w, p) {
  w.u8(p.t.charCodeAt(0));
  switch (p.t) {
    case 'C': w.u8(p.v); break;
    case 'Y': w.i16(p.v); break;
    case 'I': w.i32(p.v); break;
    case 'F': w.f32(p.v); break;
    case 'D': w.f64(p.v); break;
    case 'L': w.i64(p.v); break;
    case 'S': case 'R': {
      const b = p.t === 'S' ? strBytes(p.v) : p.v;
      w.u32(b.length); w.bytes(b); break;
    }
    case 'f': case 'd': case 'i': case 'l': {
      const bytes = new Uint8Array(p.v.buffer, p.v.byteOffset, p.v.byteLength);
      w.u32(p.v.length); w.u32(0); w.u32(bytes.length); w.bytes(bytes); break;
    }
    default: throw new Error(`bad prop type ${p.t}`);
  }
}

function writeNode(w, node) {
  const start = w.pos;
  w.u32(0); // end offset (patched)
  w.u32(node.props.length);
  w.u32(0); // property list length (patched)
  const name = strBytes(node.name);
  w.u8(name.length); w.bytes(name);
  const propStart = w.pos;
  for (const p of node.props) writeProp(w, p);
  w.patchU32(start + 8, w.pos - propStart);
  if (node.children.length) {
    for (const c of node.children) writeNode(w, c);
    w.bytes(new Uint8Array(13));
  } else if (!node.props.length || ALWAYS_SENTINEL.has(node.name)) {
    w.bytes(new Uint8Array(13));
  }
  w.patchU32(start, w.pos);
}

export function encodeFbx(topNodes) {
  const w = new Writer();
  w.bytes(strBytes('Kaydara FBX Binary  ')); w.u8(0); w.u8(0x1a); w.u8(0);
  w.u32(7400);
  for (const n of topNodes) writeNode(w, n);
  w.bytes(new Uint8Array(13));
  w.bytes(FOOT_ID);
  w.bytes(new Uint8Array(4));
  const pad = ((w.pos + 15) & ~15) - w.pos;
  w.bytes(new Uint8Array(pad === 0 ? 16 : pad));
  w.u32(7400);
  w.bytes(new Uint8Array(120));
  w.bytes(FOOT_MAGIC);
  return w.result();
}

// ---- P70 helpers ------------------------------------------------------------
const p70 = (name, type, label, flags, ...vals) => N('P', [P.S(name), P.S(type), P.S(label), P.S(flags), ...vals]);
const pInt = (n, v) => p70(n, 'int', 'Integer', '', P.I(v));
const pEnum = (n, v) => p70(n, 'enum', '', '', P.I(v));
const pDouble = (n, v) => p70(n, 'double', 'Number', '', P.D(v));
const pTime = (n, v) => p70(n, 'KTime', 'Time', '', P.L(v));
const pVec = (n, type, v) => p70(n, type, '', 'A', P.D(v[0]), P.D(v[1]), P.D(v[2]));

// ---- euler conversion with continuity --------------------------------------
const _e = new THREE.Euler();
function eulerDeg(q, prev) {
  _e.setFromQuaternion(q, 'ZYX'); // == FBX eEulerXYZ (X applied first)
  const a = [_e.x, _e.y, _e.z];
  const b = [_e.x + Math.PI, Math.PI - _e.y, _e.z + Math.PI];
  const fit = (c) => {
    if (!prev) return c;
    return c.map((v, i) => v + Math.round((prev[i] - v) / (Math.PI * 2)) * Math.PI * 2);
  };
  const fa = fit(a), fb = fit(b);
  if (!prev) return fa;
  const da = fa.reduce((s, v, i) => s + Math.abs(v - prev[i]), 0);
  const db = fb.reduce((s, v, i) => s + Math.abs(v - prev[i]), 0);
  return da <= db ? fa : fb;
}

/**
 * @param {object} clip
 *   nodes:  [{ name, parent (index or -1), restPos:[x,y,z], restQuat:[x,y,z,w], restScale:[x,y,z] }]
 *   frames: [{ pos: Float32Array(n*3), quat: Float32Array(n*4), scale: Float32Array(n*3) }]
 *   fps
 * Positions are metres; the file is written in centimetres.
 */
export function buildAnimationFbx(clip, takeName = 'Take 001') {
  const { nodes, frames, fps } = clip;
  const nFrames = frames.length;
  const toCm = 100;
  let nextId = 1000000;
  const id = () => nextId++;
  const stop = (BigInt(Math.max(0, nFrames - 1)) * KTIME_PER_SECOND) / BigInt(fps);
  const keyTimes = frames.map((_, i) => (BigInt(i) * KTIME_PER_SECOND) / BigInt(fps));

  const objects = [];
  const connections = [];
  const C = (type, child, parent, prop) => connections.push(N('C', prop ? [P.S(type), P.L(child), P.L(parent), P.S(prop)] : [P.S(type), P.L(child), P.L(parent)]));

  const stackId = id(), layerId = id();
  objects.push(N('AnimationStack', [P.L(stackId), P.S(`${takeName}\x00\x01AnimStack`), P.S('')], [
    N('Properties70', [], [pTime('LocalStart', 0), pTime('LocalStop', stop), pTime('ReferenceStart', 0), pTime('ReferenceStop', stop)]),
  ]));
  objects.push(N('AnimationLayer', [P.L(layerId), P.S('BaseLayer\x00\x01AnimLayer'), P.S('')]));
  C('OO', layerId, stackId);

  const used = new Set();
  const uniqueName = (n) => { let s = n || 'bone', k = 1; while (used.has(s)) s = `${n}_${k++}`; used.add(s); return s; };

  const modelIds = [];
  let curveNodeCount = 0, curveCount = 0;
  const q = new THREE.Quaternion();
  nodes.forEach((nd, ni) => {
    const name = uniqueName(nd.name);
    const mId = id(), aId = id();
    modelIds.push(mId);
    q.set(...nd.restQuat);
    const restRot = eulerDeg(q, null).map((r) => THREE.MathUtils.radToDeg(r));
    objects.push(N('NodeAttribute', [P.L(aId), P.S(`${name}\x00\x01NodeAttribute`), P.S('LimbNode')], [
      N('Properties70', [], [pDouble('Size', 3)]),
      N('TypeFlags', [P.S('Skeleton')]),
    ]));
    objects.push(N('Model', [P.L(mId), P.S(`${name}\x00\x01Model`), P.S('LimbNode')], [
      N('Version', [P.I(232)]),
      N('Properties70', [], [
        p70('RotationActive', 'bool', '', '', P.I(1)),
        pEnum('InheritType', 1),
        p70('ScalingMax', 'Vector3D', 'Vector', '', P.D(0), P.D(0), P.D(0)),
        pInt('DefaultAttributeIndex', 0),
        pVec('Lcl Translation', 'Lcl Translation', nd.restPos.map((v) => v * toCm)),
        pVec('Lcl Rotation', 'Lcl Rotation', restRot),
        pVec('Lcl Scaling', 'Lcl Scaling', nd.restScale),
      ]),
      N('MultiLayer', [P.I(0)]),
      N('MultiTake', [P.I(0)]),
      N('Shading', [P.C(true)]),
      N('Culling', [P.S('CullingOff')]),
    ]));
    C('OO', aId, mId);

    if (!nFrames) return;
    // Sample channels.
    const T = [[], [], []], Rr = [[], [], []], Sc = [[], [], []];
    let prev = null;
    for (const f of frames) {
      for (let k = 0; k < 3; k++) { T[k].push(f.pos[ni * 3 + k] * toCm); Sc[k].push(f.scale[ni * 3 + k]); }
      q.set(f.quat[ni * 4], f.quat[ni * 4 + 1], f.quat[ni * 4 + 2], f.quat[ni * 4 + 3]);
      prev = eulerDeg(q, prev);
      for (let k = 0; k < 3; k++) Rr[k].push(THREE.MathUtils.radToDeg(prev[k]));
    }
    const channels = [['T', 'Lcl Translation', T], ['R', 'Lcl Rotation', Rr], ['S', 'Lcl Scaling', Sc]];
    for (const [short, prop, data] of channels) {
      const constant = data.every((arr) => arr.every((v) => Math.abs(v - arr[0]) < 1e-5));
      if (constant && short !== 'R' && !(short === 'T' && ni === 0)) continue; // keep files small
      const cnId = id();
      curveNodeCount++;
      objects.push(N('AnimationCurveNode', [P.L(cnId), P.S(`${short}\x00\x01AnimCurveNode`), P.S('')], [
        N('Properties70', [], ['X', 'Y', 'Z'].map((ax, k) => p70(`d|${ax}`, 'Number', '', 'A', P.D(data[k][0])))),
      ]));
      C('OO', cnId, layerId);
      C('OP', cnId, mId, prop);
      ['X', 'Y', 'Z'].forEach((ax, k) => {
        const cId = id();
        curveCount++;
        objects.push(N('AnimationCurve', [P.L(cId), P.S('\x00\x01AnimCurve'), P.S('')], [
          N('Default', [P.D(data[k][0])]),
          N('KeyVer', [P.I(4008)]),
          N('KeyTime', [P.la(keyTimes)]),
          N('KeyValueFloat', [P.fa(data[k])]),
          N('KeyAttrFlags', [P.ia([24836])]),
          N('KeyAttrDataFloat', [P.fa([0, 0, 9.419963346924634e-30, 0])]),
          N('KeyAttrRefCount', [P.ia([nFrames])]),
        ]));
        C('OP', cId, cnId, `d|${ax}`);
      });
    }
  });
  nodes.forEach((nd, ni) => C('OO', modelIds[ni], nd.parent >= 0 ? modelIds[nd.parent] : 0));

  const now = new Date();
  const defs = [
    ['GlobalSettings', 1], ['Model', nodes.length], ['NodeAttribute', nodes.length],
    ['AnimationStack', 1], ['AnimationLayer', 1], ['AnimationCurveNode', curveNodeCount], ['AnimationCurve', curveCount],
  ].filter(([, c]) => c > 0);

  const top = [
    N('FBXHeaderExtension', [], [
      N('FBXHeaderVersion', [P.I(1003)]),
      N('FBXVersion', [P.I(7400)]),
      N('EncryptionType', [P.I(0)]),
      N('CreationTimeStamp', [], [
        N('Version', [P.I(1000)]), N('Year', [P.I(now.getFullYear())]), N('Month', [P.I(now.getMonth() + 1)]),
        N('Day', [P.I(now.getDate())]), N('Hour', [P.I(now.getHours())]), N('Minute', [P.I(now.getMinutes())]),
        N('Second', [P.I(now.getSeconds())]), N('Millisecond', [P.I(0)]),
      ]),
      N('Creator', [P.S('Vibecatcher FBX writer')]),
    ]),
    N('FileId', [P.R(FILE_ID)]),
    N('CreationTime', [P.S(TIME_ID)]),
    N('Creator', [P.S('Vibecatcher FBX writer')]),
    N('GlobalSettings', [], [
      N('Version', [P.I(1000)]),
      N('Properties70', [], [
        pInt('UpAxis', 1), pInt('UpAxisSign', 1), pInt('FrontAxis', 2), pInt('FrontAxisSign', 1),
        pInt('CoordAxis', 0), pInt('CoordAxisSign', 1), pInt('OriginalUpAxis', 1), pInt('OriginalUpAxisSign', 1),
        pDouble('UnitScaleFactor', 1), pDouble('OriginalUnitScaleFactor', 1),
        p70('AmbientColor', 'ColorRGB', 'Color', '', P.D(0), P.D(0), P.D(0)),
        p70('DefaultCamera', 'KString', '', '', P.S('Producer Perspective')),
        pEnum('TimeMode', fps === 30 ? 6 : fps === 60 ? 3 : 14), pEnum('TimeProtocol', 2), pEnum('SnapOnFrameMode', 0),
        pTime('TimeSpanStart', 0), pTime('TimeSpanStop', stop), pDouble('CustomFrameRate', fps),
      ]),
    ]),
    N('Documents', [], [
      N('Count', [P.I(1)]),
      N('Document', [P.L(id()), P.S('Scene'), P.S('Scene')], [
        N('Properties70', [], [p70('SourceObject', 'object', '', ''), p70('ActiveAnimStackName', 'KString', '', '', P.S(takeName))]),
        N('RootNode', [P.L(0)]),
      ]),
    ]),
    N('References'),
    N('Definitions', [], [
      N('Version', [P.I(100)]),
      N('Count', [P.I(defs.reduce((s, [, c]) => s + c, 0))]),
      ...defs.map(([t, c]) => N('ObjectType', [P.S(t)], [N('Count', [P.I(c)])])),
    ]),
    N('Objects', [], objects),
    N('Connections', [], connections),
    N('Takes', [], [
      N('Current', [P.S(takeName)]),
      N('Take', [P.S(takeName)], [
        N('FileName', [P.S(`${takeName.replace(/\s+/g, '_')}.tak`)]),
        N('LocalTime', [P.L(0), P.L(stop)]),
        N('ReferenceTime', [P.L(0), P.L(stop)]),
      ]),
    ]),
  ];
  return encodeFbx(top);
}
