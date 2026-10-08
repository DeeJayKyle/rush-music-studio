// ---------------------------------------------------------------------------
// Utilities, UI widgets, file I/O, worker pool
// ---------------------------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dbToGain = (db) => (db <= -96 ? 0 : Math.pow(10, db / 20));
const gainToDb = (g) => (g <= 1e-6 ? -120 : 20 * Math.log10(g));
let _uid = Date.now() % 100000;
const uid = (p = 'id') => p + (++_uid).toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const p in v) { if (v[p] == null) continue; if (p.startsWith('--')) e.style.setProperty(p, v[p]); else e.style[p] = v[p]; } }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s; };

function fmtTime(sec, ms = 3) {
  if (!isFinite(sec)) sec = 0;
  const neg = sec < 0; sec = Math.abs(sec);
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return (neg ? '-' : '') + String(m).padStart(2, '0') + ':' + s.toFixed(ms).padStart(ms ? 3 + ms : 2, '0');
}
function fmtShort(sec) { const m = Math.floor(sec / 60), s = sec - m * 60; return m + ':' + s.toFixed(1).padStart(4, '0'); }
function fmtBars(beats, bpb) {
  if (beats < 0) beats = 0;
  const bar = Math.floor(beats / bpb) + 1, beat = Math.floor(beats % bpb) + 1, tick = Math.floor((beats % 1) * 1000);
  return bar + '.' + beat + '.' + String(tick).padStart(3, '0');
}
function fmtDb(db) { return db <= -96 ? '−∞' : (db > 0 ? '+' : '') + db.toFixed(1); }

// ---- theme colors for canvas ----------------------------------------------
const C = {};
function refreshColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['bg', 'panel', 'panel-2', 'panel-3', 'line', 'line-soft', 'fg', 'muted', 'faint', 'accent', 'accent-2', 'sel', 'rec', 'ok', 'grid-bar', 'grid-beat', 'track-a', 'track-b', 'wave', 'st-vocals', 'st-melody', 'st-bass', 'st-drums'])
    C[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = cs.getPropertyValue('--' + k).trim();
}
function alpha(hex, a) {
  if (!hex) return `rgba(128,128,128,${a})`;
  if (hex.startsWith('rgb')) return hex.replace(/rgba?\(([^)]+)\)/, (m, inner) => { const p = inner.split(',').slice(0, 3).join(','); return `rgba(${p},${a})`; });
  let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function fitCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height, dpr };
}

