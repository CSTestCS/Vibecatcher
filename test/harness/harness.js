// Browser test harness: exercises the model pipeline with synthetic landmarks.
import * as THREE from 'three';
import { parseVrm, prepareLegsModel, reshapeLegs, measureThighRatio, bakeLegTexture, applyCulling, AvatarInstance } from '../../src/renderer/lib/avatar.js';
import { applyPose, solvePlacement, placeModel } from '../../src/renderer/lib/retarget.js';
import { MotionRecorder } from '../../src/renderer/lib/recorder.js';
import { BUILTIN_BOTTOMS, chooseBottoms } from '../../src/renderer/lib/bottoms.js';
import { classifyLegwear } from '../../src/renderer/lib/features.js';

function syntheticPose(yaw, t) {
  // MediaPipe-style world landmarks: x right, y down, z away (metres)
  const P = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.99 }));
  const set = (i, x, y, z) => { P[i] = { x, y, z, visibility: 0.99 }; };
  const knee = 0.25 + 0.2 * Math.sin(t);
  set(23, 0.1, 0, 0); set(24, -0.1, 0, 0);            // hips (left is +x when facing camera)
  set(11, 0.18, -0.5, 0); set(12, -0.18, -0.5, 0);    // shoulders
  set(25, 0.11, 0.42, -knee * 0.5); set(26, -0.11, 0.43, 0);  // knees
  set(27, 0.11, 0.82, 0.05); set(28, -0.11, 0.85, 0);   // ankles
  set(29, 0.11, 0.87, 0.1); set(30, -0.11, 0.9, 0.05);
  set(31, 0.11, 0.9, -0.12); set(32, -0.11, 0.92, -0.15); // toes towards camera
  set(13, 0.3, -0.25, 0); set(14, -0.3, -0.25, 0); set(15, 0.32, 0.0, -0.05); set(16, -0.32, 0.0, -0.05);
  set(17, 0.33, 0.07, -0.05); set(19, 0.32, 0.08, -0.06); set(18, -0.33, 0.07, -0.05); set(20, -0.32, 0.08, -0.06);
  set(7, 0.07, -0.68, 0.05); set(8, -0.07, -0.68, 0.05); set(0, 0, -0.66, -0.08);
  set(2, 0.03, -0.69, -0.07); set(5, -0.03, -0.69, -0.07); set(9, 0.02, -0.62, -0.07); set(10, -0.02, -0.62, -0.07);
  // yaw about the vertical axis
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const W = P.map((p) => ({ x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c, visibility: p.visibility }));
  // project to 2D: person 4 m away, 50 deg fov, aspect 16:9, centre at (0.4, 0.55)
  const f = 0.5 / Math.tan(THREE.MathUtils.degToRad(25));
  const L = W.map((p) => ({ x: 0.4 + (p.x * f / (4 + p.z)) / (16 / 9), y: 0.55 + p.y * f / (4 + p.z), z: 0, visibility: 0.99 }));
  return { lmW: W, lm2d: L };
}

window.runTest = async (url, mode) => {
  const data = await (await fetch(url)).arrayBuffer();
  const out = {};
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(960, 540, false);
  renderer.autoClear = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 1000);
  let avatar;
  if (mode === 'legs') {
    const vrm = await parseVrm(data);
    const { skinMeshes, legSets } = prepareLegsModel(vrm, { hideBaseClothing: true, showShoes: true });
    out.thighRatio = measureThighRatio(vrm, legSets);
    reshapeLegs(vrm, legSets, { thighScale: 1.15, shinScale: 1.1, thickness: 1.2 });
    avatar = new AvatarInstance(vrm, 1);
    const lw = classifyLegwear([1, 1, 1, 1, 0, 0, 0, 0, 1, 1], false, 9, [40, 60, 120]);
    out.legwear = lw;
    const pick = chooseBottoms(lw, BUILTIN_BOTTOMS);
    out.pick = pick;
    const t0 = performance.now();
    bakeLegTexture(skinMeshes, {
      skin: [140, 95, 70],
      bottom: { item: BUILTIN_BOTTOMS.find((b) => b.id === pick.bottomId), color: [40, 60, 120], hem: lw.hem },
      legwear: pick.legwearId ? { item: BUILTIN_BOTTOMS.find((b) => b.id === pick.legwearId), color: [240, 240, 240], top: lw.socksTop } : null,
    }, avatar.rest);
    out.bakeMs = performance.now() - t0;
    out.visibleMeshes = [];
    vrm.scene.traverse((o) => { if (o.isMesh && o.visible) out.visibleMeshes.push(o.name + ':' + (o.geometry.index ? o.geometry.index.count : 0)); });
  } else {
    avatar = new AvatarInstance(await parseVrm(data), 1);
  }
  applyCulling(avatar.vrm, false);
  scene.add(avatar.group);
  avatar.group.visible = true;
  const rec = new MotionRecorder();
  rec.start(avatar.vrm);
  const shots = [];
  for (let i = 0; i < 30; i++) {
    const pose = syntheticPose(0.5, i / 5);
    applyPose(avatar.rig, pose.lmW);
    avatar.vrm.humanoid.update();
    const sol = solvePlacement(avatar.rig, pose.lm2d, pose.lmW, camera, 16 / 9);
    placeModel(avatar.vrm, sol.anchor);
    avatar.vrm.update(1 / 30);
    avatar.setLighting({ dir: [0.6, 0.5, 0.6], color: [1, 0.9, 0.8], intensity: 1.5, ambientColor: [0.3, 0.3, 0.4], ambientIntensity: 0.6, skyColor: [0.8, 0.85, 1] }, 1, true);
    rec.capture(null);
    if (i === 0 || i === 15) {
      renderer.clear();
      camera.layers.set(1);
      renderer.render(scene, camera);
      // draw expected 2D landmark positions for comparison
      const c2 = document.createElement('canvas'); c2.width = 960; c2.height = 540;
      const ctx = c2.getContext('2d');
      ctx.fillStyle = '#334'; ctx.fillRect(0, 0, 960, 540);
      ctx.drawImage(canvas, 0, 0);
      ctx.fillStyle = 'red';
      for (const k of [23, 24, 25, 26, 27, 28, 11, 12, 15, 16, 0]) ctx.fillRect(pose.lm2d[k].x * 960 - 3, pose.lm2d[k].y * 540 - 3, 6, 6);
      shots.push(c2.toDataURL('image/png'));
      // measure projected knee of the model vs landmark
      const knee = avatar.vrm.humanoid.getRawBoneNode('leftLowerLeg').getWorldPosition(new THREE.Vector3()).project(camera);
      const ankle = avatar.vrm.humanoid.getRawBoneNode('leftFoot').getWorldPosition(new THREE.Vector3()).project(camera);
      out[`frame${i}`] = {
        kneeModel: [(knee.x + 1) / 2, (1 - knee.y) / 2], kneeLm: [pose.lm2d[25].x, pose.lm2d[25].y],
        ankleModel: [(ankle.x + 1) / 2, (1 - ankle.y) / 2], ankleLm: [pose.lm2d[27].x, pose.lm2d[27].y],
      };
    }
  }
  rec.stop();
  const fbx = rec.exportFbx();
  out.fbxBytes = fbx.length;
  out.fbxB64 = btoa(Array.from(fbx, (b) => String.fromCharCode(b)).join(''));
  out.nodes = rec.nodes.length;
  out.shots = shots;
  return out;
};
