// Settings menu that collapses into a draggable gear. Also manages mouse
// pass-through so the overlay never blocks normal PC use.

import { toHex } from './lib/color.js';

export class OverlayUI {
  constructor({ api, settings, onSettingsChanged }) {
    this.api = api;
    this.settings = settings;
    this.onSettingsChanged = onSettingsChanged;
    this.gear = document.getElementById('gear');
    this.menu = document.getElementById('menu');
    this.statusEl = document.getElementById('status');
    this.toastEl = document.getElementById('toast');
    this.selected = new Set();
    this.saveTimer = null;
    this.interactive = false;
    this.bindSettings();
    this.bindGear();
    this.bindPassThrough();
    document.getElementById('collapse').addEventListener('click', () => this.setMenuOpen(false));
    document.getElementById('quit').addEventListener('click', () => api.quit());
    api.onToggleMenu(() => this.setMenuOpen(this.menu.hidden));
    this.placeGear(settings.gear.x, settings.gear.y);
    this.setMenuOpen(settings.menuOpen);
    this.refreshModeSections();
  }

  // ---- settings binding ---------------------------------------------------
  bindSettings() {
    for (const el of document.querySelectorAll('[data-setting]')) {
      const key = el.dataset.setting;
      this.writeControl(el, this.settings[key]);
      el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'range' || el.type === 'number') v = Number(el.value);
        else v = el.value;
        if (key === 'maxCharacters') v = Math.max(1, Math.min(8, Math.round(v) || 1));
        this.settings[key] = v;
        this.updateOutput(key);
        if (key === 'mode') this.refreshModeSections();
        this.save();
        this.onSettingsChanged(key, v);
      });
      this.updateOutput(key);
    }
  }

  writeControl(el, v) {
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }

  updateOutput(key) {
    const out = document.querySelector(`output[data-for="${key}"]`);
    if (out) out.textContent = this.settings[key];
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.api.setSettings(this.settings), 300);
  }

  refreshModeSections() {
    for (const s of document.querySelectorAll('section[data-mode]')) s.hidden = s.dataset.mode !== this.settings.mode;
  }

  setDisplays(displays) {
    const sel = document.getElementById('display-select');
    sel.innerHTML = '';
    for (const d of displays) {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.label;
      sel.appendChild(o);
    }
    if (!displays.find((d) => d.id === String(this.settings.displayId)) && displays[0]) {
      this.settings.displayId = displays[0].id;
    }
    sel.value = this.settings.displayId;
  }

  // ---- gear: click toggles, drag moves ------------------------------------
  bindGear() {
    let start = null;
    this.gear.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, gx: this.settings.gear.x, gy: this.settings.gear.y, moved: false };
      this.gear.setPointerCapture(e.pointerId);
      this.setInteractive(true);
    });
    this.gear.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      this.placeGear(start.gx + dx, start.gy + dy);
    });
    this.gear.addEventListener('pointerup', (e) => {
      if (!start) return;
      this.gear.releasePointerCapture(e.pointerId);
      if (!start.moved) this.setMenuOpen(this.menu.hidden);
      else this.save();
      start = null;
    });
    window.addEventListener('resize', () => this.placeGear(this.settings.gear.x, this.settings.gear.y));
  }

  placeGear(x, y) {
    const W = window.innerWidth, H = window.innerHeight;
    x = Math.max(4, Math.min(W - 44, x));
    y = Math.max(4, Math.min(H - 44, y));
    this.settings.gear = { x, y };
    this.gear.style.left = `${x}px`;
    this.gear.style.top = `${y}px`;
    this.placeMenu();
  }

  placeMenu() {
    const { x, y } = this.settings.gear;
    const W = window.innerWidth, H = window.innerHeight;
    const mw = 330;
    const left = x + 50 + mw < W ? x + 50 : Math.max(4, x - mw - 10);
    this.menu.style.left = `${left}px`;
    const mh = Math.min(this.menu.offsetHeight || 500, H - 80);
    this.menu.style.top = `${Math.max(4, Math.min(H - mh - 4, y))}px`;
  }

  setMenuOpen(open) {
    this.menu.hidden = !open;
    this.gear.classList.toggle('open', open);
    this.settings.menuOpen = open;
    this.placeMenu();
    this.save();
  }

  // ---- click-through handling ---------------------------------------------
  bindPassThrough() {
    const check = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const over = !!(el && el.closest('#gear, #menu'));
      this.setInteractive(over);
    };
    window.addEventListener('mousemove', check);
    window.addEventListener('mouseleave', () => this.setInteractive(false));
  }

  setInteractive(on) {
    if (on === this.interactive) return;
    this.interactive = on;
    this.api.setIgnoreMouse(!on);
  }

  // ---- status / toasts -----------------------------------------------------
  status(text) { this.statusEl.textContent = text; }

  toast(text, ms = 2500) {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, ms);
  }

  // ---- saved characters list ----------------------------------------------
  renderCharacters(list) {
    const el = document.getElementById('char-list');
    document.getElementById('char-count').textContent = `(${list.length})`;
    el.innerHTML = '';
    const sorted = [...list].sort((a, b) => (b.loadCount || 0) - (a.loadCount || 0));
    for (const c of sorted) {
      const row = document.createElement('label');
      row.className = 'char';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.selected.has(c.id);
      cb.addEventListener('change', () => { if (cb.checked) this.selected.add(c.id); else this.selected.delete(c.id); });
      const sw = document.createElement('span');
      sw.className = 'sw';
      for (const col of [c.appearance.skin, c.appearance.hair, c.appearance.top, c.colors && c.colors.bottom]) {
        if (!col) continue;
        const i = document.createElement('i');
        i.style.background = toHex(col);
        sw.appendChild(i);
      }
      const name = document.createElement('span');
      name.textContent = `${c.hash} · ${c.bottomName || c.bottomId || 'none'}`;
      name.title = c.key;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${c.loadCount || 0}×`;
      count.title = `Last seen ${new Date(c.lastSeen).toLocaleString()}`;
      row.append(cb, sw, name, count);
      el.appendChild(row);
    }
  }
}
