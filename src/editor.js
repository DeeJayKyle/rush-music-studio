// ---------------------------------------------------------------------------
// Editor view — sample-accurate destructive audio editor
// ---------------------------------------------------------------------------
const Editor = (() => {
  const E = { A: null, start: 0, spp: 256, sel: null, cursor: 0, clip: null, spec: false, specCache: null, noise: null, drag: null, playing: null };
  const RUL = 20;
  const A = () => E.A;
  const len = () => (E.A ? E.A.buffer.length : 0);
  const sr = () => (E.A ? E.A.buffer.sampleRate : 44100);

  function open(id) {
    const a = S.assets.get(id);
    if (!a) return;
    if (E.A !== a) { E.A = a; E.sel = null; E.cursor = 0; E.specCache = null; S.editAsset = a.id; fit(); }
    fillSelect();
    setView('editor');
    draw();
  }
  function fillSelect() {
    const s = $('#edAsset'); s.innerHTML = '';
    if (!S.assets.size) s.append(el('option', { value: '' }, 'No files yet'));
    for (const a of S.assets.values()) s.append(el('option', { value: a.id, selected: E.A === a ? true : null }, a.name));
    $('#edEmpty').hidden = !!E.A;
  }
  function fit() { const w = $('#edWave').clientWidth || 800; E.start = 0; E.spp = Math.max(1, len() / w); }
  const xOf = (s) => (s - E.start) / E.spp;
  const sOf = (x) => Math.round(clamp(E.start + x * E.spp, 0, len()));
  function clampView() {
    const w = $('#edWave').clientWidth || 800;
    E.spp = clamp(E.spp, 0.02, Math.max(1, len() / w * 1.02));
    E.start = clamp(E.start, 0, Math.max(0, len() - w * E.spp));
  }
  function zoom(f, x) {
    if (!E.A) return;
    const w = $('#edWave').clientWidth;
    if (x == null) x = E.sel ? (xOf((E.sel[0] + E.sel[1]) / 2)) : xOf(E.cursor);
    if (x < 0 || x > w) x = w / 2;
    const s = E.start + x * E.spp;
    E.spp /= f; clampView();
    E.start = s - x * E.spp; clampView();
    draw();
  }
  function zoomSel() { if (!E.sel) return; const w = $('#edWave').clientWidth; E.spp = (E.sel[1] - E.sel[0]) / (w * 0.9); E.start = E.sel[0] - w * 0.05 * E.spp; clampView(); draw(); }

  // ---- drawing ----
  function draw() {
    drawWave(); drawOverview(); drawStats(); if ($('#edRegions') && !$('#edRegions').hidden) renderRegions(); if (!E.playing) drawSpectrum();
  }
  function drawWave() {
    const cv = $('#edCanvas');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = C.trackA; ctx.fillRect(0, 0, w, h);
    if (!E.A) return;
    const a = E.A, b = a.buffer, nch = b.numberOfChannels;
    // ruler
    ctx.fillStyle = C.panel; ctx.fillRect(0, 0, w, RUL);
    ctx.fillStyle = C.line; ctx.fillRect(0, RUL - 1, w, 1);
    ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--font-mono');
    const secPx = sr() / E.spp;
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s * secPx > 90) || 600;
    const t0 = E.start / sr(), t1 = (E.start + w * E.spp) / sr();
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(xOf(t * sr())) + 0.5;
      ctx.fillStyle = C.line; ctx.fillRect(x, RUL - 7, 1, 7);
      ctx.fillStyle = C.muted; ctx.fillText(step < 1 ? fmtTime(t, step < 0.01 ? 3 : 2) : fmtTime(t, 0), x + 3, 12);
    }
    const top = RUL, ch = (h - RUL) / nch;
    if (E.spec && E.specCache && E.specCache.key === specKey(w, h)) {
      ctx.drawImage(E.specCache.canvas, 0, top, w, h - top);
    } else {
      if (E.spec) requestSpec(w, h);
      for (let c = 0; c < nch; c++) {
        const y0 = top + c * ch, mid = y0 + ch / 2, amp = ch / 2 - 4;
        ctx.fillStyle = c % 2 ? C.trackB : C.trackA; ctx.fillRect(0, y0, w, ch);
        ctx.fillStyle = C.lineSoft; ctx.fillRect(0, Math.round(mid), w, 1);
        for (const db of [-6, -12]) { const g = dbToGain(db) * amp; ctx.fillStyle = alpha(C.fg, 0.04); ctx.fillRect(0, Math.round(mid - g), w, 1); ctx.fillRect(0, Math.round(mid + g), w, 1); }
        if (c > 0) { ctx.fillStyle = C.line; ctx.fillRect(0, y0, w, 1); }
        ctx.fillStyle = alpha(C.muted, 0.9); ctx.fillText(nch === 1 ? 'Mono' : c === 0 ? 'L' : c === 1 ? 'R' : 'Ch ' + (c + 1), 6, y0 + 14);
        if (E.spp < 1.5) {
          // sample-level: draw line and sample dots
          const d = b.getChannelData(c);
          ctx.strokeStyle = C.wave; ctx.lineWidth = 1.2; ctx.beginPath();
          const s0 = Math.floor(E.start), s1 = Math.min(d.length, Math.ceil(E.start + w * E.spp) + 1);
          for (let s = s0; s < s1; s++) { const x = xOf(s), y = mid - d[s] * amp; s === s0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
          ctx.stroke();
          if (E.spp < 0.15) { ctx.fillStyle = C.wave; for (let s = s0; s < s1; s++) ctx.fillRect(xOf(s) - 1.5, mid - d[s] * amp - 1.5, 3, 3); }
        } else {
          ctx.fillStyle = C.wave;
          for (let x = 0; x < w; x++) {
            const s0 = E.start + x * E.spp;
            if (s0 >= b.length) break;
            const pr = peakRange(a.peaks, b, c, s0, s0 + E.spp);
            if (!pr) continue;
            const ya = mid - pr[1] * amp, yb = mid - pr[0] * amp;
            ctx.fillRect(x, ya, 1, Math.max(1, yb - ya));
          }
        }
      }
    }
    // selection
    if (E.sel) {
      const x0 = xOf(E.sel[0]), x1 = xOf(E.sel[1]);
      ctx.fillStyle = alpha(C.sel, 0.22); ctx.fillRect(x0, top, x1 - x0, h - top);
      ctx.fillStyle = C.sel; ctx.fillRect(Math.round(x0), top, 1, h - top); ctx.fillRect(Math.round(x1), top, 1, h - top);
      ctx.fillStyle = alpha(C.sel, 0.6); ctx.fillRect(x0, 0, x1 - x0, RUL);
    }
    // markers & regions
    for (const m of (E.A.markers || [])) {
      const x0 = xOf(m.pos);
      if (m.end != null) {
        const x1 = xOf(m.end); if (x1 < 0 || x0 > w) continue;
        ctx.fillStyle = alpha(C.ok, 0.1); ctx.fillRect(x0, top, x1 - x0, h - top);
        ctx.fillStyle = alpha(C.ok, 0.85); ctx.fillRect(x0, top, Math.max(2, x1 - x0), 3);
        ctx.fillRect(Math.round(x0), top, 1, h - top); ctx.fillRect(Math.round(x1), top, 1, h - top);
        ctx.fillStyle = C.fg; ctx.fillText(m.name, Math.max(x0, 0) + 4, top + 14);
      } else {
        if (x0 < -60 || x0 > w) continue;
        ctx.fillStyle = C.sel; ctx.fillRect(Math.round(x0), top, 1, h - top);
        ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x0 + 8, top); ctx.lineTo(x0 + 8, top + 9); ctx.lineTo(x0, top + 13); ctx.fill();
        ctx.fillStyle = C.fg; ctx.fillText(m.name, x0 + 11, top + 10);
      }
    }
    // cursor
    const cx = Math.round(xOf(E.cursor)) + 0.5;
    ctx.fillStyle = C.accent; ctx.fillRect(cx - 0.5, 0, 1.5, h);
    // playhead
    if (E.playing && Engine.previewSrc === E.playing) {
      const ps = (Engine.ctx.currentTime - E.playing.t0 + E.playing.off) * sr();
      const px = xOf(ps);
      ctx.fillStyle = C.fg; ctx.fillRect(px, 0, 2, h);
    }
  }
  function drawOverview() {
    const cv = $('#edOverCanvas');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = C.panel; ctx.fillRect(0, 0, w, h);
    if (!E.A) return;
    const b = E.A.buffer, spp = b.length / w, mid = h / 2;
    ctx.fillStyle = alpha(C.wave, 0.55);
    for (let x = 0; x < w; x++) { const pr = peakRange(E.A.peaks, b, -1, x * spp, (x + 1) * spp); if (pr) ctx.fillRect(x, mid - pr[1] * (h / 2 - 3), 1, Math.max(1, (pr[1] - pr[0]) * (h / 2 - 3))); }
    const vw = $('#edWave').clientWidth;
    const x0 = E.start / spp, x1 = (E.start + vw * E.spp) / spp;
    ctx.fillStyle = alpha(C.accent, 0.12); ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0 - 1), h - 1);
    if (E.sel) { ctx.fillStyle = alpha(C.sel, 0.35); ctx.fillRect(E.sel[0] / spp, 0, Math.max(1, (E.sel[1] - E.sel[0]) / spp), h); }
  }
  function rangeStats(a, b) {
    let pk = 0, sum = 0, dc = 0, n = 0;
    const B = E.A.buffer;
    for (let c = 0; c < B.numberOfChannels; c++) {
      const d = B.getChannelData(c);
      for (let i = a; i < b; i++) { const v = d[i]; const av = v < 0 ? -v : v; if (av > pk) pk = av; sum += v * v; dc += v; n++; }
    }
    return { pk: gainToDb(pk), rms: n ? 10 * Math.log10(sum / n + 1e-20) : -120, dc: n ? dc / n * 100 : 0 };
  }
  let statsT = null;
  function drawStats() {
    const dl = $('#edStats');
    if (!E.A) { dl.innerHTML = ''; return; }
    clearTimeout(statsT);
    statsT = setTimeout(() => {
      if (!E.A) return;
      const b = E.A.buffer, r = E.sel || [0, b.length];
      const st = r[1] - r[0] > 0 && r[1] - r[0] < 40 * 1048576 ? rangeStats(r[0], r[1]) : { pk: -120, rms: -120, dc: 0 };
      const rows = [
        ['File length', fmtTime(b.duration)], ['Format', (b.sampleRate / 1000).toFixed(1) + ' kHz · ' + (b.numberOfChannels === 1 ? 'mono' : b.numberOfChannels === 2 ? 'stereo' : b.numberOfChannels + ' ch') + ' · 32f'],
        ['Cursor', fmtTime(E.cursor / sr())],
        ['Selection', E.sel ? fmtTime(E.sel[0] / sr()) + ' → ' + fmtTime(E.sel[1] / sr()) : 'none'],
        ['Sel. length', E.sel ? fmtTime((E.sel[1] - E.sel[0]) / sr()) + ' · ' + (E.sel[1] - E.sel[0]) + ' smp' : '—'],
        ['Peak', fmtDb(st.pk) + ' dBFS'], ['RMS', fmtDb(st.rms) + ' dBFS'], ['DC offset', st.dc.toFixed(3) + ' %'],
        ['Tempo', E.A.bpm ? E.A.bpm.toFixed(2) + ' BPM' : E.A.analyzing ? 'analysing…' : '—'],
        ['Key', E.A.key ? E.A.key.name + ' · ' + E.A.key.camelot : '—'],
        ['Zoom', E.spp >= 1 ? '1:' + Math.round(E.spp) : Math.round(1 / E.spp) + ':1'],
      ];
      dl.innerHTML = '';
      for (const [k, v] of rows) dl.append(el('dt', {}, k), el('dd', {}, v));
    }, 40);
  }
  // spectrum: live from master analyser while playing, else static FFT of selection
  function drawSpectrum(live) {
    const cv = $('#edSpectrum');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = C.panel; ctx.fillRect(0, 0, w, h);
    const fx = (f, nyq) => Math.log(f / 20) / Math.log(Math.min(20000, nyq) / 20) * w;
    const dy = (db) => clamp((-db) / 100 * (h - 16), 0, h - 16) + 4;
    ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--font-mono');
    ctx.fillStyle = C.faint;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = fx(f, 22050); ctx.fillStyle = C.lineSoft; ctx.fillRect(x, 0, 1, h); ctx.fillStyle = C.faint; ctx.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 2, h - 3); }
    for (const db of [-20, -40, -60, -80]) { ctx.fillStyle = C.lineSoft; ctx.fillRect(0, dy(db), w, 1); ctx.fillStyle = C.faint; ctx.fillText(db, w - 24, dy(db) - 2); }
    let mags = null, nyq = 22050;
    if (live && Engine.ctx) {
      const an = Engine.master.spec; mags = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(mags); nyq = Engine.ctx.sampleRate / 2;
    } else if (E.A) {
      const N = 8192, b = E.A.buffer; nyq = b.sampleRate / 2;
      let a0 = E.sel ? E.sel[0] : Math.max(0, E.cursor - N / 2), a1 = E.sel ? E.sel[1] : Math.min(b.length, a0 + N);
      if (a1 - a0 < N) { a0 = Math.max(0, Math.round((a0 + a1) / 2 - N / 2)); a1 = Math.min(b.length, a0 + N); }
      const frames = Math.max(1, Math.min(48, Math.floor((a1 - a0) / N)));
      const stride = Math.max(N, Math.floor((a1 - a0 - N) / Math.max(1, frames - 1)));
      const re = new Float64Array(N), im = new Float64Array(N), win = FFT.hann(N), acc = new Float64Array(N / 2);
      for (let f = 0; f < frames; f++) {
        const s = a0 + f * stride; re.fill(0); im.fill(0);
        for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < N && s + i < d.length; i++) re[i] += d[s + i] * win[i] / b.numberOfChannels; }
        FFT.transform(re, im, false);
        for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
      }
      mags = new Float32Array(N / 2);
      for (let k = 0; k < N / 2; k++) mags[k] = 10 * Math.log10(acc[k] / frames / (N * N / 16) + 1e-20);
    }
    if (!mags) return;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, alpha(C.accent, 0.55)); grad.addColorStop(1, alpha(C.accent, 0.02));
    ctx.beginPath(); ctx.moveTo(0, h);
    const n = mags.length;
    let lastX = -1, maxv = -200;
    for (let k = 1; k < n; k++) {
      const f = k * nyq / n; if (f < 20) continue; if (f > 20000) break;
      const x = Math.round(fx(f, nyq));
      maxv = Math.max(maxv, mags[k]);
      if (x !== lastX) { ctx.lineTo(x, dy(maxv)); lastX = x; maxv = -200; }
    }
    ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = C.muted; ctx.fillText(live ? 'Live spectrum · master' : E.sel ? 'Spectrum · selection' : 'Spectrum · at cursor', 8, 12);
  }
  const specKey = (w, h) => [E.A.id, E.A.version, Math.round(E.start), E.spp.toFixed(4), Math.round(w), Math.round(h)].join('|');
  let specT = null;
  function requestSpec(w, h) {
    clearTimeout(specT);
    specT = setTimeout(async () => {
      if (!E.A || !E.spec) return;
      const key = specKey(w, h);
      const b = E.A.buffer, s0 = Math.floor(E.start), s1 = Math.min(b.length, Math.ceil(E.start + w * E.spp));
      const pad = 1024;
      const a0 = Math.max(0, s0 - pad), a1 = Math.min(b.length, s1 + pad);
      const ch = bufferChannels(b).map((d) => d.slice(a0, a1));
      try {
        const r = await Pool.run('spectrogram', { ch, sr: b.sampleRate, cols: Math.round(w), rows: Math.round(h - RUL) }, ch.map((c) => c.buffer));
        const cvs = document.createElement('canvas'); cvs.width = r.cols; cvs.height = r.rows;
        const cx = cvs.getContext('2d'), img = cx.createImageData(r.cols, r.rows);
        const lut = specLut();
        for (let i = 0; i < r.data.length; i++) { const v = r.data[i] * 4; img.data[i * 4] = lut[v]; img.data[i * 4 + 1] = lut[v + 1]; img.data[i * 4 + 2] = lut[v + 2]; img.data[i * 4 + 3] = 255; }
        cx.putImageData(img, 0, 0);
        E.specCache = { key, canvas: cvs };
        drawWave();
      } catch (e) { console.warn(e); }
    }, 90);
  }
  let _lut = null;
  function specLut() {
    if (_lut) return _lut;
    _lut = new Uint8ClampedArray(256 * 4);
    const stops = [[0, [8, 10, 18]], [0.35, [48, 20, 92]], [0.6, [190, 50, 80]], [0.8, [255, 150, 40]], [1, [255, 245, 200]]];
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [ta, ca] = stops[k], [tb, cb] = stops[k + 1], f = (t - ta) / (tb - ta);
      for (let j = 0; j < 3; j++) _lut[i * 4 + j] = ca[j] + (cb[j] - ca[j]) * f;
    }
    return _lut;
  }

  // ---- mouse ----
  function bind() {
    const wa = $('#edWave');
    wa.addEventListener('pointerdown', (e) => {
      if (!E.A || e.button !== 0) return;
      wa.setPointerCapture(e.pointerId);
      const r = wa.getBoundingClientRect(), s = sOf(e.clientX - r.left);
      if (e.shiftKey && (E.sel || E.cursor != null)) {
        const anchor = E.sel ? (Math.abs(s - E.sel[0]) < Math.abs(s - E.sel[1]) ? E.sel[1] : E.sel[0]) : E.cursor;
        E.drag = { anchor }; E.sel = [Math.min(anchor, s), Math.max(anchor, s)];
      } else { E.drag = { anchor: s }; E.sel = null; E.cursor = s; }
      draw();
    });
    wa.addEventListener('pointermove', (e) => {
      if (!E.drag) return;
      const r = wa.getBoundingClientRect(), x = e.clientX - r.left, s = sOf(x);
      if (x > r.width - 10) { E.start += E.spp * 20; clampView(); } else if (x < 10) { E.start -= E.spp * 20; clampView(); }
      const a = E.drag.anchor;
      E.sel = s === a ? null : [Math.min(a, s), Math.max(a, s)];
      draw();
    });
    const up = () => { if (E.drag) { E.drag = null; if (E.sel && E.sel[1] - E.sel[0] < 2) E.sel = null; draw(); } };
    wa.addEventListener('pointerup', up); wa.addEventListener('pointercancel', up);
    wa.addEventListener('dblclick', () => { if (E.A) { E.sel = [0, len()]; draw(); } });
    wa.addEventListener('wheel', (e) => {
      if (!E.A) return; e.preventDefault();
      const r = wa.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left);
      else { E.start += (e.deltaX || e.deltaY) * E.spp; clampView(); draw(); }
    }, { passive: false });
    wa.addEventListener('contextmenu', (e) => { e.preventDefault(); if (E.A) showMenu(e.clientX, e.clientY, editMenuItems()); });
    const ov = $('#edOverview');
    let od = false;
    const ovMove = (e) => { const r = ov.getBoundingClientRect(); const vw = wa.clientWidth; E.start = (e.clientX - r.left) / r.width * len() - vw * E.spp / 2; clampView(); draw(); };
    ov.addEventListener('pointerdown', (e) => { if (!E.A) return; od = true; ov.setPointerCapture(e.pointerId); ovMove(e); });
    ov.addEventListener('pointermove', (e) => { if (od) ovMove(e); });
    ov.addEventListener('pointerup', () => { od = false; });
    new ResizeObserver(() => { clampView(); draw(); }).observe(wa);
  }

  // ---- editing core ----
  const range = () => (E.sel ? [E.sel[0], E.sel[1]] : [0, len()]);
  function commit(newChs, label, newSel) {
    const a = E.A;
    a.undo.push(a.buffer); if (a.undo.length > 40) a.undo.shift(); a.redo = [];
    assetChanged(a, makeBuffer(newChs, sr()));
    E.sel = newSel === undefined ? E.sel : newSel;
    if (E.sel) E.sel = [clamp(E.sel[0], 0, len()), clamp(E.sel[1], 0, len())];
    E.cursor = clamp(E.cursor, 0, len());
    clampView(); E.specCache = null; draw();
    status(label);
  }
  const chs = () => bufferChannels(E.A.buffer);
  function splice(a, b, insert) { // replace [a,b) with insert (array of channels or null)
    return chs().map((d, c) => {
      const ins = insert ? insert[Math.min(c, insert.length - 1)] : null;
      const il = ins ? ins.length : 0;
      const o = new Float32Array(Math.max(1, d.length - (b - a) + il));
      o.set(d.subarray(0, a), 0); if (ins) o.set(ins, a); o.set(d.subarray(b), a + il);
      return o;
    });
  }
  function mapRange(fn, label) {
    if (!E.A) return;
    const [a, b] = range(); if (b <= a) return;
    const out = chs().map((d, c) => { const o = d.slice(); fn(o.subarray(a, b), c, a, b); return o; });
    commit(out, label);
  }
  function needSel(what) { if (!E.sel) { toast('Select part of the waveform to ' + what + '.'); return false; } return true; }

  const ops = {
    copy() { if (!E.A || !needSel('copy')) return; E.clip = chs().map((d) => d.slice(E.sel[0], E.sel[1])); status('Copied ' + fmtTime((E.sel[1] - E.sel[0]) / sr())); },
    cut() { if (!E.A || !needSel('cut')) return; ops.copy(); const a = E.sel[0]; commit(splice(E.sel[0], E.sel[1], null), 'Cut', null); E.cursor = a; draw(); },
    del() { if (!E.A || !needSel('delete')) return; const a = E.sel[0]; commit(splice(E.sel[0], E.sel[1], null), 'Deleted selection', null); E.cursor = a; draw(); },
    paste() {
      if (!E.A) return; if (!E.clip) { toast('Copy some audio first.'); return; }
      const nch = E.A.buffer.numberOfChannels;
      const ins = Array.from({ length: nch }, (_, c) => E.clip[c] || (E.clip.length > nch ? null : E.clip[0]));
      if (E.clip.length > nch) { const m = new Float32Array(E.clip[0].length); for (const d of E.clip) for (let i = 0; i < m.length; i++) m[i] += d[i] / E.clip.length; ins[0] = m; }
      const a = E.sel ? E.sel[0] : E.cursor, b = E.sel ? E.sel[1] : E.cursor;
      commit(splice(a, b, ins), 'Pasted', [a, a + ins[0].length]);
    },
    pasteMix() {
      if (!E.A || !E.clip) { toast('Copy some audio first.'); return; }
      const a = E.sel ? E.sel[0] : E.cursor;
      const out = chs().map((d, c) => { const o = d.slice(); const s = E.clip[Math.min(c, E.clip.length - 1)]; for (let i = 0; i < s.length && a + i < o.length; i++) o[a + i] += s[i]; return o; });
      commit(out, 'Mixed clipboard in');
    },
    pasteNew() { if (!E.clip) { toast('Copy some audio first.'); return; } const a = addAsset((E.A ? E.A.name : 'Clip') + ' (clip)', makeBuffer(E.clip.map((c) => c.slice()), sr())); open(a.id); },
    crop() { if (!E.A || !needSel('trim to')) return; const s = E.sel; commit(chs().map((d) => d.slice(s[0], s[1])), 'Trimmed to selection', null); E.cursor = 0; fit(); draw(); },
    silence() { if (!needSel('silence')) return; mapRange((r) => r.fill(0), 'Silenced selection'); },
    async insertSilence() {
      if (!E.A) return;
      const r = await showDialog({ title: 'Insert silence', fields: [{ id: 's', label: 'Length (seconds)', type: 'number', value: 1, step: 0.01, min: 0.001 }], ok: 'Insert' });
      if (!r || !(r.s > 0)) return;
      const n = Math.round(r.s * sr());
      commit(splice(E.cursor, E.cursor, chs().map(() => new Float32Array(n))), 'Inserted ' + r.s + ' s of silence', [E.cursor, E.cursor + n]);
    },
    async normalize(ask) {
      let target = -0.1, mode = 'peak';
      if (ask) { const r = await showDialog({ title: 'Normalize', fields: [{ id: 'mode', label: 'Normalize to', type: 'select', value: 'peak', options: [{ value: 'peak', label: 'Peak level' }, { value: 'rms', label: 'Average loudness (RMS)' }] }, { id: 't', label: 'Target', type: 'range', min: -30, max: 0, step: 0.1, value: -0.1, format: (v) => v.toFixed(1) + ' dB' }] }); if (!r) return; target = r.t; mode = r.mode; }
      const [a, b] = range(); const st = rangeStats(a, b);
      const cur = mode === 'peak' ? st.pk : st.rms;
      if (cur < -119) { toast('The selection is silent.'); return; }
      let g = dbToGain(target - cur);
      if (mode === 'rms' && st.pk + (target - cur) > -0.1) toast('Some peaks will clip. Use the limiter on the master or a lower target.');
      mapRange((r) => { for (let i = 0; i < r.length; i++) r[i] *= g; }, 'Normalized to ' + target.toFixed(1) + ' dB ' + mode);
    },
    async gain() {
      const r = await showDialog({ title: 'Volume', fields: [{ id: 'g', label: 'Gain', type: 'range', min: -30, max: 30, step: 0.1, value: 3, format: (v) => fmtDb(v) + ' dB' }] });
      if (!r) return; const g = dbToGain(r.g);
      mapRange((x) => { for (let i = 0; i < x.length; i++) x[i] *= g; }, 'Gain ' + fmtDb(r.g) + ' dB');
    },
    fadein() { mapRange((x) => { const n = x.length; for (let i = 0; i < n; i++) x[i] *= Math.sin(i / n * Math.PI / 2) ** 2; }, 'Faded in'); },
    fadeout() { mapRange((x) => { const n = x.length; for (let i = 0; i < n; i++) x[i] *= Math.cos(i / n * Math.PI / 2) ** 2; }, 'Faded out'); },
    reverse() { mapRange((x) => x.reverse(), 'Reversed'); },
    invert() { mapRange((x) => { for (let i = 0; i < x.length; i++) x[i] = -x[i]; }, 'Inverted polarity'); },
    dc() { mapRange((x) => { let m = 0; for (const v of x) m += v; m /= x.length || 1; for (let i = 0; i < x.length; i++) x[i] -= m; }, 'Removed DC offset'); },
    mono() {
      if (!E.A || E.A.buffer.numberOfChannels < 2) { toast('This file is already mono.'); return; }
      const c = chs(); const m = new Float32Array(c[0].length); for (let i = 0; i < m.length; i++) m[i] = (c[0][i] + c[1][i]) / 2;
      commit([m], 'Converted to mono');
    },
    stereo() { if (!E.A || E.A.buffer.numberOfChannels > 1) { toast('This file is already stereo.'); return; } const c = chs()[0]; commit([c.slice(), c.slice()], 'Converted to stereo'); },
    swap() { if (!E.A || E.A.buffer.numberOfChannels < 2) return; const c = chs(); commit([c[1].slice(), c[0].slice(), ...c.slice(2).map((x) => x.slice())], 'Swapped channels'); },
    async stretch() {
      if (!E.A) return;
      const [a, b] = range(); const cur = (b - a) / sr();
      const r = await showDialog({ title: 'Time stretch', desc: 'Changes length without changing pitch.', fields: [{ id: 'p', label: 'New length', type: 'range', min: 25, max: 400, step: 0.5, value: 100, format: (v) => v.toFixed(1) + ' % · ' + fmtTime(cur * v / 100, 2) }] });
      if (!r || r.p === 100) return;
      status('Stretching…');
      const seg = chs().map((d) => d.slice(a, b));
      const res = await Pool.run('stretch', { ch: seg, ratio: r.p / 100, sr: sr() }, seg.map((x) => x.buffer));
      commit(splice(a, b, res), 'Stretched to ' + r.p + ' %', E.sel ? [a, a + res[0].length] : null);
    },
    async pitch() {
      if (!E.A) return;
      const r = await showDialog({ title: 'Pitch shift', desc: 'Changes pitch without changing length.', fields: [{ id: 's', label: 'Semitones', type: 'range', min: -12, max: 12, step: 0.1, value: 2, format: (v) => (v > 0 ? '+' : '') + v.toFixed(1) }] });
      if (!r || !r.s) return;
      status('Shifting pitch…');
      const [a, b] = range(); const seg = chs().map((d) => d.slice(a, b));
      const res = await Pool.run('pitch', { ch: seg, semis: r.s, sr: sr() }, seg.map((x) => x.buffer));
      commit(splice(a, b, res), 'Pitch ' + (r.s > 0 ? '+' : '') + r.s + ' st');
    },
    captureNoise() {
      if (!E.A || !needSel('capture as the noise sample')) return;
      if ((E.sel[1] - E.sel[0]) / sr() < 0.05) { toast('Select at least 50 ms of noise only.'); return; }
      E.noise = chs().map((d) => d.slice(E.sel[0], E.sel[1]));
      toast('Noise profile captured (' + fmtTime((E.sel[1] - E.sel[0]) / sr(), 2) + '). Now select the audio to clean and run Noise reduction.', 'ok');
    },
    async denoise() {
      if (!E.A) return;
      if (!E.noise) { toast('First select a stretch of pure noise and choose Capture noise profile.'); return; }
      const r = await showDialog({ title: 'Noise reduction', desc: 'Removes the captured noise from the selection, or from the whole file.', fields: [{ id: 'red', label: 'Reduction', type: 'range', min: 3, max: 40, step: 1, value: 18, format: (v) => v + ' dB' }, { id: 'sens', label: 'Sensitivity', type: 'range', min: 0.5, max: 3, step: 0.05, value: 1.4, format: (v) => v.toFixed(2) }] });
      if (!r) return;
      status('Reducing noise on ' + Pool.size + ' threads…');
      const [a, b] = range(); const seg = chs().map((d) => d.slice(a, b));
      const noise = E.noise.map((x) => x.slice());
      try {
        const res = await Pool.run('denoise', { ch: seg, noise, sr: sr(), reduction: r.red, sensitivity: r.sens }, seg.map((x) => x.buffer));
        commit(splice(a, b, res), 'Noise reduced by up to ' + r.red + ' dB');
      } catch (e) { toast(e.message, 'err'); }
    },
    async gate() {
      const r = await showDialog({ title: 'Noise gate', fields: [{ id: 't', label: 'Threshold', type: 'range', min: -80, max: -10, step: 1, value: -45, format: (v) => v + ' dB' }, { id: 'rel', label: 'Release', type: 'range', min: 10, max: 500, step: 5, value: 120, format: (v) => v + ' ms' }] });
      if (!r) return;
      const th = dbToGain(r.t), rel = Math.exp(-1 / (r.rel / 1000 * sr())), att = Math.exp(-1 / (0.001 * sr())), hold = Math.round(0.02 * sr());
      const [a, b] = range(); const all = chs();
      const env = new Float32Array(b - a);
      for (let i = 0; i < env.length; i++) { let m = 0; for (const d of all) m = Math.max(m, Math.abs(d[a + i])); env[i] = m; }
      const g = new Float32Array(b - a); let cur = 0, h = 0;
      for (let i = 0; i < g.length; i++) { const open = env[i] > th; if (open) h = hold; else if (h > 0) h--; const tgt = open || h > 0 ? 1 : 0; cur = tgt > cur ? att * cur + (1 - att) * tgt : rel * cur + (1 - rel) * tgt; g[i] = cur; }
      mapRange((x) => { for (let i = 0; i < x.length; i++) x[i] *= g[i]; }, 'Gated below ' + r.t + ' dB');
    },
    async fx(type) {
      if (!E.A) return;
      const defs = FX[type];
      const preview = async (v) => {
        const [a, b] = range(); const e = Math.min(b, a + sr() * 8);
        const out = await fxRender(chs().map((d) => d.slice(a, e)), sr(), type, v);
        Engine.halt(); Engine.playBuffer(makeBuffer(out, sr()));
      };
      const r = await showDialog({ title: defs.title, desc: defs.desc, fields: defs.fields, preview });
      Engine.stopPreview();
      if (!r) return;
      status('Applying ' + defs.title + '…');
      const [a, b] = range();
      const out = await fxRender(chs().map((d) => d.slice(a, b)), sr(), type, r);
      commit(splice(a, b, out), defs.title + ' applied');
    },
    async analyze() { if (!E.A) return; await analyzeAsset(E.A); draw(); toast(E.A.bpm ? 'Tempo ' + E.A.bpm.toFixed(2) + ' BPM · key ' + (E.A.key ? E.A.key.name : '—') : 'Could not detect a tempo.'); },
    async exportWav(selOnly) {
      if (!E.A) return;
      const r = await showDialog({ title: 'Export WAV', fields: [{ id: 'bits', label: 'Bit depth', type: 'select', value: '24', options: [{ value: '16', label: '16-bit PCM' }, { value: '24', label: '24-bit PCM' }, { value: '32', label: '32-bit float' }] }], ok: 'Export' });
      if (!r) return;
      const [a, b] = selOnly && E.sel ? E.sel : [0, len()];
      downloadBlob(encodeWav(chs().map((d) => d.subarray(a, b)), sr(), +r.bits), safeName(E.A.name) + (selOnly && E.sel ? ' (selection)' : '') + '.wav');
      status('Exported WAV');
    },
    duplicateFile() { if (!E.A) return; const a = addAsset(E.A.name + ' copy', makeBuffer(chs().map((d) => d.slice()), sr()), { bpm: E.A.bpm, beats: E.A.beats, isLoop: E.A.isLoop, key: E.A.key }); open(a.id); },
    selectAll() { if (!E.A) return; E.sel = [0, len()]; draw(); },
    marker() { if (!E.A) return; const pos = E.playing ? Math.round((Engine.ctx.currentTime - E.playing.t0 + E.playing.off) * sr()) : E.cursor; E.A.markers = E.A.markers || []; const n = E.A.markers.filter((m) => m.end == null).length + 1; E.A.markers.push({ id: uid('mk'), pos, name: 'Marker ' + n }); sortMarks(); markDirty(); draw(); status('Inserted marker at ' + fmtTime(pos / sr())); },
    region() { if (!E.A || !needSel('turn into a region')) return; E.A.markers = E.A.markers || []; const n = E.A.markers.filter((m) => m.end != null).length + 1; E.A.markers.push({ id: uid('mk'), pos: E.sel[0], end: E.sel[1], name: 'Region ' + n }); sortMarks(); markDirty(); draw(); status('Created region ' + n); },
    async autoTrim() {
      if (!E.A) return;
      const r = await showDialog({ title: 'Auto trim / crop', desc: 'Removes silence at the start and end of the file.', fields: [{ id: 'th', label: 'Silence threshold', type: 'range', min: -80, max: -20, step: 1, value: -50, format: (v) => v + ' dB' }, { id: 'pad', label: 'Keep before/after', type: 'range', min: 0, max: 500, step: 5, value: 20, format: (v) => v + ' ms' }], ok: 'Trim' });
      if (!r) return;
      const th = dbToGain(r.th), all = chs(), n = len(); let a = 0, b = n;
      const loud = (i) => all.some((d) => Math.abs(d[i]) > th);
      while (a < n && !loud(a)) a++; while (b > a && !loud(b - 1)) b--;
      if (b <= a) { toast('The whole file is below the threshold.'); return; }
      const pad = Math.round(r.pad / 1000 * sr()); a = Math.max(0, a - pad); b = Math.min(n, b + pad);
      commit(all.map((d) => d.slice(a, b)), 'Trimmed ' + fmtTime(a / sr(), 2) + ' from the start and ' + fmtTime((n - b) / sr(), 2) + ' from the end', null);
      E.cursor = 0; fit(); draw();
    },
    async resample() {
      if (!E.A) return;
      const r = await showDialog({ title: 'Resample', desc: 'Converts the file to a new sample rate (length and pitch stay the same).', fields: [{ id: 'sr', label: 'New sample rate', type: 'select', value: String(sr()), options: [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000].map((v) => ({ value: String(v), label: (v / 1000) + ' kHz' })) }], ok: 'Resample' });
      if (!r || +r.sr === sr()) return;
      const nsr = +r.sr, b = E.A.buffer;
      const oc = new OfflineAudioContext(b.numberOfChannels, Math.ceil(b.duration * nsr), nsr);
      const s0 = oc.createBufferSource(); s0.buffer = b; s0.connect(oc.destination); s0.start();
      const out = await oc.startRendering();
      const a = E.A; a.undo.push(a.buffer); a.redo = [];
      const f = nsr / sr();
      (a.markers || []).forEach((m) => { m.pos = Math.round(m.pos * f); if (m.end != null) m.end = Math.round(m.end * f); });
      assetChanged(a, out); E.sel = null; E.cursor = 0; fit(); E.specCache = null; draw();
      status('Resampled to ' + (nsr / 1000) + ' kHz');
    },
    async bitDepth() {
      if (!E.A) return;
      const r = await showDialog({ title: 'Bit-depth converter', desc: 'Reduces resolution, as when saving to a lower bit depth. Dither hides the distortion of low-level detail.', fields: [{ id: 'bits', label: 'Bit depth', type: 'select', value: '16', options: ['8', '12', '16', '20', '24'].map((v) => ({ value: v, label: v + '-bit' })) }, { id: 'dither', label: 'Dither', type: 'select', value: 'tpdf', options: [{ value: 'none', label: 'None' }, { value: 'rect', label: 'Rectangular' }, { value: 'tpdf', label: 'Triangular (TPDF)' }, { value: 'shaped', label: 'Noise-shaped' }] }] });
      if (!r) return;
      const q = Math.pow(2, +r.bits - 1);
      mapRange((x) => {
        let e1 = 0;
        for (let i = 0; i < x.length; i++) {
          let d = 0;
          if (r.dither === 'rect') d = (Math.random() - 0.5) / q;
          else if (r.dither === 'tpdf' || r.dither === 'shaped') d = (Math.random() - Math.random()) / q;
          let v = x[i] + d - (r.dither === 'shaped' ? e1 : 0);
          const o = clamp(Math.round(v * q) / q, -1, 1 - 1 / q);
          e1 = o - v;
          x[i] = o;
        }
      }, 'Converted to ' + r.bits + '-bit' + (r.dither !== 'none' ? ' with dither' : ''));
    },
    async generate() {
      const r = await showDialog({ title: 'Generate audio', desc: 'Inserts a tone, noise, DTMF dial tones or silence at the cursor. With no file open, creates a new file.', fields: [
        { id: 'type', label: 'Waveform', type: 'select', value: 'sine', options: [{ value: 'sine', label: 'Sine' }, { value: 'square', label: 'Square' }, { value: 'sawtooth', label: 'Sawtooth' }, { value: 'triangle', label: 'Triangle' }, { value: 'white', label: 'White noise' }, { value: 'pink', label: 'Pink noise' }, { value: 'sweep', label: 'Sine sweep (20 Hz → 20 kHz)' }, { value: 'dtmf', label: 'DTMF (phone keys)' }, { value: 'silence', label: 'Silence' }] },
        { id: 'freq', label: 'Frequency (Hz)', type: 'number', value: 440, step: 0.01, min: 1 },
        { id: 'digits', label: 'DTMF digits', value: '0123456789*#' },
        { id: 'dur', label: 'Length (seconds)', type: 'number', value: 2, step: 0.01, min: 0.01 },
        { id: 'amp', label: 'Level', type: 'range', min: -60, max: 0, step: 0.5, value: -6, format: (v) => v + ' dBFS' }], ok: 'Generate' });
      if (!r) return;
      const rate = E.A ? sr() : (Engine.ctx ? Engine.ctx.sampleRate : 44100), g = dbToGain(r.amp);
      let n = Math.max(1, Math.round(r.dur * rate)), x;
      if (r.type === 'dtmf') {
        const map = { '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633], '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633], '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633], '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633] };
        const ds = (r.digits || '').toUpperCase().split('').filter((c) => map[c]); if (!ds.length) { toast('Enter digits 0–9, *, #, or A–D.'); return; }
        const on = Math.round(0.12 * rate), off = Math.round(0.06 * rate); n = ds.length * (on + off); x = new Float32Array(n);
        ds.forEach((c, k) => { const [f1, f2] = map[c]; for (let i = 0; i < on; i++) { const t = i / rate, e = Math.min(1, i / 80, (on - i) / 80); x[k * (on + off) + i] = g * 0.5 * e * (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t)); } });
      } else {
        x = new Float32Array(n); const f = r.freq; let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / rate, p = (f * t) % 1; let v = 0;
          switch (r.type) {
            case 'sine': v = Math.sin(2 * Math.PI * f * t); break;
            case 'square': v = p < 0.5 ? 1 : -1; break;
            case 'sawtooth': v = 2 * p - 1; break;
            case 'triangle': v = 1 - 4 * Math.abs(p - 0.5); break;
            case 'white': v = Math.random() * 2 - 1; break;
            case 'pink': { const w = Math.random() * 2 - 1; b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926; break; }
            case 'sweep': { const fi = 20 * Math.pow(1000, i / n); ph += 2 * Math.PI * fi / rate; v = Math.sin(ph); break; }
          }
          x[i] = v * g * Math.min(1, i / 64, (n - i) / 64);
        }
      }
      if (!E.A) { const a = addAsset('Generated ' + r.type, makeBuffer([x, x.slice()], rate)); open(a.id); return; }
      const ins = chs().map(() => x);
      commit(splice(E.cursor, E.cursor, ins), 'Inserted ' + fmtTime(n / rate, 2) + ' of ' + r.type, [E.cursor, E.cursor + n]);
    },
    async chain(fx) {
      if (!E.A) { toast('Open a file in the Editor first.'); return; }
      const list = fx || [];
      const preview = async (cur) => {
        const [a, b] = range(); const e = Math.min(b, a + sr() * 10);
        const out = await Plugins.render(chs().map((d) => d.slice(a, e)), sr(), cur.filter((f) => f.on));
        Engine.halt(); bus.emit('transport'); Engine.playBuffer(makeBuffer(out, sr()));
      };
      const res = await Chainer.open({ title: fx && fx.length === 1 ? Plugins.REG[fx[0].type].name + (E.sel ? ' · selection' : ' · whole file') : 'Plug-in Chainer' + (E.sel ? ' · selection' : ' · whole file'), fx: list, live: false, onPreview: preview, applyLabel: 'Apply' });
      Engine.stopPreview();
      if (!res || !res.some((f) => f.on)) return;
      status('Processing…');
      const [a, b] = range();
      const out = await Plugins.render(chs().map((d) => d.slice(a, b)), sr(), res.filter((f) => f.on));
      commit(splice(a, b, out.map((c) => c.subarray(0, b - a))), res.filter((f) => f.on).map((f) => Plugins.REG[f.type].name).join(' → ') + ' applied');
    },
    undo() { const a = E.A; if (!a || !a.undo.length) return; a.redo.push(a.buffer); assetChanged(a, a.undo.pop()); E.specCache = null; clampView(); draw(); status('Undo edit'); },
    redo() { const a = E.A; if (!a || !a.redo.length) return; a.undo.push(a.buffer); assetChanged(a, a.redo.pop()); E.specCache = null; clampView(); draw(); status('Redo edit'); },
  };

  function sortMarks() { E.A.markers.sort((p, q) => p.pos - q.pos); renderRegions(); }
  const FX = {
    eq: { title: 'Graphic EQ', desc: 'Five-band tone shaping with high- and low-cut filters.', fields: [
      { id: 'hp', label: 'Low cut', type: 'range', min: 20, max: 500, step: 1, value: 20, format: (v) => v <= 20 ? 'off' : v + ' Hz' },
      { id: 'low', label: 'Low (100 Hz)', type: 'range', min: -15, max: 15, step: 0.5, value: 0, format: (v) => fmtDb(v) + ' dB' },
      { id: 'mid', label: 'Mid', type: 'range', min: -15, max: 15, step: 0.5, value: 0, format: (v) => fmtDb(v) + ' dB' },
      { id: 'midF', label: 'Mid frequency', type: 'range', min: 200, max: 6000, step: 10, value: 1000, format: (v) => v + ' Hz' },
      { id: 'high', label: 'High (8 kHz)', type: 'range', min: -15, max: 15, step: 0.5, value: 0, format: (v) => fmtDb(v) + ' dB' },
      { id: 'lp', label: 'High cut', type: 'range', min: 2000, max: 20000, step: 100, value: 20000, format: (v) => v >= 20000 ? 'off' : (v / 1000).toFixed(1) + ' kHz' }] },
    comp: { title: 'Compressor', desc: 'Evens out loud and quiet passages.', fields: [
      { id: 't', label: 'Threshold', type: 'range', min: -50, max: 0, step: 0.5, value: -18, format: (v) => v + ' dB' },
      { id: 'r', label: 'Ratio', type: 'range', min: 1, max: 20, step: 0.1, value: 4, format: (v) => v.toFixed(1) + ':1' },
      { id: 'a', label: 'Attack', type: 'range', min: 0.5, max: 100, step: 0.5, value: 8, format: (v) => v + ' ms' },
      { id: 'rel', label: 'Release', type: 'range', min: 20, max: 1000, step: 5, value: 180, format: (v) => v + ' ms' },
      { id: 'mk', label: 'Make-up gain', type: 'range', min: 0, max: 24, step: 0.5, value: 6, format: (v) => '+' + v + ' dB' }] },
    reverb: { title: 'Reverb', desc: 'Places the sound in a room or hall.', fields: [
      { id: 'size', label: 'Decay time', type: 'range', min: 0.2, max: 8, step: 0.1, value: 2.2, format: (v) => v.toFixed(1) + ' s' },
      { id: 'mix', label: 'Wet mix', type: 'range', min: 0, max: 100, step: 1, value: 25, format: (v) => v + ' %' },
      { id: 'tone', label: 'Brightness', type: 'range', min: 1000, max: 16000, step: 100, value: 7000, format: (v) => (v / 1000).toFixed(1) + ' kHz' }] },
    delay: { title: 'Echo / delay', desc: 'Delay time is synced to the project tempo by default.', fields: [
      { id: 'time', label: 'Time', type: 'select', value: '0.75', options: [{ value: '0.25', label: '1/16' }, { value: '0.5', label: '1/8' }, { value: '0.75', label: 'Dotted 1/8' }, { value: '1', label: '1/4' }, { value: '1.5', label: 'Dotted 1/4' }, { value: '2', label: '1/2' }] },
      { id: 'fb', label: 'Feedback', type: 'range', min: 0, max: 90, step: 1, value: 35, format: (v) => v + ' %' },
      { id: 'mix', label: 'Wet mix', type: 'range', min: 0, max: 100, step: 1, value: 30, format: (v) => v + ' %' }] },
    chorus: { title: 'Chorus', desc: 'Thickens and widens the sound.', fields: [
      { id: 'rate', label: 'Rate', type: 'range', min: 0.1, max: 5, step: 0.05, value: 0.8, format: (v) => v.toFixed(2) + ' Hz' },
      { id: 'depth', label: 'Depth', type: 'range', min: 0.5, max: 8, step: 0.1, value: 3, format: (v) => v.toFixed(1) + ' ms' },
      { id: 'mix', label: 'Wet mix', type: 'range', min: 0, max: 100, step: 1, value: 45, format: (v) => v + ' %' }] },
    distort: { title: 'Saturation', desc: 'Warm analogue-style drive.', fields: [
      { id: 'drive', label: 'Drive', type: 'range', min: 1, max: 30, step: 0.5, value: 4, format: (v) => v.toFixed(1) + '×' },
      { id: 'mix', label: 'Wet mix', type: 'range', min: 0, max: 100, step: 1, value: 60, format: (v) => v + ' %' }] },
  };
  async function fxRender(src, rate, type, p) {
    const n = src[0].length, nch = src.length;
    const oc = new OfflineAudioContext(Math.max(2, nch), n, rate);
    const s = oc.createBufferSource(); s.buffer = makeBuffer(src, rate);
    const out = oc.createGain(); out.connect(oc.destination);
    const dry = oc.createGain(), wet = oc.createGain();
    if (type === 'eq') {
      const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hp; hp.Q.value = 0.707;
      const lo = oc.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 100; lo.gain.value = p.low;
      const mi = oc.createBiquadFilter(); mi.type = 'peaking'; mi.frequency.value = p.midF; mi.Q.value = 0.9; mi.gain.value = p.mid;
      const hi = oc.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 8000; hi.gain.value = p.high;
      const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(p.lp, rate / 2 - 100); lp.Q.value = 0.707;
      let chain = s;
      if (p.hp > 20) chain = chain.connect(hp);
      chain = chain.connect(lo).connect(mi).connect(hi);
      if (p.lp < 20000) chain = chain.connect(lp);
      chain.connect(out);
    } else if (type === 'comp') {
      const c = oc.createDynamicsCompressor(); c.threshold.value = p.t; c.ratio.value = p.r; c.attack.value = p.a / 1000; c.release.value = p.rel / 1000; c.knee.value = 6;
      const mk = oc.createGain(); mk.gain.value = dbToGain(p.mk);
      s.connect(c).connect(mk).connect(out);
    } else if (type === 'reverb') {
      const cv = oc.createConvolver(); cv.buffer = makeImpulse(oc, p.size, 2.5);
      const tone = oc.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = p.tone;
      dry.gain.value = 1 - p.mix / 200; wet.gain.value = p.mix / 100 * 1.4;
      s.connect(dry).connect(out); s.connect(cv).connect(tone).connect(wet).connect(out);
    } else if (type === 'delay') {
      const d = oc.createDelay(5); d.delayTime.value = 60 / P.bpm * parseFloat(p.time);
      const fb = oc.createGain(); fb.gain.value = p.fb / 100;
      const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 5000;
      dry.gain.value = 1; wet.gain.value = p.mix / 100;
      s.connect(dry).connect(out); s.connect(d); d.connect(f).connect(fb).connect(d); d.connect(wet).connect(out);
    } else if (type === 'chorus') {
      dry.gain.value = 1 - p.mix / 200; wet.gain.value = p.mix / 100;
      s.connect(dry).connect(out);
      const merger = oc.createChannelMerger(2), split = oc.createChannelSplitter(2);
      s.connect(split);
      [0, 1].forEach((c) => {
        const d = oc.createDelay(0.1); d.delayTime.value = 0.012 + c * 0.004;
        const lfo = oc.createOscillator(), lg = oc.createGain(); lfo.frequency.value = p.rate * (1 + c * 0.13); lg.gain.value = p.depth / 1000;
        lfo.connect(lg).connect(d.delayTime); lfo.start();
        split.connect(d, Math.min(c, nch - 1)); d.connect(merger, 0, c);
      });
      merger.connect(wet).connect(out);
    } else if (type === 'distort') {
      const ws = oc.createWaveShaper(); const k = p.drive; const cv = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) { const x = i / 1023.5 - 1; cv[i] = Math.tanh(k * x) / Math.tanh(k); }
      ws.curve = cv; ws.oversample = '4x';
      dry.gain.value = 1 - p.mix / 100; wet.gain.value = p.mix / 100 * 0.8;
      s.connect(dry).connect(out); s.connect(ws).connect(wet).connect(out);
    }
    s.start();
    const r = await oc.startRendering();
    return Array.from({ length: nch }, (_, c) => r.getChannelData(c).slice());
  }

  function editMenuItems() {
    return [
      { label: 'Cut', key: 'Ctrl+X', action: ops.cut }, { label: 'Copy', key: 'Ctrl+C', action: ops.copy }, { label: 'Paste', key: 'Ctrl+V', action: ops.paste },
      { label: 'Mix paste (overdub)', action: ops.pasteMix }, { label: 'Paste to new file', action: ops.pasteNew },
      { label: 'Delete', key: 'Del', action: ops.del }, { label: 'Trim to selection', key: 'Ctrl+T', action: ops.crop }, '-',
      { label: 'Select all', key: 'Ctrl+A', action: ops.selectAll }, { label: 'Zoom to selection', action: zoomSel }, '-',
      { label: 'Export selection as WAV…', action: () => ops.exportWav(true) },
    ];
  }
  function processMenuItems() {
    return [
      { label: 'Normalize…', action: () => ops.normalize(true) }, { label: 'Volume…', action: ops.gain },
      { label: 'Fade in', action: ops.fadein }, { label: 'Fade out', action: ops.fadeout },
      { label: 'Silence', action: ops.silence }, { label: 'Insert silence…', action: ops.insertSilence }, '-',
      { label: 'Reverse', action: ops.reverse }, { label: 'Invert polarity', action: ops.invert }, { label: 'Remove DC offset', action: ops.dc }, '-',
      { label: 'Time stretch…', action: ops.stretch }, { label: 'Pitch shift…', action: ops.pitch }, '-',
      { label: 'Auto trim / crop…', action: ops.autoTrim }, { label: 'Generate tone / noise / DTMF…', action: ops.generate }, '-',
      { label: 'Resample…', action: ops.resample }, { label: 'Bit-depth converter…', action: ops.bitDepth }, '-',
      { label: 'Insert marker', key: 'M', action: ops.marker }, { label: 'Selection to region', key: 'R', action: ops.region }, '-',
      { label: 'Capture noise profile', action: ops.captureNoise }, { label: 'Noise reduction…', action: ops.denoise }, { label: 'Noise gate…', action: ops.gate }, '-',
      { label: 'Convert to mono', action: ops.mono }, { label: 'Convert to stereo', action: ops.stereo }, { label: 'Swap channels', action: ops.swap }, '-',
      { label: 'Detect tempo and key', action: ops.analyze }, { label: 'Duplicate file', action: ops.duplicateFile }, { label: 'Export file as WAV…', action: () => ops.exportWav(false) },
    ];
  }
  function fxMenuItems() {
    const items = [{ label: 'Plug-in Chainer…', key: 'Ctrl+K', action: () => ops.chain([]) }];
    for (const g of Plugins.list()) { items.push('-', { label: g.cat, header: true }); for (const d of g.items) items.push({ label: d.name + '…', action: () => ops.chain([Plugins.instance(d.type)]) }); }
    return items;
  }
  function fxMenuItemsOld() {
    return [{ label: 'Graphic EQ…', action: () => ops.fx('eq') }, { label: 'Compressor…', action: () => ops.fx('comp') }, { label: 'Reverb…', action: () => ops.fx('reverb') }, { label: 'Echo / delay…', action: () => ops.fx('delay') }, { label: 'Chorus…', action: () => ops.fx('chorus') }, { label: 'Saturation…', action: () => ops.fx('distort') }];
  }

  // ---- playback ----
  function play() {
    if (!E.A) return;
    if (E.playing) { stop(); return; }
    Engine.halt(); bus.emit('transport');
    const b = E.A.buffer, a = E.sel ? E.sel[0] : E.cursor, e = E.sel ? E.sel[1] : b.length;
    E.playing = Engine.playBuffer(b, a / sr(), (e - a) / sr(), () => { E.playing = null; $('#edPlay').innerHTML = ''; $('#edPlay').append(icon('play')); draw(); });
    $('#edPlay').innerHTML = ''; $('#edPlay').append(icon('pause'));
    const tick = () => {
      if (!E.playing) return;
      drawWave(); drawSpectrum(true);
      const ps = (Engine.ctx.currentTime - E.playing.t0 + E.playing.off) * sr(), w = $('#edWave').clientWidth;
      if (xOf(ps) > w * 0.95) { E.start = ps - w * 0.05 * E.spp; clampView(); drawOverview(); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function stop() {
    if (E.playing) {
      const ps = (Engine.ctx.currentTime - E.playing.t0 + E.playing.off) * sr();
      if (!E.sel) E.cursor = clamp(Math.round(ps), 0, len());
    }
    Engine.stopPreview(); E.playing = null; $('#edPlay').innerHTML = ''; $('#edPlay').append(icon('play')); draw();
  }

  function key(e) {
    if (!E.A) return false;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (k === ' ') { play(); return true; }
    if (mod && k === 'x') { ops.cut(); return true; }
    if (mod && k === 'c') { ops.copy(); return true; }
    if (mod && k === 'v') { ops.paste(); return true; }
    if (mod && k === 'a') { ops.selectAll(); return true; }
    if (mod && k === 't') { ops.crop(); return true; }
    if (mod && k === 'z' && !e.shiftKey) { ops.undo(); return true; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { ops.redo(); return true; }
    if (k === 'delete' || k === 'backspace') { ops.del(); return true; }
    if (k === 'home') { E.cursor = 0; E.start = 0; clampView(); draw(); return true; }
    if (k === 'end') { E.cursor = len(); E.start = len(); clampView(); draw(); return true; }
    if (k === '+' || k === '=') { zoom(1.5); return true; }
    if (k === '-') { zoom(1 / 1.5); return true; }
    if (k === 'escape') { E.sel = null; draw(); return true; }
    if (k === 'm' && !mod) { ops.marker(); return true; }
    if (k === 'r' && !mod) { ops.region(); return true; }
    if (mod && k === 'k') { ops.chain([]); return true; }
    return false;
  }

  function renderRegions() {
    const box = $('#edRegions'); if (!box) return;
    box.innerHTML = '';
    const list = (E.A && E.A.markers) || [];
    if (!list.length) { box.append(el('p', { class: 'ch-empty' }, 'Press M to drop a marker at the cursor, or select audio and press R to make a region.')); return; }
    for (const m of list) {
      const del = el('button', { class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete ' + m.name }, '✕');
      del.addEventListener('click', (e) => { e.stopPropagation(); E.A.markers = E.A.markers.filter((x) => x !== m); renderRegions(); draw(); markDirty(); });
      const row = el('div', { class: 'reg-row', tabindex: '0' }, el('span', { class: 'reg-dot' + (m.end != null ? ' region' : '') }), el('span', { class: 'reg-name' }, m.name), el('span', { class: 'reg-time' }, fmtTime(m.pos / sr(), 2) + (m.end != null ? ' – ' + fmtTime(m.end / sr(), 2) : '')), del);
      const go = () => { if (m.end != null) { E.sel = [m.pos, m.end]; } else { E.sel = null; } E.cursor = m.pos; const w = $('#edWave').clientWidth; if (xOf(m.pos) < 0 || xOf(m.pos) > w) { E.start = m.pos - w * 0.1 * E.spp; clampView(); } draw(); };
      row.addEventListener('click', go); row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      row.addEventListener('dblclick', async () => { const r = await showDialog({ title: 'Rename', fields: [{ id: 'n', label: 'Name', value: m.name }], ok: 'Rename' }); if (r && r.n) { m.name = r.n; renderRegions(); draw(); markDirty(); } });
      box.append(row);
    }
    if (list.some((m) => m.end != null)) {
      const exp = el('button', { class: 'btn sm', style: { marginTop: '8px' } }, 'Export regions as WAV files');
      exp.addEventListener('click', async () => { for (const m of list.filter((x) => x.end != null)) { downloadBlob(encodeWav(chs().map((d) => d.subarray(m.pos, m.end)), sr(), 24), safeName(E.A.name + ' - ' + m.name) + '.wav'); await sleep(300); } });
      box.append(exp);
    }
  }
  function init() {
    bind();
    $$('[data-edtab]').forEach((b) => b.addEventListener('click', () => { $$('[data-edtab]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); $('#edStats').hidden = b.dataset.edtab !== 'info'; $('#edRegions').hidden = b.dataset.edtab !== 'regions'; renderRegions(); }));
    $('#edAsset').addEventListener('change', (e) => { if (e.target.value) open(e.target.value); });
    $('#edPlay').addEventListener('click', play); $('#edStop').addEventListener('click', stop);
    $('#edUndo').addEventListener('click', ops.undo); $('#edRedo').addEventListener('click', ops.redo);
    $('#edCut').addEventListener('click', ops.cut); $('#edCopy').addEventListener('click', ops.copy); $('#edPaste').addEventListener('click', ops.paste);
    $('#edDelete').addEventListener('click', ops.del); $('#edCrop').addEventListener('click', ops.crop);
    $$('[data-proc]').forEach((b) => b.addEventListener('click', () => { const p = b.dataset.proc; p === 'normalize' ? ops.normalize(false) : ops[p](); }));
    $('#edProcMenu').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, processMenuItems()); });
    $('#edFxMenu').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, fxMenuItems()); });
    $('#edChain').addEventListener('click', () => ops.chain([]));
    $('#edZIn').addEventListener('click', () => zoom(1.5)); $('#edZOut').addEventListener('click', () => zoom(1 / 1.5));
    $('#edZFit').addEventListener('click', () => { fit(); draw(); });
    $('#edSpecBtn').addEventListener('click', (e) => { E.spec = !E.spec; e.currentTarget.setAttribute('aria-pressed', String(E.spec)); draw(); });
    bus.on('assets', () => { if (E.A && !S.assets.has(E.A.id)) { E.A = null; } if (!E.A && S.assets.size && S.view === 'editor') { E.A = S.assets.values().next().value; fit(); } fillSelect(); if (S.view === 'editor') draw(); });
    bus.on('assetMeta', (a) => { if (a === E.A) drawStats(); });
  }
  return { init, open, draw, key, ops, processMenuItems, fxMenuItems, editMenuItems, get asset() { return E.A; }, ensure() { if (!E.A && S.assets.size) { E.A = S.assets.values().next().value; fillSelect(); fit(); } fillSelect(); } };
})();
