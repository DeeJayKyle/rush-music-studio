// ---------------------------------------------------------------------------
// Tempo map — tempo markers with instant (hold) or gradual (ramp) changes.
// P.tempo = [{ id, b (beat), bpm, ramp }]; ramp=true means the tempo glides
// from the previous marker to this one. The first marker is always at beat 0
// and mirrors P.bpm.
// ---------------------------------------------------------------------------
const T = (() => {
  let sig = '', segs = [];
  function list() {
    if (!P.tempo || !P.tempo.length) P.tempo = [{ id: uid('tm'), b: 0, bpm: P.bpm, ramp: false }];
    P.tempo.sort((a, b) => a.b - b.b);
    if (P.tempo[0].b > 1e-9) P.tempo.unshift({ id: uid('tm'), b: 0, bpm: P.bpm, ramp: false });
    P.tempo[0].b = 0; P.tempo[0].bpm = P.bpm; P.tempo[0].ramp = false;
    return P.tempo;
  }
  function segSec(g, b) { const d = b - g.b0; if (Math.abs(g.k) < 1e-12) return d * 60 / g.bpm0; return 60 / g.k * Math.log((g.bpm0 + g.k * d) / g.bpm0); }
  function build() {
    const L = list();
    const s = L.map((t) => t.b + ':' + t.bpm + ':' + (t.ramp ? 1 : 0)).join('|');
    if (s === sig) return segs;
    sig = s; segs = [];
    let s0 = 0;
    for (let i = 0; i < L.length; i++) {
      const m = L[i], nx = L[i + 1];
      const b0 = m.b, b1 = nx ? nx.b : Infinity;
      const ramp = !!(nx && nx.ramp && b1 > b0 + 1e-9);
      const g = { i, b0, b1, bpm0: m.bpm, bpm1: ramp ? nx.bpm : m.bpm, s0, k: ramp ? (nx.bpm - m.bpm) / (b1 - b0) : 0, ramp };
      g.s1 = nx ? s0 + segSec(g, b1) : Infinity;
      segs.push(g); s0 = g.s1;
    }
    return segs;
  }
  function segOfB(b) { const S = build(); let lo = 0, hi = S.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].b0 <= b) lo = m; else hi = m - 1; } return S[lo]; }
  function segOfS(s) { const S = build(); let lo = 0, hi = S.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].s0 <= s) lo = m; else hi = m - 1; } return S[lo]; }
  // beats → seconds
  function b2s(b) { if (b <= 0) return b * 60 / build()[0].bpm0; const g = segOfB(b); return g.s0 + segSec(g, b); }
  // seconds → beats
  function s2b(s) {
    if (s <= 0) return s * build()[0].bpm0 / 60;
    const g = segOfS(s), d = s - g.s0;
    if (Math.abs(g.k) < 1e-12) return g.b0 + d * g.bpm0 / 60;
    return g.b0 + g.bpm0 * (Math.exp(g.k * d / 60) - 1) / g.k;
  }
  function bpmAt(b) { b = Math.max(0, b); const g = segOfB(b); return g.bpm0 + g.k * (b - g.b0); }
  const spbAt = (b) => 60 / bpmAt(b);
  function indexAt(b) { return segOfB(Math.max(0, b)).i; }
  // split [B0,B1) into pieces of (nearly) constant tempo: one per hold region, one per beat in ramps
  function pieces(B0, B1) {
    const out = [];
    for (const g of build()) {
      const x0 = Math.max(B0, g.b0), x1 = Math.min(B1, g.b1);
      if (x1 - x0 < 1e-9) continue;
      if (!g.ramp) { out.push({ p0: x0, p1: x1, bpm: g.bpm0, ramp: false }); continue; }
      let p = x0;
      while (p < x1 - 1e-9) {
        // seams sit a 16th before each beat (n + 0.75) so they never soften the hit on the beat
        const q = Math.min(x1, Math.floor(p + 0.25 + 1e-9) + 0.75);
        const sec = b2s(q) - b2s(p);
        out.push({ p0: p, p1: q, bpm: (q - p) * 60 / sec, ramp: true });
        p = q;
      }
    }
    return out;
  }
  // free (un-synced) clip length in beats for `dur` seconds starting at beat `start`
  const lenFor = (start, dur) => s2b(b2s(start) + dur) - start;

  // ---- editing (with undo) ----
  function changed() { Engine.refresh(); bus.emit('project'); bus.emit('tempo'); markDirty(); }
  function add(b, bpm, ramp = false) {
    Hist.push(); list();
    b = Math.max(0, b);
    if (b < 1e-6) { P.bpm = bpm; changed(); return P.tempo[0]; }
    const ex = P.tempo.find((t) => Math.abs(t.b - b) < 1e-6);
    if (ex) { ex.bpm = bpm; ex.ramp = ramp; changed(); return ex; }
    const m = { id: uid('tm'), b, bpm: clamp(bpm, 20, 300), ramp };
    P.tempo.push(m); changed();
    return m;
  }
  function edit(m, { b, bpm, ramp }) {
    Hist.push();
    if (m === P.tempo[0]) { if (bpm) P.bpm = clamp(bpm, 20, 300); }
    else { if (b != null) m.b = Math.max(0.001, b); if (bpm) m.bpm = clamp(bpm, 20, 300); if (ramp != null) m.ramp = ramp; }
    changed();
  }
  function remove(m) { if (m === P.tempo[0]) return; Hist.push(); P.tempo = P.tempo.filter((t) => t !== m); changed(); }
  // set the tempo before marker m so that m lands exactly at time `sec`
  function alignTo(m, sec) {
    const L = list(), i = L.indexOf(m); if (i <= 0) return false;
    const prev = L[i - 1], sPrev = b2s(prev.b);
    if (sec <= sPrev + 0.01) return false;
    const bpm = (m.b - prev.b) * 60 / (sec - sPrev);
    if (bpm < 20 || bpm > 300) return false;
    Hist.push();
    if (i - 1 === 0) P.bpm = bpm; else prev.bpm = bpm;
    m.ramp = false;
    changed();
    return bpm;
  }
  return { list, build, b2s, s2b, bpmAt, spbAt, indexAt, pieces, lenFor, add, edit, remove, alignTo, changed };
})();
