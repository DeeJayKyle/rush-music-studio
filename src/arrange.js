// ---------------------------------------------------------------------------
// Arrange view — multitrack timeline (canvas), ACID-style loop clips
// ---------------------------------------------------------------------------
const Arrange = (() => {
  const TH = 76, HEAD = 17;
  let ppb = 26;                     // pixels per beat
  let drag = null, hover = null;
  const tl = () => $('#tl'), sc = () => $('#tlScroll');

  const snapBeat = (b, force) => {
    const s = force != null ? force : P.snap;
    return s > 0 ? Math.round(b / s) * s : b;
  };
  const xOf = (beat) => beat * ppb - sc().scrollLeft;
  const beatOf = (x) => (x + sc().scrollLeft) / ppb;
  const trackAtY = (y) => Math.floor((y + sc().scrollTop) / TH);

  function totalBeats() { const vis = (tl().clientWidth || 800) / ppb; return Math.max(projectEndBeats() + P.bpb * 16, vis + P.bpb * 8, P.loop.end + 16); }

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
      const pan = el('input', { type: 'range', class: 'slim', min: -1, max: 1, step: 0.01, value: t.pan, 'aria-label': 'Pan' });
      const panV = el('span', { class: 'val' }, panTxt(t.pan));
      pan.addEventListener('input', () => { t.pan = parseFloat(pan.value); panV.textContent = panTxt(t.pan); Engine.applyAll(); bus.emit('tracks'); markDirty(); });
      pan.addEventListener('dblclick', () => { t.pan = 0; pan.value = 0; panV.textContent = 'C'; Engine.applyAll(); });
      const more = el('button', { class: 'icon-btn', style: { width: '22px', height: '20px' }, title: 'Track options', 'aria-label': 'Track options' }, icon('more'));
      more.addEventListener('click', (e) => { const r = more.getBoundingClientRect(); trackMenu(t, i, r.left, r.bottom + 4); });
      const h = el('div', { class: 'thead' + (S.selTrack === t.id ? ' sel' : ''), style: { '--c': t.color } },
        el('div', { class: 'tstrip' }),
        el('div', { class: 'body' },
          el('div', { class: 'r1' }, name, tog('m', 'M', 'mute', 'Mute'), tog('s', 'S', 'solo', 'Solo'), tog('r', 'R', 'arm', 'Arm for recording'), fxBtn(t), more),
          el('div', { class: 'r2' }, vol, volV),
          el('div', { class: 'r2' }, pan, panV)));
      h.addEventListener('pointerdown', () => { if (S.selTrack !== t.id) { S.selTrack = t.id; $$('.thead').forEach((x, j) => x.classList.toggle('sel', j === i)); } });
      h.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(t, i, e.clientX, e.clientY); });
      inner.append(h);
    });
    inner.append(el('div', { class: 'add-track' }, el('button', { class: 'btn sm ghost', onclick: () => addTrack() }, icon('plus'), 'Add track')));
  }
  function fxBtn(t) {
    const n = (t.fx || []).filter((f) => f.on).length;
    const b = el('button', { class: 'tog fx', 'aria-pressed': String(n > 0), title: n ? n + ' effect' + (n > 1 ? 's' : '') + ': ' + t.fx.map((f) => Plugins.REG[f.type] && Plugins.REG[f.type].name).join(', ') : 'Add effects' }, 'FX');
    b.addEventListener('click', () => Chainer.forTrack(t));
    return b;
  }
  const panTxt = (p) => Math.abs(p) < 0.01 ? 'C' : (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100);

  function addTrack(name) { Hist.push(); const t = newTrack(name); P.tracks.push(t); Engine.syncTracks(); bus.emit('project'); return t; }
  function trackMenu(t, i, x, y) {
    showMenu(x, y, [
      { label: 'Effects (Plug-in Chainer)…', action: () => Chainer.forTrack(t) },
      { label: 'Transpose…', action: () => transpose(t) },
      '-',
      { label: (t.env && t.env.show === 'vol' ? '✓ ' : '') + 'Show volume envelope', action: () => showEnv(t, 'vol') },
      { label: (t.env && t.env.show === 'pan' ? '✓ ' : '') + 'Show pan envelope', action: () => showEnv(t, 'pan') },
      { label: 'Hide envelopes', disabled: !(t.env && t.env.show), action: () => showEnv(t, null) },
      { label: 'Clear envelope points', disabled: !(t.env && (t.env.vol.length || t.env.pan.length)), action: () => { Hist.push(); t.env.vol = []; t.env.pan = []; Engine.refresh(); draw(); } },
      '-',
      { label: 'Rename', action: async () => { const r = await showDialog({ title: 'Rename track', fields: [{ id: 'n', label: 'Name', value: t.name }], ok: 'Rename' }); if (r) { Hist.push(); t.name = r.n || t.name; bus.emit('project'); } } },
      { label: 'Change colour', action: () => { Hist.push(); t.color = TRACK_COLORS[(TRACK_COLORS.indexOf(t.color) + 1) % TRACK_COLORS.length]; bus.emit('project'); } },
      { label: 'Duplicate track', action: () => { Hist.push(); const c = JSON.parse(JSON.stringify(t)); c.id = uid('t'); c.name = t.name + ' copy'; c.clips.forEach((k) => k.id = uid('c')); P.tracks.splice(i + 1, 0, c); Engine.syncTracks(); Engine.refresh(); bus.emit('project'); } },
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
    try { const b = await Engine.render({ tail: 1 }); addAsset(t.name + ' (render)', b, { bpm: P.bpm, beats: b.duration / spb() }); toast('Rendered ' + t.name + ' to Media', 'ok'); }
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
  function draw() {
    const cv = $('#tlCanvas');
    const box = tl();
    cv.style.width = box.clientWidth + 'px'; cv.style.height = box.clientHeight + 'px';
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = C.trackA; ctx.fillRect(0, 0, w, h);
    const st = sc().scrollTop;
    // lanes
    P.tracks.forEach((t, i) => {
      const y = i * TH - st; if (y > h || y + TH < 0) return;
      ctx.fillStyle = i % 2 ? C.trackB : C.trackA; ctx.fillRect(0, y, w, TH);
      if (S.selTrack === t.id) { ctx.fillStyle = alpha(C.fg, 0.025); ctx.fillRect(0, y, w, TH); }
      ctx.fillStyle = C.lineSoft; ctx.fillRect(0, y + TH - 1, w, 1);
    });
    // grid
    const b0 = Math.floor(beatOf(0)), b1 = Math.ceil(beatOf(w));
    const sub = ppb > 60 ? 0.25 : ppb > 30 ? 0.5 : 1;
    for (let b = b0; b <= b1; b += sub) {
      const x = Math.round(xOf(b)) + 0.5;
      const isBar = Math.abs(b % P.bpb) < 1e-9, isBeat = Math.abs(b % 1) < 1e-9;
      if (!isBar && ppb * P.bpb < 24) continue;
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
    // clips
    ctx.font = '600 11px ' + getComputedStyle(document.body).fontFamily;
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
      ctx.font = '600 10px ' + getComputedStyle(document.body).fontFamily; ctx.fillText(k === 'vol' ? 'VOLUME' : 'PAN', 6, y0 + hh - 2);
    });
    if (!P.tracks.length) {
      ctx.fillStyle = C.faint; ctx.textAlign = 'center'; ctx.font = '14px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillText('Drag files or Loop Lab loops here to start a track', w / 2, h / 2); ctx.textAlign = 'left';
    }
    drawRuler();
    drawOverlay();
  }
  function drawClip(ctx, c, t, x, y, w, h, viewW) {
    const A = S.assets.get(c.asset);
    const sel = S.selClip === c.id;
    const col = t.color;
    const r = 6;
    ctx.save();
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
    ctx.fillStyle = alpha(col, 0.16); ctx.fill();
    ctx.clip();
    ctx.fillStyle = alpha(col, sel ? 0.75 : 0.5); ctx.fillRect(x, y, w, HEAD);
    if (A) {
      const pb = playBuffer(c, t);
      const base = pb && pb.buf && (c.stem ? A.stems.buffers && A.stems.buffers[c.stem] : A.buffer);
      const peaks = c.stem ? (A.stems.peaks && A.stems.peaks[c.stem]) : A.peaks;
      // label
      ctx.fillStyle = sel ? '#0d0f14' : C.fg;
      if (!sel) ctx.fillStyle = C.fg;
      const label = A.name + (c.stem ? ' · ' + c.stem : '') + (t.pitch ? '  ' + (t.pitch > 0 ? '+' : '') + t.pitch + ' st' : '') + (c.sync && A.bpm && Math.abs(A.bpm - P.bpm) > 0.01 ? '  ' + A.bpm.toFixed(1) + '→' + P.bpm + ' BPM' : '');
      ctx.fillText(label, Math.max(x, 0) + 6, y + 12);
      if (pb && base && peaks) {
        const top = y + HEAD + 2, hh = h - HEAD - 4, mid = top + hh / 2, amp = hh / 2 * Math.min(2, dbToGain(c.gain || 0));
        const sp = spb(), srcDur = pb.srcDur, toBuf = base.duration / srcDur, sr = base.sampleRate;
        const sppx = sp / ppb * toBuf * sr;
        ctx.fillStyle = alpha(C.wave, 0.85);
        const px0 = Math.max(Math.floor(x), 0), px1 = Math.min(Math.ceil(x + w), viewW);
        let lastWrap = -1;
        for (let px = px0; px < px1; px++) {
          const tl = (px - x) / ppb * sp;
          let pt = c.offset + tl;
          if (c.loop) { const wrap = Math.floor(pt / srcDur); if (lastWrap >= 0 && wrap !== lastWrap && px > x + 2) { ctx.fillStyle = alpha(col, 0.9); ctx.fillRect(px, top, 1, hh); ctx.fillStyle = alpha(C.wave, 0.85); } lastWrap = wrap; pt = pt - wrap * srcDur; }
          else if (pt >= srcDur || pt < 0) continue;
          const s0 = pt * toBuf * sr;
          const pr = peakRange(peaks, base, -1, s0, s0 + Math.max(1, sppx));
          if (!pr) continue;
          let fg = 1;
          if (c.fadeIn > 0 && tl < c.fadeIn) fg = tl / c.fadeIn;
          const cl = c.len * sp;
          if (c.fadeOut > 0 && tl > cl - c.fadeOut) fg = Math.min(fg, (cl - tl) / c.fadeOut);
          const y0 = mid - pr[1] * amp * fg, y1 = mid - pr[0] * amp * fg;
          ctx.fillRect(px, y0, 1, Math.max(1, y1 - y0));
        }
        if (pb.pending) { ctx.fillStyle = alpha(C.fg, 0.6); ctx.fillText('stretching…', Math.max(x, 0) + 6, y + h - 6); }
      } else if (c.stem && A.stems.state !== 'done') {
        ctx.fillStyle = C.muted; ctx.fillText('stem not separated yet', Math.max(x, 0) + 6, y + HEAD + 16);
      }
    } else { ctx.fillStyle = C.rec; ctx.fillText('missing audio', x + 6, y + 12); }
    // fades
    const sp = spb();
    ctx.strokeStyle = alpha(C.fg, 0.7); ctx.lineWidth = 1;
    if (c.fadeIn > 0) { const fx = x + c.fadeIn / sp * ppb; ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(fx, y + HEAD); ctx.stroke(); }
    if (c.fadeOut > 0) { const fx = x + w - c.fadeOut / sp * ppb; ctx.beginPath(); ctx.moveTo(fx, y + HEAD); ctx.lineTo(x + w, y + h); ctx.stroke(); }
    ctx.restore();
    // handles + outline
    ctx.strokeStyle = sel ? C.fg : alpha(col, 0.9); ctx.lineWidth = sel ? 1.5 : 1;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r) : ctx.rect(x, y, w, h); ctx.stroke();
    if (sel || (hover && hover.clip === c)) {
      ctx.fillStyle = C.fg;
      const fi = x + (c.fadeIn || 0) / sp * ppb, fo = x + w - (c.fadeOut || 0) / sp * ppb;
      ctx.fillRect(fi - 3, y + HEAD - 3, 6, 6); ctx.fillRect(fo - 3, y + HEAD - 3, 6, 6);
    }
  }
  function drawRuler() {
    const cv = $('#ruler');
    const wrap = $('#rulerWrap');
    cv.style.width = wrap.clientWidth + 'px'; cv.style.height = wrap.clientHeight + 'px';
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (P.loop.end > P.loop.start) {
      const x0 = xOf(P.loop.start), x1 = xOf(P.loop.end);
      ctx.fillStyle = alpha(C.accent, P.loop.on ? 0.85 : 0.3);
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, 3, x1 - x0, 9, 3) : ctx.rect(x0, 3, x1 - x0, 9); ctx.fill();
    }
    ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--font-mono');
    ctx.fillStyle = C.muted;
    for (const m of P.markers || []) {
      const x = Math.round(xOf(m.b)); if (x < -80 || x > w) continue;
      ctx.fillStyle = C.sel; ctx.beginPath(); ctx.moveTo(x, 3); ctx.lineTo(x + 7, 3); ctx.lineTo(x + 7, 11); ctx.lineTo(x, 15); ctx.fill();
      ctx.fillStyle = C.fg; ctx.fillText(m.name, x + 10, 12);
    }
    const barPx = ppb * P.bpb;
    const every = barPx < 28 ? 8 : barPx < 50 ? 4 : barPx < 90 ? 2 : 1;
    const bar0 = Math.max(0, Math.floor(beatOf(0) / P.bpb)), bar1 = Math.ceil(beatOf(w) / P.bpb);
    for (let bar = bar0; bar <= bar1; bar++) {
      const x = Math.round(xOf(bar * P.bpb)) + 0.5;
      ctx.fillStyle = C.line; ctx.fillRect(x, h - (bar % every === 0 ? 12 : 6), 1, 12);
      if (bar % every === 0) { ctx.fillStyle = C.muted; ctx.fillText(String(bar + 1), x + 4, h - 4); }
      if (barPx > 60) for (let b = 1; b < P.bpb; b++) { ctx.fillStyle = C.lineSoft; ctx.fillRect(Math.round(xOf(bar * P.bpb + b)), h - 5, 1, 5); }
    }
  }
  function drawOverlay() {
    const cv = $('#tlOverlay'); const box = tl();
    cv.style.width = box.clientWidth + 'px'; cv.style.height = box.clientHeight + 'px';
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    // cursor (edit point)
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
    const ti = trackAtY(y), t = P.tracks[ti]; if (!t || !t.env || !t.env.show) return null;
    const k = t.env.show, pts = t.env[k], y0 = ti * TH - sc().scrollTop + 4, hh = TH - 10;
    for (let i = 0; i < pts.length; i++) if (Math.abs(xOf(pts[i].b) - x) < 7 && Math.abs(envY(k, pts[i].v, y0, hh) - y) < 7) return { t, k, i, y0, hh };
    const ly = envY(k, envAt(pts, beatOf(x), 0), y0, hh);
    if (Math.abs(ly - y) < 6) return { t, k, i: -1, y0, hh };
    return null;
  }
  // ---- hit testing ----
  function hit(x, y) {
    const ti = trackAtY(y); const t = P.tracks[ti]; if (!t) return null;
    const b = beatOf(x), sp = spb();
    const ty = ti * TH - sc().scrollTop + 2;
    for (let i = t.clips.length - 1; i >= 0; i--) {
      const c = t.clips[i];
      if (b < c.start || b > c.start + c.len) continue;
      const cx = xOf(c.start), cw = c.len * ppb, ly = y - ty;
      const fi = cx + (c.fadeIn || 0) / sp * ppb, fo = cx + cw - (c.fadeOut || 0) / sp * ppb;
      let zone = 'body';
      if (ly < HEAD + 4 && Math.abs(x - fi) < 6) zone = 'fadeIn';
      else if (ly < HEAD + 4 && Math.abs(x - fo) < 6) zone = 'fadeOut';
      else if (x - cx < 7 && cw > 16) zone = 'left';
      else if (cx + cw - x < 7 && cw > 16) zone = 'right';
      return { clip: c, track: t, ti, zone };
    }
    return { track: t, ti };
  }
  const cursorFor = { body: 'grab', left: 'w-resize', right: 'e-resize', fadeIn: 'ew-resize', fadeOut: 'ew-resize' };

  function findClip(id) { for (const t of P.tracks) { const c = t.clips.find((k) => k.id === id); if (c) return { c, t }; } return null; }
  function selected() { return S.selClip ? findClip(S.selClip) : null; }

  function bindPointer() {
    const s = sc();
    s.addEventListener('pointerdown', (e) => {
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
      if (hh && hh.clip) {
        S.selClip = hh.clip.id; S.selTrack = hh.track.id;
        let clip = hh.clip;
        if (e.altKey && hh.zone === 'body') { Hist.push(); clip = Object.assign({}, clip, { id: uid('c') }); hh.track.clips.push(clip); S.selClip = clip.id; drag = { pushed: true }; }
        drag = Object.assign(drag || {}, { kind: hh.zone, clip, track: hh.track, ti: hh.ti, b0: b, y0: y, orig: { ...clip }, moved: false, pushed: drag && drag.pushed });
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
      const r = s.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (!drag) {
        const eh = envHit(x, y);
        if (eh) { s.style.cursor = eh.i >= 0 ? 'move' : 'copy'; return; }
        const hh = hit(x, y);
        const nh = hh && hh.clip ? hh : null;
        if ((nh && nh.clip) !== (hover && hover.clip)) { hover = nh; draw(); }
        s.style.cursor = nh ? cursorFor[nh.zone] : 'default';
        return;
      }
      const b = beatOf(x), sp = spb();
      if (drag.kind === 'env') {
        const pts = drag.eh.t.env[drag.eh.k];
        drag.pt.b = Math.max(0, e.shiftKey ? b : snapBeat(b, P.snap > 0 ? P.snap / 4 : 0)); drag.pt.v = envV(drag.eh.k, y, drag.eh.y0, drag.eh.hh);
        pts.sort((p, q) => p.b - q.b);
        status((drag.eh.k === 'vol' ? 'Volume ' + fmtDb(drag.pt.v) + ' dB' : 'Pan ' + panTxt(drag.pt.v)) + ' at ' + fmtBars(drag.pt.b, P.bpb));
        draw(); return;
      }
      if (drag.kind === 'range') { drag.b1 = snapBeat(Math.max(0, b)); drag.moved = drag.moved || Math.abs(drag.b1 - drag.b0) > 0; drawOverlay(); return; }
      const d = b - drag.b0;
      if (!drag.moved && Math.abs(d * ppb) < 3 && Math.abs(y - drag.y0) < 4) return;
      if (!drag.pushed) { Hist.push(); drag.pushed = true; }
      drag.moved = true;
      const c = drag.clip, o = drag.orig;
      const A = S.assets.get(c.asset);
      const pb = playBuffer(c);
      const srcBeats = pb ? pb.srcDur / sp : Infinity;
      if (drag.kind === 'body') {
        c.start = Math.max(0, e.shiftKey ? o.start + d : snapBeat(o.start + d));
        const nt = clamp(trackAtY(y), 0, P.tracks.length - 1);
        const tt = P.tracks[nt];
        if (tt && tt !== drag.track) { drag.track.clips = drag.track.clips.filter((k) => k !== c); tt.clips.push(c); drag.track = tt; S.selTrack = tt.id; }
      } else if (drag.kind === 'left') {
        const end = o.start + o.len;
        let ns = e.shiftKey ? o.start + d : snapBeat(o.start + d);
        ns = Math.min(ns, end - 0.0625);
        let noff = o.offset + (ns - o.start) * sp;
        if (!c.loop && noff < 0) { ns = o.start - o.offset / sp; noff = 0; }
        ns = Math.max(0, ns);
        c.start = ns; c.len = end - ns; c.offset = c.loop && pb ? ((noff % pb.srcDur) + pb.srcDur) % pb.srcDur : noff;
      } else if (drag.kind === 'right') {
        let ne = e.shiftKey ? o.start + o.len + d : snapBeat(o.start + o.len + d);
        let nl = Math.max(0.0625, ne - o.start);
        if (!c.loop) nl = Math.min(nl, srcBeats - o.offset / sp);
        c.len = nl;
      } else if (drag.kind === 'fadeIn') {
        c.fadeIn = clamp((b - c.start) * sp, 0, c.len * sp - (c.fadeOut || 0));
      } else if (drag.kind === 'fadeOut') {
        c.fadeOut = clamp((c.start + c.len - b) * sp, 0, c.len * sp - (c.fadeIn || 0));
      }
      layout(); draw();
    });
    const end = (e) => {
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
      } else if (dd.moved) { Engine.refresh(); markDirty(); }
      draw();
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('pointerleave', () => { if (hover && !drag) { hover = null; draw(); } });
    s.addEventListener('dblclick', (e) => {
      const r = s.getBoundingClientRect(); const hh = hit(e.clientX - r.left, e.clientY - r.top);
      if (hh && hh.clip) { if (hh.clip.stem) { toast('Stems are edited in the Stems view. Use "Open stem in Editor" there.'); return; } Editor.open(hh.clip.asset); }
    });
    s.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = s.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const eh = envHit(x, y);
      if (eh && eh.i >= 0) { Hist.push(); eh.t.env[eh.k].splice(eh.i, 1); Engine.refresh(); draw(); return; }
      const hh = hit(x, y);
      if (hh && hh.clip) { S.selClip = hh.clip.id; draw(); clipMenu(hh.clip, hh.track, e.clientX, e.clientY, beatOf(x)); }
      else showMenu(e.clientX, e.clientY, [
        { label: 'Add track', action: () => addTrack() },
        { label: 'Set cursor here', action: () => { P.cursor = snapBeat(beatOf(x)); bus.emit('transport'); } },
        { label: 'Import audio…', action: () => $('#fileInput').click() },
      ]);
    });
    s.addEventListener('scroll', () => { layout(); draw(); });
    s.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = s.getBoundingClientRect(), x = e.clientX - r.left;
        zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, x);
      }
    }, { passive: false });
    // drop from media pool / files
    s.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/x-rush-asset') || [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    s.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation();
      document.body.classList.remove('dropping');
      const r = s.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const beat = Math.max(0, snapBeat(beatOf(x), P.snap > 0 ? P.snap : 1)), ti = trackAtY(y);
      const id = e.dataTransfer.getData('text/x-rush-asset');
      if (id && S.assets.get(id)) placeAsset(S.assets.get(id), ti, beat);
      else if (e.dataTransfer.files.length) {
        const list = await importFiles([...e.dataTransfer.files]);
        let t = ti; for (const A of list) placeAsset(A, t++, beat);
      }
    });
  }
  function zoomAt(f, x) {
    const s = sc(); const b = beatOf(x);
    ppb = clamp(ppb * f, 2, 400);
    layout();
    s.scrollLeft = Math.max(0, b * ppb - x);
    draw();
  }

  function placeAsset(A, ti, beat) {
    Hist.push();
    let t = P.tracks[ti];
    if (!t) { t = newTrack(A.name); P.tracks.push(t); Engine.syncTracks(); }
    const c = clipFor(A, beat);
    t.clips.push(c);
    S.selClip = c.id; S.selTrack = t.id;
    Engine.refresh(); bus.emit('project');
    return c;
  }
  function clipFor(A, beat, stem = null) {
    const sync = !!(A.isLoop && A.bpm);
    const len = sync ? A.beats : A.buffer.duration / spb();
    return { id: uid('c'), asset: A.id, stem, start: beat, len, offset: 0, sync, loop: sync, gain: 0, fadeIn: 0, fadeOut: 0 };
  }

  function clipMenu(c, t, x, y, beat) {
    const A = S.assets.get(c.asset);
    showMenu(x, y, [
      { label: 'Split at cursor', key: 'S', action: () => splitAt(c, t, P.cursor) },
      { label: 'Split here', action: () => splitAt(c, t, snapBeat(beat)) },
      { label: 'Duplicate', key: 'Ctrl+D', action: () => duplicate(c, t) },
      { label: 'Delete', key: 'Del', action: () => del(c, t) },
      '-',
      { label: c.sync ? 'Turn off tempo sync' : 'Sync to project tempo', disabled: !A || !A.bpm, action: () => toggleSync(c) },
      { label: c.loop ? 'Turn off looping' : 'Loop this clip', action: () => { Hist.push(); c.loop = !c.loop; if (!c.loop) { const pb = playBuffer(c); if (pb) c.len = Math.min(c.len, (pb.srcDur - c.offset) / spb()); } Engine.refresh(); draw(); } },
      { label: 'Clip gain…', action: async () => { const r = await showDialog({ title: 'Clip gain', fields: [{ id: 'g', label: 'Gain', type: 'range', min: -24, max: 12, step: 0.1, value: c.gain || 0, format: (v) => fmtDb(v) + ' dB' }] }); if (r) { Hist.push(); c.gain = r.g; Engine.refresh(); draw(); } } },
      { label: 'Set source tempo…', disabled: !A, action: () => sourceTempo(A) },
      '-',
      { label: 'Open in Editor', disabled: !!c.stem, action: () => Editor.open(c.asset) },
      { label: 'Separate stems in Stems view', disabled: !!c.stem, action: () => { Deck.load(c.asset); setView('stems'); } },
    ]);
  }
  async function sourceTempo(A) {
    const r = await showDialog({
      title: 'Source tempo', desc: 'Rush detected this tempo automatically. Correct it if a loop drifts against the grid.',
      fields: [{ id: 'bpm', label: 'Tempo (BPM)', type: 'number', value: A.bpm ? +A.bpm.toFixed(3) : 120, step: 0.001 }, { id: 'beats', label: 'Length in beats', type: 'number', value: A.beats ? +A.beats.toFixed(3) : 4, step: 0.25 }, { id: 'loop', label: 'Treat as a loop', type: 'check', value: A.isLoop }],
    });
    if (!r) return;
    Hist.push();
    if (r.beats !== A.beats && r.beats > 0) { A.beats = r.beats; A.bpm = r.beats * 60 / A.buffer.duration; } else A.bpm = r.bpm;
    A.isLoop = r.loop; A.stretch.clear();
    Engine.refresh(); bus.emit('assets'); draw();
  }
  function toggleSync(c) {
    Hist.push();
    const A = S.assets.get(c.asset); const ratio = A.bpm / P.bpm;
    if (c.sync) { c.sync = false; c.offset *= 1 / ratio; }
    else { c.sync = true; c.offset *= ratio; }
    Engine.refresh(); draw();
  }
  function splitAt(c, t, beat) {
    if (beat <= c.start + 1e-6 || beat >= c.start + c.len - 1e-6) { status('Put the cursor inside the clip to split it.'); return; }
    Hist.push();
    const right = Object.assign({}, c, { id: uid('c'), start: beat, len: c.start + c.len - beat, offset: c.offset + (beat - c.start) * spb(), fadeIn: 0 });
    c.len = beat - c.start; c.fadeOut = 0;
    t.clips.push(right);
    Engine.refresh(); draw();
  }
  function duplicate(c, t) { Hist.push(); const d = Object.assign({}, c, { id: uid('c'), start: c.start + c.len }); t.clips.push(d); S.selClip = d.id; Engine.refresh(); layout(); draw(); }
  function del(c, t) { Hist.push(); t.clips = t.clips.filter((k) => k !== c); S.selClip = null; Engine.refresh(); draw(); }

  function addMarker(b) {
    Hist.push();
    P.markers = P.markers || [];
    const n = P.markers.length + 1;
    P.markers.push({ id: uid('m'), b, name: String(n) });
    P.markers.sort((p, q) => p.b - q.b);
    draw(); status('Marker ' + n + ' at ' + fmtBars(b, P.bpb));
  }
  function jumpMarker(dir) {
    const cur = Engine.playing ? Engine.posBeats() : P.cursor;
    const list = (P.markers || []).map((m) => m.b).concat([0]).sort((a, b) => a - b);
    const t = dir > 0 ? list.find((b) => b > cur + 0.01) : list.reverse().find((b) => b < cur - 0.01);
    if (t == null) return;
    P.cursor = t; if (Engine.playing) Engine.play(t); bus.emit('transport');
  }
  function key(e) {
    if (e.key === 'M' && e.shiftKey) { addMarker(snapBeat(Engine.playing ? Engine.posBeats() : P.cursor)); return true; }
    if (e.key === ',' ) { jumpMarker(-1); return true; }
    if (e.key === '.') { jumpMarker(1); return true; }
    const s = selected();
    if ((e.key === 'Delete' || e.key === 'Backspace') && s) { del(s.c, s.t); return true; }
    if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) {
      const pos = Engine.playing ? Engine.posBeats() : P.cursor;
      if (s) splitAt(s.c, s.t, pos);
      else { for (const t of P.tracks) for (const c of [...t.clips]) if (pos > c.start && pos < c.start + c.len) splitAt(c, t, pos); }
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && s) { duplicate(s.c, s.t); return true; }
    if (s && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { Hist.push(); const st = P.snap || 0.25; s.c.start = Math.max(0, s.c.start + (e.key === 'ArrowLeft' ? -st : st)); Engine.refresh(); draw(); return true; }
    if (e.key === '+' || e.key === '=') { zoomAt(1.25, sc().clientWidth / 2); return true; }
    if (e.key === '-' || e.key === '_') { zoomAt(0.8, sc().clientWidth / 2); return true; }
    return false;
  }

  function follow() {
    if (!Engine.playing) return;
    const s = sc(); const x = xOf(Engine.posBeats());
    if (x > s.clientWidth * 0.88 || x < 0) s.scrollLeft = Math.max(0, Engine.posBeats() * ppb - s.clientWidth * 0.12);
  }

  function rulerPointer() {
    const w = $('#rulerWrap');
    let rd = null;
    const markerAt = (x) => (P.markers || []).find((m) => Math.abs(xOf(m.b) - x) < 7 || (x > xOf(m.b) && x < xOf(m.b) + 12 + m.name.length * 6.5));
    w.addEventListener('contextmenu', (e) => {
      e.preventDefault(); const r = w.getBoundingClientRect(); const m = markerAt(e.clientX - r.left);
      if (!m) { showMenu(e.clientX, e.clientY, [{ label: 'Insert marker here', action: () => addMarker(snapBeat(beatOf(e.clientX - r.left))) }]); return; }
      showMenu(e.clientX, e.clientY, [
        { label: 'Rename marker…', action: async () => { const q = await showDialog({ title: 'Rename marker', fields: [{ id: 'n', label: 'Name', value: m.name }], ok: 'Rename' }); if (q && q.n) { Hist.push(); m.name = q.n; draw(); } } },
        { label: 'Delete marker', action: () => { Hist.push(); P.markers = P.markers.filter((x) => x !== m); draw(); } },
      ]);
    });
    w.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = w.getBoundingClientRect();
      const mk = e.clientY - r.top < 16 ? markerAt(e.clientX - r.left) : null;
      const b = mk ? mk.b : snapBeat(Math.max(0, beatOf(e.clientX - r.left)));
      rd = { b0: b, b1: b, moved: false }; w.setPointerCapture(e.pointerId);
    });
    w.addEventListener('pointermove', (e) => {
      if (!rd) return; const r = w.getBoundingClientRect();
      rd.b1 = snapBeat(Math.max(0, beatOf(e.clientX - r.left))); if (rd.b1 !== rd.b0) rd.moved = true;
      if (rd.moved) { P.loop.start = Math.min(rd.b0, rd.b1); P.loop.end = Math.max(rd.b0, rd.b1); P.loop.on = true; draw(); bus.emit('transport'); }
    });
    w.addEventListener('pointerup', () => {
      if (!rd) return;
      if (!rd.moved) { P.cursor = rd.b0; if (Engine.playing) Engine.play(P.cursor); }
      else { markDirty(); Engine.refresh(); }
      rd = null; bus.emit('transport'); draw();
    });
    w.addEventListener('wheel', (e) => { e.preventDefault(); sc().scrollLeft += e.deltaY + e.deltaX; }, { passive: false });
  }

  function init() {
    bindPointer(); rulerPointer();
    $('#addTrack').addEventListener('click', () => addTrack());
    $('#zIn').addEventListener('click', () => zoomAt(1.3, sc().clientWidth / 2));
    $('#zOut').addEventListener('click', () => zoomAt(1 / 1.3, sc().clientWidth / 2));
    $('#heads').addEventListener('wheel', (e) => { sc().scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
    new ResizeObserver(() => { layout(); draw(); }).observe(tl());
    bus.on('project', () => { renderHeads(); layout(); draw(); });
    bus.on('tracks', () => draw());
    bus.on('assets', () => draw());
    bus.on('redraw', () => draw());
    bus.on('transport', () => drawOverlay());
    bus.on('assetMeta', (A) => {
      // first analysis result for a freshly dropped loop: switch its clips to tempo sync
      let ch = false;
      for (const t of P.tracks) for (const c of t.clips) if (c.asset === A.id && !c.sync && A.isLoop && c.offset === 0 && Math.abs(c.len - A.buffer.duration / spb()) < 0.01) { c.sync = true; c.loop = true; c.len = A.beats; ch = true; }
      if (ch) { Engine.refresh(); draw(); }
    });
  }
  return { init, draw, drawOverlay, layout, renderHeads, follow, key, placeAsset, clipFor, addTrack, selected, zoomAt, addMarker, transpose, get ppb() { return ppb; }, set ppb(v) { ppb = v; } };
})();
