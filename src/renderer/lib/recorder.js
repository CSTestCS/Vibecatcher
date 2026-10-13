// Records the VRM skeleton's local transforms every tick (30 fps) and exports
// them as an FBX animation.

import * as THREE from 'three';
import { buildAnimationFbx } from './fbx.js';

export class MotionRecorder {
  constructor() {
    this.recording = false;
    this.frames = [];
    this.nodes = null;
    this.objects = null;
    this.rootRestPos = null;
    this.fps = 30;
  }

  /** Collects the raw bone hierarchy (humanoid bones + their ancestors). */
  bind(vrm) {
    const set = new Set();
    const humanBones = vrm.humanoid.humanBones;
    for (const name of Object.keys(humanBones)) {
      let n = vrm.humanoid.getRawBoneNode(name);
      while (n && n !== vrm.scene) { set.add(n); n = n.parent; }
    }
    // Keep hierarchy order (parents before children).
    const ordered = [];
    vrm.scene.traverse((o) => { if (set.has(o)) ordered.push(o); });
    this.objects = ordered;
    this.hips = vrm.humanoid.getRawBoneNode('hips');
    this.nodes = ordered.map((o) => ({
      name: o.name,
      parent: ordered.indexOf(o.parent),
      restPos: o.position.toArray(),
      restQuat: o.quaternion.toArray(),
      restScale: o.scale.toArray(),
    }));
    this.frames = [];
  }

  start(vrm) {
    this.bind(vrm);
    this.recording = true;
  }

  stop() { this.recording = false; }

  get duration() { return this.frames.length / this.fps; }

  /**
   * @param {THREE.Vector3|null} rootMotion hips displacement (model space metres)
   */
  capture(rootMotion) {
    if (!this.recording || !this.objects) return;
    const n = this.objects.length;
    const f = { pos: new Float32Array(n * 3), quat: new Float32Array(n * 4), scale: new Float32Array(n * 3) };
    this.objects.forEach((o, i) => {
      let p = o.position;
      if (o === this.hips && rootMotion) {
        p = new THREE.Vector3().fromArray(this.nodes[i].restPos).add(rootMotion);
      } else if (o === this.hips) {
        p = new THREE.Vector3().fromArray(this.nodes[i].restPos);
      }
      f.pos.set([p.x, p.y, p.z], i * 3);
      f.quat.set([o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w], i * 4);
      f.scale.set([o.scale.x, o.scale.y, o.scale.z], i * 3);
    });
    this.frames.push(f);
  }

  exportFbx() {
    if (!this.nodes || !this.frames.length) return null;
    return buildAnimationFbx({ nodes: this.nodes, frames: this.frames, fps: this.fps });
  }
}
