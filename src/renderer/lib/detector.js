// Person detection + per-character pose tracking, fully offline (the WASM
// runtime and the models are bundled and served from the vibe:// scheme).
//
// Two stages:
//  1. An object detector (EfficientDet, COCO "person") finds every humanoid in
//     the frame. Unlike the pose model's own face-based detector, it also finds
//     characters seen from behind, partly off-screen or small, and ignores
//     background clutter.
//  2. Each tracked character gets its own pose landmarker in VIDEO mode, fed a
//     high-resolution square crop around that character. The landmarker keeps
//     its own temporal tracking inside the crop, and the crop follows the
//     character, so small or distant characters get full model resolution.

import { FilesetResolver, PoseLandmarker, ObjectDetector } from '@mediapipe/tasks-vision';

const WASM_BASE = 'vibe://app/dist/renderer/wasm';
const POSE_MODEL = (variant) => `vibe://app/assets/models/pose_landmarker_${variant}.task`;
const PERSON_MODEL = (variant) => `vibe://app/assets/models/efficientdet_${variant}.tflite`;
export const CROP_SIZE = 320;

let filesetPromise = null;
function fileset() {
  if (!filesetPromise) filesetPromise = FilesetResolver.forVisionTasks(WASM_BASE);
  return filesetPromise;
}

async function createWithFallback(Task, options, delegate = 'GPU') {
  if (delegate === 'CPU') {
    return Task.createFromOptions(await fileset(), { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
  }
  try {
    return await Task.createFromOptions(await fileset(), { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
  } catch (e) {
    console.warn('GPU delegate unavailable, using CPU', e);
    return Task.createFromOptions(await fileset(), { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
  }
}

class Clock {
  constructor() { this.last = 0; }
  next() {
    let t = performance.now();
    if (t <= this.last) t = this.last + 1;
    this.last = t;
    return t;
  }
}

export class PersonDetector {
  constructor() { this.task = null; this.cfg = null; this.clock = new Clock(); }

  // The person detector is small; on the CPU (XNNPACK) it is fast and leaves
  // the GPU to the pose models and rendering.
  async init({ variant, threshold, maxResults, delegate = 'CPU' }) {
    const cfg = `${variant}|${threshold}|${maxResults}|${delegate}`;
    if (this.task && cfg === this.cfg) return;
    if (this.task) this.task.close();
    this.task = await createWithFallback(ObjectDetector, {
      baseOptions: { modelAssetPath: PERSON_MODEL(variant) },
      runningMode: 'VIDEO',
      scoreThreshold: threshold,
      maxResults,
      categoryAllowlist: ['person'],
    }, delegate);
    this.cfg = cfg;
  }

  /** @returns {Array<{x,y,w,h,score}>} boxes normalised to the frame */
  detect(canvas) {
    if (!this.task) return [];
    const r = this.task.detectForVideo(canvas, this.clock.next());
    const W = canvas.width, H = canvas.height;
    return r.detections.map((d) => ({
      x: d.boundingBox.originX / W, y: d.boundingBox.originY / H,
      w: d.boundingBox.width / W, h: d.boundingBox.height / H,
      score: d.categories[0] ? d.categories[0].score : 0,
    }));
  }
}

/** A pool of single-person pose landmarkers, one per tracked character. */
export class PosePool {
  constructor() { this.slots = []; this.cfg = null; }

  async init({ variant, count, minConfidence, delegate = 'GPU' }) {
    const cfg = `${variant}|${count}|${minConfidence}|${delegate}`;
    if (cfg === this.cfg) return;
    for (const s of this.slots) s.task.close();
    this.slots = [];
    for (let i = 0; i < count; i++) {
      const task = await createWithFallback(PoseLandmarker, {
        baseOptions: { modelAssetPath: POSE_MODEL(variant) },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: minConfidence,
        minPosePresenceConfidence: minConfidence,
        minTrackingConfidence: minConfidence,
        outputSegmentationMasks: true,
      }, delegate);
      this.slots.push({ task, owner: null, clock: new Clock() });
    }
    this.cfg = cfg;
  }

  acquire(owner) {
    const s = this.slots.find((x) => x.owner === null);
    if (!s) return -1;
    s.owner = owner;
    return this.slots.indexOf(s);
  }

  release(index) { if (this.slots[index]) this.slots[index].owner = null; }

  /**
   * Runs the slot's landmarker on a crop canvas.
   * @returns {{lm: Array, lmW: Array, mask: Float32Array|null}|null} lm in crop coordinates
   */
  detect(index, crop, wantMask) {
    const s = this.slots[index];
    if (!s) return null;
    let out = null;
    s.task.detectForVideo(crop, s.clock.next(), (res) => {
      if (!res.landmarks.length) return;
      let mask = null;
      if (wantMask && res.segmentationMasks && res.segmentationMasks[0]) {
        mask = res.segmentationMasks[0].getAsFloat32Array().slice();
      }
      out = { lm: res.landmarks[0], lmW: res.worldLandmarks[0], mask };
    });
    return out;
  }
}
