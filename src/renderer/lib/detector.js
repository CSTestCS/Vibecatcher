// Pose detection with MediaPipe Pose Landmarker, fully offline: the WASM
// runtime and the model files are bundled and served from the vibe:// scheme.

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const WASM_BASE = 'vibe://app/dist/renderer/wasm';
const MODEL_URL = (variant) => `vibe://app/assets/models/pose_landmarker_${variant}.task`;

export class PoseDetector {
  constructor() {
    this.landmarker = null;
    this.config = null;
    this.lastTs = 0;
  }

  async init({ variant, numPoses, minConfidence }) {
    const cfg = `${variant}|${numPoses}|${minConfidence}`;
    if (this.landmarker && this.config === cfg) return;
    if (this.landmarker) { this.landmarker.close(); this.landmarker = null; }
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const base = {
      runningMode: 'VIDEO',
      numPoses,
      minPoseDetectionConfidence: minConfidence,
      minPosePresenceConfidence: minConfidence,
      minTrackingConfidence: minConfidence,
      outputSegmentationMasks: true,
    };
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        ...base, baseOptions: { modelAssetPath: MODEL_URL(variant), delegate: 'GPU' },
      });
    } catch (e) {
      console.warn('GPU delegate unavailable, falling back to CPU', e);
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        ...base, baseOptions: { modelAssetPath: MODEL_URL(variant), delegate: 'CPU' },
      });
    }
    this.config = cfg;
  }

  /**
   * Runs detection on a canvas. `wantMasks` copies the masks to CPU memory
   * (slow-ish) only when the caller needs them this frame.
   * @returns {Array<{lm2d, lmW, mask}>}
   */
  detect(canvas, wantMasks) {
    if (!this.landmarker) return [];
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    const out = [];
    this.landmarker.detectForVideo(canvas, ts, (res) => {
      for (let i = 0; i < res.landmarks.length; i++) {
        let mask = null;
        if (wantMasks && res.segmentationMasks && res.segmentationMasks[i]) {
          mask = res.segmentationMasks[i].getAsFloat32Array().slice();
        }
        out.push({ lm2d: res.landmarks[i], lmW: res.worldLandmarks[i], mask });
      }
    });
    return out;
  }
}
