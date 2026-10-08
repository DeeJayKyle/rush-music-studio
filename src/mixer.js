// ---------------------------------------------------------------------------
// Mixer view — channel strips with EQ, dynamics, sends, meters
// ---------------------------------------------------------------------------
const Mixer = (() => {
  let meters = [];
  function render() {
    const m = $('#mixer'); m.innerHTML = ''; meters = [];
    for (const t of P.tracks) m.append(strip(t));
    m.append(masterStrip());
    if (!P.tracks.length) m.prepend(el('div', { style: { color: 'var(--muted)', alignSelf: 'center', padding: '0 20px' } }, 'Tracks you add in Arrange appear here as channel strips.'));
  }
  function fader(val, onInput, label) {
    const f = el('input', { type: 'range', class: 'vfader', min: -60, max: 6, step: 0.1, value: val <= -60 ? -60 : val, 'aria-label': label, orient: 'vertical' });
    f.addEventListener('input', () => onInput(parseFloat(f.value) <= -59.9 ? -120 : parseFloat(f.value)));
    return f;
  }
  function strip(t) {
    const set = (k, v) => { t[k] = v; Engine.applyAll(); markDirty(); };
    const db = el('div', { class: 'db' }, fmtDb(t.vol) + ' dB');
    const cv = el('canvas', { class: 'meter', width: 32, height: 300 });
    meters.push({ cv, get an() { const n = Engine.nodes.get(t.id); return n && [n.an]; } });
    const tog = (cls, l, prop) => { const b = el('button', { class: 'tog ' + cls, 'aria-pressed': String(!!t[prop]) }, l); b.addEventListener('click', () => { t[prop] = !t[prop]; b.setAttribute('aria-pressed', String(t[prop])); Engine.applyAll(); Arrange.renderHeads(); markDirty(); }); return b; };
    const kn = (label, prop, min, max, def, fmt) => knob({ label, min, max, value: t[prop], def, step: (max - min) / 200, format: fmt, onInput: (v) => set(prop, v) }).el;
    const dbf = (v) => fmtDb(v);
    return el('div', { class: 'strip', style: { '--c': t.color } },
      el('div', { class: 'sname', title: t.name }, t.name),
      el('div', { class: 'knobs' },
        kn('Low', 'low', -15, 15, 0, dbf), kn('High', 'high', -15, 15, 0, dbf),
        kn('Mid', 'mid', -15, 15, 0, dbf), kn('Comp', 'comp', 0, 1, 0, (v) => v < 0.01 ? 'off' : Math.round(v * 100) + '%'),
        kn('Reverb', 'rev', 0, 1, 0, (v) => Math.round(v * 100) + '%'), kn('Echo', 'dly', 0, 1, 0, (v) => Math.round(v * 100) + '%')),
      knob({ label: 'Pan', min: -1, max: 1, value: t.pan, def: 0, step: 0.01, format: (v) => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100), onInput: (v) => { set('pan', v); Arrange.renderHeads(); } }).el,
      el('div', { class: 'fader-area' }, fader(t.vol, (v) => { set('vol', v); db.textContent = fmtDb(v) + ' dB'; Arrange.renderHeads(); }, t.name + ' volume'), el('div', { class: 'meter-box' }, cv)),
      db,
      el('div', { class: 'row' }, tog('m', 'M', 'mute'), tog('s', 'S', 'solo'), fxb(() => Chainer.forTrack(t), t.fx)));
  }
  function masterStrip() {
    const M = P.master;
    const set = (k, v) => { M[k] = v; Engine.applyAll(); markDirty(); };
    const db = el('div', { class: 'db' }, fmtDb(M.vol) + ' dB');
    const cv = el('canvas', { class: 'meter', width: 32, height: 300 });
    meters.push({ cv, get an() { return Engine.master && [Engine.master.anL, Engine.master.anR]; } });
    const lim = el('button', { class: 'btn sm', 'aria-pressed': String(M.limiter), title: 'Brick-wall limiter at −1.5 dBFS' }, M.limiter ? 'Limiter on' : 'Limiter off');
    lim.addEventListener('click', () => { set('limiter', !M.limiter); lim.textContent = M.limiter ? 'Limiter on' : 'Limiter off'; lim.setAttribute('aria-pressed', String(M.limiter)); });
    const kn = (label, prop, min, max, def, fmt) => knob({ label, min, max, value: M[prop], def, step: (max - min) / 200, format: fmt, onInput: (v) => set(prop, v) }).el;
    return el('div', { class: 'strip master' },
      el('div', { class: 'sname' }, 'Master'),
      el('div', { class: 'knobs' }, kn('Low', 'low', -12, 12, 0, fmtDb), kn('High', 'high', -12, 12, 0, fmtDb), kn('Mid', 'mid', -12, 12, 0, fmtDb), kn('Echo FB', 'dlyFb', 0, 0.9, 0.35, (v) => Math.round(v * 100) + '%')),
      el('div', { class: 'row' }, lim, fxb(() => Chainer.forMaster(), M.fx)),
      el('div', { class: 'fader-area' }, fader(M.vol, (v) => { set('vol', v); db.textContent = fmtDb(v) + ' dB'; }, 'Master volume'), el('div', { class: 'meter-box' }, cv)),
      db);
  }
  function fxb(fn, fx) {
    const n = (fx || []).filter((f) => f.on).length;
    const b = el('button', { class: 'tog fx', 'aria-pressed': String(n > 0), title: n ? (fx || []).map((f) => Plugins.REG[f.type] && Plugins.REG[f.type].name).join(' → ') : 'Add effects' }, n ? 'FX ' + n : 'FX');
    b.addEventListener('click', fn); return b;
  }
  const buf = new Float32Array(2048);
  function peakOf(an) { an.getFloatTimeDomainData(buf.subarray(0, an.fftSize)); let p = 0; for (let i = 0; i < an.fftSize; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; } return p; }
  function drawMeter(cv, ans, hold) {
    const r = cv.getBoundingClientRect(); if (!r.height) return;
    const th = Math.min(2000, Math.round(r.height * 2)); if (cv.height !== th) { cv.height = th; }
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    if (!ans || !Engine.ctx) return;
    const n = ans.length, bw = w / n;
    ans.forEach((an, i) => {
      const db = gainToDb(peakOf(an));
      const f = clamp((db + 60) / 66, 0, 1);
      const g = ctx.createLinearGradient(0, h, 0, 0);
      g.addColorStop(0, C.ok); g.addColorStop(0.75, C.ok); g.addColorStop(0.88, C.accent); g.addColorStop(1, C.rec);
      ctx.fillStyle = g; ctx.fillRect(i * bw + 1, h - f * h, bw - 2, f * h);
    });
    ctx.fillStyle = alpha(C.fg, 0.25); const z = h - (60 / 66) * h; ctx.fillRect(0, z, w, 1);
  }
  function tick() { for (const m of meters) drawMeter(m.cv, m.an); }
  function init() { bus.on('project', () => { if (S.view === 'mixer') render(); }); }
  return { init, render, tick, drawMeter, peakOf };
})();