// ---- toasts / status --------------------------------------------------------
function toast(msg, kind = '') {
  const t = el('div', { class: 'toast ' + kind, role: 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, kind === 'err' ? 6000 : 3200);
}
function status(msg) { const s = $('#statusMsg'); if (s) s.textContent = msg; }

// ---- menus --------------------------------------------------------------------
let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; $$('.menu-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); } }
function showMenu(x, y, items, anchor) {
  closeMenu();
  const m = el('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(el('hr')); continue; }
    if (it.label && it.header) { m.append(el('div', { class: 'mlabel' }, it.label)); continue; }
    const b = el('button', { role: 'menuitem', disabled: it.disabled ? true : null }, el('span', {}, it.label), it.key ? el('kbd', {}, it.key) : null);
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.action && it.action(); });
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = clamp(x, 4, innerWidth - r.width - 4) + 'px';
  m.style.top = clamp(y, 4, innerHeight - r.height - 4) + 'px';
  openMenuEl = m;
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  const first = m.querySelector('button:not(:disabled)'); if (first) first.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => {
  if (!openMenuEl) return;
  const btns = $$('button:not(:disabled)', openMenuEl), i = btns.indexOf(document.activeElement);
  if (e.key === 'Escape') { closeMenu(); e.preventDefault(); e.stopPropagation(); }
  else if (e.key === 'ArrowDown') { btns[(i + 1) % btns.length].focus(); e.preventDefault(); e.stopPropagation(); }
  else if (e.key === 'ArrowUp') { btns[(i - 1 + btns.length) % btns.length].focus(); e.preventDefault(); e.stopPropagation(); }
}, true);

// ---- dialog (replaces prompt/confirm; works inside sandboxes) --------------
function showDialog({ title, desc, fields = [], ok = 'Apply', cancel = 'Cancel', preview, danger }) {
  return new Promise((resolve) => {
    const bg = el('div', { class: 'modal-bg' });
    const form = el('form', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const vals = {};
    const fwrap = el('div', { class: 'fields' });
    for (const f of fields) {
      const id = 'dlg-' + f.id;
      vals[f.id] = f.value;
      const wrap = el('div', { class: 'f' });
      if (f.type === 'range') {
        const out = el('output', {}, f.format ? f.format(f.value) : f.value);
        const inp = el('input', { type: 'range', id, min: f.min, max: f.max, step: f.step || 1, value: f.value });
        inp.addEventListener('input', () => { vals[f.id] = parseFloat(inp.value); out.textContent = f.format ? f.format(vals[f.id]) : inp.value; });
        wrap.append(el('label', { for: id }, f.label, out), inp);
      } else if (f.type === 'select') {
        const sel = el('select', { id }, f.options.map((o) => el('option', { value: o.value ?? o, selected: (o.value ?? o) == f.value ? true : null }, o.label ?? o)));
        sel.addEventListener('change', () => { vals[f.id] = sel.value; });
        wrap.append(el('label', { for: id }, f.label), sel);
      } else if (f.type === 'check') {
        const cb = el('input', { type: 'checkbox', id, checked: f.value ? true : null });
        cb.addEventListener('change', () => { vals[f.id] = cb.checked; });
        wrap.append(el('label', { for: id, style: { justifyContent: 'flex-start', gap: '8px' } }, cb, f.label));
      } else {
        const inp = el('input', { class: 'inp', id, type: f.type || 'text', value: f.value ?? '', min: f.min, max: f.max, step: f.step });
        inp.addEventListener('input', () => { vals[f.id] = f.type === 'number' ? parseFloat(inp.value) : inp.value; });
        wrap.append(el('label', { for: id }, f.label), inp);
      }
      fwrap.append(wrap);
    }
    const done = (v) => { bg.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    const footer = el('footer', {},
      preview ? el('button', { type: 'button', class: 'btn ghost', onclick: () => preview(vals) }, 'Preview') : null,
      el('div', { class: 'spacer' }),
      cancel ? el('button', { type: 'button', class: 'btn', onclick: () => done(null) }, cancel) : null,
      el('button', { type: 'submit', class: 'btn primary', style: danger ? { background: 'var(--rec)', color: '#fff' } : null }, ok));
    form.append(el('header', {}, el('h3', {}, title), desc ? el('p', {}, desc) : null), fields.length ? fwrap : null, footer);
    form.addEventListener('submit', (e) => { e.preventDefault(); done({ ...vals }); });
    bg.addEventListener('pointerdown', (e) => { if (e.target === bg) done(null); });
    bg.append(form);
    document.body.append(bg);
    const first = form.querySelector('input,select') || form.querySelector('button[type=submit]');
    first && first.focus();
  });
}
async function confirmDialog(title, desc, ok = 'Continue', danger = false) { return !!(await showDialog({ title, desc, ok, danger })); }

// ---- knob ---------------------------------------------------------------------
function knob({ label, min, max, value, step = 0.01, def = value, format = (v) => v.toFixed(1), onInput }) {
  const out = el('output', {}, format(value));
  const dial = el('div', { class: 'dial', tabindex: '0', role: 'slider', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max });
  const wrap = el('div', { class: 'knob' }, dial, el('label', {}, label), out);
  let v = value;
  const set = (nv, fire = true) => {
    nv = clamp(Math.round(nv / step) * step, min, max); v = nv;
    const a = -135 + 270 * (v - min) / (max - min);
    dial.style.setProperty('--a', a + 'deg');
    dial.setAttribute('aria-valuenow', v.toFixed(2));
    out.textContent = format(v);
    if (fire && onInput) onInput(v);
  };
  set(value, false);
  let sy = 0, sv = 0;
  dial.addEventListener('pointerdown', (e) => { dial.setPointerCapture(e.pointerId); sy = e.clientY; sv = v; e.preventDefault(); });
  dial.addEventListener('pointermove', (e) => { if (!dial.hasPointerCapture(e.pointerId)) return; const fine = e.shiftKey ? 0.2 : 1; set(sv + (sy - e.clientY) * (max - min) / 160 * fine); });
  dial.addEventListener('dblclick', () => set(def));
  dial.addEventListener('wheel', (e) => { e.preventDefault(); set(v - Math.sign(e.deltaY) * (max - min) / 60); }, { passive: false });
  dial.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(v + (max - min) / 50); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(v - (max - min) / 50); e.preventDefault(); }
  });
  return { el: wrap, set, get: () => v };
}

