// ---------------------------------------------------------------------------
// Loop Lab — procedural, tempo-exact loop synthesis (offline, no samples needed)
// ---------------------------------------------------------------------------
const LoopLab = (() => {
  const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const KEYS = [];
  for (const m of ['minor', 'major']) for (let i = 0; i < 12; i++) KEYS.push(NOTE[i] + ' ' + m);
  const mf = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // patterns on a 16-step bar: arrays of steps; bass: [step, degree, lenSteps]
  const STYLES = {
    'Afrobeat': { bpm: 105, swing: 0.06, kick: [0, 7, 10], clap: [4, 12], rim: [3, 6, 11, 14], hatC: [2, 6, 10, 14], shaker: 'all', conga: [2, 5, 9, 13, 15], bass: [[0, 0, 3], [7, 0, 2], [10, 4, 2], [14, 3, 2]], chords: 'stab', chordSteps: [0, 3, 6, 10, 12], prog: 'minor' },
    'Amapiano': { bpm: 112, swing: 0.08, kick: [0, 4, 8, 12], kickVel: 0.65, clap: [4, 12], rim: [3, 7, 10, 15], shaker: 'all', log: [[3, 0, 2], [6, 0, 2], [10, 4, 2], [11, 3, 1], [14, 0, 2]], chords: 'stab', chordSteps: [0, 3, 6, 9, 12], prog: 'minor' },
    'House': { bpm: 124, swing: 0, kick: [0, 4, 8, 12], clap: [4, 12], hatO: [2, 6, 10, 14], hatC: 'all', bass: [[2, 0, 1], [6, 0, 1], [10, 0, 1], [14, 2, 1]], chords: 'stab', chordSteps: [2, 6, 10, 14], prog: 'minor' },
    'Hip-Hop': { bpm: 90, swing: 0.14, kick: [0, 7, 10], snare: [4, 12], hatC: 'eighths', bass: [[0, 0, 4], [7, 0, 2], [10, 5, 3]], chords: 'pad', prog: 'minor' },
    'Trap': { bpm: 140, swing: 0, kick: [0, 11], snare: [8], hatC: 'all', roll: [14, 15], sub: [[0, 0, 7], [11, 0, 4]], chords: 'pad', prog: 'minor' },
    'Techno': { bpm: 130, swing: 0, kick: [0, 4, 8, 12], clap: [4, 12], clapVel: 0.5, hatO: [2, 6, 10, 14], hatC: 'all', bass: [[1, 0, 1], [3, 0, 1], [5, 0, 1], [7, 0, 1], [9, 0, 1], [11, 0, 1], [13, 0, 1], [15, 0, 1]], chords: 'stab', chordSteps: [3, 11], prog: 'minor' },
    'Dancehall': { bpm: 100, swing: 0.04, kick: [0, 8], snare: [3, 6, 11, 14], hatC: 'eighths', bass: [[0, 0, 3], [3, 0, 3], [8, 5, 3], [11, 4, 3]], chords: 'stab', chordSteps: [3, 6, 11, 14], prog: 'minor' },
  };

  function noiseBuf(ctx) { const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; }
  function env(g, t, v, a, d) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }

  function make(ctx, out) {
    const nb = noiseBuf(ctx);
    const noise = (t, dur) => { const s = ctx.createBufferSource(); s.buffer = nb; s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05); return s; };
    const I = {
      kick(t, v = 1) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(165, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
        env(g, t, v, 0.002, 0.42); o.connect(g).connect(out); o.start(t); o.stop(t + 0.5);
        const n = noise(t, 0.02), f = ctx.createBiquadFilter(), gn = ctx.createGain(); f.type = 'highpass'; f.frequency.value = 2500;
        env(gn, t, v * 0.25, 0.001, 0.012); n.connect(f).connect(gn).connect(out);
      },
      snare(t, v = 0.8) {
        const n = noise(t, 0.25), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'highpass'; f.frequency.value = 1300;
        env(g, t, v * 0.7, 0.001, 0.2); n.connect(f).connect(g).connect(out);
        const o = ctx.createOscillator(), go = ctx.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
        env(go, t, v * 0.5, 0.001, 0.1); o.connect(go).connect(out); o.start(t); o.stop(t + 0.15);
      },
      clap(t, v = 0.8) {
        const n = noise(t, 0.3), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'bandpass'; f.frequency.value = 1150; f.Q.value = 1.1;
        g.gain.setValueAtTime(0.0001, t);
        for (const d of [0, 0.011, 0.022]) { g.gain.setValueAtTime(v, t + d); g.gain.exponentialRampToValueAtTime(v * 0.2, t + d + 0.009); }
        g.gain.setValueAtTime(v * 0.9, t + 0.031); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        const p = ctx.createStereoPanner(); p.pan.value = 0.05;
        n.connect(f).connect(g).connect(p).connect(out);
      },
      hat(t, v = 0.35, open = false, pan = 0.2) {
        const n = noise(t, open ? 0.35 : 0.08), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
        f.type = 'highpass'; f.frequency.value = 7600; p.pan.value = pan;
        env(g, t, v, 0.001, open ? 0.28 : 0.045); n.connect(f).connect(g).connect(p).connect(out);
      },
      shaker(t, v = 0.2, pan = -0.25) {
        const n = noise(t, 0.1), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
        f.type = 'bandpass'; f.frequency.value = 6200; f.Q.value = 1.6; p.pan.value = pan;
        env(g, t, v, 0.012, 0.06); n.connect(f).connect(g).connect(p).connect(out);
      },
      rim(t, v = 0.4) {
        const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner(); o.type = 'triangle'; o.frequency.value = 1750; p.pan.value = -0.15;
        env(g, t, v, 0.0008, 0.03); o.connect(g).connect(p).connect(out); o.start(t); o.stop(t + 0.06);
      },
      conga(t, v, f, pan) {
        const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner(); p.pan.value = pan;
        o.frequency.setValueAtTime(f * 1.25, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.03);
        env(g, t, v, 0.002, 0.22); o.connect(g).connect(p).connect(out); o.start(t); o.stop(t + 0.3);
      },
      bass(t, dur, f, v = 0.55) {
        const o = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = f; o2.type = 'sine'; o2.frequency.value = f / 2;
        lp.type = 'lowpass'; lp.Q.value = 6; lp.frequency.setValueAtTime(180, t); lp.frequency.exponentialRampToValueAtTime(1100, t + 0.02); lp.frequency.exponentialRampToValueAtTime(240, t + Math.min(dur, 0.25));
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.006); g.gain.setValueAtTime(v, t + dur * 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        const g2 = ctx.createGain(); g2.gain.value = 0.6;
        o.connect(lp).connect(g); o2.connect(g2).connect(g); g.connect(out);
        o.start(t); o2.start(t); o.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
      },
      sub(t, dur, f, v = 0.85) {
        const o = ctx.createOscillator(), g = ctx.createGain(), ws = ctx.createWaveShaper();
        const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(2.2 * x); } ws.curve = curve;
        o.frequency.setValueAtTime(f * 2.2, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.004); g.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.25);
        o.connect(ws).connect(g).connect(out); o.start(t); o.stop(t + dur + 0.3);
      },
      log(t, dur, f, v = 0.75) {
        const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter(), ws = ctx.createWaveShaper();
        const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(3 * x) * 0.8; } ws.curve = curve;
        o.frequency.setValueAtTime(f * 1.9, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
        lp.type = 'lowpass'; lp.frequency.value = 850;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.18, dur * 1.1));
        o.connect(ws).connect(lp).connect(g).connect(out); o.start(t); o.stop(t + dur + 0.3);
      },
      chord(t, dur, freqs, v = 0.12, stab = false) {
        const lp = ctx.createBiquadFilter(), g = ctx.createGain();
        lp.type = 'lowpass'; lp.frequency.setValueAtTime(stab ? 2600 : 900, t); if (!stab) lp.frequency.linearRampToValueAtTime(2200, t + dur * 0.5);
        const a = stab ? 0.004 : 0.08, rel = stab ? 0.12 : 0.35;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + a); g.gain.setValueAtTime(v, t + Math.max(a, dur - rel)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        lp.connect(g).connect(out);
        freqs.forEach((f, i) => {
          for (const det of [-8, 8]) {
            const o = ctx.createOscillator(), p = ctx.createStereoPanner();
            o.type = stab ? 'square' : 'sawtooth'; o.frequency.value = f; o.detune.value = det;
            p.pan.value = (det < 0 ? -1 : 1) * (0.25 + 0.15 * (i % 2));
            o.connect(p).connect(lp); o.start(t); o.stop(t + dur + 0.05);
          }
        });
      },
    };
    return I;
  }

  async function generate({ style, part, key, bars, bpm, bpb = 4, seed = Date.now() }) {
    const st = STYLES[style] || STYLES.Afrobeat;
    const R = rng(seed);
    const sr = (Engine.ctx && Engine.ctx.sampleRate) || 44100;
    const steps = bpb * 4, stepDur = 60 / bpm / 4, total = bars * steps, loopDur = total * stepDur;
    const tail = 1.5;
    const oc = new OfflineAudioContext(2, Math.ceil((loopDur + tail) * sr), sr);
    const bus = oc.createGain(); bus.gain.value = 0.9;
    const comp = oc.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.12;
    bus.connect(comp).connect(oc.destination);
    const I = make(oc, bus);
    const [rootName, mode] = key.split(' ');
    const pc = NOTE.indexOf(rootName);
    const scale = mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
    const prog = mode === 'major' ? [0, 4, 5, 3] : [0, 5, 2, 6];
    let bassRoot = 36 + pc; if (pc >= 7) bassRoot -= 12;
    const deg = (d, base) => base + scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
    const has = (arr, s) => arr === 'all' ? true : arr === 'eighths' ? s % 2 === 0 : Array.isArray(arr) && arr.includes(s);
    const T = (i) => i * stepDur + (i % 2 === 1 ? st.swing * stepDur : 0);
    const want = (p) => part === p || part === 'Full groove';
    const human = () => 0.85 + R() * 0.15;

    for (let i = 0; i < total; i++) {
      const s = i % 16, t = T(i), barIdx = Math.floor(i / steps);
      const chordDeg = prog[barIdx % prog.length];
      if (want('Drums')) {
        if (has(st.kick, s)) I.kick(t, (st.kickVel || 1) * (s === 0 ? 1 : 0.9));
        if (st.snare && has(st.snare, s)) I.snare(t, 0.75 * human());
        if (st.clap && has(st.clap, s)) I.clap(t, (st.clapVel || 0.75) * human());
        if (st.hatC && has(st.hatC, s)) I.hat(t, (s % 4 === 2 ? 0.32 : 0.18) * human(), false);
        if (st.hatO && has(st.hatO, s)) I.hat(t, 0.22, true, -0.2);
        if (st.roll && st.roll.includes(s) && barIdx % 2 === 1) { I.hat(t + stepDur / 2, 0.16, false); I.hat(t + stepDur / 3, 0.12, false); }
      }
      if (want('Drums') || want('Percussion')) {
        if (st.shaker && has(st.shaker, s)) I.shaker(t, (s % 2 ? 0.22 : 0.12) * human());
        if (st.rim && has(st.rim, s)) I.rim(t, 0.33 * human());
      }
      if (want('Percussion') && st.conga && has(st.conga, s)) I.conga(t, 0.4 * human(), s % 4 === 1 ? 260 : 196, s % 2 ? 0.35 : -0.35);
      if (want('Bass')) {
        const pat = st.bass || st.log || st.sub;
        for (const [ps, d, ln] of pat) if (ps === s) {
          const f = mf(deg(chordDeg + d, bassRoot));
          if (st.log) I.log(t, ln * stepDur, f);
          else if (st.sub) I.sub(t, ln * stepDur, f);
          else I.bass(t, ln * stepDur * 0.95, f);
        }
      }
      if (want('Chords')) {
        const notes = [0, 2, 4, 6].map((x) => mf(deg(chordDeg + x, 48 + pc + (pc < 5 ? 12 : 0))));
        if (st.chords === 'pad' && s === 0) I.chord(t, steps * stepDur, notes, 0.08, false);
        if (st.chords === 'stab' && st.chordSteps.includes(s)) I.chord(t, stepDur * 1.6, notes, 0.09, true);
      }
    }
    const rendered = await oc.startRendering();
    // fold the tail back onto the start so the loop repeats seamlessly
    const n = Math.round(loopDur * sr);
    const chs = [0, 1].map((c) => {
      const d = rendered.getChannelData(c), o = d.slice(0, n);
      for (let i = n; i < d.length; i++) o[(i - n) % n] += d[i];
      return o;
    });
    return makeBuffer(chs, sr);
  }

  function fillKeys(sel) { sel.innerHTML = ''; for (const k of KEYS) sel.append(el('option', { value: k }, k)); sel.value = 'A minor'; }
  return { generate, STYLES, KEYS, fillKeys };
})();
