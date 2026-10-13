// Downloads the MediaPipe pose models at BUILD time so they ship inside the
// app. The packaged application itself never touches the network.
'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');

const dir = path.join(__dirname, '..', 'assets', 'models');
const MODELS = [
  ...['lite', 'full', 'heavy'].map((v) => ({
    file: `pose_landmarker_${v}.task`,
    url: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/1/pose_landmarker_${v}.task`,
  })),
  // person detectors (COCO), used to find characters before pose tracking
  ...['lite0', 'lite2'].map((v) => ({
    file: `efficientdet_${v}.tflite`,
    url: `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_${v}/float16/1/efficientdet_${v}.tflite`,
  })),
];

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> HTTP ${res.statusCode}`)); }
      const tmp = `${dest}.part`;
      const f = fs.createWriteStream(tmp);
      res.pipe(f);
      f.on('finish', () => f.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      f.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const m of MODELS) {
    const dest = path.join(dir, m.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1e6) { console.log('model present:', m.file); continue; }
    console.log('downloading', m.file);
    await download(m.url, dest);
  }
})().catch((e) => { console.error(e); process.exit(1); });
