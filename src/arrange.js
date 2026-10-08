// ---------------------------------------------------------------------------
// Arrange view — multitrack timeline with tempo map, markers, clip effects,
// crossfades and a mixtape-oriented workflow
// ---------------------------------------------------------------------------
const Arrange = (() => {
  let TH = 76;
  const HEAD = 17, LANE_T = 15, LANE_M = 30;   // ruler rows: tempo 0–15, markers 15–30, bars 30–46
  let ppb = 26;                     // pixels per beat
  let drag = null, hover = null, pan = null;
  let clipboard = null;
  const tl = () => $('#tl'), sc = () => $('#tlScroll');

  let tool = 'edit';
  const snapBeat = (b, force) => {
    if (typeof PREF !== 'undefined' && !PREF.snapOn) return b;
    const s = force != null ? force : P.snap;
    return s > 0 ? Math.round(b / s) * s : b;
  };
  const xOf = (beat) => beat * ppb - sc().scrollLeft;
  const beatOf = (x) => (x + sc().scrollLeft) / ppb;
  const trackAtY = (y) => Math.floor((y + sc().scrollTop) / TH);
  const cursorBeat = () => (Engine.playing ? Engine.posBeats() : P.cursor);
  const fmtBpm = (v) => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(v * 10 % 1 ? 2 : 1));

  function totalBeats() { const vis = (tl().clientWidth || 800) / ppb; return Math.max(projectEndBeats() + P.bpb * 16, vis + P.bpb * 8, P.loop.end + 16); }
  // fade widths in beats (fades are stored in seconds)
  const fadeInBeats = (c) => (c.fadeIn > 0 ? T.s2b(T.b2s(c.start) + c.fadeIn) - c.start : 0);
  const fadeOutBeats = (c) => (c.fadeOut > 0 ? c.start + c.len - T.s2b(T.b2s(c.start + c.len) - c.fadeOut) : 0);
  const clipSecs = (c) => T.b2s(c.start + c.len) - T.b2s(c.start);

  // ---- headers ----
  function renderHeads() {
    const inner = $('#headsInner');
    inner.innerHTML = '';
    P.tracks.forEach((t, i) => {
      const name = el('input', { class: 'tname', value: t.name, 'aria-label': 'Track name', spellcheck: 'false' });
      name.addEventListener('change', () => { Hist.push(); t.name = name.value || t.name; bus.emit('tracks'); });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
      const tog = (cls, label, prop, title) => {
        const b = el('button', { class: 'tog ' + cls, 'aria-pressed': String(!!t[prop]), title }, label);
        b.addEventListener('click', () => {
          if (prop === 'arm') P.tracks.forEach((o) => { if (o !== t) o.arm = false; });
          t[prop] = !t[prop]; Engine.applyAll(); renderHeads(); bus.emit('tracks'); markDirty();
        });
        return b;
      };
      const vol = el('input', { type: 'range', class: 'slim', min: -60, max: 6, step: 0.1, value: t.vol, 'aria-label': 'Volume' });
      const volV = el('span', { class: 'val' }, fmtDb(t.vol) + ' dB');
      vol.addEventListener('input', () => { t.vol = parseFloat(vol.value); if (t.vol <= -59.9) t.vol = -120; volV.textContent = fmtDb(t.vol) + ' dB'; Engine.applyAll(); bus.emit('tracks'); markDirty(); });
      vol.addEventListener('dblclick', () => { t.vol = 0; vol.value = 0; volV.textContent = '0.0 dB'; Engine.applyAll(); });
      const pn = el('input', { type: 'range', class: 'slim', min: -1, max: 1, step: 0.01, value: t.pan, 'aria-label': 'Pan' });
      const panV = el('span', { class: 'val' }, panTxt(t.pan));
      pn.addEventListener('input', () => { t.pan = parseFloat(pn.value); panV.textContent = panTxt(t.pan); Engine.applyAll(); bus.emit('tracks'); markDirty(); });
      pn.addEventListener('dblclick', () => { t.pan = 0; pn.value = 0; panV.textContent = 'C'; Engine.applyAll(); });
      const more = el('button', { class: 'icon-btn', style: { width: '22px', height: '20px' }, title: 'Track options', 'aria-label': 'Track options' }, icon('more'));
      more.addEventListener('click', () => { const r = more.getBoundingClientRect(); trackMenu(t, i, r.left, r.bottom + 4); });
      const h = el('div', { class: 'thead' + (S.selTrack === t.id ? ' sel' : ''), style: { '--c': t.color, height: TH + 'px' } },
        el('div', { class: 'tstrip' }),
        el('div', { class: 'body' },
          el('div', { class: 'r1' }, el('span', { class: 'tnum' }, String(i + 1)), name, tog('m', 'M', 'mute', 'Mute'), tog('s', 'S', 'solo', 'Solo'), tog('r', 'R', 'arm', 'Arm for recording'), fxBtn(t), more),
          el('div', { class: 'r2' }, vol, volV),
          TH >= 64 ? el('div', { class: 'r2' }, pn, panV) : null,
          el('canvas', { class: 'tmeter', width: 200, height: 6, 'aria-hidden': 'true' })));
      h.addEventListener('pointerdown', () => { if (S.selTrack !== t.id) { S.selTrack = t.id; $$('.thead').forEach((x, j) => x.classList.toggle('sel', j === i)); draw(); } });
      h.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(t, i, e.clientX, e.clientY); });
      inner.append(h);
    });
    inner.append(el('div', { class: 'add-track' }, el('button', { class: 'btn sm ghost', onclick: () => addTrack() }, icon('plus'), 'Add track')));
  }
  function fxBtn(t) {
    const n = (t.fx || []).filter((f) => f.on).length;
    const b = el('button', { class: 'tog fx', 'aria-pressed': String(n > 0), title: n ? 'Track effects: ' + t.fx.map((f) => Plugins.REG[f.type] && Plugins.REG[f.type].name).join(' → ') : 'Add track effects' }, 'FX');
    b.addEventListener('click', () => Chainer.forTrack(t));
    return b;
  }
  const panTxt = (p) => (Math.abs(p) < 0.01 ? 'C' : (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100));

  function addTrack(name) { Hist.push(); const t = newTrack(name); P.tracks.push(t); Engine.syncTracks(); bus.emit('project'); return t; }
  function trackMenu(t, i, x, y) {
    showMenu(x, y, [
      { label: 'Track effects…', key: 'Shift+E', action: () => Chainer.forTrack(t) },
      { label: 'Track EQ…', key: 'Shift+Q', action: () => trackEqDialog(t) },
      { label: 'Transpose…', action: () => transpose(t) },
      '-',
      { label: (t.env && t.env.show === 'vol' ? '✓ ' : '') + 'Show volume envelope', key: 'V', action: () => showEnv(t, 'vol') },
      { label: (t.env && t.env.show === 'pan' ? '✓ ' : '') + 'Show pan envelope', key: 'P', action: () => showEnv(t, 'pan') },
      { label: 'Hide envelopes', disabled: !(t.env && t.env.show), action: () => showEnv(t, null) },
      { label: 'Clear envelope points', disabled: !(t.env && (t.env.vol.length || t.env.pan.length)), action: () => { Hist.push(); t.env.vol = []; t.env.pan = []; Engine.refresh(); draw(); } },
      '-',
      { label: 'Rename', action: async () => { const r = await showDialog({ title: 'Rename track', fields: [{ id: 'n', label: 'Name', value: t.name }], ok: 'Rename' }); if (r) { Hist.push(); t.name = r.n || t.name; bus.emit('project'); } } },
      { label: 'Change colour', action: () => { Hist.push(); t.color = TRACK_COLORS[(TRACK_COLORS.indexOf(t.color) + 1) % TRACK_COLORS.length]; bus.emit('project'); } },
      { label: 'Duplicate track', action: () => { Hist.push(); const c = JSON.parse(JSON.stringify(t)); c.id = uid('t'); c.name = t.name + ' copy'; c.clips.forEach((k) => (k.id = uid('c'))); P.tracks.splice(i + 1, 0, c); Engine.syncTracks(); Engine.refresh(); bus.emit('project'); } },
      { label: 'Move up', disabled: i === 0, action: () => { Hist.push(); P.tracks.splice(i - 1, 0, P.tracks.splice(i, 1)[0]); bus.emit('project'); } },
      { label: 'Move down', disabled: i === P.tracks.length - 1, action: () => { Hist.push(); P.tracks.splice(i + 1, 0, P.tracks.splice(i, 1)[0]); bus.emit('project'); } },
      { label: 'Render track to new file', action: () => renderTrack(t) },
      '-',
      { label: 'Delete track', action: () => { Hist.push(); P.tracks.splice(i, 1); Engine.syncTracks(); Engine.refresh(); bus.emit('project'); } },
    ]);
  }
  function showEnv(t, kind) { t.env = t.env || { vol: [], pan: [], show: null }; t.env.show = kind; draw(); if (kind) status((kind === 'vol' ? 'Volume' : 'Pan') + ' envelope: click the line to add points, drag to move, right-click a point to delete it.'); }
  async function transpose(t) {
    const r = await showDialog({ title: 'Transpose ' + t.name, desc: 'Shifts the pitch of every clip on this track without changing its timing.', fields: [{ id: 's', label: 'Semitones', type: 'range', min: -12, max: 12, step: 1, value: t.pitch || 0, format: (v) => (v > 0 ? '+' : '') + v }] });
    if (!r) return;
    Hist.push(); t.pitch = r.s; Engine.refresh(); draw();
    if (r.s) status('Transposing ' + t.name + ' by ' + (r.s > 0 ? '+' : '') + r.s + ' semitones…');
  }
  async function renderTrack(t) {
    const solo = P.tracks.map((x) => x.solo), mute = P.tracks.map((x) => x.mute);
    P.tracks.forEach((x) => { x.solo = x === t; x.mute = false; });
    try { const b = await Engine.render({ tail: 1 }); addAsset(t.name + ' (render)', b, { bpm: P.bpm, beats: b.duration * P.bpm / 60 }); toast('Rendered ' + t.name + ' to Media', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    P.tracks.forEach((x, i) => { x.solo = solo[i]; x.mute = mute[i]; });
    Engine.applyAll();
  }

  // ---- drawing ----
  function layout() {
    $('#tlSpacer').style.width = Math.ceil(totalBeats() * ppb) + 'px';
    $('#tlSpacer').style.height = (P.tracks.length * TH + 160) + 'px';
    $('#headsInner').style.transform = `translateY(${-sc().scrollTop}px)`;
  }
  const uiFont = () => getComputedStyle(document.body).fontFamily;
  function draw() {
    const cv = $('#tlCanvas');
    const box = tl();
    cv.style.width = box.clientWidth + 'px'; cv.style.height = box.clientHeight + 'px';
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = C.trackA; ctx.fillRect(0, 0, w, h);
    const st = sc().scrollTop;
    P.tracks.forEach((t, i) => {
      const y = i * TH - st; if (y > h || y + TH < 0) return;
      ctx.fillStyle = i % 2 ? C.trackB : C.trackA; ctx.fillRect(0, y, w, TH);
      if (S.selTrack === t.id) { ctx.fillStyle = alpha(C.fg, 0.03); ctx.fillRect(0, y, w, TH); }
      ctx.fillStyle = C.lineSoft; ctx.fillRect(0, y + TH - 1, w, 1);
    });
    // grid
    const b0 = Math.floor(beatOf(0)), b1 = Math.ceil(beatOf(w));
    const sub = ppb > 60 ? 0.25 : ppb > 30 ? 0.5 : 1;
    for (let b = Math.max(0, b0); b <= b1; b += sub) {
      const isBar = Math.abs(b % P.bpb) < 1e-9, isBeat = Math.abs(b % 1) < 1e-9;
      if (!isBar && ppb * P.bpb < 24) continue;
      if (isBar && ppb * P.bpb < 6 && (b / P.bpb) % 4) continue;
      const x = Math.round(xOf(b)) + 0.5;
      ctx.fillStyle = isBar ? C.gridBar : isBeat ? C.gridBeat : alpha(C.fg, 0.02);
      ctx.fillRect(x, 0, 1, h);
    }
    // loop region
    if (P.loop.end > P.loop.start) {
      const x0 = xOf(P.loop.start), x1 = xOf(P.loop.end);
      ctx.fillStyle = alpha(C.accent, P.loop.on ? 0.07 : 0.03); ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.fillStyle = alpha(C.accent, P.loop.on ? 0.5 : 0.2); ctx.fillRect(Math.round(x0), 0, 1, h); ctx.fillRect(Math.round(x1), 0, 1, h);
    }
    for (const m of P.markers || []) { const x = Math.round(xOf(m.b)) + 0.5; if (x >= 0 && x <= w) { ctx.fillStyle = alpha(C.sel, 0.45); ctx.fillRect(x, 0, 1, h); } }
    for (const m of T.list().slice(1)) { const x = Math.round(xOf(m.b)) + 0.5; if (x >= 0 && x <= w) { ctx.fillStyle = alpha(C.rec, 0.35); ctx.fillRect(x, 0, 1, h); } }
    // clips
    ctx.font = '600 11px ' + uiFont();
    P.tracks.forEach((t, i) => {
      const y = i * TH - st; if (y > h || y + TH < 0) return;
      for (const c of t.clips) {
        const x = xOf(c.start), cw = c.len * ppb;
        if (x > w || x + cw < 0) continue;
        drawClip(ctx, c, t, x, y + 2, cw, TH - 5, w);
      }
    });
    // envelopes
    P.tracks.forEach((t, i) => {
      const k = t.env && t.env.show; if (!k) return;
      const y0 = i * TH - st + 4, hh = TH - 10; if (y0 > h || y0 + hh < 0) return;
      const pts = t.env[k];
      const col = k === 'vol' ? C.ok : C.sel;
      ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath();
      const yv = (v) => envY(k, v, y0, hh);
      ctx.moveTo(0, yv(envAt(pts, beatOf(0), 0)));
      for (const p of pts) ctx.lineTo(xOf(p.b), yv(p.v));
      ctx.lineTo(w, yv(envAt(pts, beatOf(w), 0)));
      ctx.stroke();
      ctx.fillStyle = col;
      for (const p of pts) { ctx.beginPath(); ctx.arc(xOf(p.b), yv(p.v), 4, 0, Math.PI * 2); ctx.fill(); }
      ctx.font = '600 10px ' + uiFont(); ctx.fillText(k === 'vol' ? 'VOLUME' : 'PAN', 6, y0 + hh - 2);
    });
    if (!P.tracks.length) {
      ctx.fillStyle = C.faint; ctx.textAlign = 'center'; ctx.font = '14px ' + uiFont();
      ctx.fillText('Drag songs here, or use “Add to mix” in Media to build a mixtape', w / 2, h / 2); ctx.textAlign = 'left';
    }
    drawRuler();
    drawOverview();
    drawOverlay();
  }
  function fadePath(ctx, x0, x1, yTop, yBot, rising, lin) {
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const u = i / 16, g = lin ? u : Math.sin(u * Math.PI / 2);
      const x = x0 + (x1 - x0) * u, gy = rising ? g : (lin ? 1 - u : Math.cos(u * Math.PI / 2));
      const y = yBot - (yBot - yTop) * gy;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  function drawClip(ctx, c, t, x, y, w, h, viewW) {
    const A = S.assets.get(c.asset);
    const sel = S.selClip === c.id;
    const col = t.color;
    const r = 5;
    ctx.save();
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
    ctx.fillStyle = alpha(col, 0.18); ctx.fill();
    ctx.clip();
    ctx.fillStyle = alpha(col, sel ? 0.8 : 0.55); ctx.fillRect(x, y, w, HEAD);
    // clip-effects badge
    const nfx = (c.fx || []).filter((f) => f.on).length;
    const bx = Math.max(x, 0) + 3;
    if (w > 26) {
      ctx.fillStyle = nfx ? C.sel : alpha(C.bg, 0.55);
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, y + 2, 20, 13, 3) : ctx.rect(bx, y + 2, 20, 13); ctx.fill();
      ctx.fillStyle = nfx ? '#fff' : C.fg; ctx.font = '700 9px ' + uiFont(); ctx.fillText(nfx ? 'fx' + nfx : 'fx', bx + (nfx ? 3 : 5), y + 12);
      ctx.font = '600 11px ' + uiFont();
    }
    if (A) {
      const base = clipBase(c);
      const peaks = c.stem ? (A.stems.peaks && A.stems.peaks[c.stem]) : A.peaks;
      const synced = isSynced(c, A);
      const info = [];
      if (c.stem) info.push(c.stem);
      if (synced) info.push(fmtBpm(A.bpm) + ' BPM'); else info.push('free time');
      if (A.key) info.push(A.key.camelot);
      const st = clipSemis(c, t); if (st) info.push((st > 0 ? '+' : '') + st + ' st');
      if (synced && c.keylock === false) info.push('varispeed');
      ctx.fillStyle = C.fg;
      ctx.fillText(A.name + '  ·  ' + info.join(' · '), Math.max(x, 0) + (w > 26 ? 28 : 5), y + 12);
      if (base && peaks) {
        const top = y + HEAD + 2, hh = h - HEAD - 4, mid = top + hh / 2, amp = hh / 2 * Math.min(2, dbToGain(c.gain || 0));
        const sr = base.sampleRate, clen = clipSecs(c), cs = T.b2s(c.start);
        ctx.fillStyle = alpha(C.wave, 0.85);
        const px0 = Math.max(Math.floor(x), 0), px1 = Math.min(Math.ceil(x + w), viewW);
        let prev = null;
        for (let px = px0; px < px1; px++) {
          const bt = c.start + (px - x) / ppb, bt2 = bt + 1 / ppb;
          const t0 = clipBufTime(c, bt);
          if (t0 == null) { prev = null; continue; }
          let t1 = clipBufTime(c, bt2); if (t1 == null || t1 < t0) t1 = t0 + (prev != null ? Math.abs(t0 - prev) : 0.001);
          if (prev != null && t0 < prev - 0.01 && px > x + 2) { ctx.fillStyle = alpha(col, 0.95); ctx.fillRect(px, top, 1, hh); ctx.fillStyle = alpha(C.wave, 0.85); }
          prev = t0;
          const pr = peakRange(peaks, base, -1, t0 * sr, Math.max(t0 * sr + 1, t1 * sr));
          if (!pr) continue;
          const g = clipGainAt(c, T.b2s(bt) - cs, clen) / Math.max(1e-6, dbToGain(c.gain || 0));
          const y0 = mid - pr[1] * amp * g, y1 = mid - pr[0] * amp * g;
          ctx.fillRect(px, y0, 1, Math.max(1, y1 - y0));
        }
        let pending = false; for (const v of A.stretch.values()) if (v === 'pending') { pending = true; break; }
        if (pending && synced) { ctx.fillStyle = alpha(C.fg, 0.65); ctx.font = '10px ' + uiFont(); ctx.fillText('time-stretching…', Math.max(x, 0) + 6, y + h - 5); }
      } else if (c.stem && A.stems.state !== 'done') {
        ctx.fillStyle = C.muted; ctx.fillText('stem not separated yet', Math.max(x, 0) + 6, y + HEAD + 16);
      }
    } else { ctx.fillStyle = C.rec; ctx.fillText('missing audio', x + 30, y + 12); }
    // fade curves
    ctx.strokeStyle = alpha(C.fg, 0.8); ctx.lineWidth = 1.2;
    const lin = c.fadeCurve === 'lin';
    if (c.fadeIn > 0) fadePath(ctx, x, x + fadeInBeats(c) * ppb, y + HEAD, y + h, true, lin);
    if (c.fadeOut > 0) fadePath(ctx, x + w - fadeOutBeats(c) * ppb, x + w, y + HEAD, y + h, false, lin);
    ctx.restore();
    ctx.strokeStyle = sel ? C.fg : alpha(col, 0.95); ctx.lineWidth = sel ? 1.6 : 1;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r) : ctx.rect(x, y, w, h); ctx.stroke();
    if (sel || (hover && hover.clip === c)) {
      ctx.fillStyle = C.fg;
      const fi = x + fadeInBeats(c) * ppb, fo = x + w - fadeOutBeats(c) * ppb;
      ctx.fillRect(fi - 3, y + HEAD - 3, 6, 6); ctx.fillRect(fo - 3, y + HEAD - 3, 6, 6);
    }
  }
  function drawRuler() {
    const cv = $('#ruler');
    const wrap = $('#rulerWrap');
    cv.style.width = wrap.clientWidth + 'px'; cv.style.height = wrap.clientHeight + 'px';
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const mono = getComputedStyle(document.body).getPropertyValue('--font-mono');
    // lanes
    ctx.fillStyle = alpha(C.rec, 0.05); ctx.fillRect(0, 0, w, LANE_T);
    ctx.fillStyle = alpha(C.sel, 0.04); ctx.fillRect(0, LANE_T, w, LANE_M - LANE_T);
    ctx.fillStyle = C.lineSoft; ctx.fillRect(0, LANE_T, w, 1); ctx.fillRect(0, LANE_M, w, 1);
    // tempo curve (faint) across the tempo lane
    const L = T.list();
    let lo = Infinity, hi = -Infinity; for (const m of L) { lo = Math.min(lo, m.bpm); hi = Math.max(hi, m.bpm); }
    if (hi - lo > 0.01) {
      ctx.strokeStyle = alpha(C.rec, 0.45); ctx.lineWidth = 1; ctx.beginPath();
      for (let x = 0; x <= w; x += 3) { const v = T.bpmAt(Math.max(0, beatOf(x))); const yy = LANE_T - 2 - (v - lo) / (hi - lo) * (LANE_T - 4); x ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); }
      ctx.stroke();
    }
    ctx.font = '600 10px ' + mono;
    L.forEach((m, i) => {
      const x = Math.round(xOf(m.b)); if (x < -120 || x > w + 2) return;
      const selT = S.selTempo === m.id;
      ctx.fillStyle = selT ? C.accent : C.rec;
      ctx.fillRect(x, 1, 1.5, LANE_T - 1); ctx.fillRect(x, 1, 8, 8);
      const label = (m.ramp ? '↗ ' : '') + fmtBpm(i === 0 ? P.bpm : m.bpm) + (i === 0 ? ' BPM · ' + P.bpb + '/4' : '');
      ctx.fillStyle = C.fg; ctx.fillText(label, x + 11, 10);
    });
    // markers
    ctx.font = '11px ' + mono;
    for (const m of P.markers || []) {
      const x = Math.round(xOf(m.b)); if (x < -120 || x > w + 2) continue;
      ctx.fillStyle = C.sel; ctx.beginPath(); ctx.moveTo(x, LANE_T + 2); ctx.lineTo(x + 8, LANE_T + 2); ctx.lineTo(x + 8, LANE_T + 10); ctx.lineTo(x, LANE_T + 13); ctx.fill();
      ctx.fillStyle = C.fg; ctx.fillText(m.name, x + 11, LANE_T + 11);
    }
    // loop bar + bar numbers
    if (P.loop.end > P.loop.start) {
      const x0 = xOf(P.loop.start), x1 = xOf(P.loop.end);
      ctx.fillStyle = alpha(C.accent, P.loop.on ? 0.85 : 0.3);
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, LANE_M + 2, x1 - x0, 5, 2) : ctx.rect(x0, LANE_M + 2, x1 - x0, 5); ctx.fill();
    }
    ctx.font = '11px ' + mono;
    const barPx = ppb * P.bpb;
    const every = barPx < 10 ? 32 : barPx < 18 ? 16 : barPx < 28 ? 8 : barPx < 50 ? 4 : barPx < 90 ? 2 : 1;
    const bar0 = Math.max(0, Math.floor(beatOf(0) / P.bpb)), bar1 = Math.ceil(beatOf(w) / P.bpb);
    for (let bar = bar0; bar <= bar1; bar++) {
      if (bar % every && barPx < 6) continue;
      const x = Math.round(xOf(bar * P.bpb)) + 0.5;
      ctx.fillStyle = C.line; ctx.fillRect(x, h - (bar % every === 0 ? 10 : 5), 1, 10);
      if (bar % every === 0) { ctx.fillStyle = C.muted; ctx.fillText(String(bar + 1), x + 3, h - 3); }
      if (barPx > 60) for (let b = 1; b < P.bpb; b++) { ctx.fillStyle = C.lineSoft; ctx.fillRect(Math.round(xOf(bar * P.bpb + b)), h - 4, 1, 4); }
    }
  }
  function drawOverview() {
    const cv = $('#ovCanvas'); if (!cv) return;
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    const end = Math.max(projectEndBeats() + P.bpb * 4, (tl().clientWidth || 800) / ppb);
    const k = w / end, n = Math.max(1, P.tracks.length), rowH = clamp((h - 6) / n, 1.5, 6);
    if (P.loop.end > P.loop.start) { ctx.fillStyle = alpha(C.accent, P.loop.on ? 0.18 : 0.08); ctx.fillRect(P.loop.start * k, 0, (P.loop.end - P.loop.start) * k, h); }
    P.tracks.forEach((t, i) => {
      ctx.fillStyle = alpha(t.color, 0.9);
      for (const c of t.clips) ctx.fillRect(c.start * k, 3 + i * rowH * (n * rowH > h - 6 ? (h - 6) / (n * rowH) : 1), Math.max(1, c.len * k), Math.max(1, rowH - 0.5));
    });
    for (const m of T.list().slice(1)) { ctx.fillStyle = C.rec; ctx.fillRect(m.b * k, 0, 1, h); }
    for (const m of P.markers || []) { ctx.fillStyle = C.sel; ctx.fillRect(m.b * k, 0, 1, h); }
    const v0 = beatOf(0) * k, v1 = beatOf(tl().clientWidth || w) * k;
    ctx.strokeStyle = C.fg; ctx.lineWidth = 1; ctx.strokeRect(v0 + 0.5, 0.5, Math.max(3, v1 - v0 - 1), h - 1);
    ctx.fillStyle = alpha(C.fg, 0.06); ctx.fillRect(v0, 0, v1 - v0, h);
    const pb = cursorBeat(); ctx.fillStyle = Engine.playing ? C.accent : C.sel; ctx.fillRect(pb * k, 0, 1.5, h);
    cv._k = k;
  }
  function drawOverlay() {
    const cv = $('#tlOverlay'); const box = tl();
    cv.style.width = box.clientWidth + 'px'; cv.style.height = box.clientHeight + 'px';
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const cx = Math.round(xOf(P.cursor)) + 0.5;
    ctx.fillStyle = alpha(C.sel, 0.7); ctx.fillRect(cx, 0, 1, h);
    if (Engine.playing) {
      const px = Math.round(xOf(Engine.posBeats())) + 0.5;
      ctx.fillStyle = C.accent; ctx.fillRect(px - 0.5, 0, 2, h);
    }
    if (drag && drag.kind === 'range') {
      const a = xOf(Math.min(drag.b0, drag.b1)), b = xOf(Math.max(drag.b0, drag.b1));
      ctx.fillStyle = alpha(C.sel, 0.12); ctx.fillRect(a, 0, b - a, h);
    }
  }

  // envelope geometry: volume in dB (−60…+6, sqrt-shaped), pan −1…1
  function envY(k, v, y0, hh) { if (k === 'pan') return y0 + hh / 2 - v * hh / 2; const n = Math.sqrt(clamp((v + 60) / 66, 0, 1)); return y0 + hh - n * hh; }
  function envV(k, y, y0, hh) { const f = clamp((y0 + hh - y) / hh, 0, 1); if (k === 'pan') return clamp(f * 2 - 1, -1, 1); return Math.round((f * f * 66 - 60) * 10) / 10; }
  function envHit(x, y) {
    const ti = trackAtY(y), t = P.tracks[ti]; if (!t) return null;
    if (tool === 'env' && (!t.env || !t.env.show)) { t.env = t.env || { vol: [], pan: [], show: null }; t.env.show = 'vol'; }
    if (!t.env || !t.env.show) return null;
    const k = t.env.show, pts = t.env[k], y0 = ti * TH - sc().scrollTop + 4, hh = TH - 10;
    for (let i = 0; i < pts.length; i++) if (Math.abs(xOf(pts[i].b) - x) < 7 && Math.abs(envY(k, pts[i].v, y0, hh) - y) < 7) return { t, k, i, y0, hh };
    const ly = envY(k, envAt(pts, beatOf(x), 0), y0, hh);
    if (Math.abs(ly - y) < 6 || (tool === 'env' && y >= y0 - 2 && y <= y0 + hh + 2)) return { t, k, i: -1, y0, hh };
    return null;
  }
  // ---- hit testing ----
  function hit(x, y) {
    const ti = trackAtY(y); const t = P.tracks[ti]; if (!t) return null;
    const b = beatOf(x);
    const ty = ti * TH - sc().scrollTop + 2;
    for (let i = t.clips.length - 1; i >= 0; i--) {
      const c = t.clips[i];
      if (b < c.start || b > c.start + c.len) continue;
      const cx = xOf(c.start), cw = c.len * ppb, ly = y - ty;
      const fi = cx + fadeInBeats(c) * ppb, fo = cx + cw - fadeOutBeats(c) * ppb;
      const bx = Math.max(cx, 0) + 3;
      let zone = 'body';
      if (cw > 26 && ly >= 1 && ly <= 16 && x >= bx && x <= bx + 20) zone = 'fx';
      else if (ly < HEAD + 4 && Math.abs(x - fi) < 6) zone = 'fadeIn';
      else if (ly < HEAD + 4 && Math.abs(x - fo) < 6) zone = 'fadeOut';
      else if (x - cx < 7 && cw > 16) zone = 'left';
      else if (cx + cw - x < 7 && cw > 16) zone = 'right';
      return { clip: c, track: t, ti, zone };
    }
    return { track: t, ti };
  }
  const cursorFor = { body: 'grab', left: 'w-resize', right: 'e-resize', fadeIn: 'ew-resize', fadeOut: 'ew-resize', fx: 'pointer' };

  function findClip(id) { for (const t of P.tracks) { const c = t.clips.find((k) => k.id === id); if (c) return { c, t }; } return null; }
  function selected() { return S.selClip ? findClip(S.selClip) : null; }

  function bindPointer() {
    const s = sc();
    s.addEventListener('pointerdown', (e) => {
      if (e.button === 1) { // middle-drag pans in both directions
        e.preventDefault(); pan = { x: e.clientX, y: e.clientY, l: s.scrollLeft, t: s.scrollTop }; s.setPointerCapture(e.pointerId); s.style.cursor = 'grabbing'; return;
      }
      if (e.button !== 0) return;
      s.focus({ preventScroll: true });
      const r = s.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (x > s.clientWidth || y > s.clientHeight) return; // scrollbar
      const eh = envHit(x, y);
      if (eh) {
        Hist.push();
        const pts = eh.t.env[eh.k];
        let idx = eh.i;
        if (idx < 0) { const nb = Math.max(0, snapBeat(beatOf(x), P.snap > 0 ? P.snap / 4 : 0)); pts.push({ b: nb, v: envV(eh.k, y, eh.y0, eh.hh) }); pts.sort((p, q) => p.b - q.b); idx = pts.findIndex((p) => p.b === nb); }
        drag = { kind: 'env', eh, pt: pts[idx], moved: true, pushed: true };
        s.setPointerCapture(e.pointerId); draw(); return;
      }
      const hh = hit(x, y);
      const b = beatOf(x);
      if (tool === 'erase') {
        if (hh && hh.clip) { Hist.push(); rippleRemove(hh.clip, hh.track); }
        drag = { kind: 'erase', moved: true }; s.setPointerCapture(e.pointerId); Engine.refresh(); draw(); return;
      }
      if (tool === 'sel' || (tool === 'env' && !hh)) {
        S.selClip = null; if (hh) S.selTrack = hh.track.id;
        drag = { kind: 'range', b0: snapBeat(b), b1: snapBeat(b), moved: false }; s.setPointerCapture(e.pointerId); draw(); return;
      }
      if (tool === 'draw' && hh && !hh.clip) {
        const A = drawAsset(); if (!A) { status('Pick a file in Media first (or select a clip): the Draw tool paints it onto tracks.'); return; }
        Hist.push();
        const c = clipFor(A, Math.max(0, snapBeat(b))); c.start = Math.max(0, snapBeat(b)); c.offB = A.isLoop ? 0 : c.offB;
        if (c.sync && !A.isLoop) { c.offB = 0; c.len = Math.min(c.len, clipMaxLen(c)); }
        hh.track.clips.push(c); S.selClip = c.id; S.selTrack = hh.track.id;
        drag = { kind: 'draw', clip: c, track: hh.track, ti: hh.ti, b0: c.start, y0: y, orig: { ...c }, moved: true, pushed: true };
        s.setPointerCapture(e.pointerId); draw(); return;
      }
      if (hh && hh.clip) {
        S.selClip = hh.clip.id; S.selTrack = hh.track.id;
        if (hh.zone === 'fx') { draw(); clipFx(hh.clip); return; }
        let clip = hh.clip, pushed = false;
        if (e.altKey && hh.zone === 'body') { Hist.push(); clip = JSON.parse(JSON.stringify(clip)); clip.id = uid('c'); hh.track.clips.push(clip); S.selClip = clip.id; pushed = true; }
        drag = { kind: hh.zone, clip, track: hh.track, ti: hh.ti, b0: b, y0: y, orig: { ...clip }, moved: false, pushed };
        s.setPointerCapture(e.pointerId);
        if (hh.zone === 'body') s.style.cursor = 'grabbing';
        draw(); bus.emit('selection');
      } else {
        S.selClip = null;
        if (hh) S.selTrack = hh.track.id;
        drag = { kind: 'range', b0: snapBeat(b), b1: snapBeat(b), moved: false };
        s.setPointerCapture(e.pointerId);
        draw(); bus.emit('selection');
      }
    });
    s.addEventListener('pointermove', (e) => {
      if (pan) { s.scrollLeft = pan.l - (e.clientX - pan.x); s.scrollTop = pan.t - (e.clientY - pan.y); return; }
      const r = s.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (!drag) {
        const eh = envHit(x, y);
        if (eh) { s.style.cursor = eh.i >= 0 ? 'move' : 'copy'; return; }
        const hh = hit(x, y);
        const nh = hh && hh.clip ? hh : null;
        if ((nh && nh.clip) !== (hover && hover.clip)) { hover = nh; draw(); }
        s.style.cursor = tool === 'erase' ? (nh ? 'not-allowed' : 'default') : tool === 'sel' ? 'text' : tool === 'draw' && !nh ? 'crosshair' : nh ? cursorFor[nh.zone] : 'default';
        if (nh && nh.zone === 'fx') s.title = 'Clip effects (E)'; else s.title = '';
        return;
      }
      // auto-scroll while dragging near the edges
      if (x > s.clientWidth - 24) s.scrollLeft += 12; else if (x < 24 && s.scrollLeft > 0) s.scrollLeft -= 12;
      const b = beatOf(x);
      if (drag.kind === 'env') {
        const pts = drag.eh.t.env[drag.eh.k];
        drag.pt.b = Math.max(0, e.shiftKey ? b : snapBeat(b, P.snap > 0 ? P.snap / 4 : 0)); drag.pt.v = envV(drag.eh.k, y, drag.eh.y0, drag.eh.hh);
        pts.sort((p, q) => p.b - q.b);
        status((drag.eh.k === 'vol' ? 'Volume ' + fmtDb(drag.pt.v) + ' dB' : 'Pan ' + panTxt(drag.pt.v)) + ' at ' + fmtBars(drag.pt.b, P.bpb));
        draw(); return;
      }
      if (drag.kind === 'range') { drag.b1 = snapBeat(Math.max(0, b)); drag.moved = drag.moved || Math.abs(drag.b1 - drag.b0) > 0; drawOverlay(); return; }
      if (drag.kind === 'erase') { const h2 = hit(x, y); if (h2 && h2.clip) { rippleRemove(h2.clip, h2.track); Engine.refresh(); draw(); } return; }
      if (drag.kind === 'draw') {
        const c = drag.clip, A = S.assets.get(c.asset), ne = Math.max(c.start + (P.snap > 0 ? P.snap : 0.25), e.shiftKey ? b : snapBeat(b));
        if (A && A.isLoop) { c.loop = true; c.len = ne - c.start; } else c.len = Math.min(ne - c.start, clipMaxLen(c));
        layout(); draw(); return;
      }
      const d = b - drag.b0;
      if (!drag.moved && Math.abs(d * ppb) < 3 && Math.abs(y - drag.y0) < 4) return;
      if (!drag.pushed) { Hist.push(); drag.pushed = true; }
      drag.moved = true;
      const c = drag.clip, o = drag.orig;
      if (drag.kind === 'body') {
        c.start = Math.max(0, e.shiftKey ? o.start + d : snapBeat(o.start + d));
        const nt = clamp(trackAtY(y), 0, P.tracks.length - 1);
        const tt = P.tracks[nt];
        if (tt && tt !== drag.track) { drag.from = drag.from || drag.track; drag.track.clips = drag.track.clips.filter((k) => k !== c); tt.clips.push(c); drag.track = tt; S.selTrack = tt.id; }
        status(fmtBars(c.start, P.bpb) + ' · ' + fmtTime(T.b2s(c.start)));
      } else if (drag.kind === 'left') {
        Object.assign(c, o);
        const end = o.start + o.len;
        let ns = e.shiftKey ? o.start + d : snapBeat(o.start + d);
        ns = clamp(ns, 0, end - 0.0625);
        clipTrimStart(c, ns);
        if (!c.loop) {
          const A = S.assets.get(c.asset);
          if (isSynced(c, A) && c.offB < 0) clipTrimStart(c, c.start - c.offB);
          else if (!isSynced(c, A) && c.offset < 0) clipTrimStart(c, T.s2b(T.b2s(c.start) - c.offset));
        }
      } else if (drag.kind === 'right') {
        const ne = e.shiftKey ? o.start + o.len + d : snapBeat(o.start + o.len + d);
        c.len = Math.min(Math.max(0.0625, ne - o.start), clipMaxLen(c));
      } else if (drag.kind === 'fadeIn') {
        c.fadeIn = clamp(T.b2s(b) - T.b2s(c.start), 0, clipSecs(c) - (c.fadeOut || 0)); c.axIn = false;
        status('Fade in ' + c.fadeIn.toFixed(2) + ' s');
      } else if (drag.kind === 'fadeOut') {
        c.fadeOut = clamp(T.b2s(c.start + c.len) - T.b2s(b), 0, clipSecs(c) - (c.fadeIn || 0)); c.axOut = false;
        status('Fade out ' + c.fadeOut.toFixed(2) + ' s');
      }
      layout(); draw();
    });
    const end = () => {
      if (pan) { pan = null; s.style.cursor = 'default'; return; }
      if (!drag) return;
      const dd = drag; drag = null;
      s.style.cursor = 'default';
      if (dd.kind === 'range') {
        if (dd.moved) {
          Hist.push();
          P.loop.start = Math.min(dd.b0, dd.b1); P.loop.end = Math.max(dd.b0, dd.b1);
          P.cursor = P.loop.start;
          status('Selected ' + fmtBars(P.loop.start, P.bpb) + ' – ' + fmtBars(P.loop.end, P.bpb) + '. Press L to loop it.');
        } else {
          P.cursor = Math.max(0, dd.b0);
          if (Engine.playing) Engine.play(P.cursor);
        }
        bus.emit('transport');
      } else if (dd.moved) {
        if (dd.kind === 'right' && PREF.ripple && dd.orig) rippleShift(dd.track, dd.orig.start + dd.orig.len, dd.clip.len - dd.orig.len, dd.clip);
        if (dd.track && PREF.autoXfade && ['body', 'left', 'right', 'draw'].includes(dd.kind)) { autoXfade(dd.track); if (dd.from && dd.from !== dd.track) autoXfade(dd.from); }
        Engine.refresh(); markDirty();
      }
      draw();
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    s.addEventListener('pointerleave', () => { if (hover && !drag) { hover = null; draw(); } });
    s.addEventListener('dblclick', (e) => {
      const r = s.getBoundingClientRect(); const hh = hit(e.clientX - r.left, e.clientY - r.top);
      if (hh && hh.clip && hh.zone !== 'fx') clipProps(hh.clip, hh.track);
    });
    s.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = s.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const eh = envHit(x, y);
      if (eh && eh.i >= 0) { Hist.push(); eh.t.env[eh.k].splice(eh.i, 1); Engine.refresh(); draw(); return; }
      const hh = hit(x, y);
      if (hh && hh.clip) { S.selClip = hh.clip.id; draw(); clipMenu(hh.clip, hh.track, e.clientX, e.clientY, beatOf(x)); }
      else showMenu(e.clientX, e.clientY, [
        { label: 'Set cursor here', action: () => setCursor(snapBeat(beatOf(x))) },
        { label: 'Insert tempo change here…', key: 'T', action: () => tempoDialog(null, snapBeat(beatOf(x))) },
        { label: 'Insert marker here', key: 'M', action: () => addMarker(snapBeat(beatOf(x))) },
        { label: 'Paste clip here', key: 'Ctrl+V', disabled: !clipboard, action: () => paste(snapBeat(beatOf(x)), hh ? hh.ti : 0) },
        '-',
        { label: 'Add track', action: () => addTrack() },
        { label: 'Import audio…', action: () => $('#fileInput').click() },
      ]);
    });
    s.addEventListener('scroll', () => { layout(); draw(); });
    s.addEventListener('wheel', (e) => {
      const r = s.getBoundingClientRect(), x = e.clientX - r.left;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0025), x); }        // trackpad pinch arrives as ctrl+wheel
      else if (e.altKey) { e.preventDefault(); setTH(TH * (e.deltaY < 0 ? 1.12 : 1 / 1.12)); }
      else if (e.shiftKey && !e.deltaX) { e.preventDefault(); s.scrollLeft += e.deltaY; }
    }, { passive: false });
    // drop from media pool / files
    s.addEventListener('dragover', (e) => { const ty = [...e.dataTransfer.types]; if (ty.includes('text/x-rush-asset') || ty.includes('text/x-rush-explorer') || ty.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    s.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation();
      document.body.classList.remove('dropping');
      const r = s.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const beat = Math.max(0, snapBeat(beatOf(x), P.snap > 0 ? P.snap : 1)), ti = trackAtY(y);
      const id = e.dataTransfer.getData('text/x-rush-asset');
      if (id && S.assets.get(id)) placeAsset(S.assets.get(id), ti, beat);
      else if (e.dataTransfer.getData('text/x-rush-explorer')) Explorer.dropped(ti, beat);
      else if (e.dataTransfer.files.length) {
        const list = await importFiles([...e.dataTransfer.files]);
        let t = ti; for (const A of list) placeAsset(A, t++, beat);
      }
    });
  }
  function zoomAt(f, x) {
    const s = sc(); const b = beatOf(x);
    ppb = clamp(ppb * f, 0.25, 400);
    layout();
    s.scrollLeft = Math.max(0, b * ppb - x);
    draw();
  }
  function zoomFit() {
    const w = sc().clientWidth || 800, end = Math.max(projectEndBeats(), P.bpb * 4);
    ppb = clamp((w - 30) / end, 0.25, 400); layout(); sc().scrollLeft = 0; draw();
    status('Zoomed to show the whole project');
  }
  function zoomTo(b0, b1) {
    const w = sc().clientWidth || 800; if (b1 <= b0) return;
    ppb = clamp((w * 0.9) / (b1 - b0), 0.25, 400); layout(); sc().scrollLeft = Math.max(0, b0 * ppb - w * 0.05); draw();
  }
  function setTH(h) { TH = Math.round(clamp(h, 40, 180)); renderHeads(); layout(); draw(); try { localStorage.setItem('rush.th', TH); } catch (e) { } }
  function ensureVisible(b) {
    const s = sc(), x = xOf(b);
    if (x < 30 || x > s.clientWidth - 40) s.scrollLeft = Math.max(0, b * ppb - s.clientWidth * 0.3);
  }
  function ensureTrackVisible(ti) {
    const s = sc(), y = ti * TH;
    if (y < s.scrollTop) s.scrollTop = y; else if (y + TH > s.scrollTop + s.clientHeight) s.scrollTop = y + TH - s.clientHeight;
  }
  function setCursor(b) {
    P.cursor = Math.max(0, b);
    if (Engine.playing) Engine.play(P.cursor);
    ensureVisible(P.cursor); bus.emit('transport'); drawOverview();
  }

  // ---- clips ----
  function placeAsset(A, ti, beat) {
    Hist.push();
    let t = P.tracks[ti];
    if (!t) { t = newTrack(A.name); P.tracks.push(t); Engine.syncTracks(); }
    const c = clipFor(A, beat);
    t.clips.push(c);
    S.selClip = c.id; S.selTrack = t.id;
    if (PREF.autoXfade) autoXfade(t);
    Engine.refresh(); bus.emit('project');
    maybeBeatmap(A);
    return c;
  }
  // long songs get the Beatmapper the first time they are used (Options › Beatmapper for long songs)
  function maybeBeatmap(A) {
    if (!A || A.isLoop || A.beatmapped || A.revOf || !PREF.autoBeatmap || A.buffer.duration < PREF.beatmapMin) return;
    A.beatmapped = true;
    setTimeout(() => beatmap(A), 60);
  }
  async function beatmap(A) {
    if (!A) return;
    if (A.analyzing) await new Promise((res) => { const f = (x) => { if (x === A) res(); }; bus.on('assetMeta', f); setTimeout(res, 30000); });
    const first = !P.tracks.some((t) => t.clips.some((c) => c.asset !== A.id));
    const r = await Beatmapper.open(A, { first });
    A.beatmapped = true;
    if (!r || r.skip) return;
    Hist.push();
    applyGrid(A, r.bpm, r.db);
    const clips = []; for (const t of P.tracks) for (const c of t.clips) if (c.asset === A.id) clips.push([c, t]);
    for (const [c] of clips) if (!!c.sync !== !!r.sync) { toggleSync(c); Hist.undo.pop(); }
    if (r.setTempo && clips.length) { const c0 = clips.map(([c]) => c).sort((a, b) => a.start - b.start)[0]; const at = Math.max(0, c0.start - (c0.offB || 0)); if (at < 1e-6) setBpm(Math.round(r.bpm * 100) / 100); else T.add(at, Math.round(r.bpm * 100) / 100, false); }
    Engine.refresh(); draw(); markDirty();
    status('Beatmapped ' + A.name + ' at ' + r.bpm.toFixed(2) + ' BPM');
  }
  // move a song's beat grid while keeping every synced clip on the same audio
  function applyGrid(A, bpm, db) {
    if (Math.abs(bpm - (A.bpm || 0)) < 1e-6 && Math.abs(db - (A.downbeat || 0)) < 1e-6) return;
    const keep = [];
    for (const tr of P.tracks) for (const k of tr.clips) if (k.asset === A.id && isSynced(k, A)) keep.push([k, clipBufTime(k, k.start)]);
    A.bpm = bpm; A.downbeat = db; A.beats = A.buffer.duration * bpm / 60; A.stretch.clear();
    for (const [k, tStart] of keep) { if (tStart == null) continue; const end = k.start + k.len; k.offB = (tStart - db) * bpm / 60; k.len = Math.min(end - k.start, clipMaxLen(k)); }
    bus.emit('assets');
  }
  // the Draw tool paints the selected clip's file, else the last file in Media
  let lastDrawAsset = null;
  function drawAsset() {
    const s = selected(); if (s && S.assets.get(s.c.asset)) return (lastDrawAsset = S.assets.get(s.c.asset));
    if (lastDrawAsset && S.assets.has(lastDrawAsset.id)) return lastDrawAsset;
    const all = [...S.assets.values()]; return all[all.length - 1] || null;
  }
  function setTool(t) {
    tool = t;
    $$('.tool-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    const names = { edit: 'Edit tool: move, trim, fade and select clips', draw: 'Draw tool: drag on an empty part of a track to paint the selected file', env: 'Envelope tool: click a track to add volume points, drag to shape them', sel: 'Time selection tool: drag anywhere to select a range', erase: 'Erase tool: click or drag across clips to remove them' };
    status(names[t] || '');
    if (t === 'env') for (const tr of P.tracks) { tr.env = tr.env || { vol: [], pan: [], show: null }; if (!tr.env.show) tr.env.show = 'vol'; }
    draw();
  }
  // non-destructive reverse: the clip switches to a reversed copy of its file (made once, shared)
  function reversedOf(A) {
    const other = A.revOf ? S.assets.get(A.revOf) : A.revId ? S.assets.get(A.revId) : [...S.assets.values()].find((x) => x.revOf === A.id);
    if (other) { A.revId = A.revOf ? undefined : other.id; return other; }
    const chs = bufferChannels(A.buffer).map((c) => { const r = new Float32Array(c.length); for (let i = 0, n = c.length; i < n; i++) r[i] = c[n - 1 - i]; return r; });
    const dur = A.buffer.duration, p = A.bpm ? 60 / A.bpm : 0;
    const R = addAsset(A.name + ' (reversed)', makeBuffer(chs, A.buffer.sampleRate), { bpm: A.bpm, beats: A.beats, isLoop: A.isLoop, key: A.key, downbeat: p ? fmod(dur - (A.downbeat || 0), p) : 0 });
    R.revOf = A.id; R.beatmapped = true; A.revId = R.id;
    if (A.stems && A.stems.state === 'done') {
      const bufs = {}, peaks = {};
      for (const k in A.stems.buffers) { const b = A.stems.buffers[k]; bufs[k] = makeBuffer(bufferChannels(b).map((c) => { const r = new Float32Array(c.length); for (let i = 0, n = c.length; i < n; i++) r[i] = c[n - 1 - i]; return r; }), b.sampleRate); peaks[k] = computePeaks(bufs[k]); }
      R.stems = { state: 'done', buffers: bufs, peaks, promise: null, ms: 0 };
    }
    return R;
  }
  function reverse(c) {
    const A = S.assets.get(c.asset); if (!A) return;
    Hist.push();
    const base = clipBase(c), dur = base.duration;
    const R = reversedOf(A);
    if (isSynced(c, A)) {
      const p = 60 / A.bpm, t0 = (A.downbeat || 0) + (c.offB || 0) * p, t1 = t0 + c.len * p;
      c.asset = R.id; c.offB = (dur - t1 - (R.downbeat || 0)) / p;
      if (c.loop) c.offB = fmod(c.offB - srcBeatRange(R, base)[0], assetBeats(R, base)) + srcBeatRange(R, base)[0];
    } else {
      const secs = T.b2s(c.start + c.len) - T.b2s(c.start), o = c.offset || 0;
      c.asset = R.id; c.offset = c.loop ? fmod(dur - o - secs, dur) : Math.max(0, dur - o - secs);
    }
    [c.fadeIn, c.fadeOut] = [c.fadeOut || 0, c.fadeIn || 0]; [c.axIn, c.axOut] = [c.axOut, c.axIn];
    c.reversed = !c.reversed;
    Engine.refresh(); draw(); markDirty();
    status(c.reversed ? 'Clip reversed (non-destructive: the original file is untouched)' : 'Clip plays forwards again');
  }

  // ---- Track EQ: 5-band with a live response curve ----
  function trackEqDialog(t) {
    Hist.push();
    const before = JSON.stringify([t.low, t.mid, t.high, t.eq || null]);
    t.eq = trackEq(t);
    const cv = el('canvas', { class: 'teq-graph', 'aria-label': 'EQ response' });
    const ctl = el('div', { class: 'teq-ctl' });
    const live = () => { const n = Engine.nodes.get(t.id); if (n && Engine.ctx) { Engine.applyAll(); } drawG(); markDirty(); };
    const logF = (v) => Math.round(Math.exp(v)), linF = (f) => Math.log(f);
    const band = (title, rows) => el('div', { class: 'teq-band' }, el('h4', {}, title), ...rows);
    const slider = (label, get, set, min, max, step, fmt) => {
      const out = el('output', {}, fmt(get()));
      const i = el('input', { type: 'range', class: 'slim', min, max, step, value: get() });
      i.addEventListener('input', () => { set(parseFloat(i.value)); out.textContent = fmt(get()); live(); });
      i.addEventListener('dblclick', () => { i.value = min < 0 && max > 0 ? 0 : i.value; i.dispatchEvent(new Event('input')); });
      return el('label', { class: 'teq-row' }, el('span', {}, label), i, out);
    };
    const fHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz');
    const db = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
    ctl.append(
      band('Low cut', [slider('Freq', () => (t.eq.hp > 0 ? linF(t.eq.hp) : linF(10)), (v) => (t.eq.hp = v <= linF(12) ? 0 : logF(v)), linF(10), linF(1000), 0.01, () => (t.eq.hp > 0 ? fHz(t.eq.hp) : 'off'))]),
      band('Low', [slider('Gain', () => t.low, (v) => (t.low = v), -18, 18, 0.1, db), slider('Freq', () => linF(t.eq.lowF), (v) => (t.eq.lowF = logF(v)), linF(30), linF(1000), 0.01, () => fHz(t.eq.lowF))]),
      band('Mid', [slider('Gain', () => t.mid, (v) => (t.mid = v), -18, 18, 0.1, db), slider('Freq', () => linF(t.eq.midF), (v) => (t.eq.midF = logF(v)), linF(100), linF(12000), 0.01, () => fHz(t.eq.midF)), slider('Width', () => t.eq.midQ, (v) => (t.eq.midQ = v), 0.2, 8, 0.05, (v) => 'Q ' + v.toFixed(2))]),
      band('High', [slider('Gain', () => t.high, (v) => (t.high = v), -18, 18, 0.1, db), slider('Freq', () => linF(t.eq.highF), (v) => (t.eq.highF = logF(v)), linF(1500), linF(16000), 0.01, () => fHz(t.eq.highF))]),
      band('High cut', [slider('Freq', () => (t.eq.lp > 0 ? linF(t.eq.lp) : linF(20000)), (v) => (t.eq.lp = v >= linF(19500) ? 0 : logF(v)), linF(1000), linF(20000), 0.01, () => (t.eq.lp > 0 ? fHz(t.eq.lp) : 'off'))]));
    function drawG() {
      const r = cv.getBoundingClientRect(); if (!r.width) return;
      const { ctx, w, h } = fitCanvas(cv);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      const f0 = 20, f1 = 20000, xF = (f) => Math.log(f / f0) / Math.log(f1 / f0) * w, yD = (d) => h / 2 - d / 24 * (h / 2 - 8);
      ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--font-mono');
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { ctx.fillStyle = alpha(C.line, 0.9); ctx.fillRect(Math.round(xF(f)), 0, 1, h); ctx.fillStyle = C.faint; ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), xF(f) + 3, h - 4); }
      for (const d of [-12, 0, 12]) { ctx.fillStyle = alpha(C.line, d ? 0.6 : 1); ctx.fillRect(0, Math.round(yD(d)), w, 1); ctx.fillStyle = C.faint; ctx.fillText((d > 0 ? '+' : '') + d, 3, yD(d) - 3); }
      // exact response of the same biquads the engine uses
      const oc = new OfflineAudioContext(1, 1, 48000), N = Math.max(2, Math.floor(w)), fr = new Float32Array(N);
      for (let i = 0; i < N; i++) fr[i] = f0 * Math.pow(f1 / f0, i / (N - 1));
      const mk = (type, f, g, q) => { const b = oc.createBiquadFilter(); b.type = type; b.frequency.value = f; if (g != null) b.gain.value = g; if (q != null) b.Q.value = q; return b; };
      const e = t.eq, fl = [mk('highpass', e.hp > 0 ? e.hp : 10, null, 0.707), mk('lowshelf', e.lowF, t.low), mk('peaking', e.midF, t.mid, e.midQ), mk('highshelf', e.highF, t.high), mk('lowpass', e.lp > 0 ? e.lp : 23999, null, 0.707)];
      const tot = new Float32Array(N).fill(1), mag = new Float32Array(N), ph = new Float32Array(N);
      for (const b of fl) { b.getFrequencyResponse(fr, mag, ph); for (let i = 0; i < N; i++) tot[i] *= mag[i]; }
      ctx.beginPath();
      for (let i = 0; i < N; i++) { const y = yD(clamp(20 * Math.log10(tot[i] + 1e-9), -26, 26)); i ? ctx.lineTo(i, y) : ctx.moveTo(i, y); }
      ctx.strokeStyle = t.color || C.accent; ctx.lineWidth = 2; ctx.stroke();
      ctx.lineTo(w, h / 2); ctx.lineTo(0, h / 2); ctx.closePath(); ctx.fillStyle = alpha(t.color || C.accent, 0.12); ctx.fill();
    }
    const bg = el('div', { class: 'modal-bg' });
    const close = (ok) => {
      bg.remove(); document.removeEventListener('keydown', esc, true);
      if (!ok) { const [l, m, hi, eq] = JSON.parse(before); t.low = l; t.mid = m; t.high = hi; t.eq = eq || undefined; Hist.undo.pop(); Engine.applyAll(); }
      bus.emit('tracks'); renderHeads(); draw();
    };
    const box = el('div', { class: 'modal teq', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Track EQ' },
      el('header', {}, el('h3', {}, 'Track EQ · ' + t.name), el('p', {}, 'Changes are heard immediately. Double-click a gain slider to reset it.')),
      el('div', { class: 'teq-body' }, cv, ctl),
      el('footer', {}, el('button', { class: 'btn ghost', type: 'button', onclick: () => { t.low = t.mid = t.high = 0; t.eq = trackEq({}); close(true); trackEqDialog(t); Hist.undo.pop(); } }, 'Flat'), el('div', { class: 'spacer' }), el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'), el('button', { class: 'btn primary', type: 'button', onclick: () => close(true) }, 'OK')));
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); } };
    document.addEventListener('keydown', esc, true);
    bg.addEventListener('pointerdown', (e) => { if (e.target === bg) close(true); });
    bg.append(box); document.body.append(bg);
    requestAnimationFrame(drawG);
  }
  // a song's first downbeat lands on `beat`; its intro (if any) hangs to the left of it
  function clipFor(A, beat, stem = null) {
    const base = stem ? (A.stems.buffers && A.stems.buffers[stem]) || A.buffer : A.buffer;
    const syncSongs = !P.mix || P.mix.syncSongs !== false;
    const sync = !!(A.bpm && (A.isLoop || syncSongs));
    const c = { id: uid('c'), asset: A.id, stem, start: beat, len: 0, offset: 0, offB: 0, sync, loop: !!(sync && A.isLoop), gain: 0, fadeIn: 0, fadeOut: 0, fadeCurve: 'eq', fx: [], pitch: 0, keylock: true };
    if (!sync) { c.len = T.lenFor(beat, base.duration); return c; }
    if (A.isLoop) { c.len = A.beats; return c; }
    const [lo, hi] = srcBeatRange(A, base);
    c.start = Math.max(0, beat + lo);
    c.offB = -(beat - c.start);
    c.len = hi - c.offB;
    return c;
  }
  // mixtape: put the song on a new track, overlapping the end of the mix, with a crossfade
  function addToMix(A) {
    const mix = Object.assign({ overlap: 16, xfade: true, follow: false }, P.mix || {});
    Hist.push();
    const end = projectEndBeats();
    const start = end > 0 ? Math.max(0, Math.round((end - mix.overlap) / P.bpb) * P.bpb) : 0;
    const t = newTrack(A.name); P.tracks.push(t); Engine.syncTracks();
    const c = clipFor(A, start); t.clips.push(c);
    if (mix.follow && A.bpm && end > 0) {
      const from = T.bpmAt(start), to = A.isLoop ? A.bpm : A.bpm;
      if (Math.abs(from - to) > 0.05) {
        T.list();
        if (!P.tempo.some((m) => Math.abs(m.b - start) < 1e-6)) P.tempo.push({ id: uid('tm'), b: start, bpm: from, ramp: false });
        P.tempo.push({ id: uid('tm'), b: start + Math.max(P.bpb, mix.overlap), bpm: Math.round(to * 100) / 100, ramp: true });
      }
    }
    if (mix.xfade) crossfade(c, false);
    S.selClip = c.id; S.selTrack = t.id;
    maybeBeatmap(A);
    Engine.syncTracks(); Engine.refresh(); bus.emit('project'); bus.emit('tempo');
    ensureVisible(start); ensureTrackVisible(P.tracks.length - 1);
    status('Added ' + A.name + ' to the mix at bar ' + (Math.floor(start / P.bpb) + 1) + (mix.xfade && end > 0 ? ' with a ' + mix.overlap + '-beat crossfade' : ''));
    return c;
  }
  async function mixSettings() {
    const m = Object.assign({ overlap: 16, xfade: true, follow: false, syncSongs: true }, P.mix || {});
    const r = await showDialog({ title: 'Mixtape settings', desc: '“Add to mix” puts each song on its own track, overlapping the end of the mix.', ok: 'Save', fields: [
      { id: 'overlap', label: 'Overlap between songs', type: 'select', value: String(m.overlap), options: [0, 4, 8, 16, 32, 64].map((v) => ({ value: String(v), label: v ? v + ' beats (' + v / P.bpb + ' bars)' : 'No overlap' })) },
      { id: 'xfade', label: 'Crossfade overlapping songs', type: 'check', value: m.xfade },
      { id: 'follow', label: 'Ramp the tempo to each new song’s BPM during the overlap', type: 'check', value: m.follow },
      { id: 'syncSongs', label: 'Songs follow the project tempo (time-stretch, pitch kept)', type: 'check', value: m.syncSongs !== false }] });
    if (!r) return;
    Hist.push(); P.mix = { overlap: +r.overlap, xfade: r.xfade, follow: r.follow, syncSongs: r.syncSongs }; markDirty();
  }
  // crossfade a clip with every clip it overlaps (any track)
  function crossfade(c, push = true) {
    if (push) Hist.push();
    const cEnd = c.start + c.len; let n = 0;
    for (const t of P.tracks) for (const o of t.clips) {
      if (o === c) continue;
      const oEnd = o.start + o.len;
      if (o.start < c.start && oEnd > c.start + 1e-6) {          // o is fading out as c comes in
        const e = Math.min(oEnd, cEnd), sec = T.b2s(e) - T.b2s(c.start);
        c.fadeIn = Math.max(c.fadeIn || 0, sec); o.fadeOut = T.b2s(oEnd) - T.b2s(c.start) <= sec + 1e-6 ? sec : o.fadeOut; n++;
      } else if (o.start > c.start && o.start < cEnd - 1e-6 && oEnd > cEnd) {   // c fades out as o comes in
        const sec = T.b2s(cEnd) - T.b2s(o.start);
        c.fadeOut = Math.max(c.fadeOut || 0, sec); o.fadeIn = sec; n++;
      }
    }
    if (push) { Engine.refresh(); draw(); status(n ? 'Crossfaded with ' + n + ' overlapping clip' + (n > 1 ? 's' : '') : 'This clip does not overlap any other clip.'); }
    return n;
  }
  function crossfadeAll() {
    Hist.push(); let n = 0;
    for (const t of P.tracks) for (const c of t.clips) n += crossfade(c, false);
    Engine.refresh(); draw(); status(n ? 'Crossfaded every overlap in the project' : 'No overlapping clips found.');
  }
  async function clipFx(c) {
    Hist.push();
    c.fx = c.fx || [];
    const A = S.assets.get(c.asset);
    await Chainer.open({ title: 'Clip effects · ' + (A ? A.name : 'clip'), fx: c.fx, live: true, onChange: () => { Engine.updateClipFx(c); draw(); markDirty(); } });
    Engine.refresh(); draw();
  }

  function clipMenu(c, t, x, y, beat) {
    const A = S.assets.get(c.asset);
    const nfx = (c.fx || []).filter((f) => f.on).length;
    showMenu(x, y, [
      { label: 'Clip properties…', key: 'Alt+Enter', action: () => clipProps(c, t) },
      { label: 'Clip effects…' + (nfx ? ' (' + nfx + ')' : ''), key: 'E', action: () => clipFx(c) },
      { label: 'Pitch +1 semitone', key: 'Shift+↑', action: () => clipPitch(c, 1) },
      { label: 'Pitch −1 semitone', key: 'Shift+↓', action: () => clipPitch(c, -1) },
      { label: (c.keylock === false ? '✓ ' : '') + 'Varispeed (pitch follows tempo, like vinyl)', disabled: !c.sync, action: () => { Hist.push(); c.keylock = c.keylock === false; Engine.refresh(); draw(); } },
      { label: (c.reversed ? '✓ ' : '') + 'Reverse', key: 'Shift+R', action: () => reverse(c) },
      { label: 'Crossfade with overlapping clips', key: 'X', action: () => crossfade(c) },
      { label: 'Fade curve: ' + (c.fadeCurve === 'lin' ? 'linear → switch to smooth' : 'smooth → switch to linear'), action: () => { Hist.push(); c.fadeCurve = c.fadeCurve === 'lin' ? 'eq' : 'lin'; Engine.refresh(); draw(); } },
      { label: 'Remove fades', disabled: !(c.fadeIn || c.fadeOut), action: () => { Hist.push(); c.fadeIn = 0; c.fadeOut = 0; Engine.refresh(); draw(); } },
      '-',
      { label: 'Split at cursor', key: 'S', action: () => splitAt(c, t, P.cursor) },
      { label: 'Split here', action: () => splitAt(c, t, snapBeat(beat)) },
      { label: 'Copy', key: 'Ctrl+C', action: () => copy(c, t) },
      { label: 'Duplicate', key: 'Ctrl+D', action: () => duplicate(c, t) },
      { label: 'Delete', key: 'Del', action: () => del(c, t) },
      '-',
      { label: c.sync ? 'Free time (don’t follow tempo)' : 'Follow project tempo', disabled: !A || !A.bpm, action: () => toggleSync(c) },
      { label: c.loop ? 'Turn off looping' : 'Loop this clip', action: () => { Hist.push(); c.loop = !c.loop; if (!c.loop) c.len = Math.min(c.len, clipMaxLen(c)); Engine.refresh(); draw(); } },
      { label: 'Clip gain…', action: async () => { const r = await showDialog({ title: 'Clip gain', fields: [{ id: 'g', label: 'Gain', type: 'range', min: -24, max: 12, step: 0.1, value: c.gain || 0, format: (v) => fmtDb(v) + ' dB' }] }); if (r) { Hist.push(); c.gain = r.g; Engine.refresh(); draw(); } } },
      { label: 'Song tempo & key…', disabled: !A, action: () => sourceTempo(A) },
      { label: 'Beatmapper…', disabled: !A || A.isLoop, action: () => beatmap(A) },
      { label: 'Set project tempo to this song (' + (A && A.bpm ? fmtBpm(A.bpm) : '—') + ' BPM) here', disabled: !A || !A.bpm, action: () => T.add(c.start, Math.round(A.bpm * 100) / 100, false) },
      '-',
      { label: 'Open in Editor', disabled: !!c.stem, action: () => Editor.open(c.asset) },
      { label: 'Separate stems in Stems view', disabled: !!c.stem, action: () => { Deck.load(c.asset); setView('stems'); } },
    ]);
  }
  function clipPitch(c, d) { Hist.push(); c.pitch = clamp(Math.round(((c.pitch || 0) + d) * 100) / 100, -24, 24); Engine.refresh(); draw(); status('Clip pitch ' + (c.pitch > 0 ? '+' : '') + c.pitch + ' semitones'); }

  // ---- clip properties: tempo, beat grid (downbeat), pitch, stretching ----
  function clipProps(c, t) {
    const A = S.assets.get(c.asset); if (!A) return;
    const base = clipBase(c) || A.buffer;
    const st = { bpm: A.bpm || T.bpmAt(c.start), db: A.downbeat || 0, sync: !!c.sync, keylock: c.keylock !== false, pitch: c.pitch || 0, gain: c.gain || 0, loop: !!c.loop, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 };
    let view = { t0: 0, t1: base.duration }, prev = null, clickT = null;
    const bg = el('div', { class: 'modal-bg' });
    const num = (id, label, v, step, min, max) => { const i = el('input', { class: 'inp', type: 'number', id: 'cp-' + id, value: v, step, min, max }); return [el('label', { for: 'cp-' + id }, label), i]; };
    const chk = (id, label, v) => { const i = el('input', { type: 'checkbox', id: 'cp-' + id, checked: v ? true : null }); return el('label', { class: 'cp-chk', for: 'cp-' + id }, i, label); };
    const [lBpm, iBpm] = num('bpm', 'Song tempo (BPM)', +st.bpm.toFixed(3), 0.001, 20, 300);
    const [lDb, iDb] = num('db', 'First downbeat (seconds)', +st.db.toFixed(3), 0.001, 0, base.duration);
    const [lPitch, iPitch] = num('pitch', 'Pitch shift (semitones)', st.pitch, 0.5, -24, 24);
    const [lGain, iGain] = num('gain', 'Clip gain (dB)', +st.gain.toFixed(1), 0.5, -48, 24);
    const [lFi, iFi] = num('fi', 'Fade in (s)', +st.fadeIn.toFixed(2), 0.1, 0, 600);
    const [lFo, iFo] = num('fo', 'Fade out (s)', +st.fadeOut.toFixed(2), 0.1, 0, 600);
    const cSync = chk('sync', 'Follow project tempo (time-stretch)', st.sync);
    const cKey = chk('key', 'Preserve pitch when stretching', st.keylock);
    const cLoop = chk('loop', 'Loop', st.loop);
    const read = () => { st.bpm = clamp(+iBpm.value || st.bpm, 20, 300); st.db = clamp(+iDb.value || 0, 0, base.duration); st.pitch = +iPitch.value || 0; st.gain = +iGain.value || 0; st.fadeIn = Math.max(0, +iFi.value || 0); st.fadeOut = Math.max(0, +iFo.value || 0); st.sync = cSync.firstChild.checked; st.keylock = cKey.firstChild.checked; st.loop = cLoop.firstChild.checked; };
    [iBpm, iDb].forEach((i) => i.addEventListener('input', () => { read(); drawGrid(); }));
    const small = (txt, title, fn) => { const b = el('button', { class: 'btn sm', type: 'button', title }, txt); b.addEventListener('click', () => { fn(); iBpm.value = +st.bpm.toFixed(3); iDb.value = +st.db.toFixed(3); drawGrid(); }); return b; };
    const per = () => 60 / st.bpm;
    const cv = el('canvas', { class: 'cp-wave', 'aria-label': 'Song waveform with beat grid. Click to set the first downbeat.' });
    const info = el('div', { class: 'cp-info' },
      el('div', {}, el('b', {}, A.name)),
      el('div', {}, (base.sampleRate / 1000).toFixed(1) + ' kHz · ' + (base.numberOfChannels > 1 ? 'stereo' : 'mono') + ' · ' + fmtTime(base.duration, 2) + (A.key ? ' · ' + A.key.name + ' (' + A.key.camelot + ')' : '')));
    const playBtn = el('button', { class: 'btn sm', type: 'button' }, icon('play'), 'Play from click with metronome');
    const stopBtn = el('button', { class: 'btn sm ghost', type: 'button' }, 'Stop');
    const form = el('div', { class: 'cp-form' },
      info,
      el('h4', {}, 'Stretch'), cSync, cKey, cLoop,
      lBpm, iBpm, el('div', { class: 'cp-row' }, small('÷2', 'Half the tempo', () => (st.bpm /= 2)), small('×2', 'Double the tempo', () => (st.bpm *= 2)), small('−0.01', 'Slower', () => (st.bpm -= 0.01)), small('+0.01', 'Faster', () => (st.bpm += 0.01))),
      lDb, iDb, el('div', { class: 'cp-row' }, small('◀ beat', 'Move the downbeat one beat earlier', () => (st.db = Math.max(0, st.db - per()))), small('beat ▶', 'Move the downbeat one beat later', () => (st.db = Math.min(base.duration, st.db + per()))), small('−10 ms', 'Earlier', () => (st.db = Math.max(0, st.db - 0.01))), small('+10 ms', 'Later', () => (st.db += 0.01))),
      el('h4', {}, 'Clip'), lPitch, iPitch, lGain, iGain, el('div', { class: 'cp-two' }, el('div', {}, lFi, iFi), el('div', {}, lFo, iFo)),
      el('button', { class: 'btn sm', type: 'button', onclick: () => { close(true); clipFx(c); } }, 'Clip effects…'));
    const box = el('div', { class: 'modal clipprops', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Clip properties' },
      el('header', {}, el('h3', {}, 'Clip properties'), el('p', {}, 'Line the grid up with the song: set its tempo, then click the first strong downbeat in the waveform. Scroll to zoom.')),
      el('div', { class: 'cp-body' }, form, el('div', { class: 'cp-right' }, cv, el('div', { class: 'cp-row' }, playBtn, stopBtn, el('span', { class: 'cp-hint' }, 'Orange lines are beats, thick ones are bars.')))),
      el('footer', {}, el('div', { class: 'spacer' }), el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'), el('button', { class: 'btn primary', type: 'button', onclick: () => close(true) }, 'OK')));
    function drawGrid() {
      const r = cv.getBoundingClientRect(); if (!r.width) return;
      const { ctx, w, h } = fitCanvas(cv);
      ctx.fillStyle = C.trackA; ctx.fillRect(0, 0, w, h);
      const sr = base.sampleRate, spp = (view.t1 - view.t0) * sr / w, mid = h / 2;
      ctx.fillStyle = alpha(C.wave, 0.8);
      for (let x = 0; x < w; x++) { const s0 = (view.t0 * sr) + x * spp; const pr = peakRange(clipBase(c) === base ? (c.stem ? A.stems.peaks[c.stem] : A.peaks) : A.peaks, base, -1, s0, s0 + Math.max(1, spp)); if (pr) ctx.fillRect(x, mid - pr[1] * (h / 2 - 6), 1, Math.max(1, (pr[1] - pr[0]) * (h / 2 - 6))); }
      const p = per(), xT = (t) => (t - view.t0) / (view.t1 - view.t0) * w;
      const k0 = Math.ceil((view.t0 - st.db) / p), k1 = Math.floor((view.t1 - st.db) / p);
      const pxPerBeat = p / (view.t1 - view.t0) * w;
      ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--font-mono');
      for (let k = k0; k <= k1; k++) {
        const bar = ((k % P.bpb) + P.bpb) % P.bpb === 0;
        if (!bar && pxPerBeat < 4) continue;
        const x = Math.round(xT(st.db + k * p)) + 0.5;
        ctx.fillStyle = k === 0 ? C.sel : alpha(C.accent, bar ? 0.9 : 0.45); ctx.fillRect(x, 0, k === 0 ? 2 : 1, h);
        if (bar && pxPerBeat * P.bpb > 28) { ctx.fillStyle = C.fg; ctx.fillText(String(Math.floor(k / P.bpb) + 1), x + 3, 11); }
      }
      if (clickT != null) { ctx.fillStyle = C.fg; ctx.fillRect(xT(clickT), 0, 1, h); }
    }
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect(); const tt = view.t0 + (e.clientX - r.left) / r.width * (view.t1 - view.t0);
      if (e.shiftKey) { clickT = tt; drawGrid(); return; }
      // snap to the strongest attack within ±40 ms
      const d = base.getChannelData(0), sr = base.sampleRate; let best = Math.round(tt * sr), bv = 0;
      for (let i = Math.max(1, Math.round((tt - 0.04) * sr)); i < Math.min(d.length, Math.round((tt + 0.04) * sr)); i++) { const v = Math.abs(d[i]) - Math.abs(d[i - 1]); if (v > bv) { bv = v; best = i; } }
      st.db = best / sr; iDb.value = +st.db.toFixed(3); clickT = st.db; drawGrid();
      status('First downbeat set to ' + st.db.toFixed(3) + ' s. Shift-click picks a preview start without moving the grid.');
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); const r = cv.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width; const tt = view.t0 + f * (view.t1 - view.t0);
      if (e.ctrlKey || e.metaKey || !e.shiftKey) { const span = clamp((view.t1 - view.t0) * (e.deltaY > 0 ? 1.25 : 0.8), 0.25, base.duration); view.t0 = clamp(tt - f * span, 0, base.duration - span); view.t1 = view.t0 + span; }
      else { const span = view.t1 - view.t0, sh = span * 0.1 * Math.sign(e.deltaY); view.t0 = clamp(view.t0 + sh, 0, base.duration - span); view.t1 = view.t0 + span; }
      drawGrid();
    }, { passive: false });
    playBtn.addEventListener('click', () => {
      read(); stopPrev();
      const ctx = Engine.ensure(); const from = clickT != null ? clickT : st.db;
      const src = Engine.playBuffer(base, from);
      const p = per(), t0 = src.t0; const clicks = [];
      for (let k = Math.ceil((from - st.db) / p); st.db + k * p < Math.min(base.duration, from + 30); k++) {
        const at = t0 + (st.db + k * p - from); const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = ((k % P.bpb) + P.bpb) % P.bpb === 0 ? 1760 : 1180; g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.4, at + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
        o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.06); clicks.push(o);
      }
      prev = { clicks };
    });
    const stopPrev = () => { Engine.stopPreview(); if (prev) prev.clicks.forEach((o) => { try { o.stop(); } catch (e) { } }); prev = null; };
    stopBtn.addEventListener('click', stopPrev);
    function close(ok) {
      stopPrev(); bg.remove(); document.removeEventListener('keydown', esc, true);
      if (!ok) return;
      read();
      Hist.push();
      applyGrid(A, st.bpm, st.db); A.beatmapped = true;
      if (st.sync !== !!c.sync && A.bpm) { toggleSync(c); Hist.undo.pop(); }
      c.keylock = st.keylock; c.pitch = st.pitch; c.gain = st.gain; c.fadeIn = st.fadeIn; c.fadeOut = st.fadeOut;
      if (st.loop !== !!c.loop) { c.loop = st.loop; if (!c.loop) c.len = Math.min(c.len, clipMaxLen(c)); }
      Engine.refresh(); draw(); markDirty();
      status('Updated ' + A.name);
    }
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); } if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); close(true); } };
    document.addEventListener('keydown', esc, true);
    bg.addEventListener('pointerdown', (e) => { if (e.target === bg) close(false); });
    bg.append(box); document.body.append(bg);
    requestAnimationFrame(drawGrid);
  }

  // live level meters in the track headers
  function tickMeters() {
    if (!Engine.ctx) return;
    const cvs = $$('.thead canvas.tmeter');
    P.tracks.forEach((t, i) => {
      const cv = cvs[i], n = Engine.nodes.get(t.id); if (!cv || !n) return;
      const db = gainToDb(Mixer.peakOf(n.an)), f = clamp((db + 54) / 60, 0, 1);
      const ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, C.ok); g.addColorStop(0.78, C.ok); g.addColorStop(0.9, C.accent); g.addColorStop(1, C.rec);
      ctx.fillStyle = g; ctx.fillRect(0, 0, f * w, h);
    });
  }
  async function sourceTempo(A) {
    const r = await showDialog({
      title: 'Song tempo & key', desc: 'Rush detected these automatically. Correct the tempo if the song drifts against the grid.',
      fields: [{ id: 'bpm', label: 'Tempo (BPM)', type: 'number', value: A.bpm ? +A.bpm.toFixed(3) : 120, step: 0.001 }, { id: 'beats', label: 'Length in beats', type: 'number', value: A.beats ? +A.beats.toFixed(3) : 4, step: 0.25 }, { id: 'loop', label: 'Treat as a loop', type: 'check', value: A.isLoop }],
    });
    if (!r) return;
    Hist.push();
    if (Math.abs(r.beats - (A.beats || 0)) > 1e-3 && r.beats > 0) { A.beats = r.beats; A.bpm = r.beats * 60 / A.buffer.duration; } else { A.bpm = r.bpm; A.beats = A.buffer.duration * r.bpm / 60; }
    A.isLoop = r.loop; A.stretch.clear();
    Engine.refresh(); bus.emit('assets'); draw();
  }
  function toggleSync(c) {
    Hist.push();
    const A = S.assets.get(c.asset);
    if (c.sync) { c.offset = clipBufTime(c, c.start) || 0; c.sync = false; }
    else { c.offB = (c.offset || 0) * A.bpm / 60; c.sync = true; }
    c.len = Math.min(c.len, clipMaxLen(c));
    Engine.refresh(); draw();
  }
  function splitAt(c, t, beat) {
    if (beat <= c.start + 1e-6 || beat >= c.start + c.len - 1e-6) { status('Put the cursor inside the clip to split it.'); return; }
    Hist.push();
    const right = JSON.parse(JSON.stringify(c)); right.id = uid('c'); right.fadeIn = 0;
    clipTrimStart(right, beat);
    c.len = beat - c.start; c.fadeOut = 0;
    t.clips.push(right);
    Engine.refresh(); draw();
  }
  function duplicate(c, t) { Hist.push(); const d = JSON.parse(JSON.stringify(c)); d.id = uid('c'); d.start = c.start + c.len; t.clips.push(d); S.selClip = d.id; Engine.refresh(); layout(); draw(); }
  function del(c, t) { Hist.push(); rippleRemove(c, t); Engine.refresh(); draw(); }
  // remove a clip; with ripple on, later clips on the track close the gap
  function rippleRemove(c, t) {
    t.clips = t.clips.filter((k) => k !== c); if (S.selClip === c.id) S.selClip = null;
    if (PREF.ripple) rippleShift(t, c.start + c.len, -c.len);
    if (PREF.autoXfade) autoXfade(t);
  }
  function rippleShift(t, from, d, except) {
    if (Math.abs(d) < 1e-9) return;
    for (const k of t.clips) if (k !== except && k.start >= from - 1e-6) k.start = Math.max(0, k.start + d);
  }
  // overlapping clips on one track crossfade automatically (and the fades go away when they no longer overlap)
  function autoXfade(t) {
    const cl = t.clips.slice().sort((a, b) => a.start - b.start);
    for (const c of cl) { if (c.axIn) { c.fadeIn = 0; c.axIn = false; } if (c.axOut) { c.fadeOut = 0; c.axOut = false; } }
    for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
      const a = cl[i], b = cl[j], aEnd = a.start + a.len;
      if (b.start >= aEnd - 1e-6) continue;
      if (b.start + b.len <= aEnd + 1e-6) continue;            // fully inside: leave it alone
      const sec = T.b2s(aEnd) - T.b2s(b.start);
      if ((a.fadeOut || 0) < sec) { a.fadeOut = sec; a.axOut = true; }
      if ((b.fadeIn || 0) < sec) { b.fadeIn = sec; b.axIn = true; }
    }
  }
  function copy(c, t) { clipboard = { clip: JSON.parse(JSON.stringify(c)), ti: P.tracks.indexOf(t) }; status('Copied clip'); }
  function paste(beat, ti) {
    if (!clipboard) return;
    Hist.push();
    const t = P.tracks[ti] || P.tracks[clipboard.ti] || P.tracks[0]; if (!t) return;
    const d = JSON.parse(JSON.stringify(clipboard.clip)); d.id = uid('c'); d.start = Math.max(0, beat);
    if (PREF.ripple) rippleShift(t, d.start, d.len);
    t.clips.push(d);
    if (PREF.autoXfade) autoXfade(t); S.selClip = d.id; S.selTrack = t.id;
    Engine.refresh(); layout(); draw(); status('Pasted at ' + fmtBars(d.start, P.bpb));
  }

  // ---- markers & tempo ----
  function addMarker(b) {
    Hist.push();
    P.markers = P.markers || [];
    const n = P.markers.length + 1;
    P.markers.push({ id: uid('m'), b, name: String(n) });
    P.markers.sort((p, q) => p.b - q.b);
    draw(); status('Marker ' + n + ' at ' + fmtBars(b, P.bpb) + '. Double-click it in the ruler to rename.');
  }
  function jumpMarker(dir) {
    const cur = cursorBeat();
    const list = (P.markers || []).map((m) => m.b).concat(T.list().map((m) => m.b), [0]).sort((a, b) => a - b);
    const t = dir > 0 ? list.find((b) => b > cur + 0.01) : list.reverse().find((b) => b < cur - 0.01);
    if (t == null) return;
    setCursor(t);
  }
  async function tempoDialog(m, b) {
    const L = T.list();
    const isFirst = m === L[0];
    const at = m ? m.b : Math.max(0, b);
    const before = T.bpmAt(Math.max(0, at - 1e-6));
    const r = await showDialog({
      title: m ? (isFirst ? 'Starting tempo' : 'Edit tempo change') : 'Insert tempo change',
      desc: (m ? '' : 'At ' + fmtBars(at, P.bpb) + ' · ' + fmtTime(T.b2s(at)) + '. ') + 'Tempo just before here: ' + before.toFixed(2) + ' BPM. Songs that follow the project tempo are time-stretched to match, keeping their pitch.',
      ok: m ? 'Save' : 'Insert',
      fields: [
        { id: 'bpm', label: 'Tempo (BPM)', type: 'number', value: +(m ? (isFirst ? P.bpm : m.bpm) : before).toFixed(2), step: 0.01, min: 20, max: 300 },
        isFirst ? null : { id: 'ramp', label: 'Transition', type: 'select', value: m && m.ramp ? 'ramp' : 'hold', options: [{ value: 'hold', label: 'Instant change at this point' }, { value: 'ramp', label: 'Gradual ramp from the previous tempo change' }] },
        isFirst ? null : { id: 'pos', label: 'Position (bar.beat)', value: fmtBars(at, P.bpb).replace(/\.000$/, '') },
      ].filter(Boolean),
    });
    if (!r) return;
    const bpm = clamp(+r.bpm || before, 20, 300);
    if (isFirst) { T.edit(m, { bpm }); }
    else {
      let pos = at;
      if (r.pos) { const pr = parseBars(r.pos); if (pr != null) pos = pr; }
      if (m) T.edit(m, { b: pos, bpm, ramp: r.ramp === 'ramp' });
      else T.add(pos, bpm, r.ramp === 'ramp');
    }
    status('Tempo ' + bpm.toFixed(2) + ' BPM at ' + fmtBars(m ? m.b : at, P.bpb));
  }
  function parseBars(str) {
    const m = String(str).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!m) return null;
    return (parseInt(m[1], 10) - 1) * P.bpb + (m[2] ? parseInt(m[2], 10) - 1 : 0) + (m[3] ? parseInt(m[3], 10) / 1000 : 0);
  }
  function tempoMenu(m, x, y) {
    const L = T.list(), first = m === L[0];
    showMenu(x, y, [
      { label: 'Edit tempo change…', action: () => tempoDialog(m) },
      { label: 'Go to', action: () => setCursor(m.b) },
      { label: m.ramp ? 'Make it an instant change' : 'Ramp smoothly into this tempo', disabled: first, action: () => T.edit(m, { ramp: !m.ramp }) },
      { label: 'Adjust tempo so this lines up with the cursor', disabled: first, action: () => { const ok = T.alignTo(m, T.b2s(P.cursor)); status(ok ? 'Previous tempo set to ' + ok.toFixed(2) + ' BPM' : 'Put the cursor after the previous tempo change first.'); if (ok) setCursor(m.b); } },
      '-',
      { label: 'Delete', disabled: first, action: () => T.remove(m) },
    ]);
  }

  function nextClip(dir) {
    const all = []; P.tracks.forEach((t, ti) => t.clips.forEach((c) => all.push({ c, t, ti })));
    all.sort((a, b) => a.c.start - b.c.start || a.ti - b.ti);
    if (!all.length) return;
    const curSel = selected();
    let i = curSel ? all.findIndex((x) => x.c === curSel.c) : -1;
    if (i < 0) i = dir > 0 ? all.findIndex((x) => x.c.start > P.cursor + 1e-6) - 1 : all.length;
    const nx = all[clamp(i + dir, 0, all.length - 1)];
    S.selClip = nx.c.id; S.selTrack = nx.t.id;
    setCursor(nx.c.start); ensureTrackVisible(nx.ti); draw();
    const A = S.assets.get(nx.c.asset); status((A ? A.name : 'Clip') + ' · ' + fmtBars(nx.c.start, P.bpb));
  }

  function key(e) {
    const k = e.key, lk = k.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const s = selected();
    const step = P.snap > 0 ? P.snap : 1;
    if (lk === 'm' && !mod) { addMarker(snapBeat(cursorBeat())); return true; }
    if (lk === 't' && !mod) { const L = T.list(), i = T.indexAt(P.cursor); e.shiftKey ? tempoDialog(L[i]) : tempoDialog(null, snapBeat(P.cursor)); return true; }
    if (k === ',' || (mod && k === 'ArrowLeft')) { jumpMarker(-1); return true; }
    if (k === '.' || (mod && k === 'ArrowRight')) { jumpMarker(1); return true; }
    if ((k === 'Delete' || k === 'Backspace') && s) { del(s.c, s.t); return true; }
    if (lk === 's' && !mod) {
      const pos = cursorBeat();
      if (s) splitAt(s.c, s.t, pos);
      else { for (const t of P.tracks) for (const c of [...t.clips]) if (pos > c.start && pos < c.start + c.len) splitAt(c, t, pos); }
      return true;
    }
    if (mod && lk === 'd' && s) { duplicate(s.c, s.t); return true; }
    if (mod && lk === 'c' && s) { copy(s.c, s.t); return true; }
    if (mod && lk === 'x' && s) { copy(s.c, s.t); del(s.c, s.t); return true; }
    if (mod && lk === 'v') { paste(P.cursor, P.tracks.findIndex((t) => t.id === S.selTrack)); return true; }
    if (lk === 'e' && !mod) { if (e.shiftKey) { const t = P.tracks.find((x) => x.id === S.selTrack); if (t) Chainer.forTrack(t); } else if (s) clipFx(s.c); else status('Select a clip first (click it, or press Tab).'); return true; }
    if (lk === 'x' && !mod) { if (e.shiftKey) crossfadeAll(); else if (s) crossfade(s.c); return true; }
    if (lk === 'v' && !mod) { const t = P.tracks.find((x) => x.id === S.selTrack); if (t) showEnv(t, t.env && t.env.show === 'vol' ? null : 'vol'); return true; }
    if (lk === 'p' && !mod) { const t = P.tracks.find((x) => x.id === S.selTrack); if (t) showEnv(t, t.env && t.env.show === 'pan' ? null : 'pan'); return true; }
    if (k === 'Tab') { nextClip(e.shiftKey ? -1 : 1); return true; }
    if (k === 'Enter' && e.altKey && s) { clipProps(s.c, s.t); return true; }
    if ((k === 'ArrowUp' || k === 'ArrowDown') && e.shiftKey && !mod && s) { clipPitch(s.c, k === 'ArrowUp' ? 1 : -1); return true; }
    if (lk === 'f' && !mod) { zoomFit(); return true; }
    if (!mod && !e.altKey && !e.shiftKey && ['a', 'd', 'g', 'i', 'u'].includes(lk)) { setTool({ a: 'edit', d: 'draw', g: 'env', i: 'sel', u: 'erase' }[lk]); return true; }
    if (lk === 'r' && e.shiftKey && !mod && s) { reverse(s.c); return true; }
    if (lk === 'q' && e.shiftKey && !mod) { const t = P.tracks.find((x) => x.id === S.selTrack) || P.tracks[0]; if (t) trackEqDialog(t); return true; }
    if (lk === 'z' && !mod) { if (s) zoomTo(s.c.start, s.c.start + s.c.len); else if (P.loop.end > P.loop.start) zoomTo(P.loop.start, P.loop.end); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const dir = k === 'ArrowLeft' ? -1 : 1;
      if (e.altKey && s) { Hist.push(); s.c.start = Math.max(0, s.c.start + dir * (e.shiftKey ? 1 / 16 : step)); Engine.refresh(); draw(); return true; }
      setCursor(snapBeat(P.cursor + dir * (e.shiftKey ? P.bpb : step), step));
      return true;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      const dir = k === 'ArrowUp' ? 1 : -1;
      if (mod) setTH(TH * (dir > 0 ? 1.15 : 1 / 1.15)); else zoomAt(dir > 0 ? 1.3 : 1 / 1.3, xOf(cursorBeat()) >= 0 && xOf(cursorBeat()) <= sc().clientWidth ? xOf(cursorBeat()) : sc().clientWidth / 2);
      return true;
    }
    if (k === 'PageDown' || k === 'PageUp') { const w = sc().clientWidth / ppb; setCursor(Math.max(0, P.cursor + (k === 'PageDown' ? w * 0.8 : -w * 0.8))); sc().scrollLeft = Math.max(0, P.cursor * ppb - 40); return true; }
    if (k === 'End') { setCursor(projectEndBeats()); return true; }
    if (k === '+' || k === '=') { zoomAt(1.25, sc().clientWidth / 2); return true; }
    if (k === '-' || k === '_') { zoomAt(0.8, sc().clientWidth / 2); return true; }
    return false;
  }

  function follow() {
    if (!Engine.playing || !S.follow) return;
    const s = sc(); const x = xOf(Engine.posBeats());
    if (x > s.clientWidth * 0.88 || x < 0) s.scrollLeft = Math.max(0, Engine.posBeats() * ppb - s.clientWidth * 0.12);
  }

  function rulerPointer() {
    const w = $('#rulerWrap');
    let rd = null;
    const pos = (e) => { const r = w.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const markerAt = (x) => (P.markers || []).find((m) => x >= xOf(m.b) - 4 && x <= xOf(m.b) + 12 + m.name.length * 6.5);
    const tempoAt = (x) => { const L = T.list(); for (let i = L.length - 1; i >= 0; i--) { const mx = xOf(L[i].b); if (x >= mx - 4 && x <= mx + 10 + (i === 0 ? 70 : 30)) return L[i]; } return null; };
    w.addEventListener('contextmenu', (e) => {
      e.preventDefault(); const { x, y } = pos(e); const bt = snapBeat(Math.max(0, beatOf(x)));
      if (y < LANE_T) { const m = tempoAt(x); if (m) { tempoMenu(m, e.clientX, e.clientY); return; } showMenu(e.clientX, e.clientY, [{ label: 'Insert tempo change here…', action: () => tempoDialog(null, bt) }]); return; }
      const m = y < LANE_M ? markerAt(x) : null;
      if (!m) { showMenu(e.clientX, e.clientY, [{ label: 'Insert marker here', action: () => addMarker(bt) }, { label: 'Insert tempo change here…', action: () => tempoDialog(null, bt) }]); return; }
      showMenu(e.clientX, e.clientY, [
        { label: 'Rename marker…', action: () => renameMarker(m) },
        { label: 'Go to', action: () => setCursor(m.b) },
        { label: 'Delete marker', action: () => { Hist.push(); P.markers = P.markers.filter((q) => q !== m); draw(); } },
      ]);
    });
    w.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e); const bt = snapBeat(Math.max(0, beatOf(x)));
      if (y < LANE_T) { const m = tempoAt(x); tempoDialog(m || null, bt); return; }
      if (y < LANE_M) { const m = markerAt(x); if (m) renameMarker(m); else addMarker(bt); return; }
      const bar = Math.floor(beatOf(x) / P.bpb) * P.bpb;
      Hist.push(); P.loop.start = bar; P.loop.end = bar + P.bpb; P.loop.on = true; Engine.refresh(); bus.emit('transport'); draw();
      status('Looping bar ' + (bar / P.bpb + 1));
    });
    w.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const { x, y } = pos(e);
      if (y < LANE_T) {
        const m = tempoAt(x);
        if (m) { S.selTempo = m.id; rd = { kind: 'tempo', m, x0: x, b0: m.b, moved: false }; w.setPointerCapture(e.pointerId); draw(); return; }
      } else if (y < LANE_M) {
        const m = markerAt(x);
        if (m) { rd = { kind: 'marker', m, x0: x, b0: m.b, moved: false }; w.setPointerCapture(e.pointerId); return; }
      }
      const b = snapBeat(Math.max(0, beatOf(x)));
      rd = { kind: 'loop', b0: b, b1: b, moved: false }; w.setPointerCapture(e.pointerId);
    });
    w.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e);
      if (!rd) { w.style.cursor = y < LANE_T ? (tempoAt(x) ? 'ew-resize' : 'copy') : y < LANE_M ? (markerAt(x) ? 'ew-resize' : 'copy') : 'pointer'; w.title = y < LANE_T ? 'Tempo changes: double-click to add, drag to move, right-click for options' : y < LANE_M ? 'Markers: double-click to add or rename, drag to move' : 'Click to set the cursor, drag to set a loop, double-click to loop a bar'; return; }
      if (rd.kind === 'tempo' || rd.kind === 'marker') {
        if (!rd.moved && Math.abs(x - rd.x0) < 3) return;
        if (rd.kind === 'tempo' && rd.m === T.list()[0]) return;
        if (!rd.moved) { Hist.push(); rd.moved = true; }
        rd.m.b = Math.max(rd.kind === 'tempo' ? 0.25 : 0, e.shiftKey ? beatOf(x) : snapBeat(beatOf(x)));
        status((rd.kind === 'tempo' ? 'Tempo change' : 'Marker') + ' at ' + fmtBars(rd.m.b, P.bpb));
        if (rd.kind === 'marker') P.markers.sort((p, q) => p.b - q.b);
        draw(); return;
      }
      rd.b1 = snapBeat(Math.max(0, beatOf(x))); if (rd.b1 !== rd.b0) rd.moved = true;
      if (rd.moved) { P.loop.start = Math.min(rd.b0, rd.b1); P.loop.end = Math.max(rd.b0, rd.b1); P.loop.on = true; draw(); bus.emit('transport'); }
    });
    w.addEventListener('pointerup', () => {
      if (!rd) return;
      const d = rd; rd = null;
      if (d.kind === 'tempo' || d.kind === 'marker') {
        if (d.moved) { if (d.kind === 'tempo') T.changed(); else { markDirty(); draw(); } }
        else setCursor(d.m.b);
        return;
      }
      if (!d.moved) setCursor(d.b0);
      else { markDirty(); Engine.refresh(); }
      bus.emit('transport'); draw();
    });
    w.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const r = w.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left); }
      else sc().scrollLeft += e.deltaY + e.deltaX;
    }, { passive: false });
  }
  async function renameMarker(m) { const q = await showDialog({ title: 'Rename marker', fields: [{ id: 'n', label: 'Name', value: m.name }], ok: 'Rename' }); if (q && q.n) { Hist.push(); m.name = q.n; draw(); } }

  function overviewPointer() {
    const w = $('#ovWrap'); let down = false;
    const go = (e) => { const r = w.getBoundingClientRect(), k = $('#ovCanvas')._k || 1; const b = (e.clientX - r.left) / k; sc().scrollLeft = Math.max(0, b * ppb - sc().clientWidth / 2); };
    w.addEventListener('pointerdown', (e) => { down = true; w.setPointerCapture(e.pointerId); go(e); });
    w.addEventListener('pointermove', (e) => { if (down) go(e); });
    w.addEventListener('pointerup', () => { down = false; });
    w.addEventListener('dblclick', (e) => { const r = w.getBoundingClientRect(), k = $('#ovCanvas')._k || 1; setCursor(Math.max(0, (e.clientX - r.left) / k)); });
    w.addEventListener('wheel', (e) => { e.preventDefault(); if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), sc().clientWidth / 2); else sc().scrollLeft += (e.deltaY + e.deltaX) * 4; }, { passive: false });
  }

  function init() {
    try { const v = +localStorage.getItem('rush.th'); if (v) TH = clamp(v, 40, 180); } catch (e) { }
    S.follow = true;
    bindPointer(); rulerPointer(); overviewPointer();
    $('#addTrack').addEventListener('click', () => addTrack());
    $('#zIn').addEventListener('click', () => zoomAt(1.3, sc().clientWidth / 2));
    $('#zOut').addEventListener('click', () => zoomAt(1 / 1.3, sc().clientWidth / 2));
    $('#heads').addEventListener('wheel', (e) => { if (e.altKey || e.ctrlKey) { e.preventDefault(); setTH(TH * (e.deltaY < 0 ? 1.12 : 1 / 1.12)); return; } sc().scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
    new ResizeObserver(() => { layout(); draw(); }).observe(tl());
    bus.on('project', () => { renderHeads(); layout(); draw(); });
    bus.on('tracks', () => draw());
    bus.on('assets', () => draw());
    bus.on('redraw', () => draw());
    bus.on('transport', () => { drawOverlay(); drawOverview(); });
    bus.on('assetMeta', (A) => {
      // first analysis result for a freshly dropped file: let it follow the project tempo
      let ch = false;
      const syncSongs = !P.mix || P.mix.syncSongs !== false;
      for (const t of P.tracks) for (const c of t.clips) {
        if (c.asset !== A.id || c.sync || !A.bpm || !(A.isLoop || syncSongs) || (c.offset || 0) !== 0) continue;
        if (Math.abs(c.len - T.lenFor(c.start, A.buffer.duration)) > 0.05) continue;
        const [lo, hi] = srcBeatRange(A, A.buffer);
        c.sync = true; c.loop = !!A.isLoop; c.offB = A.isLoop ? 0 : lo; c.len = A.isLoop ? A.beats : hi - lo; ch = true;
      }
      if (ch) { Engine.refresh(); layout(); draw(); }
    });
  }
  return {
    init, draw, drawOverlay, drawOverview, layout, renderHeads, follow, key, placeAsset, clipFor, addTrack, selected, zoomAt, zoomFit, addMarker, transpose,
    addToMix, mixSettings, crossfade, crossfadeAll, clipFx, clipProps, tickMeters, tempoDialog, setTool, get tool() { return tool; }, reverse, beatmap, applyGrid, trackEqDialog, autoXfade, jumpMarker, setCursor, setTH, nextClip,
    get ppb() { return ppb; }, set ppb(v) { ppb = v; }, get TH() { return TH; },
  };
})();
