// ---------------------------------------------------------------------------
// Beatmapper — a three-step wizard that fits a beat grid to a whole song
// (first downbeat → tempo check later in the song → how to use it), so long
// tracks lock to the project tempo and mix cleanly.
// ---------------------------------------------------------------------------
const Beatmapper = (() => {
  function open(A, opts = {}) {
    return new Promise((resolve) => {
      const base = A.buffer, dur = base.duration;
      const st = { bpm: A.bpm || 120, db: A.downbeat || 0, step: 0, sync: true, setTempo: !projectEndBeats() || !!opts.first };
      let view = { t0: 0, t1: 1 }, prev = null, grab = null, playFrom = null;
      const per = () => 60 / st.bpm;
      const STEPS = [
        { title: 'Find the first downbeat', text: 'Click the first strong downbeat — the “one” of bar 1. The red line is where Rush heard it; clicks snap to the nearest attack. Press Play to hear the metronome against the song.' },
        { title: 'Check the tempo', text: 'This is later in the song. If the orange beat lines drift off the hits, drag a line onto its hit (or nudge the tempo) until they sit together.' },
        { title: 'Use the beatmap', text: 'Rush will stretch the song to follow your project’s tempo — with pitch preserved — so every bar lines up in the mix.' },
      ];
      const bg = el('div', { class: 'modal-bg' });
      const cv = el('canvas', { class: 'bm-wave', 'aria-label': 'Song waveform with beat grid' });
      const head = el('header', {});
      const dots = el('div', { class: 'bm-dots' });
      const ctl = el('div', { class: 'bm-ctl' });
      const fin = el('div', { class: 'bm-fin' });
      const backBtn = el('button', { class: 'btn', type: 'button' }, 'Back');
      const nextBtn = el('button', { class: 'btn primary', type: 'button' }, 'Next');
      const skipBtn = el('button', { class: 'btn ghost', type: 'button', title: 'Keep the automatic beatmap' }, 'Skip');
      const box = el('div', { class: 'modal beatmapper', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Beatmapper' },
        head, el('div', { class: 'bm-body' }, dots, cv, ctl, fin),
        el('footer', {}, skipBtn, el('div', { class: 'spacer' }), backBtn, nextBtn));
      const bpmIn = el('input', { class: 'inp bm-bpm', type: 'number', step: 0.01, min: 20, max: 300, 'aria-label': 'Song tempo in BPM' });
      bpmIn.addEventListener('input', () => { const v = parseFloat(bpmIn.value); if (v >= 20 && v <= 300) { st.bpm = v; draw(); } });
      bpmIn.addEventListener('keydown', (e) => e.stopPropagation());
      const btn = (txt, title, fn) => el('button', { class: 'btn sm', type: 'button', title, onclick: () => { fn(); sync(); } }, txt);
      const playBtn = el('button', { class: 'btn sm primary', type: 'button' }, icon('play'), 'Play');
      playBtn.addEventListener('click', () => (prev ? stopPrev() : play()));

      function setView() {
        if (st.step === 0) { view.t0 = Math.max(0, st.db - 3); view.t1 = Math.min(dur, view.t0 + 10); }
        else if (st.step === 1) { const mid = Math.max(st.db + 16 * per(), dur * 0.62); view.t0 = clamp(mid - 4, 0, Math.max(0, dur - 8)); view.t1 = Math.min(dur, view.t0 + 8); }
        playFrom = st.step === 0 ? st.db : view.t0;
      }
      function sync() { bpmIn.value = +st.bpm.toFixed(3); draw(); if (prev) play(); }
      function render() {
        stopPrev();
        const S0 = STEPS[st.step];
        head.innerHTML = ''; head.append(el('h3', {}, 'Beatmapper · ' + A.name), el('p', {}, el('b', {}, 'Step ' + (st.step + 1) + ' of 3 — ' + S0.title + '. '), S0.text));
        dots.innerHTML = ''; STEPS.forEach((s, i) => dots.append(el('span', { class: i === st.step ? 'on' : i < st.step ? 'done' : '' }, (i + 1) + ' ' + s.title)));
        ctl.innerHTML = ''; fin.innerHTML = '';
        cv.hidden = st.step === 2;
        if (st.step === 0) ctl.append(playBtn, btn('◀ beat', 'Downbeat one beat earlier', () => (st.db = Math.max(0, st.db - per()))), btn('beat ▶', 'Downbeat one beat later', () => (st.db = Math.min(dur, st.db + per()))), btn('−10 ms', 'Earlier', () => (st.db = Math.max(0, st.db - 0.01))), btn('+10 ms', 'Later', () => (st.db = Math.min(dur, st.db + 0.01))), el('span', { class: 'bm-read' }, 'Downbeat ', el('b', { id: 'bmDb' }, fmtTime(st.db, 3))));
        else if (st.step === 1) ctl.append(playBtn, el('label', { class: 'bm-read' }, 'Tempo ', bpmIn), btn('÷2', 'Half', () => (st.bpm /= 2)), btn('×2', 'Double', () => (st.bpm *= 2)), btn('−0.1', 'Slower', () => (st.bpm -= 0.1)), btn('−0.01', 'Slower', () => (st.bpm -= 0.01)), btn('+0.01', 'Faster', () => (st.bpm += 0.01)), btn('+0.1', 'Faster', () => (st.bpm += 0.1)), btn('Jump ▶', 'Check another part of the song', () => { const span = view.t1 - view.t0; view.t0 = view.t1 + span > dur ? Math.max(0, st.db + 8 * per()) : view.t1; view.t1 = Math.min(dur, view.t0 + span); playFrom = view.t0; }));
        else {
          const chk = (label, k) => { const i = el('input', { type: 'checkbox', checked: st[k] ? true : null }); i.addEventListener('change', () => (st[k] = i.checked)); return el('label', { class: 'cp-chk' }, i, label); };
          fin.append(
            el('div', { class: 'bm-sum' }, el('div', {}, el('span', {}, 'Tempo'), el('b', {}, st.bpm.toFixed(2) + ' BPM')), el('div', {}, el('span', {}, 'First downbeat'), el('b', {}, fmtTime(st.db, 3))), el('div', {}, el('span', {}, 'Key'), el('b', {}, A.key ? A.key.name + ' · ' + A.key.camelot : '—')), el('div', {}, el('span', {}, 'Bars'), el('b', {}, String(Math.floor((dur - st.db) / per() / P.bpb))))),
            chk('Stretch the song to follow the project tempo (pitch preserved)', 'sync'),
            chk('Set the project tempo to ' + st.bpm.toFixed(2) + ' BPM where this song starts', 'setTempo'));
        }
        bpmIn.value = +st.bpm.toFixed(3);
        backBtn.disabled = st.step === 0;
        nextBtn.textContent = st.step === 2 ? 'Finish' : 'Next';
        setView();
        requestAnimationFrame(draw);
      }
      function draw() {
        if (cv.hidden) return;
        const r = cv.getBoundingClientRect(); if (!r.width) return;
        const { ctx, w, h } = fitCanvas(cv);
        ctx.fillStyle = C.trackA; ctx.fillRect(0, 0, w, h);
        const sr = base.sampleRate, spp = (view.t1 - view.t0) * sr / w, mid = h / 2;
        ctx.fillStyle = alpha(C.wave, 0.85);
        for (let x = 0; x < w; x++) { const s0 = view.t0 * sr + x * spp; const pr = peakRange(A.peaks, base, -1, s0, s0 + Math.max(1, spp)); if (pr) ctx.fillRect(x, mid - pr[1] * (h / 2 - 8), 1, Math.max(1, (pr[1] - pr[0]) * (h / 2 - 8))); }
        const p = per(), xT = (t) => (t - view.t0) / (view.t1 - view.t0) * w;
        ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--font-mono');
        for (let k = Math.ceil((view.t0 - st.db) / p); st.db + k * p <= view.t1; k++) {
          const bar = ((k % P.bpb) + P.bpb) % P.bpb === 0, x = Math.round(xT(st.db + k * p)) + 0.5;
          ctx.fillStyle = k === 0 ? C.rec : alpha(C.accent, bar ? 0.95 : 0.5); ctx.fillRect(x - (k === 0 ? 1 : 0), 0, k === 0 ? 3 : bar ? 2 : 1, h);
          if (bar) { ctx.fillStyle = C.fg; ctx.fillText(String(Math.floor(k / P.bpb) + 1), x + 4, 13); }
        }
        const pp = prev && Engine.previewSrc ? prev.from + (Engine.ctx.currentTime - prev.t0) : null;
        if (pp != null) { ctx.fillStyle = C.fg; ctx.fillRect(xT(pp), 0, 1.5, h); }
        ctx.fillStyle = C.muted; ctx.fillText(fmtTime(view.t0, 1) + ' – ' + fmtTime(view.t1, 1), 6, h - 6);
        const dbEl = $('#bmDb'); if (dbEl) dbEl.textContent = fmtTime(st.db, 3);
      }
      const tAt = (e) => { const r = cv.getBoundingClientRect(); return view.t0 + (e.clientX - r.left) / r.width * (view.t1 - view.t0); };
      cv.addEventListener('pointerdown', (e) => {
        const tt = tAt(e), p = per();
        if (st.step === 0) {
          // snap to the strongest attack within ±40 ms
          const d = base.getChannelData(0), sr = base.sampleRate; let best = Math.round(tt * sr), bv = 0;
          for (let i = Math.max(1, Math.round((tt - 0.04) * sr)); i < Math.min(d.length, Math.round((tt + 0.04) * sr)); i++) { const v = Math.abs(d[i]) - Math.abs(d[i - 1]); if (v > bv) { bv = v; best = i; } }
          st.db = best / sr; playFrom = st.db; draw(); if (prev) play();
          return;
        }
        // step 2: grab the nearest beat line and drag it onto a hit; the grid stretches around the downbeat
        const k = Math.round((tt - st.db) / p);
        if (k > 0) { grab = { k }; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'ew-resize'; }
      });
      cv.addEventListener('pointermove', (e) => {
        if (!grab) { cv.style.cursor = st.step === 1 ? 'ew-resize' : 'crosshair'; return; }
        const tt = tAt(e); if (tt <= st.db + 0.05) return;
        st.bpm = clamp(60 / ((tt - st.db) / grab.k), 20, 300); bpmIn.value = +st.bpm.toFixed(3); draw();
      });
      cv.addEventListener('pointerup', () => { if (grab) { grab = null; if (prev) play(); } });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault(); const r = cv.getBoundingClientRect(), f = (e.clientX - r.left) / r.width, tt = view.t0 + f * (view.t1 - view.t0);
        if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) { const span = clamp((view.t1 - view.t0) * (e.deltaY > 0 ? 1.2 : 1 / 1.2), 0.5, dur); view.t0 = clamp(tt - f * span, 0, Math.max(0, dur - span)); view.t1 = view.t0 + span; }
        else { const span = view.t1 - view.t0, sh = span * 0.002 * (e.deltaX || e.deltaY); view.t0 = clamp(view.t0 + sh, 0, Math.max(0, dur - span)); view.t1 = view.t0 + span; }
        draw();
      }, { passive: false });
      function play() {
        stopPrev(true);
        const ctx = Engine.ensure(), from = Math.max(0, playFrom != null ? playFrom : view.t0);
        const src = Engine.playBuffer(base, from), p = per(), clicks = [];
        for (let k = Math.ceil((from - st.db) / p - 1e-6); st.db + k * p < Math.min(dur, from + 40); k++) {
          const at = src.t0 + (st.db + k * p - from); const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = ((k % P.bpb) + P.bpb) % P.bpb === 0 ? 1760 : 1180; g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.4, at + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
          o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.06); clicks.push(o);
        }
        prev = { clicks, from, t0: src.t0 };
        playBtn.innerHTML = ''; playBtn.append(icon('stop'), 'Stop');
        const tick = () => { if (!prev) return; draw(); requestAnimationFrame(tick); }; tick();
      }
      function stopPrev(keepBtn) {
        Engine.stopPreview(); if (prev) prev.clicks.forEach((o) => { try { o.stop(); } catch (e) { } }); prev = null;
        if (!keepBtn) { playBtn.innerHTML = ''; playBtn.append(icon('play'), 'Play'); }
      }
      function close(result) { stopPrev(); bg.remove(); document.removeEventListener('keydown', onKey, true); resolve(result); }
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === ' ' && e.target.tagName !== 'INPUT') { e.preventDefault(); e.stopPropagation(); prev ? stopPrev() : play(); }
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); e.stopPropagation(); nextBtn.click(); }
      };
      document.addEventListener('keydown', onKey, true);
      backBtn.addEventListener('click', () => { if (st.step > 0) { st.step--; render(); } });
      nextBtn.addEventListener('click', () => { if (st.step < 2) { st.step++; render(); } else close({ bpm: st.bpm, db: st.db, sync: st.sync, setTempo: st.setTempo }); });
      skipBtn.addEventListener('click', () => close({ skip: true }));
      bg.append(box); document.body.append(bg);
      render();
    });
  }
  return { open };
})();