// ---- WAV encode / decode helpers ------------------------------------------
function encodeWav(channels, sr, bits = 16) {
  const nch = channels.length, len = channels[0].length, bps = bits / 8, isFloat = bits === 32;
  const dataLen = len * nch * bps, buf = new ArrayBuffer(44 + dataLen), dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, isFloat ? 3 : 1, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nch * bps, true); dv.setUint16(32, nch * bps, true); dv.setUint16(34, bits, true);
  ws(36, 'data'); dv.setUint32(40, dataLen, true);
  let o = 44;
  if (bits === 16) {
    const out = new Int16Array(buf, 44, len * nch);
    for (let i = 0, j = 0; i < len; i++) for (let c = 0; c < nch; c++) { const s = clamp(channels[c][i], -1, 1); out[j++] = s < 0 ? s * 32768 : s * 32767; }
  } else if (bits === 24) {
    for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) { const s = Math.round(clamp(channels[c][i], -1, 1) * 8388607); dv.setUint8(o, s & 255); dv.setUint8(o + 1, (s >> 8) & 255); dv.setUint8(o + 2, (s >> 16) & 255); o += 3; }
  } else {
    for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) { dv.setFloat32(o, channels[c][i], true); o += 4; }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
function bufferChannels(b) { const a = []; for (let c = 0; c < b.numberOfChannels; c++) a.push(b.getChannelData(c)); return a; }
function makeBuffer(channels, sr) {
  const b = new AudioBuffer({ length: Math.max(1, channels[0].length), numberOfChannels: channels.length, sampleRate: sr });
  channels.forEach((d, i) => { if (d.length) b.copyToChannel(d, i); });
  return b;
}
function downloadBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function safeName(s) { return (s || 'untitled').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled'; }

// ---- peaks --------------------------------------------------------------------
const PEAK_SPP = 256;
function computePeaks(buffer) {
  const chs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c), n = Math.ceil(d.length / PEAK_SPP);
    const mn = new Float32Array(n), mx = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let lo = 1, hi = -1; const e = Math.min(d.length, (i + 1) * PEAK_SPP);
      for (let j = i * PEAK_SPP; j < e; j++) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo > hi) lo = hi = 0;
      mn[i] = lo; mx[i] = hi;
    }
    chs.push({ min: mn, max: mx });
  }
  return { spp: PEAK_SPP, sr: buffer.sampleRate, chs, len: buffer.length };
}
// min/max over sample range [s0,s1) for channel c (or all channels if c<0)
function peakRange(peaks, buffer, c, s0, s1) {
  s0 = Math.max(0, Math.floor(s0)); s1 = Math.min(peaks.len, Math.ceil(s1));
  if (s1 <= s0) return null;
  let lo = 1, hi = -1;
  const list = c < 0 ? peaks.chs.map((_, i) => i) : [c];
  if (s1 - s0 < peaks.spp * 2 && buffer) {
    for (const ci of list) { const d = buffer.getChannelData(ci); for (let j = s0; j < s1; j++) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; } }
  } else {
    const i0 = Math.floor(s0 / peaks.spp), i1 = Math.ceil(s1 / peaks.spp);
    for (const ci of list) { const p = peaks.chs[ci]; for (let i = i0; i < i1; i++) { if (p.min[i] < lo) lo = p.min[i]; if (p.max[i] > hi) hi = p.max[i]; } }
  }
  if (lo > hi) return null;
  return [lo, hi];
}

// ---- DSP worker pool ----------------------------------------------------------
const Pool = (() => {
  const size = clamp((navigator.hardwareConcurrency || 4) - 1, 2, 16);
  let workers = [], url = null, seq = 0;
  const pending = new Map(), queue = [];
  function init() {
    if (workers.length) return;
    const src = document.getElementById('rush-dsp-src').textContent;
    url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    for (let i = 0; i < size; i++) {
      const w = new Worker(url);
      w.busy = false;
      w.onmessage = (ev) => {
        const m = ev.data, p = pending.get(m.id);
        pending.delete(m.id); w.busy = false;
        if (p) m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
        pump();
      };
      w.onerror = (e) => { console.error('worker error', e); };
      workers.push(w);
    }
  }
  function pump() {
    for (const w of workers) {
      if (!queue.length) return;
      if (w.busy) continue;
      const job = queue.shift();
      w.busy = true;
      pending.set(job.msg.id, job);
      w.postMessage(job.msg, job.transfer || []);
    }
  }
  function run(type, data, transfer) {
    init();
    return new Promise((resolve, reject) => {
      const msg = Object.assign({ id: ++seq, type }, data);
      queue.push({ msg, transfer, resolve, reject });
      pump();
    });
  }
  return { run, size, init };
})();
