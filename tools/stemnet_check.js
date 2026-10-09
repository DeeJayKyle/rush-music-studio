// Runs Rush's neural stem engine (src/stemnet.js + WebAssembly kernels) in Node on a planar
// stereo float32 file and writes the 4 x 2 stems. usage: node stemnet_check.js model.rsm in.f32 out.f32 [fma]
const fs = require('fs'), path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const { StemNet } = new Function(src('fft.js') + '\n' + src('stemnet.js') + '\nreturn { StemNet };')();
(async () => {
  const [model, inp, outp, variant] = process.argv.slice(2);
  const wasm = fs.readFileSync(path.join(__dirname, '..', 'src', 'kernels', variant === 'fma' ? 'kernels_fma.wasm' : 'kernels.wasm'));
  if (!WebAssembly.validate(wasm)) { console.log(JSON.stringify({ skipped: 'relaxed SIMD not supported by this Node' })); return; }
  const mb = fs.readFileSync(model);
  const net = await StemNet.create({ wasm, model: mb.buffer.slice(mb.byteOffset, mb.byteOffset + mb.byteLength), backend: 'cpu' });
  const ib = fs.readFileSync(inp), x = new Float32Array(ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.byteLength)), n = x.length / 2;
  const t0 = Date.now();
  const out = await net.segment(x.slice(0, n), x.slice(n));
  const ms = Date.now() - t0;
  const all = new Float32Array(8 * n); let k = 0; for (const s of out) for (const c of s) all.set(c, (k++) * n);
  fs.writeFileSync(outp, Buffer.from(all.buffer));
  console.log(JSON.stringify({ samples: n, ms }));
})().catch((e) => { console.error(e); process.exit(1); });
