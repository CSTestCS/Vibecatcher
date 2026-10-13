'use strict';

// Vibecatcher main process.
// Creates a transparent, click-through, always-on-top overlay window that covers
// one display, feeds that display's pixels to the renderer and keeps the whole
// app strictly offline.

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, protocol, session, screen, desktopCapturer,
  dialog, shell, Tray, Menu, nativeImage, globalShortcut,
} = require('electron');

const APP_ROOT = path.join(__dirname, '..', '..');
const SCHEME = 'vibe';

// ---------------------------------------------------------------------------
// Offline hardening. Nothing in this app needs the network, so we switch off
// every Chromium feature that could phone home and block any remote request.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-features', 'SpellCheck,AutofillServerCommunication,MediaRouter,OptimizationHints,NetworkTimeServiceQuerying,Translate');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.task': 'application/octet-stream', '.map': 'application/json', '.svg': 'image/svg+xml',
};

// vibe://app/<path>   -> files bundled with the application
// vibe://user/<path>  -> files in the user's bottoms library folder
function resolveSchemePath(url) {
  const u = new URL(url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  let base;
  if (u.host === 'app') base = APP_ROOT;
  else if (u.host === 'user') base = userBottomsDir();
  else return null;
  const full = path.normalize(path.join(base, rel));
  if (!full.startsWith(path.normalize(base))) return null; // no path traversal
  return full;
}

// ---------------------------------------------------------------------------
// Persistent JSON stores in the userData folder.
// ---------------------------------------------------------------------------
const userDir = () => app.getPath('userData');
const userBottomsDir = () => path.join(userDir(), 'bottoms');
const settingsFile = () => path.join(userDir(), 'settings.json');
const charactersFile = () => path.join(userDir(), 'characters.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let settings = {};
let overlay = null;
let tray = null;
let ignoringMouse = true;

function targetDisplay() {
  const displays = screen.getAllDisplays();
  return displays.find((d) => String(d.id) === String(settings.displayId)) || screen.getPrimaryDisplay();
}

function createOverlay() {
  const d = targetDisplay();
  overlay = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the overlay itself out of screen captures so the detector never sees
  // the models we draw (prevents a feedback loop).
  overlay.setContentProtection(true);
  overlay.setIgnoreMouseEvents(true, { forward: true });
  // VIBE_TEST_SOURCE (development only) feeds a still image instead of the screen.
  const test = process.env.VIBE_TEST_SOURCE ? `?testSource=${encodeURIComponent(`${SCHEME}://app/${process.env.VIBE_TEST_SOURCE}`)}` : '';
  overlay.loadURL(`${SCHEME}://app/dist/renderer/index.html${test}`);
  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.on('closed', () => { overlay = null; });
  // Never open new windows / navigate away.
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (e) => e.preventDefault());
}

function moveOverlayToDisplay() {
  if (!overlay) return;
  const d = targetDisplay();
  overlay.setBounds(d.bounds);
}

function makeTrayIcon() {
  const iconPath = path.join(APP_ROOT, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(iconPath);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Vibecatcher overlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Toggle settings menu  (Ctrl+Alt+V)', click: () => overlay && overlay.webContents.send('toggle-menu') },
    { label: 'Show / hide overlay  (Ctrl+Alt+H)', click: toggleOverlayVisible },
    { type: 'separator' },
    { label: 'Quit Vibecatcher', click: () => app.quit() },
  ]));
}

function toggleOverlayVisible() {
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide(); else overlay.showInactive();
}

// Dialogs must be able to appear above the screen-saver level overlay.
async function withDialog(fn) {
  if (!overlay) return fn(undefined);
  overlay.setAlwaysOnTop(false);
  try { return await fn(overlay); } finally { overlay.setAlwaysOnTop(true, 'screen-saver'); }
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, next) => {
    const displayChanged = String(next.displayId) !== String(settings.displayId);
    settings = next;
    writeJSON(settingsFile(), settings);
    if (displayChanged) moveOverlayToDisplay();
    return true;
  });
  ipcMain.handle('characters:get', () => readJSON(charactersFile(), { version: 1, characters: [] }));
  ipcMain.handle('characters:set', (_e, data) => { writeJSON(charactersFile(), data); return true; });

  ipcMain.on('mouse:ignore', (_e, ignore) => {
    if (!overlay || ignore === ignoringMouse) return;
    ignoringMouse = ignore;
    overlay.setIgnoreMouseEvents(ignore, { forward: true });
    if (!ignore) overlay.focus();
  });

  ipcMain.handle('displays:list', () => screen.getAllDisplays().map((d, i) => ({
    id: String(d.id), label: `Display ${i + 1} (${d.size.width}x${d.size.height})${d.id === screen.getPrimaryDisplay().id ? ' - primary' : ''}`,
  })));

  ipcMain.handle('vrm:open', () => withDialog(async (win) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a VRM model', properties: ['openFile'],
      filters: [{ name: 'VRM / VRoid model', extensions: ['vrm', 'vrn', 'glb'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    return { path: p, name: path.basename(p), data: fs.readFileSync(p) };
  }));
  ipcMain.handle('vrm:read', (_e, p) => {
    try { return { path: p, name: path.basename(p), data: fs.readFileSync(p) }; } catch { return null; }
  });

  ipcMain.handle('fbx:save', (_e, bytes, suggested) => withDialog(async (win) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Export animation as FBX',
      defaultPath: path.join(app.getPath('documents'), suggested || 'vibecatcher_motion.fbx'),
      filters: [{ name: 'FBX animation', extensions: ['fbx'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(bytes));
    return r.filePath;
  }));

  ipcMain.handle('bottoms:list', () => {
    const dir = userBottomsDir();
    fs.mkdirSync(dir, { recursive: true });
    const items = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const item = readJSON(path.join(dir, f), null);
      if (item && item.id) items.push({ ...item, source: 'user', file: f });
    }
    return items;
  });
  ipcMain.handle('bottoms:openFolder', () => {
    fs.mkdirSync(userBottomsDir(), { recursive: true });
    return shell.openPath(userBottomsDir());
  });

  ipcMain.on('app:quit', () => app.quit());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.whenReady().then(() => {
  settings = readJSON(settingsFile(), {});
  fs.mkdirSync(userBottomsDir(), { recursive: true });

  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(false);

  // Block every request that is not to our local scheme or an in-memory URL.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const local = u.startsWith(`${SCHEME}:`) || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('devtools:') || u.startsWith('chrome-extension:');
    if (!local) console.warn(`[offline] blocked request to ${u}`);
    cb({ cancel: !local });
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture'));

  protocol.handle(SCHEME, async (req) => {
    const file = resolveSchemePath(req.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // getDisplayMedia() in the renderer is answered with the chosen display,
  // without showing a picker.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const d = targetDisplay();
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    cb(src ? { video: src } : {});
  });

  registerIpc();
  createOverlay();
  createTray();

  globalShortcut.register('Control+Alt+V', () => overlay && overlay.webContents.send('toggle-menu'));
  globalShortcut.register('Control+Alt+H', toggleOverlayVisible);

  screen.on('display-removed', moveOverlayToDisplay);
  screen.on('display-metrics-changed', moveOverlayToDisplay);
});

app.on('second-instance', () => overlay && overlay.webContents.send('toggle-menu'));
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
