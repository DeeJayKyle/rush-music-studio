// ---------------------------------------------------------------------------
// Rush plugin rack — original effects built on Web Audio. Each plugin runs in
// real time (track / master inserts) and offline (destructive Editor apply).
// ---------------------------------------------------------------------------
const Plugins = (() => {
  const REG = {};
  const CATS = ['EQ & Filter', 'Dynamics', 'Reverb & Delay', 'Modulation', 'Distortion', 'Stereo & Utility'];
  const isOff = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
  const setP = (ctx, param, v) => { if (!isFinite(v)) return; if (isOff(ctx)) param.value = v; else param.setTargetAtTime(v, ctx.currentTime, 0.012); };
  const bq = (ctx, type, f = 1000, q = 0.707, g = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b; };
  const G = (ctx, v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const hz = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : Math.round(v) + ' Hz');
  const db = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  const pct = (v) => Math.round(v) + '%';
  const ms = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v.toFixed(v < 10 ? 1 : 0) + ' ms');
  const NOTE_OPTS = [{ value: '0', label: 'Free (ms)' }, { value: '0.25', label: '1/16' }, { value: '0.5', label: '1/8' }, { value: '0.75', label: '1/8 dotted' }, { value: '0.333', label: '1/8 triplet' }, { value: '1', label: '1/4' }, { value: '1.5', label: '1/4 dotted' }, { value: '2', label: '1/2' }];
  const beatSec = () => 60 / ((typeof P !== 'undefined' && P.bpm) || 120);

  function def(type, spec) { spec.type = type; REG[type] = spec; }
  // wet/dry wrapper
  function wetDry(ctx) {
    const input = G(ctx), output = G(ctx), dry = G(ctx), wet = G(ctx);
    input.connect(dry).connect(output); wet.connect(output);
    return { input, output, dry, wet, mix(m) { setP(ctx, dry.gain, Math.cos(m / 100 * Math.PI / 2)); setP(ctx, wet.gain, Math.sin(m / 100 * Math.PI / 2)); } };
  }
  function lfo(ctx, rate, depth, shape = 'sine') {
    const o = ctx.createOscillator(); o.type = shape; o.frequency.value = rate;
    const g = G(ctx, depth); o.connect(g); o.start();
    return { o, g, stop() { try { o.stop(); } catch (e) { } } };
  }
  function shaperCurve(fn, n = 4096) { const c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = fn(i / (n - 1) * 2 - 1); return c; }
  function impulse(ctx, secs, decay, damp, width = 1) {
    const sr = ctx.sampleRate, n = Math.max(64, Math.floor(sr * secs)), b = ctx.createBuffer(2, n, sr);
    const a = Math.exp(-2 * Math.PI * damp / sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n, white = Math.random() * 2 - 1;
        lp = a * lp + (1 - a) * white;
        const bright = lp * (1 - t) + white * 0.15 * (1 - t);
        d[i] = bright * Math.pow(1 - t, decay) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
      }
    }
    if (width < 1) { const L = b.getChannelData(0), R = b.getChannelData(1); for (let i = 0; i < n; i++) { const m = (L[i] + R[i]) / 2; L[i] = m + (L[i] - m) * width; R[i] = m + (R[i] - m) * width; } }
    return b;
  }

  // ---------------- EQ & Filter ----------------
  def('peq', {
    name: 'Parametric EQ', cat: 'EQ & Filter', desc: 'Four fully adjustable bands plus low- and high-cut filters.',
    params: [
      { id: 'hp', label: 'Low cut', min: 20, max: 1000, def: 20, log: true, fmt: (v) => (v <= 20.5 ? 'off' : hz(v)) },
      { id: 'f1', label: 'Low freq', min: 30, max: 500, def: 100, log: true, fmt: hz }, { id: 'g1', label: 'Low gain', min: -18, max: 18, def: 0, fmt: db },
      { id: 'f2', label: 'Lo-mid', min: 100, max: 3000, def: 400, log: true, fmt: hz }, { id: 'g2', label: 'Lo-mid gain', min: -18, max: 18, def: 0, fmt: db }, { id: 'q2', label: 'Lo-mid Q', min: 0.2, max: 10, def: 1, log: true, fmt: (v) => v.toFixed(2) },
      { id: 'f3', label: 'Hi-mid', min: 500, max: 12000, def: 2500, log: true, fmt: hz }, { id: 'g3', label: 'Hi-mid gain', min: -18, max: 18, def: 0, fmt: db }, { id: 'q3', label: 'Hi-mid Q', min: 0.2, max: 10, def: 1, log: true, fmt: (v) => v.toFixed(2) },
      { id: 'f4', label: 'High freq', min: 2000, max: 18000, def: 8000, log: true, fmt: hz }, { id: 'g4', label: 'High gain', min: -18, max: 18, def: 0, fmt: db },
      { id: 'lp', label: 'High cut', min: 1000, max: 20000, def: 20000, log: true, fmt: (v) => (v >= 19900 ? 'off' : hz(v)) },
    ],
    presets: { 'Vocal presence': { hp: 90, g1: -2, f2: 300, g2: -2.5, g3: 3, f3: 3200, g4: 2.5 }, 'Bass boost': { f1: 70, g1: 6, f2: 250, g2: -3 }, 'Telephone': { hp: 400, lp: 3200, f3: 1500, g3: 6 }, 'Air': { f4: 12000, g4: 5 }, 'De-mud': { f2: 300, g2: -5, q2: 1.4 }, 'Kick punch': { f1: 60, g1: 5, f2: 350, g2: -6, f3: 4000, g3: 4 } },
    build(ctx) {
      const hp = bq(ctx, 'highpass', 20), b1 = bq(ctx, 'lowshelf', 100), b2 = bq(ctx, 'peaking', 400), b3 = bq(ctx, 'peaking', 2500), b4 = bq(ctx, 'highshelf', 8000), lp = bq(ctx, 'lowpass', 20000);
      hp.connect(b1).connect(b2).connect(b3).connect(b4).connect(lp);
      return { input: hp, output: lp, set(p) {
        setP(ctx, hp.frequency, p.hp <= 20.5 ? 5 : p.hp); setP(ctx, lp.frequency, Math.min(p.lp >= 19900 ? 22000 : p.lp, ctx.sampleRate / 2 - 10));
        setP(ctx, b1.frequency, p.f1); setP(ctx, b1.gain, p.g1); setP(ctx, b2.frequency, p.f2); setP(ctx, b2.gain, p.g2); setP(ctx, b2.Q, p.q2);
        setP(ctx, b3.frequency, p.f3); setP(ctx, b3.gain, p.g3); setP(ctx, b3.Q, p.q3); setP(ctx, b4.frequency, p.f4); setP(ctx, b4.gain, p.g4);
      } };
    },
  });
  const GEQ_F = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  def('geq', {
    name: 'Graphic EQ (10-band)', cat: 'EQ & Filter', desc: 'Ten fixed octave bands, ±15 dB each.',
    params: GEQ_F.map((f, i) => ({ id: 'b' + i, label: f >= 1000 ? f / 1000 + 'k' : String(f), min: -15, max: 15, def: 0, fmt: db })).concat([{ id: 'out', label: 'Output', min: -18, max: 12, def: 0, fmt: db }]),
    presets: { 'Smile': { b0: 5, b1: 4, b2: 2, b3: 0, b4: -2, b5: -2, b6: 0, b7: 2, b8: 4, b9: 5 }, 'Loudness': { b0: 6, b1: 4, b8: 3, b9: 4 }, 'Radio': { b0: -15, b1: -12, b2: -4, b5: 4, b6: 5, b8: -8, b9: -15 }, 'Warm': { b2: 2, b3: 2, b8: -2, b9: -4 } },
    build(ctx) {
      const bands = GEQ_F.map((f, i) => bq(ctx, i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking', f, 1.41));
      const out = G(ctx);
      bands.reduce((a, b) => (a.connect(b), b)); bands[9].connect(out);
      return { input: bands[0], output: out, set(p) { bands.forEach((b, i) => setP(ctx, b.gain, p['b' + i])); setP(ctx, out.gain, dbToGain(p.out)); } };
    },
  });
  def('filter', {
    name: 'Auto filter', cat: 'EQ & Filter', desc: 'Resonant filter with optional tempo-synced sweep.',
    params: [
      { id: 'type', label: 'Type', options: [{ value: 'lowpass', label: 'Low-pass' }, { value: 'highpass', label: 'High-pass' }, { value: 'bandpass', label: 'Band-pass' }, { value: 'notch', label: 'Notch' }], def: 'lowpass' },
      { id: 'freq', label: 'Cutoff', min: 40, max: 18000, def: 2000, log: true, fmt: hz }, { id: 'q', label: 'Resonance', min: 0.3, max: 18, def: 1.5, log: true, fmt: (v) => v.toFixed(1) },
      { id: 'rate', label: 'Sweep rate', min: 0, max: 8, def: 0, step: 0.01, fmt: (v) => (v < 0.01 ? 'off' : v.toFixed(2) + ' Hz') }, { id: 'depth', label: 'Sweep depth', min: 0, max: 100, def: 50, fmt: pct },
    ],
    presets: { 'Club muffle': { type: 'lowpass', freq: 400, q: 2 }, 'Slow sweep': { freq: 1200, q: 6, rate: 0.12, depth: 80 }, 'Thin out': { type: 'highpass', freq: 600, q: 1 } },
    build(ctx) {
      const f = bq(ctx, 'lowpass', 2000), L = lfo(ctx, 0.0001, 0);
      L.g.connect(f.detune);
      return { input: f, output: f, set(p) { f.type = p.type; setP(ctx, f.frequency, p.freq); setP(ctx, f.Q, p.q); setP(ctx, L.o.frequency, Math.max(0.0001, p.rate)); setP(ctx, L.g.gain, p.rate < 0.01 ? 0 : p.depth * 36); }, dispose() { L.stop(); } };
    },
  });
  def('wah', {
    name: 'Wah-wah', cat: 'EQ & Filter', desc: 'Swept band-pass, classic funk guitar sound.',
    params: [{ id: 'rate', label: 'Rate', min: 0.1, max: 10, def: 1.8, log: true, fmt: (v) => v.toFixed(2) + ' Hz' }, { id: 'center', label: 'Centre', min: 300, max: 3000, def: 900, log: true, fmt: hz }, { id: 'depth', label: 'Depth', min: 0, max: 100, def: 75, fmt: pct }, { id: 'q', label: 'Q', min: 1, max: 15, def: 5, fmt: (v) => v.toFixed(1) }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, fmt: pct }],
    presets: { 'Funk': { rate: 2.5, depth: 85, q: 7 }, 'Slow vowel': { rate: 0.4, center: 700, q: 4 } },
    build(ctx) {
      const w = wetDry(ctx), f = bq(ctx, 'bandpass', 900, 5), L = lfo(ctx, 1.8, 0), mk = G(ctx, 2);
      L.g.connect(f.detune); w.input.connect(f).connect(mk).connect(w.wet);
      return { input: w.input, output: w.output, set(p) { setP(ctx, f.frequency, p.center); setP(ctx, f.Q, p.q); setP(ctx, L.o.frequency, p.rate); setP(ctx, L.g.gain, p.depth * 18); w.mix(p.mix); }, dispose() { L.stop(); } };
    },
  });

  // ---------------- Dynamics ----------------
  def('comp', {
    name: 'Compressor', cat: 'Dynamics', desc: 'Smooths level differences; adds punch and sustain.',
    params: [{ id: 'th', label: 'Threshold', min: -60, max: 0, def: -18, fmt: db }, { id: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, log: true, fmt: (v) => v.toFixed(1) + ':1' }, { id: 'att', label: 'Attack', min: 0.1, max: 200, def: 10, log: true, fmt: ms }, { id: 'rel', label: 'Release', min: 10, max: 1500, def: 200, log: true, fmt: ms }, { id: 'knee', label: 'Knee', min: 0, max: 30, def: 6, fmt: db }, { id: 'mk', label: 'Make-up', min: 0, max: 30, def: 4, fmt: db }],
    presets: { 'Gentle glue': { th: -14, ratio: 2, att: 30, rel: 300, mk: 2 }, 'Vocal': { th: -20, ratio: 4, att: 5, rel: 150, mk: 6 }, 'Drum smash': { th: -32, ratio: 10, att: 1, rel: 80, mk: 12 }, 'Bass even': { th: -22, ratio: 5, att: 15, rel: 220, mk: 6 } },
    build(ctx) {
      const c = ctx.createDynamicsCompressor(), m = G(ctx); c.connect(m);
      return { input: c, output: m, set(p) { c.threshold.value = p.th; c.ratio.value = p.ratio; c.attack.value = p.att / 1000; c.release.value = p.rel / 1000; c.knee.value = p.knee; setP(ctx, m.gain, dbToGain(p.mk)); } };
    },
  });
  def('maxim', {
    name: 'Loudness maximizer', cat: 'Dynamics', desc: 'Drives the signal into a fast limiter for a loud, dense master.',
    params: [{ id: 'drive', label: 'Drive', min: 0, max: 18, def: 4, fmt: db }, { id: 'ceil', label: 'Ceiling', min: -6, max: 0, def: -0.3, step: 0.1, fmt: db }, { id: 'rel', label: 'Release', min: 10, max: 800, def: 120, log: true, fmt: ms }],
    presets: { 'Streaming master': { drive: 4, ceil: -1 }, 'Loud club': { drive: 9, ceil: -0.3, rel: 60 }, 'Transparent': { drive: 2, ceil: -0.5, rel: 250 } },
    build(ctx) {
      const pre = G(ctx), c = ctx.createDynamicsCompressor(), clip = ctx.createWaveShaper(), out = G(ctx);
      c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001;
      clip.curve = shaperCurve((x) => Math.tanh(x * 1.2) / Math.tanh(1.2)); clip.oversample = '4x';
      pre.connect(c).connect(clip).connect(out);
      return { input: pre, output: out, set(p) { setP(ctx, pre.gain, dbToGain(p.drive)); c.threshold.value = p.ceil - 1.5; c.release.value = p.rel / 1000; setP(ctx, out.gain, dbToGain(p.ceil)); } };
    },
  });
  def('gate', {
    name: 'Noise gate', cat: 'Dynamics', desc: 'Silences the signal when it falls below the threshold.',
    params: [{ id: 'th', label: 'Threshold', min: -70, max: -6, def: -40, fmt: db }, { id: 'smooth', label: 'Release', min: 5, max: 200, def: 30, log: true, fmt: (v) => Math.round(v) + ' Hz⁻' }, { id: 'range', label: 'Floor', min: -80, max: 0, def: -80, fmt: db }],
    presets: { 'Tight drums': { th: -30, smooth: 60 }, 'Vocal clean-up': { th: -45, smooth: 20, range: -20 } },
    build(ctx) {
      // audio-rate envelope follower: |x| → low-pass → threshold curve → gain modulation
      const input = G(ctx), vca = G(ctx, 0), abs = ctx.createWaveShaper(), sm = bq(ctx, 'lowpass', 30, 0.5), thr = ctx.createWaveShaper(), pre = G(ctx, 8);
      abs.curve = shaperCurve((x) => Math.abs(x));
      input.connect(vca); input.connect(abs).connect(sm).connect(pre).connect(thr).connect(vca.gain);
      return { input, output: vca, set(p) {
        const t = dbToGain(p.th) * 8 * 0.6, floor = dbToGain(p.range);
        thr.curve = shaperCurve((x) => { const e = Math.max(0, x); const k = clamp((e - t * 0.6) / (t * 0.4 + 1e-6), 0, 1); return floor + (1 - floor) * k * k * (3 - 2 * k); }, 8192);
        setP(ctx, sm.frequency, p.smooth);
      } };
    },
  });

  // ---------------- Reverb & Delay ----------------
  def('reverb', {
    name: 'Reverb', cat: 'Reverb & Delay', desc: 'Algorithmic room, plate and hall spaces.',
    params: [{ id: 'size', label: 'Decay', min: 0.2, max: 10, def: 2.2, log: true, fmt: (v) => v.toFixed(1) + ' s' }, { id: 'pre', label: 'Pre-delay', min: 0, max: 200, def: 15, fmt: ms }, { id: 'damp', label: 'Damping', min: 1000, max: 18000, def: 6000, log: true, fmt: hz }, { id: 'width', label: 'Width', min: 0, max: 100, def: 100, fmt: pct }, { id: 'lowcut', label: 'Low cut', min: 20, max: 800, def: 150, log: true, fmt: hz }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 25, fmt: pct }],
    presets: { 'Small room': { size: 0.6, pre: 5, damp: 7000, mix: 18 }, 'Vocal plate': { size: 1.8, pre: 25, damp: 9000, mix: 22, lowcut: 250 }, 'Concert hall': { size: 3.5, pre: 30, damp: 5000, mix: 30 }, 'Cathedral': { size: 8, pre: 50, damp: 3500, mix: 40 }, 'Ambient wash': { size: 9.5, pre: 80, damp: 4000, mix: 55 } },
    build(ctx) {
      const w = wetDry(ctx), d = ctx.createDelay(1), cv = ctx.createConvolver(), hp = bq(ctx, 'highpass', 150);
      w.input.connect(d).connect(hp).connect(cv).connect(w.wet);
      let key = '';
      return { input: w.input, output: w.output, set(p) {
        const k = [p.size, p.damp, p.width].map((v) => v.toFixed(2)).join('|');
        if (k !== key) { key = k; cv.buffer = impulse(ctx, p.size, 2.6, p.damp, p.width / 100); }
        setP(ctx, d.delayTime, p.pre / 1000); setP(ctx, hp.frequency, p.lowcut); w.mix(p.mix);
      } };
    },
  });
  def('delay', {
    name: 'Simple delay', cat: 'Reverb & Delay', desc: 'Echo with feedback, tone and optional tempo sync.',
    params: [{ id: 'sync', label: 'Sync', options: NOTE_OPTS, def: '0.75' }, { id: 'time', label: 'Time (free)', min: 1, max: 2000, def: 350, log: true, fmt: ms }, { id: 'fb', label: 'Feedback', min: 0, max: 95, def: 35, fmt: pct }, { id: 'tone', label: 'Tone', min: 500, max: 16000, def: 5000, log: true, fmt: hz }, { id: 'ping', label: 'Ping-pong', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], def: 'off' }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 30, fmt: pct }],
    presets: { 'Slapback': { sync: '0', time: 110, fb: 10, mix: 25 }, 'Dub echo': { sync: '0.75', fb: 65, tone: 2200, mix: 40 }, 'Ping-pong 1/8': { sync: '0.5', ping: 'on', fb: 45, mix: 30 } },
    build(ctx) {
      const w = wetDry(ctx), dl = ctx.createDelay(4), dr = ctx.createDelay(4), fb = G(ctx), tone = bq(ctx, 'lowpass', 5000), merge = ctx.createChannelMerger(2), cross = G(ctx), self = G(ctx);
      w.input.connect(dl); dl.connect(tone).connect(fb);
      fb.connect(self).connect(dl); fb.connect(cross).connect(dr); dr.connect(dl);
      dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(w.wet);
      const mono = G(ctx); dl.connect(mono); mono.connect(w.wet);
      return { input: w.input, output: w.output, set(p) {
        const t = p.sync !== '0' ? beatSec() * parseFloat(p.sync) : p.time / 1000;
        const ping = p.ping === 'on';
        setP(ctx, dl.delayTime, t); setP(ctx, dr.delayTime, t);
        setP(ctx, fb.gain, p.fb / 100); setP(ctx, tone.frequency, p.tone);
        setP(ctx, self.gain, ping ? 0 : 1); setP(ctx, cross.gain, ping ? 1 : 0);
        setP(ctx, mono.gain, ping ? 0 : 1); merge.disconnect(); if (ping) merge.connect(w.wet);
        w.mix(p.mix);
      } };
    },
  });
  def('mtdelay', {
    name: 'Multi-tap delay', cat: 'Reverb & Delay', desc: 'Up to eight echoes spread across the stereo field.',
    params: [{ id: 'taps', label: 'Taps', min: 1, max: 8, def: 4, step: 1, fmt: (v) => String(Math.round(v)) }, { id: 'sync', label: 'Spacing', options: NOTE_OPTS, def: '0.5' }, { id: 'time', label: 'Spacing (free)', min: 10, max: 1000, def: 180, log: true, fmt: ms }, { id: 'decay', label: 'Decay', min: 10, max: 100, def: 65, fmt: pct }, { id: 'spread', label: 'Spread', min: 0, max: 100, def: 80, fmt: pct }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 35, fmt: pct }],
    presets: { 'Rhythmic 1/16': { taps: 6, sync: '0.25', decay: 70 }, 'Wide scatter': { taps: 8, sync: '0', time: 95, spread: 100, decay: 80 } },
    build(ctx) {
      const w = wetDry(ctx), taps = [];
      for (let i = 0; i < 8; i++) { const d = ctx.createDelay(8), g = G(ctx, 0), pn = ctx.createStereoPanner(); w.input.connect(d).connect(g).connect(pn).connect(w.wet); taps.push({ d, g, pn }); }
      return { input: w.input, output: w.output, set(p) {
        const sp = p.sync !== '0' ? beatSec() * parseFloat(p.sync) : p.time / 1000;
        taps.forEach((t, i) => { const on = i < Math.round(p.taps); setP(ctx, t.d.delayTime, sp * (i + 1)); setP(ctx, t.g.gain, on ? Math.pow(p.decay / 100, i) : 0); setP(ctx, t.pn.pan, (i % 2 ? 1 : -1) * p.spread / 100 * (0.4 + 0.6 * i / 7)); });
        w.mix(p.mix);
      } };
    },
  });

  // ---------------- Modulation ----------------
  def('chorus', {
    name: 'Chorus', cat: 'Modulation', desc: 'Two modulated voices for width and shimmer.',
    params: [{ id: 'rate', label: 'Rate', min: 0.05, max: 6, def: 0.8, log: true, fmt: (v) => v.toFixed(2) + ' Hz' }, { id: 'depth', label: 'Depth', min: 0.1, max: 10, def: 3, fmt: ms }, { id: 'delay', label: 'Delay', min: 5, max: 40, def: 14, fmt: ms }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 45, fmt: pct }],
    presets: { 'Lush': { rate: 0.5, depth: 5, delay: 18, mix: 55 }, 'Subtle double': { rate: 0.3, depth: 1.5, delay: 22, mix: 35 } },
    build(ctx) {
      const w = wetDry(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), voices = [];
      w.input.connect(sp);
      for (let c = 0; c < 2; c++) { const d = ctx.createDelay(0.2), L = lfo(ctx, 0.8 * (1 + c * 0.17), 0); L.g.connect(d.delayTime); sp.connect(d, c); d.connect(mg, 0, c); voices.push({ d, L }); }
      mg.connect(w.wet);
      return { input: w.input, output: w.output, set(p) { voices.forEach((v, c) => { setP(ctx, v.d.delayTime, p.delay / 1000 + c * 0.003); setP(ctx, v.L.o.frequency, p.rate * (1 + c * 0.17)); setP(ctx, v.L.g.gain, p.depth / 1000); }); w.mix(p.mix); }, dispose() { voices.forEach((v) => v.L.stop()); } };
    },
  });
  def('flanger', {
    name: 'Flanger', cat: 'Modulation', desc: 'Short swept delay with feedback for the jet-plane sweep.',
    params: [{ id: 'rate', label: 'Rate', min: 0.02, max: 5, def: 0.25, log: true, fmt: (v) => v.toFixed(2) + ' Hz' }, { id: 'depth', label: 'Depth', min: 0.1, max: 5, def: 2, fmt: ms }, { id: 'delay', label: 'Delay', min: 0.5, max: 10, def: 2.5, fmt: ms }, { id: 'fb', label: 'Feedback', min: -90, max: 90, def: 55, fmt: pct }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 50, fmt: pct }],
    presets: { 'Jet': { rate: 0.12, depth: 3, fb: 80, mix: 50 }, 'Metallic': { rate: 1.5, depth: 0.8, delay: 1, fb: -75 } },
    build(ctx) {
      const w = wetDry(ctx), d = ctx.createDelay(0.1), fb = G(ctx), L = lfo(ctx, 0.25, 0);
      L.g.connect(d.delayTime); w.input.connect(d); d.connect(fb).connect(d); d.connect(w.wet);
      return { input: w.input, output: w.output, set(p) { setP(ctx, d.delayTime, p.delay / 1000 + p.depth / 1000); setP(ctx, L.o.frequency, p.rate); setP(ctx, L.g.gain, p.depth / 1000); setP(ctx, fb.gain, p.fb / 100); w.mix(p.mix); }, dispose() { L.stop(); } };
    },
  });
  def('phaser', {
    name: 'Phaser', cat: 'Modulation', desc: 'Six-stage swept all-pass phaser.',
    params: [{ id: 'rate', label: 'Rate', min: 0.02, max: 8, def: 0.4, log: true, fmt: (v) => v.toFixed(2) + ' Hz' }, { id: 'center', label: 'Centre', min: 200, max: 4000, def: 900, log: true, fmt: hz }, { id: 'depth', label: 'Depth', min: 0, max: 100, def: 70, fmt: pct }, { id: 'fb', label: 'Feedback', min: 0, max: 90, def: 40, fmt: pct }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 50, fmt: pct }],
    presets: { 'Slow swirl': { rate: 0.15, depth: 85, fb: 55 }, 'Fast vibe': { rate: 4, depth: 45, fb: 20 } },
    build(ctx) {
      const w = wetDry(ctx), stages = [], L = lfo(ctx, 0.4, 0), fb = G(ctx);
      for (let i = 0; i < 6; i++) { const a = bq(ctx, 'allpass', 900, 0.6); L.g.connect(a.detune); stages.push(a); }
      w.input.connect(stages[0]); stages.reduce((a, b) => (a.connect(b), b)); stages[5].connect(w.wet); stages[5].connect(fb).connect(stages[0]);
      return { input: w.input, output: w.output, set(p) { stages.forEach((s) => setP(ctx, s.frequency, p.center)); setP(ctx, L.o.frequency, p.rate); setP(ctx, L.g.gain, p.depth * 24); setP(ctx, fb.gain, p.fb / 100); w.mix(p.mix); }, dispose() { L.stop(); } };
    },
  });
  def('tremolo', {
    name: 'Tremolo / auto-pan', cat: 'Modulation', desc: 'Amplitude modulation, or left-right panning, synced to tempo.',
    params: [{ id: 'mode', label: 'Mode', options: [{ value: 'trem', label: 'Tremolo' }, { value: 'pan', label: 'Auto-pan' }], def: 'trem' }, { id: 'sync', label: 'Rate', options: [{ value: '0', label: 'Free (Hz)' }, { value: '0.25', label: '1/16' }, { value: '0.5', label: '1/8' }, { value: '1', label: '1/4' }, { value: '2', label: '1/2' }, { value: '4', label: '1 bar' }], def: '0.5' }, { id: 'rate', label: 'Rate (free)', min: 0.1, max: 20, def: 5, log: true, fmt: (v) => v.toFixed(2) + ' Hz' }, { id: 'depth', label: 'Depth', min: 0, max: 100, def: 60, fmt: pct }, { id: 'shape', label: 'Shape', options: [{ value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'square', label: 'Square' }], def: 'sine' }],
    presets: { 'Surf guitar': { sync: '0', rate: 6, depth: 70 }, 'Chopped gate': { sync: '0.25', shape: 'square', depth: 100 }, 'Wide pan': { mode: 'pan', sync: '2', depth: 80 } },
    build(ctx) {
      const input = G(ctx), vca = G(ctx, 1), pan = ctx.createStereoPanner(), L = lfo(ctx, 5, 0), panL = G(ctx, 0), volL = G(ctx, 0);
      input.connect(vca).connect(pan);
      L.g.connect(volL).connect(vca.gain); L.g.connect(panL).connect(pan.pan);
      return { input, output: pan, set(p) {
        L.o.type = p.shape;
        const r = p.sync !== '0' ? 1 / (beatSec() * parseFloat(p.sync)) : p.rate;
        setP(ctx, L.o.frequency, r); setP(ctx, L.g.gain, 1);
        const d = p.depth / 100;
        if (p.mode === 'pan') { setP(ctx, vca.gain, 1); setP(ctx, volL.gain, 0); setP(ctx, panL.gain, d); }
        else { setP(ctx, vca.gain, 1 - d / 2); setP(ctx, volL.gain, d / 2); setP(ctx, panL.gain, 0); }
      }, dispose() { L.stop(); } };
    },
  });
  def('vibrato', {
    name: 'Vibrato', cat: 'Modulation', desc: 'Pitch wobble from a modulated delay line.',
    params: [{ id: 'rate', label: 'Rate', min: 0.5, max: 12, def: 5, log: true, fmt: (v) => v.toFixed(2) + ' Hz' }, { id: 'depth', label: 'Depth', min: 0.05, max: 4, def: 0.6, log: true, fmt: ms }],
    presets: { 'Gentle': { rate: 4.5, depth: 0.3 }, 'Warped tape': { rate: 0.8, depth: 3 } },
    build(ctx) {
      const d = ctx.createDelay(0.1), L = lfo(ctx, 5, 0); L.g.connect(d.delayTime);
      return { input: d, output: d, set(p) { setP(ctx, d.delayTime, 0.005 + p.depth / 1000); setP(ctx, L.o.frequency, p.rate); setP(ctx, L.g.gain, p.depth / 1000); }, dispose() { L.stop(); } };
    },
  });

  // ---------------- Distortion ----------------
  def('distort', {
    name: 'Distortion', cat: 'Distortion', desc: 'Soft saturation, hard clipping or fuzz with tone control.',
    params: [{ id: 'type', label: 'Type', options: [{ value: 'soft', label: 'Tape saturation' }, { value: 'hard', label: 'Hard clip' }, { value: 'fuzz', label: 'Fuzz' }, { value: 'fold', label: 'Wave fold' }], def: 'soft' }, { id: 'drive', label: 'Drive', min: 0, max: 40, def: 12, fmt: db }, { id: 'tone', label: 'Tone', min: 500, max: 18000, def: 7000, log: true, fmt: hz }, { id: 'out', label: 'Output', min: -30, max: 6, def: -6, fmt: db }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, fmt: pct }],
    presets: { 'Warm tape': { type: 'soft', drive: 6, out: -3, mix: 70 }, 'Crunch': { type: 'hard', drive: 20, tone: 5000, out: -10 }, 'Fuzz bass': { type: 'fuzz', drive: 28, tone: 3000, out: -12, mix: 60 } },
    build(ctx) {
      const w = wetDry(ctx), pre = G(ctx), sh = ctx.createWaveShaper(), tone = bq(ctx, 'lowpass', 7000), out = G(ctx);
      sh.oversample = '4x'; w.input.connect(pre).connect(sh).connect(tone).connect(out).connect(w.wet);
      let t = '';
      return { input: w.input, output: w.output, set(p) {
        if (t !== p.type) { t = p.type; const f = { soft: (x) => Math.tanh(x), hard: (x) => clamp(x * 1.5, -1, 1), fuzz: (x) => Math.sign(x) * (1 - Math.exp(-Math.abs(x) * 3)), fold: (x) => Math.sin(x * 2.2) }[t]; sh.curve = shaperCurve(f); }
        setP(ctx, pre.gain, dbToGain(p.drive)); setP(ctx, tone.frequency, p.tone); setP(ctx, out.gain, dbToGain(p.out)); w.mix(p.mix);
      } };
    },
  });
  def('bitcrush', {
    name: 'Bit crusher', cat: 'Distortion', desc: 'Lo-fi bit-depth reduction with bandwidth limit.',
    params: [{ id: 'bits', label: 'Bits', min: 2, max: 16, def: 8, step: 1, fmt: (v) => Math.round(v) + '-bit' }, { id: 'bw', label: 'Bandwidth', min: 1000, max: 20000, def: 8000, log: true, fmt: hz }, { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, fmt: pct }],
    presets: { '8-bit console': { bits: 6, bw: 6000 }, 'Telephone crush': { bits: 10, bw: 3200 } },
    build(ctx) {
      const w = wetDry(ctx), sh = ctx.createWaveShaper(), lp = bq(ctx, 'lowpass', 8000);
      w.input.connect(sh).connect(lp).connect(w.wet);
      let b = -1;
      return { input: w.input, output: w.output, set(p) { const bits = Math.round(p.bits); if (bits !== b) { b = bits; const q = Math.pow(2, bits - 1); sh.curve = shaperCurve((x) => Math.round(x * q) / q, 65536); } setP(ctx, lp.frequency, Math.min(p.bw, ctx.sampleRate / 2 - 10)); w.mix(p.mix); } };
    },
  });
  def('exciter', {
    name: 'Smooth / enhance', cat: 'Distortion', desc: 'Negative values smooth harsh highs; positive values add sparkle.',
    params: [{ id: 'amount', label: 'Amount', min: -100, max: 100, def: 30, fmt: (v) => (v < 0 ? 'Smooth ' + Math.round(-v) : 'Enhance ' + Math.round(v)) }, { id: 'freq', label: 'Frequency', min: 1500, max: 12000, def: 4000, log: true, fmt: hz }],
    presets: { 'Vocal air': { amount: 40, freq: 6000 }, 'Tame harshness': { amount: -50, freq: 5000 } },
    build(ctx) {
      const input = G(ctx), out = G(ctx), smooth = bq(ctx, 'highshelf', 4000), hp = bq(ctx, 'highpass', 4000), sh = ctx.createWaveShaper(), amt = G(ctx, 0);
      sh.curve = shaperCurve((x) => Math.tanh(4 * x) / 2 + x * x * 0.4);
      input.connect(smooth).connect(out); input.connect(hp).connect(sh).connect(amt).connect(out);
      return { input, output: out, set(p) { const a = p.amount / 100; setP(ctx, smooth.frequency, p.freq); setP(ctx, smooth.gain, a < 0 ? a * 14 : 0); setP(ctx, hp.frequency, p.freq); setP(ctx, amt.gain, a > 0 ? a * 0.35 : 0); } };
    },
  });

  // ---------------- Stereo & Utility ----------------
  def('stereo', {
    name: 'Pan / expand', cat: 'Stereo & Utility', desc: 'Stereo width from mono to extra-wide, plus balance.',
    params: [{ id: 'width', label: 'Width', min: 0, max: 200, def: 100, fmt: pct }, { id: 'pan', label: 'Balance', min: -100, max: 100, def: 0, fmt: (v) => (Math.abs(v) < 1 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v))) }, { id: 'swap', label: 'Swap L/R', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], def: 'off' }],
    presets: { 'Mono': { width: 0 }, 'Wide': { width: 150 }, 'Extra wide': { width: 200 } },
    build(ctx) {
      const input = G(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), pan = ctx.createStereoPanner();
      // M/S matrix with gains: L' = a*L + b*R, R' = b*L + a*R
      const LL = G(ctx), LR = G(ctx), RL = G(ctx), RR = G(ctx);
      input.connect(sp); sp.connect(LL, 0); sp.connect(RL, 0); sp.connect(LR, 1); sp.connect(RR, 1);
      LL.connect(mg, 0, 0); LR.connect(mg, 0, 0); RL.connect(mg, 0, 1); RR.connect(mg, 0, 1); mg.connect(pan);
      return { input, output: pan, set(p) {
        const wd = p.width / 100, a = (1 + wd) / 2, b = (1 - wd) / 2, s = p.swap === 'on';
        setP(ctx, LL.gain, s ? b : a); setP(ctx, LR.gain, s ? a : b); setP(ctx, RL.gain, s ? a : b); setP(ctx, RR.gain, s ? b : a);
        setP(ctx, pan.pan, p.pan / 100);
      } };
    },
  });
  def('gain', {
    name: 'Volume / phase', cat: 'Stereo & Utility', desc: 'Gain trim, polarity flip and mono fold-down.',
    params: [{ id: 'gain', label: 'Gain', min: -48, max: 24, def: 0, fmt: db }, { id: 'phase', label: 'Polarity', options: [{ value: 'norm', label: 'Normal' }, { value: 'inv', label: 'Inverted' }], def: 'norm' }, { id: 'mono', label: 'Mono', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], def: 'off' }],
    presets: { '-6 dB': { gain: -6 }, '+6 dB': { gain: 6 } },
    build(ctx) {
      const g = G(ctx), out = G(ctx); g.connect(out);
      return { input: g, output: out, set(p) { setP(ctx, g.gain, dbToGain(p.gain) * (p.phase === 'inv' ? -1 : 1)); out.channelCountMode = p.mono === 'on' ? 'explicit' : 'max'; out.channelCount = p.mono === 'on' ? 1 : 2; } };
    },
  });

  // ---------------- API ----------------
  function defaults(type) { const d = REG[type], o = {}; for (const p of d.params) o[p.id] = p.def; return o; }
  function instance(type, params) { return { id: uid('fx'), type, on: true, params: Object.assign(defaults(type), params || {}) }; }
  function list() { return CATS.map((c) => ({ cat: c, items: Object.values(REG).filter((d) => d.cat === c) })); }

  let bypassAll = false;   // Options › Bypass all effects (live playback only)
  class Chain {
    constructor(ctx, live = true) { this.ctx = ctx; this.live = live && !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext); this.input = G(ctx); this.output = G(ctx); this.nodes = []; this.sig = null; this.fx = []; this.input.connect(this.output); }
    set(fx) {
      this.fx = fx;
      fx = this.live && bypassAll ? [] : (fx || []).filter((f) => REG[f.type]);
      const sig = fx.map((f) => f.id + (f.on ? '1' : '0')).join('|');
      if (sig !== this.sig) {
        this.sig = sig;
        try { this.input.disconnect(); } catch (e) { }
        for (const n of this.nodes) { try { n.node.output.disconnect(); } catch (e) { } n.node.dispose && n.node.dispose(); }
        this.nodes = [];
        let prev = this.input;
        for (const f of fx) {
          if (!f.on) continue;
          const node = REG[f.type].build(this.ctx);
          node.set(Object.assign(defaults(f.type), f.params));
          prev.connect(node.input); prev = node.output;
          this.nodes.push({ id: f.id, node });
        }
        prev.connect(this.output);
      } else {
        for (const f of fx) { const n = this.nodes.find((x) => x.id === f.id); if (n) n.node.set(Object.assign(defaults(f.type), f.params)); }
      }
    }
  }
  async function render(chs, sr, fx, tail = 0) {
    const n = chs[0].length, nch = chs.length, len = n + Math.round(tail * sr);
    const oc = new OfflineAudioContext(2, len, sr);
    const src = oc.createBufferSource(); src.buffer = makeBuffer(chs, sr);
    const ch = new Chain(oc, false); ch.set(fx);
    src.connect(ch.input); ch.output.connect(oc.destination); src.start();
    const r = await oc.startRendering();
    return Array.from({ length: nch }, (_, c) => r.getChannelData(Math.min(c, 1)).slice(0, len));
  }

  // user presets
  const loadUser = () => { try { return JSON.parse(localStorage.getItem('rush.presets') || '{}'); } catch (e) { return {}; } };
  const saveUser = (o) => { try { localStorage.setItem('rush.presets', JSON.stringify(o)); } catch (e) { } };
  function presets(type) { const u = loadUser()[type] || {}; return { factory: REG[type].presets || {}, user: u }; }
  function savePreset(type, name, params) { const u = loadUser(); (u[type] = u[type] || {})[name] = params; saveUser(u); }
  function deletePreset(type, name) { const u = loadUser(); if (u[type]) { delete u[type][name]; saveUser(u); } }

  return { get bypassAll() { return bypassAll; }, set bypassAll(v) { bypassAll = !!v; }, REG, CATS, Chain, render, instance, defaults, list, presets, savePreset, deletePreset };
})();
