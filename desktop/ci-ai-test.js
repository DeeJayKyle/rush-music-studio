// CI check for the AI stem separator: runs Rush's real separation code (src/aiworker.js)
// with the bundled HTDemucs model on a synthetic song whose true stems are known, and
// reports the quality (SDR, dB, higher is better) next to the fast DSP separator.
// Usage: node ci-ai-test.js <path to onnxruntime-node>
const fs = require('fs'), path = require('path');
const ort = require(process.argv[2] || 'onnxruntime-node');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
global.self = {};                       // worker.js expects a worker global
eval(src('aiworker.js') + '\n;global.separateCore = separateCore;');
eval(src('fft.js') + '\n' + src('worker.js').replace(/self\.onmessage[\s\S]*$/, '') + '\n;global.dspSeparate = separate;');

const sr = 44100, secs = 24, n = sr * secs, bpm = 120, beat = 60 / bpm;
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const mk = () => [new Float32Array(n), new Float32Array(n)];
const drums = mk(), bass = mk(), other = mk(), vocals = mk();
for (let i = 0; i < n; i++) {
  const t = i / sr, b = t / beat, inB = (b % 1) * beat, bi = Math.floor(b);
  let d = Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-inB * 30)) * inB) * Math.exp(-inB * 9) * 0.8;          // kick
  if (bi % 2 === 1) d += rnd() * Math.exp(-inB * 22) * 0.45;                                                  // snare
  const h8 = (t / (beat / 2)) % 1 * beat / 2; d += rnd() * Math.exp(-h8 * 90) * 0.12;                          // hats
  drums[0][i] = d; drums[1][i] = d * 0.95;
  const root = [55, 55, 65.4, 49][Math.floor(bi / 4) % 4];
  let bs = 0; for (let k = 1; k < 8; k++) bs += Math.sin(2 * Math.PI * root * k * t) / k * (k < 3 ? 1 : 0.4);
  bass[0][i] = bass[1][i] = bs * 0.25 * Math.min(1, inB * 40);
  const chord = [[220, 277, 330], [220, 277, 330], [262, 330, 392], [196, 247, 294]][Math.floor(bi / 4) % 4];
  let o = 0; for (const f of chord) o += Math.sin(2 * Math.PI * f * t + Math.sin(2 * Math.PI * 0.3 * t)) + 0.3 * Math.sin(4 * Math.PI * f * t);
  other[0][i] = o * 0.06; other[1][i] = o * 0.05 * (1 + 0.3 * Math.sin(t));
  // a sung line: pulse train with vibrato through vowel formants
  const note = [440, 494, 523, 494, 440, 392, 440, 0][Math.floor(b / 2) % 8];
  vocals[0][i] = vocals[1][i] = note ? note * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t)) : 0;
}
// formant filter for the vocal line
{
  const f0 = vocals[0], out = new Float32Array(n); let ph = 0;
  const forms = [[700, 80, 1], [1220, 90, 0.5], [2600, 120, 0.25]].map(([f, bw, g]) => { const r = Math.exp(-Math.PI * bw / sr), c = 2 * r * Math.cos(2 * Math.PI * f / sr); return { a1: c, a2: -r * r, g, y1: 0, y2: 0 }; });
  for (let i = 0; i < n; i++) {
    let x = 0; if (f0[i]) { ph += f0[i] / sr; if (ph >= 1) { ph -= 1; x = 1; } }
    let y = 0; for (const F of forms) { const v = x * F.g + F.a1 * F.y1 + F.a2 * F.y2; F.y2 = F.y1; F.y1 = v; y += v; }
    out[i] = y * 0.05;
  }
  vocals[0] = out; vocals[1] = out.slice();
}
const truth = { drums, bass, other, vocals };
const mixL = new Float32Array(n), mixR = new Float32Array(n);
for (const k in truth) for (let i = 0; i < n; i++) { mixL[i] += truth[k][0][i]; mixR[i] += truth[k][1][i]; }
let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(mixL[i]), Math.abs(mixR[i]));
const sc = 0.8 / pk; for (let i = 0; i < n; i++) { mixL[i] *= sc; mixR[i] *= sc; } for (const k in truth) for (const c of truth[k]) for (let i = 0; i < n; i++) c[i] *= sc;

const sdr = (est, ref) => { let s = 0, e = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) { s += ref[c][i] ** 2; e += (ref[c][i] - est[c][i]) ** 2; } return 10 * Math.log10(s / (e + 1e-12)); };

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'ai/models/manifest.json'), 'utf8'));
  const t0 = Date.now();
  const session = await ort.InferenceSession.create(path.join(__dirname, 'ai/models', manifest.model));
  const inName = session.inputNames[0], outName = session.outputNames[0];
  const load = Date.now() - t0;
  let runs = 0, runMs = 0;
  const run = async (x) => { const a = Date.now(); const r = await session.run({ [inName]: new ort.Tensor('float32', x, [1, 2, manifest.segment]) }); runs++; runMs += Date.now() - a; return r[outName].data; };
  const got = { drums: mk(), bass: mk(), other: mk(), vocals: mk() };
  await separateCore({ L: mixL, R: mixR, seg: manifest.segment, nStems: 4, run, focus: () => 0,
    onRegion: (a, b, data) => manifest.stems.forEach((k, s) => { got[k][0].set(data[s * 2], a); got[k][1].set(data[s * 2 + 1], a); }) });
  const dsp = dspSeparate(mixL.slice(), mixR.slice(), sr, {}).stems;
  const rows = [];
  for (const k of ['vocals', 'drums', 'bass', 'other']) rows.push(`${k}: AI ${sdr(got[k], truth[k]).toFixed(1)} dB vs fast ${sdr(dsp[k], truth[k]).toFixed(1)} dB`);
  const msg = `HTDemucs loaded in ${(load / 1000).toFixed(1)} s; ${runs} windows at ${(runMs / runs / 1000).toFixed(2)} s each (${(secs / (runMs / 1000)).toFixed(1)}x real-time on the CI CPU). SDR ` + rows.join(' | ');
  console.log(msg);
  console.log('::notice title=AI stem quality::' + msg);
  if (!rows.length || !isFinite(sdr(got.drums, truth.drums))) { console.log('::error title=AI stems::separation produced no output'); process.exit(1); }
})().catch((e) => { console.log('::error title=AI stems::' + String(e && e.stack || e).replace(/\n/g, ' | ')); process.exit(1); });
