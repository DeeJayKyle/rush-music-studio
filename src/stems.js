// ---------------------------------------------------------------------------
// Stems deck — real-time stem control (instant DSP split → HQ pre-analysed stems)
// ---------------------------------------------------------------------------
const Deck = (() => {
  const D = {
    A: null, playing: false, t0: 0, off: 0, cue: 0, rate: 1, srcs: [], g: null, mode: 'idle',
    on: { vocals: true, melody: true, bass: true, drums: true }, vol: { vocals: 1, melody: 1, bass: 1, drums: 1 },
    filter: 0, echo: 0, deckVol: 1, scrub: null, zoomSec: 6,
  };
  const order = ['drums', 'bass', 'melody', 'vocals'];
  const keyMap = { z: 'vocals', x: 'melody', c: 'bass', v: 'drums' };

  function graph() {
    const ctx = Engine.ensure(false);
    if (D.g && D.g.ctx === ctx) return D.g;
    const g = { ctx };
    g.bus = ctx.createGain();
    g.lp = ctx.createBiquadFilter(); g.lp.type = 'lowpass'; g.lp.frequency.value = 22000; g.lp.Q.value = 0.9;
    g.hp = ctx.createBiquadFilter(); g.hp.type = 'highpass'; g.hp.frequency.value = 10; g.hp.Q.value = 0.9;
    g.out = ctx.createGain();
    g.bus.connect(g.lp).connect(g.hp).connect(g.out).connect(Engine.master.input);
    g.stem = {};
    for (const k of order) { g.stem[k] = ctx.createGain(); g.stem[k].connect(g.bus); }
    // vocal echo (beat synced)
    g.echoSend = ctx.createGain(); g.echoSend.gain.value = 0;
    g.echo = ctx.createDelay(4); g.echoFb = ctx.createGain(); g.echoFb.gain.value = 0.45;
    const ef = ctx.createBiquadFilter(); ef.type = 'bandpass'; ef.frequency.value = 1800; ef.Q.value = 0.6;
    g.stem.vocals.connect(g.echoSend).connect(g.echo); g.echo.connect(ef).connect(g.echoFb).connect(g.echo); ef.connect(g.bus);
    // instant (live) split network on the full mix
    g.liveIn = ctx.createGain();
    g.liveGate = ctx.createGain(); g.liveGate.connect(g.liveIn);   // closes where AI stems take over
    g.direct = ctx.createGain(); g.liveIn.connect(g.direct).connect(g.bus);
    const split = ctx.createChannelSplitter(2);
    g.liveIn.connect(split);
    const mid = ctx.createGain(); mid.gain.value = 0.5;
    const side = ctx.createGain(); side.gain.value = 0.5;
    const inv = ctx.createGain(); inv.gain.value = -1;
    split.connect(mid, 0); split.connect(mid, 1); split.connect(side, 0); split.connect(inv, 1); inv.connect(side);
    const mk = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    g.live = {};
    const lb1 = mk('lowpass', 170), lb2 = mk('lowpass', 170); g.liveIn.connect(lb1).connect(lb2); g.live.bass = lb2;
    const ld1 = mk('highpass', 5200), ld2 = mk('highpass', 5200); g.liveIn.connect(ld1).connect(ld2); g.live.drums = ld2;
    const lv1 = mk('highpass', 240), lv2 = mk('lowpass', 4200), lv3 = mk('peaking', 2500, 1); lv3.gain.value = 3; mid.connect(lv1).connect(lv2).connect(lv3); g.live.vocals = lv3;
    const lm1 = mk('highpass', 200), lm2 = mk('lowpass', 6000); side.connect(lm1).connect(lm2); g.live.melody = lm2;
    g.liveG = {};
    for (const k of order) { g.liveG[k] = ctx.createGain(); g.liveG[k].gain.value = 0; g.live[k].connect(g.liveG[k]).connect(g.stem[k]); }
    D.g = g;
    apply();
    return g;
  }
  const hq = () => D.A && D.A.stems.state === 'done';
  function apply() {
    const g = D.g; if (!g) return;
    const t = Engine.ctx.currentTime;
    const all = order.every((k) => D.on[k] && Math.abs(D.vol[k] - 1) < 1e-3);
    for (const k of order) {
      const v = D.on[k] ? D.vol[k] : 0;
      g.stem[k].gain.setTargetAtTime(v, t, 0.012);
      g.liveG[k].gain.setTargetAtTime(hq() || all ? 0 : 1.2, t, 0.012);
    }
    g.direct.gain.setTargetAtTime(!hq() && all ? 1 : 0, t, 0.012);
    // filter: <0 low-pass sweep, >0 high-pass sweep
    const f = D.filter;
    g.lp.frequency.setTargetAtTime(f < 0 ? 22000 * Math.pow(120 / 22000, -f) : 22000, t, 0.02);
    g.hp.frequency.setTargetAtTime(f > 0 ? 10 * Math.pow(8000 / 10, f) : 10, t, 0.02);
    g.echoSend.gain.setTargetAtTime(D.echo, t, 0.02);
    const bpm = (D.A && D.A.bpm) || 120;
    g.echo.delayTime.setTargetAtTime(60 / (bpm * D.rate) * 0.75, t, 0.05);
    g.out.gain.setTargetAtTime(D.deckVol, t, 0.02);
  }

  function pos() { if (!D.playing) return D.off; return D.off + (Engine.ctx.currentTime - D.t0) * D.rate; }
  function dur() { return D.A ? D.A.buffer.duration : 0; }
  function start(at) {
    const ctx = Engine.ensure(); const g = graph();
    stopSrcs();
    at = clamp(at, 0, Math.max(0, dur() - 0.01));
    const when = ctx.currentTime + 0.03;
    if (hq()) {
      for (const k of order) {
        const s = ctx.createBufferSource(); s.buffer = D.A.stems.buffers[k]; s.playbackRate.value = D.rate;
        s.connect(g.stem[k]); s.start(when, at); D.srcs.push(s);
      }
      D.mode = 'hq';
    } else {
      const s = ctx.createBufferSource(); s.buffer = D.A.buffer; s.playbackRate.value = D.rate;
      s.connect(g.liveGate); s.start(when, at); D.srcs.push(s);
      D.mode = 'live';
      D.sched = { when, at, recs: [] };
      g.liveGate.gain.cancelScheduledValues(0); g.liveGate.gain.setValueAtTime(1, ctx.currentTime);
      if (D.A.stems.live) for (const r of D.A.stems.live.regions) scheduleRegion(r, true);
      gate();
      if (D.A.stems.ai) D.A.stems.ai.focus(at);
    }
    D.srcs[0].onended = () => { if (D.playing && pos() >= dur() - 0.05) { D.playing = false; D.off = 0; ui(); } };
    D.t0 = when; D.off = at; D.playing = true;
    apply(); ui();
  }
  function stopSrcs() {
    for (const s of D.srcs) { try { s.onended = null; s.stop(); } catch (e) { } } D.srcs = [];
    if (D.sched) for (const rec of D.sched.recs) for (const s of rec.srcs) { try { s.stop(); } catch (e) { } }
    D.sched = null;
  }
  // ---- progressive AI stems: play each finished stretch as soon as it arrives, live split elsewhere ----
  const XF = 0.012;
  const ctxTime = (t) => D.sched.when + (t - D.sched.at) / D.rate;
  function scheduleRegion(r, batch) {
    if (!D.playing || !D.sched || D.mode !== 'live') return;
    const ctx = Engine.ctx, g = D.g, now = ctx.currentTime + 0.05;
    const songNow = D.sched.at + Math.max(0, now - D.sched.when) * D.rate;
    const a = Math.max(r.a, songNow);
    if (a >= r.b - 0.02) return;
    if (!r.bufs) { r.bufs = {}; for (const k of order) r.bufs[k] = makeBuffer(r.parts[k], r.sr); }
    const t0 = ctxTime(a), t1 = ctxTime(r.b), rec = { a, b: r.b, t0, t1, srcs: [], gains: [] };
    for (const k of order) {
      const src = ctx.createBufferSource(); src.buffer = r.bufs[k]; src.playbackRate.value = D.rate;
      const gn = ctx.createGain(); src.connect(gn).connect(g.stem[k]);
      src.start(t0, a - r.a); src.stop(t1);
      rec.srcs.push(src); rec.gains.push(gn);
    }
    D.sched.recs.push(rec);
    if (!batch) gate();
  }
  // fades at the edges of AI coverage, and the live split muted wherever AI stems play
  function gate() {
    if (!D.sched) return;
    const ctx = Engine.ctx, now = ctx.currentTime, recs = D.sched.recs.sort((x, y) => x.a - y.a), lg = D.g.liveGate.gain;
    const covered = (t) => recs.some((q) => t >= q.a - 1e-3 && t < q.b - 1e-3);
    lg.cancelScheduledValues(now); lg.setValueAtTime(lg.value, now);
    for (const rec of recs) {
      if (rec.t1 < now) continue;
      const contigIn = recs.some((q) => q !== rec && Math.abs(q.b - rec.a) < 2e-3), contigOut = recs.some((q) => q !== rec && Math.abs(q.a - rec.b) < 2e-3);
      for (const gn of rec.gains) {
        gn.gain.cancelScheduledValues(now);
        if (rec.t0 > now && !contigIn) { gn.gain.setValueAtTime(0, rec.t0); gn.gain.linearRampToValueAtTime(1, rec.t0 + XF); }
        else gn.gain.setValueAtTime(1, Math.max(now, rec.t0));
        if (!contigOut) { gn.gain.setValueAtTime(1, Math.max(now, rec.t1 - XF)); gn.gain.linearRampToValueAtTime(0, rec.t1); }
      }
      if (!contigIn) { if (rec.t0 > now) { lg.setValueAtTime(1, rec.t0); lg.linearRampToValueAtTime(0, rec.t0 + XF); } else lg.setValueAtTime(0, now); }
      if (!contigOut) { lg.setValueAtTime(0, Math.max(now, rec.t1 - XF)); lg.linearRampToValueAtTime(1, rec.t1); }
    }
    if (!recs.length || !covered(D.sched.at + (now - D.sched.when) * D.rate)) { /* live split keeps playing */ }
  }
  function play() {
    if (!D.A) { toast('Load a song to the deck first.'); return; }
    if (D.playing) { pause(); return; }
    Engine.halt(); Engine.stopPreview(); bus.emit('transport');
    start(D.off);
    loop();
  }
  function pause() { if (!D.playing) return; D.off = pos(); D.playing = false; stopSrcs(); ui(); }
  function cue() {
    if (!D.A) return;
    if (D.playing) { pause(); D.off = D.cue; }
    else { if (Math.abs(D.off - D.cue) < 0.01) { start(D.cue); loop(); return; } D.cue = D.off; toast('Cue point set at ' + fmtShort(D.cue)); }
    draw();
  }
  function seek(t) { t = clamp(t, 0, dur()); if (D.playing) start(t); else { D.off = t; draw(); if (D.A && D.A.stems.ai) D.A.stems.ai.focus(t); } }
  function loop() {
    if (!D.playing) { draw(); return; }
    draw();
    requestAnimationFrame(loop);
  }

  async function load(id) {
    const A = S.assets.get(id);
    if (!A) return;
    pause();
    D.A = A; D.off = 0; D.cue = 0;
    $('#dkAsset').value = id;
    ui(); draw();
    if (A.stems.state !== 'done') separate();
    else ui();
  }
  function unload() { pause(); D.A = null; ui(); draw(); }
  async function separate() {
    const A = D.A; if (!A) return;
    const t0 = performance.now();
    const label = () => (A.stems.engine === 'ai' ? AI.describe() : 'Fast separator on ' + Pool.size + ' threads');
    setStatus('live', 'Preparing stems… instant mode is live meanwhile.', A.stems.progress || 0);
    try {
      await separateAsset(A, (p) => { if (D.A === A) setStatus('live', label() + ' · ' + Math.round(p * 100) + ' %' + (A.stems.engine === 'ai' ? ' · finished parts already play as AI stems' : ''), p); }, { from: D.off });
      if (D.A !== A) return;
      ui();
      // already playing AI stems to the end? keep going without a restart
      if (D.playing) {
        const p = pos(), recs = D.sched ? D.sched.recs.slice().sort((x, y) => x.a - y.a) : [];
        let t = p; for (const r of recs) if (r.a <= t + 2e-3 && r.b > t) t = r.b;
        if (t < dur() - 0.05) start(p); else { D.mode = 'hq'; apply(); }
      }
      draw();
    } catch (e) { setStatus('idle', 'Separation stopped: ' + e.message, 0); }
  }
  function setStatus(mode, txt, p) {
    const b = $('#dkMode');
    b.className = 'badge ' + (mode === 'hq' ? 'hq' : mode === 'live' ? 'live' : '');
    const ai = D.A && D.A.stems.engine === 'ai';
    b.textContent = mode === 'hq' ? (ai ? 'AI stems' : 'HQ stems') : mode === 'live' ? (D.sched && D.sched.recs.length ? 'Instant + AI' : 'Instant mode') : 'Idle';
    $('#dkStatusTxt').textContent = txt;
    $('#dkProg').style.width = Math.round((p || 0) * 100) + '%';
  }

  // ---- UI ----
  const stemEls = {};
  function buildStems() {
    const row = $('#stemRow'); row.innerHTML = '';
    for (const s of STEMS) {
      const k = s.key;
      const pad = el('button', { class: 'stem-pad', 'aria-pressed': 'true', title: s.label + ' on/off (' + Object.keys(keyMap).find((x) => keyMap[x] === k).toUpperCase() + ')' }, s.label, el('small', {}, 'ON'));
      pad.addEventListener('click', () => toggle(k));
      const fader = el('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: 1, 'aria-label': s.label + ' level' });
      const out = el('output', {}, '100%');
      fader.addEventListener('input', () => { D.vol[k] = parseFloat(fader.value); out.textContent = Math.round(D.vol[k] * 100) + '%'; apply(); });
      fader.addEventListener('dblclick', () => { D.vol[k] = 1; fader.value = 1; out.textContent = '100%'; apply(); });
      const solo = el('button', { class: 'btn sm ghost', title: 'Hear only this stem' }, 'Solo');
      solo.addEventListener('click', () => { for (const o of order) D.on[o] = o === k; ui(); apply(); });
      const toEd = el('button', { class: 'btn sm ghost', title: 'Copy this stem to Media and open it in the Editor' }, 'Edit');
      toEd.addEventListener('click', () => stemToAsset(k, true));
      const card = el('div', { class: 'stem', style: { '--sc': `var(--st-${k})` } }, pad, el('div', { class: 'stem-fader' }, fader, out), el('div', { class: 'stem-acts' }, solo, toEd));
      row.append(card);
      stemEls[k] = { pad, fader, out };
    }
    const fx = $('#deckFx'); fx.innerHTML = '';
    const kf = knob({ label: 'Filter', min: -1, max: 1, value: 0, def: 0, step: 0.01, format: (v) => Math.abs(v) < 0.02 ? 'off' : v < 0 ? 'LP ' + Math.round(-v * 100) : 'HP ' + Math.round(v * 100), onInput: (v) => { D.filter = Math.abs(v) < 0.02 ? 0 : v; apply(); } });
    const ke = knob({ label: 'Vocal echo', min: 0, max: 1, value: 0, def: 0, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { D.echo = v; apply(); } });
    const kt = knob({ label: 'Tempo', min: -8, max: 8, value: 0, def: 0, step: 0.05, format: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%', onInput: (v) => { const p = pos(); D.rate = 1 + v / 100; if (D.playing) start(p); else apply(); ui(); } });
    const kv = knob({ label: 'Deck level', min: 0, max: 1.5, value: 1, def: 1, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { D.deckVol = v; apply(); } });
    fx.append(kf.el, ke.el, kt.el, kv.el,
      el('div', { style: { color: 'var(--muted)', fontSize: '12px', maxWidth: '340px', lineHeight: '1.45' } },
        'Keys: Z vocals · X melody · C bass · V drums · Space play · drag the waveform to scrub. Turning the knobs while the deck plays changes the sound in real time.'));
  }
  function toggle(k) { D.on[k] = !D.on[k]; ui(); apply(); }
  function quick(q) {
    const set = { all: [1, 1, 1, 1], acapella: [1, 0, 0, 0], instrumental: [0, 1, 1, 1], drums: [0, 0, 0, 1], nodrums: [1, 1, 1, 0] }[q];
    ['vocals', 'melody', 'bass', 'drums'].forEach((k, i) => { D.on[k] = !!set[i]; });
    ui(); apply();
  }
  function ui() {
    for (const k in stemEls) { const e = stemEls[k]; e.pad.setAttribute('aria-pressed', String(D.on[k])); e.pad.querySelector('small').textContent = D.on[k] ? 'ON' : 'MUTED'; }
    const A = D.A;
    $('#dkTitle').textContent = A ? A.name : 'No track loaded';
    $('#dkSub').textContent = A ? (fmtShort(A.buffer.duration) + ' · ' + (A.buffer.sampleRate / 1000).toFixed(1) + ' kHz · ' + (A.buffer.numberOfChannels > 1 ? 'stereo' : 'mono')) : 'Pick a song from Media, then press Load to deck.';
    $('#dkBpm').textContent = A && A.bpm ? (A.bpm * D.rate).toFixed(1) : '—';
    $('#dkKey').textContent = A && A.key ? A.key.camelot + ' ' + A.key.short : '—';
    const pb = $('#dkPlay'); pb.innerHTML = ''; pb.append(icon(D.playing ? 'pause' : 'play'));
    if (!A) setStatus('idle', AI.status === 'unknown' ? 'Separation runs fully offline on this computer.' : AI.describe(), 0);
    else if (A.stems.state === 'done') setStatus('hq', (A.stems.engine === 'ai' ? 'AI stems ready (HTDemucs)' : 'Fast stems ready') + (A.stems.ms ? ' · separated in ' + (A.stems.ms / 1000).toFixed(1) + ' s (' + (A.buffer.duration / (A.stems.ms / 1000)).toFixed(1) + '× real-time)' : '') + (A.stems.engine !== 'ai' && AI.status === 'ready' ? ' · for AI quality, right-click the file in Media › Separate again with AI' : ''), 1);
  }
  function fillSelect() {
    const s = $('#dkAsset'); const cur = s.value; s.innerHTML = '';
    if (!S.assets.size) s.append(el('option', { value: '' }, 'No files yet'));
    for (const a of S.assets.values()) s.append(el('option', { value: a.id }, a.name + (a.stems.state === 'done' ? '  ✓ stems' : '')));
    if (D.A) s.value = D.A.id; else if (cur && S.assets.has(cur)) s.value = cur;
  }

  function stemPeakAt(k, s0, s1) {
    const pk = D.A.stems.peaks[k]; const b = D.A.stems.buffers[k];
    const r = peakRange(pk, b, -1, s0, s1); return r ? Math.max(-r[0], r[1]) : 0;
  }
  function drawWaveInto(cv, t0, t1, center) {
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = C.panel; ctx.fillRect(0, 0, w, h);
    if (!D.A) { ctx.fillStyle = C.faint; ctx.textAlign = 'center'; ctx.font = '13px ' + getComputedStyle(document.body).fontFamily; if (center) ctx.fillText('Load a song to see its stems here', w / 2, h / 2); ctx.textAlign = 'left'; return { ctx, w, h }; }
    const b = D.A.buffer, sr = b.sampleRate, mid = h / 2, amp = h / 2 - 4;
    const spx = (t1 - t0) / w * sr;
    if (hq()) {
      for (const k of order) {
        const col = C['st' + k[0].toUpperCase() + k.slice(1)];
        ctx.fillStyle = D.on[k] ? alpha(col, 0.88) : alpha(C.muted, 0.18);
        const g = D.on[k] ? Math.min(1.5, D.vol[k]) : 1;
        for (let x = 0; x < w; x++) {
          const s0 = (t0 * sr) + x * spx; if (s0 < 0 || s0 >= b.length) continue;
          const v = stemPeakAt(k, s0, s0 + Math.max(1, spx)) * g;
          const hh = Math.min(amp, v * amp * 1.15);
          ctx.fillRect(x, mid - hh, 1, hh * 2 || 1);
        }
      }
    } else {
      ctx.fillStyle = alpha(C.wave, 0.6);
      for (let x = 0; x < w; x++) {
        const s0 = (t0 * sr) + x * spx; if (s0 < 0 || s0 >= b.length) continue;
        const r = peakRange(D.A.peaks, b, -1, s0, s0 + Math.max(1, spx)); if (!r) continue;
        const v = Math.max(-r[0], r[1]); ctx.fillRect(x, mid - v * amp, 1, Math.max(1, v * amp * 2));
      }
    }
    return { ctx, w, h };
  }
  function draw() {
    const p = pos();
    const half = D.zoomSec / 2;
    const r = drawWaveInto($('#dkCanvas'), p - half, p + half, true);
    if (D.A) {
      const { ctx, w, h } = r;
      // beat ticks (relative grid from detected tempo)
      if (D.A.bpm) {
        const bp = 60 / D.A.bpm; ctx.fillStyle = alpha(C.fg, 0.08);
        for (let t = Math.ceil((p - half) / bp) * bp; t < p + half; t += bp) { const x = (t - (p - half)) / D.zoomSec * w; ctx.fillRect(Math.round(x), 0, 1, h); }
      }
      // cue
      const cx = (D.cue - (p - half)) / D.zoomSec * w;
      if (cx >= 0 && cx <= w) { ctx.fillStyle = C.sel; ctx.fillRect(cx, 0, 2, h); ctx.beginPath(); ctx.moveTo(cx - 5, 0); ctx.lineTo(cx + 7, 0); ctx.lineTo(cx + 1, 8); ctx.fill(); }
      ctx.fillStyle = C.fg; ctx.fillRect(w / 2 - 1, 0, 2, h);
      ctx.fillStyle = alpha(C.bg, 0.6); ctx.fillRect(0, 0, 4, h);
    }
    const o = drawWaveInto($('#dkOverCanvas'), 0, Math.max(0.01, dur()), false);
    if (D.A) {
      const { ctx, w, h } = o;
      const x = p / dur() * w;
      ctx.fillStyle = alpha(C.bg, 0.45); ctx.fillRect(0, 0, x, h);
      ctx.fillStyle = C.accent; ctx.fillRect(x - 1, 0, 2, h);
      ctx.fillStyle = C.sel; ctx.fillRect(D.cue / dur() * w, 0, 1.5, h);
      if (D.A.stems.live) { ctx.fillStyle = alpha(C.ok, 0.9); for (const r of D.A.stems.live.regions) ctx.fillRect(r.a / dur() * w, h - 3, Math.max(1, (r.b - r.a) / dur() * w), 3); }
    }
    $('#dkTime').textContent = fmtShort(p);
    $('#dkRemain').textContent = '-' + fmtShort(Math.max(0, dur() - p));
  }

  async function stemToAsset(k, openIt) {
    if (!D.A) { toast('Load a song first.'); return null; }
    if (!hq()) { toast('Stems are still being separated. Try again when the HQ badge shows.'); return null; }
    const b = D.A.stems.buffers[k];
    const a = addAsset(D.A.name + ' (' + k + ')', makeBuffer(bufferChannels(b).map((c) => c.slice()), b.sampleRate), { bpm: D.A.bpm, beats: D.A.beats, isLoop: D.A.isLoop, key: D.A.key });
    if (openIt) Editor.open(a.id);
    return a;
  }
  function toArrange() {
    if (!D.A) { toast('Load a song first.'); return; }
    if (!hq()) { toast('Wait for HQ stems before sending them to Arrange.'); return; }
    Hist.push();
    const A = D.A;
    for (const s of STEMS) {
      const t = newTrack(A.name + ' · ' + s.label); t.color = getComputedStyle(document.documentElement).getPropertyValue('--st-' + s.key).trim() || t.color;
      const c = Arrange.clipFor(A, 0, s.key);
      t.clips.push(c); P.tracks.push(t);
    }
    Engine.syncTracks(); bus.emit('project');
    toast('Added 4 stem tracks to Arrange', 'ok');
    setView('arrange');
  }
  async function exportStems() {
    if (!D.A || !hq()) { toast('Separate a song first.'); return; }
    const r = await showDialog({ title: 'Export stems', desc: 'Saves four WAV files: vocals, melody, bass and drums.', fields: [{ id: 'bits', label: 'Bit depth', type: 'select', value: '24', options: [{ value: '16', label: '16-bit PCM' }, { value: '24', label: '24-bit PCM' }, { value: '32', label: '32-bit float' }] }], ok: 'Export 4 files' });
    if (!r) return;
    for (const s of STEMS) {
      const b = D.A.stems.buffers[s.key];
      downloadBlob(encodeWav(bufferChannels(b), b.sampleRate, +r.bits), safeName(D.A.name) + ' - ' + s.label + '.wav');
      await sleep(350);
    }
    toast('Exported 4 stems', 'ok');
  }

  function bindWave() {
    const w = $('#dkWave');
    w.addEventListener('pointerdown', (e) => { if (!D.A) return; w.setPointerCapture(e.pointerId); D.scrub = { x: e.clientX, p: pos(), was: D.playing }; if (D.playing) pause(); w.style.cursor = 'grabbing'; });
    w.addEventListener('pointermove', (e) => { if (!D.scrub) return; const dx = e.clientX - D.scrub.x; D.off = clamp(D.scrub.p - dx / w.clientWidth * D.zoomSec, 0, dur()); draw(); });
    const up = () => { if (!D.scrub) return; const was = D.scrub.was; D.scrub = null; w.style.cursor = ''; if (was) { start(D.off); loop(); } };
    w.addEventListener('pointerup', up); w.addEventListener('pointercancel', up);
    w.addEventListener('wheel', (e) => { e.preventDefault(); D.zoomSec = clamp(D.zoomSec * (e.deltaY > 0 ? 1.15 : 1 / 1.15), 1.5, 40); draw(); }, { passive: false });
    const o = $('#dkOver');
    o.addEventListener('pointerdown', (e) => { if (!D.A) return; const r = o.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * dur()); if (D.playing) loop(); });
    new ResizeObserver(() => draw()).observe(w);
  }

  function key(e) {
    const k = e.key.toLowerCase();
    if (k === ' ') { play(); return true; }
    if (keyMap[k] && !e.ctrlKey && !e.metaKey) { toggle(keyMap[k]); return true; }
    return false;
  }
  function init() {
    buildStems(); bindWave();
    $('#dkPlay').addEventListener('click', play);
    $('#dkCue').addEventListener('click', cue);
    $('#dkLoad').addEventListener('click', () => { const id = $('#dkAsset').value; if (id) load(id); });
    $$('[data-quick]').forEach((b) => b.addEventListener('click', () => quick(b.dataset.quick)));
    $('#dkToArr').addEventListener('click', toArrange);
    $('#dkExport').addEventListener('click', exportStems);
    bus.on('assets', () => { fillSelect(); if (D.A && !S.assets.has(D.A.id)) unload(); });
    bus.on('assetChanged', (A) => { if (A === D.A) { pause(); ui(); draw(); if (S.view === 'stems') separate(); } });
    bus.on('assetMeta', (A) => { if (A === D.A) ui(); });
    bus.on('stemRegion', ({ A, r }) => { if (A === D.A) { scheduleRegion(r); setStatus('live', $('#dkStatusTxt').textContent, A.stems.progress); if (!D.playing) draw(); } });
    bus.on('ai', () => { if (D.A) ui(); else setStatus('idle', AI.describe(), 0); });
    fillSelect(); ui();
  }
  function unloadAudio() { pause(); D.g = null; }
  return { init, load, unload, unloadAudio, play, pause, draw, key, separate, get asset() { return D.A; }, get playing() { return D.playing; } };
})();
