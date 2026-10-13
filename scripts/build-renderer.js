// Bundles the renderer (three.js, three-vrm, MediaPipe) into dist/renderer and
// copies the MediaPipe WASM runtime next to it so the app runs fully offline.
'use strict';

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'renderer');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'renderer', 'app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(out, 'app.js'),
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  logLevel: 'info',
});

for (const f of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(root, 'src', 'renderer', f), path.join(out, f));
}

const wasmDir = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
for (const f of fs.readdirSync(wasmDir)) fs.copyFileSync(path.join(wasmDir, f), path.join(out, 'wasm', f));

console.log('renderer built ->', path.relative(root, out));
