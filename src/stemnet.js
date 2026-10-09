// ---------------------------------------------------------------------------
// Rush neural stem engine — Hybrid Transformer Demucs (htdemucs) inference.
// Original implementation (MIT). Model weights: Demucs by Meta Platforms, MIT licence.
// The network code is written once against a small tensor backend with two
// implementations: WebAssembly SIMD on the CPU, and WebGPU compute shaders.
// ---------------------------------------------------------------------------
const StemNet = (() => {
  const SEG = 343980, NFFT = 4096, HOP = 1024;

  function parseModel(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 16 || dv.getUint32(0, true) !== 0x4d545352) throw new Error('Not a Rush stem model file');
    const jl = dv.getUint32(8, true), hl = dv.getUint32(12, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, jl)));
    return { meta, dataOff: hl };
  }
  const prod = (s) => s.reduce((a, b) => a * b, 1);

  // =============================== CPU backend (WebAssembly SIMD) ===============================
  async function cpuBackend(wasm, model, meta, dataOff) {
    const mem = new WebAssembly.Memory({ initial: 256, maximum: 65536 });
    const res = await WebAssembly.instantiate(wasm, { env: { memory: mem } });
    const K = (res.instance || res).exports;
    const align = (n) => (n + 63) & ~63;
    let heap = K.__heap_base.value;
    const grow = (end) => { const need = Math.ceil(end / 65536) - mem.buffer.byteLength / 65536; if (need > 0) mem.grow(need); };
    const scratch = align(heap); heap = scratch + align(K.scratch_bytes());
    const wBase = align(heap), wBytes = model.byteLength - dataOff;
    grow(wBase + wBytes);
    new Uint8Array(mem.buffer, wBase, wBytes).set(new Uint8Array(model, dataOff, wBytes));
    K.set_scratch(scratch);
    const arenaStart = align(wBase + wBytes);
    const blocks = []; let top = arenaStart;
    function allocBytes(n) {
      n = align(n);
      for (let i = 0; i < blocks.length; i++) { const b = blocks[i]; if (b.free && b.n >= n) { if (b.n - n > 1 << 20) { blocks.splice(i + 1, 0, { p: b.p + n, n: b.n - n, free: true }); b.n = n; } b.free = false; return b.p; } }
      const p = top; top += n; grow(top); blocks.push({ p, n, free: false }); return p;
    }
    function freeBytes(p) {
      const i = blocks.findIndex((b) => b.p === p); if (i < 0) return;
      blocks[i].free = true;
      for (let j = blocks.length - 1; j > 0; j--) if (blocks[j].free && blocks[j - 1].free && blocks[j - 1].p + blocks[j - 1].n === blocks[j].p) { blocks[j - 1].n += blocks[j].n; blocks.splice(j, 1); }
      while (blocks.length && blocks[blocks.length - 1].free) { const b = blocks.pop(); top = b.p; }
    }
    // f32 tensors: byte = p + 4*off ; f16 weights: byte = wBase + 2*(o + off)
    const ad = (r) => (r.f16 ? wBase + 2 * (r.t.o + (r.off || 0)) : r.t.p + 4 * (r.off || 0));
    const pa = (t) => (t ? (t.f16 ? wBase + 2 * t.o : t.p) : 0);
    const F = (t, n) => new Float32Array(mem.buffer, t.p, n);
    return {
      kind: 'cpu',
      alloc(shape) { return { p: allocBytes(prod(shape) * 4), shape }; },
      free(t) { if (t && t.p != null) freeBytes(t.p); },
      weight(off, shape) { return { o: off, shape, f16: true }; },
      upload(t, data) { F(t, data.length).set(data); },
      async read(t) { return F(t, prod(t.shape)).slice(); },
      gemm(M, N, Kd, A, B, C, acc, alpha) { K.gemm(M, N, Kd, ad(A), A.f16 ? 1 : 0, A.rs, A.cs, ad(B), B.f16 ? 1 : 0, B.rs, B.nb, B.s1, B.s2, ad(C), C.rs, C.nb, C.s1, C.s2, acc ? 1 : 0, alpha); },
      gelu(t, n) { K.gelu(t.p, n); },
      glu(x, y, C, inner) { K.glu(x.p, y.p, C, inner); },
      fillBias(y, b, C, inner) { K.fill_bias(y.p, pa(b), C, inner); },
      addBiasRows(y, b, N, C, boff = 0) { K.add_bias_rows(y.p, pa(b) + 2 * boff, N, C); },
      add(x, y, n) { K.add(x.p, y.p, n); },
      addScaledCM(x, y, s, C, inner) { K.add_scaled_cm(x.p, y.p, pa(s), C, inner); },
      addScaledTM(x, y, s, N, C) { K.add_scaled_tm(x.p, y.p, pa(s), N, C); },
      groupnormRows(x, C, R, L, w, b) { K.groupnorm_rows(x.p, C, R, L, pa(w), pa(b)); },
      groupnormTM(x, N, C, w, b) { K.groupnorm_tm(x.p, N, C, pa(w), pa(b)); },
      layernorm(x, y, N, C, w, b) { K.layernorm(x.p, y.p, N, C, pa(w), pa(b)); },
      softmax(x, R, N) { K.softmax_rows(x.p, R, N); },
      transpose(x, y, R, Cc) { K.transpose(x.p, y.p, R, Cc); },
      pad3(x, y, C, Fd, Td, pl, pr, ql, qr) { K.pad3(x.p, y.p, C, Fd, Td, pl, pr, ql, qr); },
      sliceLast(x, y, C, L, off, n) { K.slice_last(x.p, y.p, C, L, off, n); },
      scaleShift(x, n, a, b) { K.scale_shift(x.p, n, a, b); },
      copy(x, y, n) { F(y, n).set(F(x, n)); },
      permute3(x, y, A, Bn, C) { const s = F(x, A * Bn * C), d = F(y, A * Bn * C); for (let a = 0; a < A; a++) for (let b = 0; b < Bn; b++) d.set(s.subarray((a * Bn + b) * C, (a * Bn + b + 1) * C), (b * A + a) * C); },
      addTable(x, table, n) { const v = F(x, n); for (let i = 0; i < n; i++) v[i] += table[i]; },
      freqEmb(x, w, C, Fd, Td) { const h = new Uint16Array(mem.buffer, wBase + 2 * w.o, Fd * C), a = F(x, C * Fd * Td); for (let f = 0; f < Fd; f++) for (let c = 0; c < C; c++) { const val = 2 * K.h2f_export(h[f * C + c]); const o = (c * Fd + f) * Td; for (let t = 0; t < Td; t++) a[o + t] += val; } },
      memBytes: () => mem.buffer.byteLength,
    };
  }

  // =============================== GPU backend (WebGPU) ===============================
  async function gpuBackend(model, meta, dataOff) {
    if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('WebGPU is not available');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No GPU adapter');
    const Lm = adapter.limits;
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Lm.maxStorageBufferBindingSize, maxBufferSize: Lm.maxBufferSize } });
    let lost = null; device.lost.then((i) => { lost = i; });
    const wBytes = model.byteLength - dataOff;
    if (wBytes > Lm.maxStorageBufferBindingSize) throw new Error('GPU buffer limit too small for the model');
    const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST;
    const wbuf = device.createBuffer({ size: (wBytes + 3) & ~3, usage: S | CD });
    device.queue.writeBuffer(wbuf, 0, model, dataOff, wBytes & ~3);
    const dummy = () => device.createBuffer({ size: 16, usage: S });
    const zA = dummy(), zB = dummy();
    const LOAD = `
fn ld(buf: ptr<storage, array<u32>, read>, idx: u32, f16: u32) -> f32 {
  if (f16 == 1u) { let w = (*buf)[idx >> 1u]; let v = unpack2x16float(w); return select(v.x, v.y, (idx & 1u) == 1u); }
  return bitcast<f32>((*buf)[idx]);
}`;
    const GEMM = `
struct P { M: u32, N: u32, K: u32, aoff: u32, af16: u32, ars: u32, acs: u32, boff: u32, bf16: u32, brs: u32, bnb: u32, bs1: u32, bs2: u32,
           coff: u32, crs: u32, cnb: u32, cs1: u32, cs2: u32, acc: u32, alpha: f32 };
@group(0) @binding(0) var<storage, read> A: array<u32>;
@group(0) @binding(1) var<storage, read> B: array<u32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> As: array<array<f32, 64>, 16>;
var<workgroup> Bs: array<array<f32, 64>, 16>;
${LOAD}
@compute @workgroup_size(16, 16)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let m0 = wid.y * 64u; let n0 = wid.x * 64u;
  let tid = lid.y * 16u + lid.x;
  var acc: array<array<f32, 4>, 4>;
  for (var i = 0u; i < 4u; i++) { for (var j = 0u; j < 4u; j++) { acc[i][j] = 0.0; } }
  let bn = n0 + (tid & 63u);
  let bcol = (bn / p.bnb) * p.bs1 + (bn % p.bnb) * p.bs2;
  let am = m0 + (tid & 63u);
  for (var k0 = 0u; k0 < p.K; k0 += 16u) {
    for (var q = 0u; q < 4u; q++) {
      let kk = (tid >> 6u) + 4u * q;
      let k = k0 + kk;
      var av = 0.0; var bv = 0.0;
      if (am < p.M && k < p.K) { av = ld(&A, p.aoff + am * p.ars + k * p.acs, p.af16); }
      if (bn < p.N && k < p.K) { bv = ld(&B, p.boff + k * p.brs + bcol, p.bf16); }
      As[kk][tid & 63u] = av; Bs[kk][tid & 63u] = bv;
    }
    workgroupBarrier();
    for (var kk = 0u; kk < 16u; kk++) {
      let a = vec4<f32>(As[kk][lid.y * 4u], As[kk][lid.y * 4u + 1u], As[kk][lid.y * 4u + 2u], As[kk][lid.y * 4u + 3u]);
      let b = vec4<f32>(Bs[kk][lid.x * 4u], Bs[kk][lid.x * 4u + 1u], Bs[kk][lid.x * 4u + 2u], Bs[kk][lid.x * 4u + 3u]);
      for (var i = 0u; i < 4u; i++) { for (var j = 0u; j < 4u; j++) { acc[i][j] = fma(a[i], b[j], acc[i][j]); } }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    let m = m0 + lid.y * 4u + i;
    if (m >= p.M) { continue; }
    for (var j = 0u; j < 4u; j++) {
      let n = n0 + lid.x * 4u + j;
      if (n >= p.N) { continue; }
      let ci = p.coff + m * p.crs + (n / p.cnb) * p.cs1 + (n % p.cnb) * p.cs2;
      let v = p.alpha * acc[i][j];
      if (p.acc == 1u) { C[ci] = C[ci] + v; } else { C[ci] = v; }
    }
  }
}`;
    const ELEM = `
struct Q { op: u32, n: u32, a: u32, b: u32, c: u32, d: u32, e: u32, f: u32, g: u32, h: u32, x0: f32, x1: f32, woff: u32, boff: u32, w2: u32, w3: u32 };
@group(0) @binding(0) var<storage, read_write> X: array<f32>;
@group(0) @binding(1) var<storage, read_write> Y: array<f32>;
@group(0) @binding(2) var<storage, read> W: array<u32>;
@group(0) @binding(3) var<uniform> q: Q;
fn wv(idx: u32) -> f32 { let w = W[idx >> 1u]; let v = unpack2x16float(w); return select(v.x, v.y, (idx & 1u) == 1u); }
fn erf_(x: f32) -> f32 {
  let s = sign(x); let ax = abs(x); let t = 1.0 / (1.0 + 0.3275911 * ax);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-ax * ax);
  return s * y;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= q.n) { return; }
  switch q.op {
    case 0u: { let v = X[i]; X[i] = 0.5 * v * (1.0 + erf_(v * 0.70710678118654752)); }
    case 1u: { let c = i / q.a; let r = i % q.a; Y[i] = X[c * q.a + r] / (1.0 + exp(-X[(c + q.b) * q.a + r])); }
    case 2u: { let c = i / q.a; Y[i] = select(0.0, wv(q.woff + c), q.w2 == 1u); }
    case 3u: { let c = i % q.a; Y[i] = Y[i] + wv(q.woff + c); }
    case 4u: { X[i] = X[i] + Y[i]; }
    case 5u: { let c = i / q.a; X[i] = X[i] + wv(q.woff + c) * Y[i]; }
    case 6u: { let c = i % q.a; X[i] = X[i] + wv(q.woff + c) * Y[i]; }
    case 7u: { X[i] = X[i] * q.x0 + q.x1; }
    case 8u: { Y[i] = X[i]; }
    case 9u: { let c = i / q.a; let r = i % q.a; Y[i] = X[r * q.b + c]; }
    case 10u: {
      let t2 = i % q.f; let f2 = (i / q.f) % q.e; let c = i / (q.f * q.e);
      let f = i32(f2) - i32(q.c); let t = i32(t2) - i32(q.d);
      if (f < 0 || f >= i32(q.a) || t < 0 || t >= i32(q.b)) { Y[i] = 0.0; } else { Y[i] = X[(c * q.a + u32(f)) * q.b + u32(t)]; } }
    case 11u: { let c = i / q.b; let k = i % q.b; Y[i] = X[c * q.a + q.c + k]; }
    case 12u: { let cc = i % q.c; let aa = (i / q.c) % q.a; let bb = i / (q.c * q.a); Y[i] = X[(aa * q.b + bb) * q.c + cc]; }
    case 13u: { let t = i % q.c; let f = (i / q.c) % q.b; let c = i / (q.c * q.b); X[i] = X[i] + 2.0 * wv(q.woff + f * q.a + c); }
    default: {}
  }
}`;
    const STATS = `
struct Q { R: u32, C: u32, T: u32, rstride: u32, cstride: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read_write> St: array<f32>;
@group(0) @binding(2) var<uniform> q: Q;
var<workgroup> s1: array<f32, 256>; var<workgroup> s2: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let r = wid.x + wid.y * nw.x;
  if (r >= q.R) { return; }
  let n = q.C * q.T;
  let shift = X[r * q.rstride];
  var a = 0.0; var b = 0.0;
  for (var e = lid.x; e < n; e += 256u) { let c = e / q.T; let t = e % q.T; let v = X[c * q.cstride + r * q.rstride + t] - shift; a += v; b += v * v; }
  s1[lid.x] = a; s2[lid.x] = b; workgroupBarrier();
  for (var k = 128u; k > 0u; k >>= 1u) { if (lid.x < k) { s1[lid.x] += s1[lid.x + k]; s2[lid.x] += s2[lid.x + k]; } workgroupBarrier(); }
  if (lid.x == 0u) { let nn = f32(n); let m = s1[0] / nn; let v = max(s2[0] / nn - m * m, 0.0); St[2u * r] = m + shift; St[2u * r + 1u] = 1.0 / sqrt(v + 1e-5); }
}`;
    const NORM = `
struct Q { mode: u32, n: u32, C: u32, R: u32, T: u32, woff: u32, boff: u32, inplace: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read_write> Y: array<f32>;
@group(0) @binding(2) var<storage, read> St: array<f32>;
@group(0) @binding(3) var<storage, read> W: array<u32>;
@group(0) @binding(4) var<uniform> q: Q;
fn wv(idx: u32) -> f32 { let w = W[idx >> 1u]; let v = unpack2x16float(w); return select(v.x, v.y, (idx & 1u) == 1u); }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= q.n) { return; }
  var c = 0u; var r = 0u;
  if (q.mode == 0u) { c = i / (q.R * q.T); r = (i / q.T) % q.R; }
  else if (q.mode == 1u) { c = i % q.C; r = 0u; }
  else { c = i % q.C; r = i / q.C; }
  let xv = select(X[i], Y[i], q.inplace == 1u);
  Y[i] = (xv - St[2u * r]) * St[2u * r + 1u] * wv(q.woff + c) + wv(q.boff + c);
}`;
    const SOFTMAX = `
struct Q { R: u32, N: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<storage, read_write> X: array<f32>;
@group(0) @binding(1) var<uniform> q: Q;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let r = wid.x + wid.y * nw.x; if (r >= q.R) { return; }
  let base = r * q.N;
  var m = -3.4e38; for (var i = lid.x; i < q.N; i += 256u) { m = max(m, X[base + i]); }
  red[lid.x] = m; workgroupBarrier();
  for (var k = 128u; k > 0u; k >>= 1u) { if (lid.x < k) { red[lid.x] = max(red[lid.x], red[lid.x + k]); } workgroupBarrier(); }
  let mx = red[0]; workgroupBarrier();
  var s = 0.0; for (var i = lid.x; i < q.N; i += 256u) { let e = exp(X[base + i] - mx); X[base + i] = e; s += e; }
  red[lid.x] = s; workgroupBarrier();
  for (var k = 128u; k > 0u; k >>= 1u) { if (lid.x < k) { red[lid.x] += red[lid.x + k]; } workgroupBarrier(); }
  let inv = 1.0 / red[0];
  for (var i = lid.x; i < q.N; i += 256u) { X[base + i] = X[base + i] * inv; }
}`;
    // async creation rejects on shader compile errors, so a bad driver falls back to the CPU at start-up
    const mkp = (code) => device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const [pg, pe, ps, pn, pm] = await Promise.all([mkp(GEMM), mkp(ELEM), mkp(STATS), mkp(NORM), mkp(SOFTMAX)]);
    const P = { gemm: pg, elem: pe, stats: ps, norm: pn, softmax: pm };
    const UNI = 256, RING = 4096;
    const ubuf = device.createBuffer({ size: UNI * RING, usage: GPUBufferUsage.UNIFORM | CD });
    const ustage = new ArrayBuffer(UNI * RING); let uidx = 0;
    const passes = [], deferred = [];
    function flush() {
      if (passes.length) {
        device.queue.writeBuffer(ubuf, 0, ustage, 0, uidx * UNI);
        const enc = device.createCommandEncoder(), ps = enc.beginComputePass();
        for (const p of passes) { ps.setPipeline(p.pipe); ps.setBindGroup(0, p.bg); ps.dispatchWorkgroups(p.x, p.y); }
        ps.end(); device.queue.submit([enc.finish()]);
        passes.length = 0; uidx = 0;
      }
      for (const f of deferred.splice(0)) f();
    }
    function uni(words) {
      if (uidx >= RING) flush();
      const o = uidx * UNI, dv = new DataView(ustage, o, UNI);
      words.forEach((v, i) => { if (typeof v === 'object') dv.setFloat32(i * 4, v.f, true); else dv.setUint32(i * 4, v >>> 0, true); });
      uidx++; return { buffer: ubuf, offset: o, size: UNI };
    }
    function dispatch(pipe, bufs, x, y = 1) {
      const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: bufs.map((b, i) => ({ binding: i, resource: b.offset != null ? b : { buffer: b } })) });
      passes.push({ pipe, bg, x, y });
    }
    const grid = (n) => { const g = Math.ceil(n / 256); return g <= 65535 ? [g, 1] : [65535, Math.ceil(g / 65535)]; };
    const grid1 = (R) => (R <= 65535 ? [R, 1] : [65535, Math.ceil(R / 65535)]);
    const fl = (v) => ({ f: v });
    // buffer pool with geometric size classes (1/8 octave) so freed buffers are reused; bounded in size
    const pool = new Map(); let pooled = 0;
    const sizeClass = (b) => { if (b <= 4096) return 4096; const e = Math.floor(Math.log2(b)), step = 2 ** (e - 3); return Math.ceil(b / step) * step; };
    function alloc(shape) {
      const n = prod(shape), bytes = sizeClass(Math.max(256, n * 4));
      const list = pool.get(bytes);
      if (list && list.length) { pooled -= bytes; return { buf: list.pop(), bytes, shape }; }
      return { buf: device.createBuffer({ size: bytes, usage: S | CS | CD }), bytes, shape };
    }
    function free(t) {
      if (!t || !t.buf) return;
      if (pooled + t.bytes > 768 * 1048576) { deferred.push(() => t.buf.destroy()); return; }
      if (!pool.has(t.bytes)) pool.set(t.bytes, []); pool.get(t.bytes).push(t.buf); pooled += t.bytes;
    }
    const tmpFree = (t) => deferred.push(() => free(t));
    const bufOf = (r) => (r.f16 ? wbuf : r.t.buf);
    const elem = (op, n, X, Y, e = {}) => {
      const u = uni([op, n, e.a || 0, e.b || 0, e.c || 0, e.d || 0, e.e || 0, e.f || 0, 0, 0, fl(e.x0 || 0), fl(e.x1 || 0), e.woff || 0, 0, e.w2 || 0, 0]);
      const [gx, gy] = grid(n);
      dispatch(P.elem, [X ? X.buf : zA, Y ? Y.buf : zB, wbuf, u], gx, gy);
    };
    function stats(x, R, C, T, rstride, cstride) {
      const s = alloc([2 * Math.max(1, R)]);
      const [gx, gy] = grid1(R);
      dispatch(P.stats, [x.buf, s.buf, uni([R, C, T, rstride, cstride, 0, 0, 0])], gx, gy);
      return s;
    }
    function norm(mode, x, y, s, n, C, R, T, w, b) { const ip = x === y; const [gx, gy] = grid(n); dispatch(P.norm, [ip ? zA : x.buf, y.buf, s.buf, wbuf, uni([mode, n, C, R, T, w.o, b.o, ip ? 1 : 0])], gx, gy); tmpFree(s); }
    const self = {
      kind: 'gpu', info: adapter.info || {},
      begin() { device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation'); },
      async end() { flush(); const v = await device.popErrorScope(), o = await device.popErrorScope(); if (v || o) throw new Error('GPU ' + (v ? 'validation' : 'memory') + ' error: ' + (v || o).message); },
      alloc, free,
      weight(off, shape) { return { o: off, shape, f16: true }; },
      upload(t, data) { flush(); device.queue.writeBuffer(t.buf, 0, data.buffer, data.byteOffset, data.byteLength); },
      async read(t) {
        flush();
        const n = prod(t.shape), rb = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | CD });
        const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(t.buf, 0, rb, 0, n * 4); device.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
        if (lost) throw new Error('GPU device lost: ' + (lost.message || lost.reason));
        return out;
      },
      gemm(M, N, Kd, A, B, C, acc, alpha) {
        const aoff = A.f16 ? A.t.o + (A.off || 0) : (A.off || 0), boff = B.f16 ? B.t.o + (B.off || 0) : (B.off || 0);
        const u = uni([M, N, Kd, aoff, A.f16 ? 1 : 0, A.rs, A.cs, boff, B.f16 ? 1 : 0, B.rs, B.nb, B.s1, B.s2, C.off || 0, C.rs, C.nb, C.s1, C.s2, acc ? 1 : 0, fl(alpha)]);
        dispatch(P.gemm, [bufOf(A), bufOf(B), C.t.buf, u], Math.ceil(N / 64), Math.ceil(M / 64));
      },
      gelu(t, n) { elem(0, n, t, null); },
      glu(x, y, C, inner) { elem(1, C * inner, x, y, { a: inner, b: C }); },
      fillBias(y, b, C, inner) { elem(2, C * inner, null, y, { a: inner, woff: b ? b.o : 0, w2: b ? 1 : 0 }); },
      addBiasRows(y, b, N, C, boff = 0) { elem(3, N * C, null, y, { a: C, woff: b.o + boff }); },
      add(x, y, n) { elem(4, n, x, y); },
      addScaledCM(x, y, s, C, inner) { elem(5, C * inner, x, y, { a: inner, woff: s.o }); },
      addScaledTM(x, y, s, N, C) { elem(6, N * C, x, y, { a: C, woff: s.o }); },
      groupnormRows(x, C, R, L, w, b) { const s = stats(x, R, C, L, L, R * L); norm(0, x, x, s, C * R * L, C, R, L, w, b); },
      groupnormTM(x, N, C, w, b) { const s = stats(x, 1, 1, N * C, 0, 0); norm(1, x, x, s, N * C, C, 1, 1, w, b); },
      layernorm(x, y, N, C, w, b) { const s = stats(x, N, 1, C, C, 0); norm(2, x, y, s, N * C, C, N, 1, w, b); },
      softmax(x, R, N) { const [gx, gy] = grid1(R); dispatch(P.softmax, [x.buf, uni([R, N, 0, 0])], gx, gy); },
      transpose(x, y, R, Cc) { elem(9, R * Cc, x, y, { a: R, b: Cc }); },
      pad3(x, y, C, Fd, Td, pl, pr, ql, qr) { const F2 = Fd + pl + pr, T2 = Td + ql + qr; elem(10, C * F2 * T2, x, y, { a: Fd, b: Td, c: pl, d: ql, e: F2, f: T2 }); },
      sliceLast(x, y, C, L, off, n) { elem(11, C * n, x, y, { a: L, b: n, c: off }); },
      scaleShift(x, n, a, b) { elem(7, n, x, null, { x0: a, x1: b }); },
      copy(x, y, n) { elem(8, n, x, y); },
      permute3(x, y, A, Bn, C) { elem(12, A * Bn * C, x, y, { a: A, b: Bn, c: C }); },
      addTable(x, table, n) { const t = alloc([n]); self.upload(t, table); elem(4, n, x, t); tmpFree(t); },
      freqEmb(x, w, C, Fd, Td) { elem(13, C * Fd * Td, x, null, { a: C, b: Fd, c: Td, woff: w.o }); },
      destroy() { flush(); for (const l of pool.values()) for (const b of l) b.destroy(); wbuf.destroy(); ubuf.destroy(); device.destroy(); },
    };
    return self;
  }

  // =============================== the network ===============================
  async function create({ wasm, model, backend = 'cpu' }) {
    const { meta, dataOff } = parseModel(model);
    const be = backend === 'gpu' ? await gpuBackend(model, meta, dataOff) : await cpuBackend(wasm, model, meta, dataOff);
    const W = {};
    for (const [k, [off, shape]] of Object.entries(meta.tensors)) W[k] = be.weight(off / 2, shape);
    const w = (k) => { const t = W[k]; if (!t) throw new Error('missing weight ' + k); return t; };
    const T = (shape) => be.alloc(shape);
    const del = (...ts) => { for (const t of ts) if (t) be.free(t); };
    const size = (t) => prod(t.shape);
    const view = (t, shape) => ({ ...t, shape });
    const R = (t, off = 0) => ({ t, off });
    const WR = (t, off = 0) => ({ t, off, f16: true });

    function convRows(x, name, { stride = 1, pad = 0, dil = 1 } = {}) {
      const [Cin, Rr, Lx] = x.shape, wt = w(name + '.weight'), Cout = wt.shape[0], Kk = wt.shape[2] || 1;
      let xp = x, Lp = Lx;
      if (pad) { Lp = Lx + 2 * pad; xp = T([Cin, Rr, Lp]); be.pad3(x, xp, Cin, Rr, Lx, 0, 0, pad, pad); }
      const Lo = Math.floor((Lp - dil * (Kk - 1) - 1) / stride) + 1;
      const y = T([Cout, Rr, Lo]);
      be.fillBias(y, w(name + '.bias'), Cout, Rr * Lo);
      for (let k = 0; k < Kk; k++)
        be.gemm(Cout, Rr * Lo, Cin, { ...WR(wt, k), rs: Cin * Kk, cs: Kk }, { ...R(xp, k * dil), rs: Rr * Lp, nb: Lo, s1: Lp, s2: stride }, { ...R(y), rs: Rr * Lo, nb: Rr * Lo, s1: 0, s2: 1 }, true, 1);
      if (xp !== x) del(xp);
      return y;
    }
    function convFreq(x, name, s, pad) {
      const [Cin, Fd, Tt] = x.shape, wt = w(name + '.weight'), Cout = wt.shape[0], Kk = wt.shape[2];
      const Fp = Fd + 2 * pad, xp = T([Cin, Fp, Tt]); be.pad3(x, xp, Cin, Fd, Tt, pad, pad, 0, 0);
      const Fo = Math.floor((Fp - Kk) / s) + 1, y = T([Cout, Fo, Tt]);
      be.fillBias(y, w(name + '.bias'), Cout, Fo * Tt);
      for (let k = 0; k < Kk; k++)
        be.gemm(Cout, Fo * Tt, Cin, { ...WR(wt, k), rs: Cin * Kk, cs: Kk }, { ...R(xp, k * Tt), rs: Fp * Tt, nb: Tt, s1: s * Tt, s2: 1 }, { ...R(y), rs: Fo * Tt, nb: Fo * Tt, s1: 0, s2: 1 }, true, 1);
      del(xp); return y;
    }
    function conv33(x, name) {
      const [Cin, Fd, Tt] = x.shape, wt = w(name + '.weight'), Cout = wt.shape[0];
      const xp = T([Cin, Fd + 2, Tt + 2]); be.pad3(x, xp, Cin, Fd, Tt, 1, 1, 1, 1);
      const y = T([Cout, Fd, Tt]); be.fillBias(y, w(name + '.bias'), Cout, Fd * Tt);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
        be.gemm(Cout, Fd * Tt, Cin, { ...WR(wt, i * 3 + j), rs: Cin * 9, cs: 9 }, { ...R(xp, i * (Tt + 2) + j), rs: (Fd + 2) * (Tt + 2), nb: Tt, s1: Tt + 2, s2: 1 }, { ...R(y), rs: Fd * Tt, nb: Fd * Tt, s1: 0, s2: 1 }, true, 1);
      del(xp); return y;
    }
    function convTr(x, name, freq) {
      const wt = w(name + '.weight'), [Cin, Cout, Kk] = wt.shape;
      if (!freq) {
        const Lx = x.shape[x.shape.length - 1], Lo = (Lx - 1) * 4 + Kk, y = T([Cout, Lo]);
        be.fillBias(y, w(name + '.bias'), Cout, Lo);
        for (let k = 0; k < Kk; k++) be.gemm(Cout, Lx, Cin, { ...WR(wt, k), rs: Kk, cs: Cout * Kk }, { ...R(x), rs: Lx, nb: Lx, s1: 0, s2: 1 }, { ...R(y, k), rs: Lo, nb: Lx, s1: 0, s2: 4 }, true, 1);
        return y;
      }
      const [, Fd, Tt] = x.shape, Fo = (Fd - 1) * 4 + Kk, y = T([Cout, Fo, Tt]);
      be.fillBias(y, w(name + '.bias'), Cout, Fo * Tt);
      for (let k = 0; k < Kk; k++) be.gemm(Cout, Fd * Tt, Cin, { ...WR(wt, k), rs: Kk, cs: Cout * Kk }, { ...R(x), rs: Fd * Tt, nb: Fd * Tt, s1: 0, s2: 1 }, { ...R(y, k * Tt), rs: Fo * Tt, nb: Tt, s1: 4 * Tt, s2: 1 }, true, 1);
      return y;
    }
    function glu(x) { const [C2, ...r] = x.shape, inner = size(x) / C2, y = T([C2 / 2, ...r]); be.glu(x, y, C2 / 2, inner); del(x); return y; }
    const gelu = (x) => { be.gelu(x, size(x)); return x; };
    function dconv(x, p) {
      const [C, Rr, Lx] = x.shape;
      for (let d = 0; d < 2; d++) {
        const q = p + '.dconv.layers.' + d, dil = 1 << d;
        const y = convRows(x, q + '.0', { pad: dil, dil });
        be.groupnormRows(y, y.shape[0], Rr, Lx, w(q + '.1.weight'), w(q + '.1.bias')); gelu(y);
        const z = convRows(y, q + '.3'); del(y);
        be.groupnormRows(z, z.shape[0], Rr, Lx, w(q + '.4.weight'), w(q + '.4.bias'));
        const g = glu(z);
        be.addScaledCM(x, g, w(q + '.6.scale'), C, Rr * Lx); del(g);
      }
      return x;
    }
    function encT(x, i) {
      const p = 'tencoder.' + i; let [C, Lx] = x.shape, xin = x, padded = null;
      if (Lx % 4) { padded = T([C, Lx + 4 - Lx % 4]); be.pad3(x, padded, C, 1, Lx, 0, 0, 0, 4 - Lx % 4); xin = padded; Lx = padded.shape[1]; }
      const y = gelu(convRows(view(xin, [C, 1, Lx]), p + '.conv', { stride: 4, pad: 2 })); del(padded);
      dconv(y, p);
      const z = convRows(y, p + '.rewrite'); del(y);
      const o = glu(z); return view(o, [o.shape[0], o.shape[2]]);
    }
    function encF(x, i) {
      const p = 'encoder.' + i;
      const y = gelu(convFreq(x, p + '.conv', 4, 2));
      const [C, Fd, Tt] = y.shape;
      dconv(y, p);
      const z = convRows(view(y, [C, 1, Fd * Tt]), p + '.rewrite'); del(y);
      const o = glu(z); return view(o, [C, Fd, Tt]);
    }
    function decF(x, skip, i, last) {
      const p = 'decoder.' + i;
      be.add(x, skip, size(x)); del(skip);
      const y = glu(conv33(x, p + '.rewrite')); del(x);
      dconv(y, p);
      const z = convTr(y, p + '.conv_tr', true); del(y);
      const [C, Fo, Tt] = z.shape, o = T([C, Fo - 4, Tt]);
      be.sliceLast(z, o, C, Fo * Tt, 2 * Tt, (Fo - 4) * Tt); del(z);
      return last ? o : gelu(o);
    }
    function decT(x, skip, i, length, last) {
      const p = 'tdecoder.' + i, [C, Lx] = x.shape;
      be.add(x, skip, size(x)); del(skip);
      const y = glu(convRows(view(x, [C, 1, Lx]), p + '.rewrite', { pad: 1 })); del(x);
      dconv(y, p);
      const z = convTr(y, p + '.conv_tr', false); del(y);
      const Co = z.shape[0], Lz = z.shape[1], o = T([Co, length]);
      be.sliceLast(z, o, Co, Lz, 2, length); del(z);
      return last ? o : gelu(o);
    }
    function linear(x, wname, rowOff = 0, rows = null) {
      const [N, Cin] = x.shape, wt = w(wname), Cout = rows || wt.shape[0], y = T([N, Cout]);
      be.gemm(N, Cout, Cin, { ...R(x), rs: Cin, cs: 1 }, { ...WR(wt, rowOff * Cin), rs: 1, nb: Cout, s1: 0, s2: Cin }, { ...R(y), rs: Cout, nb: Cout, s1: 0, s2: 1 }, false, 1);
      return y;
    }
    function lin(x, name) { const y = linear(x, name + '.weight'); be.addBiasRows(y, w(name + '.bias'), x.shape[0], y.shape[1]); return y; }
    function layernorm(x, name) { const y = T(x.shape); be.layernorm(x, y, x.shape[0], x.shape[1], w(name + '.weight'), w(name + '.bias')); return y; }
    function mha(q, k, p) {
      const [Nq, C] = q.shape, Nk = k.shape[0], bi = w(p + '.in_proj_bias');
      const proj = (x, r0) => { const y = linear(x, p + '.in_proj_weight', r0, C); be.addBiasRows(y, bi, x.shape[0], C, r0); return y; };
      const Q = proj(q, 0), Kt = proj(k, C), V = proj(k, 2 * C);
      const H = 8, D = C / H, O = T([Nq, C]), Sm = T([Nq, Nk]);
      for (let h = 0; h < H; h++) {
        be.gemm(Nq, Nk, D, { ...R(Q, h * D), rs: C, cs: 1 }, { ...R(Kt, h * D), rs: 1, nb: Nk, s1: 0, s2: C }, { ...R(Sm), rs: Nk, nb: Nk, s1: 0, s2: 1 }, false, 1 / Math.sqrt(D));
        be.softmax(Sm, Nq, Nk);
        be.gemm(Nq, D, Nk, { ...R(Sm), rs: Nk, cs: 1 }, { ...R(V, h * D), rs: C, nb: D, s1: 0, s2: 1 }, { ...R(O, h * D), rs: C, nb: D, s1: 0, s2: 1 }, false, 1);
      }
      del(Sm, Q, Kt, V);
      const y = lin(O, p + '.out_proj'); del(O); return y;
    }
    function ffn(x, p) { const h = gelu(lin(x, p + '.linear1')); const y = lin(h, p + '.linear2'); del(h); return y; }
    function tlayer(x, p) {
      const n1 = layernorm(x, p + '.norm1'); const a = mha(n1, n1, p + '.self_attn'); del(n1);
      be.addScaledTM(x, a, w(p + '.gamma_1.scale'), x.shape[0], x.shape[1]); del(a);
      const n2 = layernorm(x, p + '.norm2'); const f = ffn(n2, p); del(n2);
      be.addScaledTM(x, f, w(p + '.gamma_2.scale'), x.shape[0], x.shape[1]); del(f);
      be.groupnormTM(x, x.shape[0], x.shape[1], w(p + '.norm_out.weight'), w(p + '.norm_out.bias'));
      return x;
    }
    function xlayer(q, k, p) {
      const n1 = layernorm(q, p + '.norm1'), n2 = layernorm(k, p + '.norm2'); const a = mha(n1, n2, p + '.cross_attn'); del(n1, n2);
      const x = T(q.shape); be.copy(q, x, size(q));
      be.addScaledTM(x, a, w(p + '.gamma_1.scale'), x.shape[0], x.shape[1]); del(a);
      const n3 = layernorm(x, p + '.norm3'); const f = ffn(n3, p); del(n3);
      be.addScaledTM(x, f, w(p + '.gamma_2.scale'), x.shape[0], x.shape[1]); del(f);
      be.groupnormTM(x, x.shape[0], x.shape[1], w(p + '.norm_out.weight'), w(p + '.norm_out.bias'));
      return x;
    }
    const posCache = {};
    function pos2d(C, Fr, T1) {
      const key = C + ':' + Fr + ':' + T1; if (posCache[key]) return posCache[key];
      const pe = new Float32Array(T1 * Fr * C), d = C / 2;
      for (let t = 0; t < T1; t++) for (let f = 0; f < Fr; f++) {
        const o = (t * Fr + f) * C;
        for (let i = 0; i < d / 2; i++) { const div = Math.exp(2 * i * -(Math.log(10000) / d)); pe[o + 2 * i] = Math.sin(t * div); pe[o + 2 * i + 1] = Math.cos(t * div); pe[o + d + 2 * i] = Math.sin(f * div); pe[o + d + 2 * i + 1] = Math.cos(f * div); }
      }
      return (posCache[key] = pe);
    }
    function pos1d(N, C) {
      const key = 't' + N + ':' + C; if (posCache[key]) return posCache[key];
      const pe = new Float32Array(N * C), half = C / 2;
      for (let n = 0; n < N; n++) for (let a = 0; a < half; a++) { const ph = n / Math.pow(10000, a / (half - 1)); pe[n * C + a] = Math.cos(ph); pe[n * C + half + a] = Math.sin(ph); }
      return (posCache[key] = pe);
    }
    function transformer(x, xt) {
      const [C, Fr, T1] = x.shape, T2 = xt.shape[1];
      const xs0 = T([Fr * T1, C]); be.transpose(x, xs0, C, Fr * T1);
      const xs1 = T([T1 * Fr, C]); be.permute3(xs0, xs1, Fr, T1, C); del(xs0);
      let xs = layernorm(xs1, 'crosstransformer.norm_in'); del(xs1);
      be.addTable(xs, pos2d(C, Fr, T1), T1 * Fr * C);
      const ts0 = T([T2, C]); be.transpose(xt, ts0, C, T2);
      let ts = layernorm(ts0, 'crosstransformer.norm_in_t'); del(ts0);
      be.addTable(ts, pos1d(T2, C), T2 * C);
      for (let i = 0; i < 5; i++) {
        const p = 'crosstransformer.layers.' + i, pt = 'crosstransformer.layers_t.' + i;
        if (i % 2 === 0) { tlayer(xs, p); tlayer(ts, pt); }
        else { const nx = xlayer(xs, ts, p), nt = xlayer(ts, xs, pt); del(xs, ts); xs = nx; ts = nt; }
      }
      const b0 = T([Fr * T1, C]); be.permute3(xs, b0, T1, Fr, C); del(xs);
      const xo = T([C, Fr, T1]); be.transpose(b0, xo, Fr * T1, C); del(b0);
      const to = T([C, T2]); be.transpose(ts, to, T2, C); del(ts);
      return [xo, to];
    }
    function pointwise(x, name) { const [C, ...r] = x.shape, inner = size(x) / C; const y = convRows(view(x, [C, 1, inner]), name); return view(y, [y.shape[0], ...r]); }

    // ---- STFT (torch.stft semantics: hann, normalized, centre + reflect padding) ----
    const hann = FFT.hann(NFFT);
    const reflect = (n, i) => { while (i < 0 || i >= n) { if (i < 0) i = -i; if (i >= n) i = 2 * (n - 1) - i; } return i; };
    function stftCaC(ch, le) {
      const pad = HOP / 2 * 3, o = new Float32Array(4 * 2048 * le);
      const re = new Float64Array(NFFT), im = new Float64Array(NFFT), sc = 1 / Math.sqrt(NFFT);
      for (let c = 0; c < 2; c++) {
        const x = ch[c], Lx = x.length;
        for (let fr = 0; fr < le; fr++) {
          const start = fr * HOP;
          for (let n = 0; n < NFFT; n++) { re[n] = x[reflect(Lx, start + n - pad)] * hann[n]; im[n] = 0; }
          FFT.transform(re, im, false);
          for (let f = 0; f < 2048; f++) { o[((2 * c) * 2048 + f) * le + fr] = re[f] * sc; o[((2 * c + 1) * 2048 + f) * le + fr] = im[f] * sc; }
        }
      }
      return o;
    }
    function istftAdd(a, s, c, le, Lx, dst) {
      const pad = HOP / 2 * 3, n = le + 4, total = NFFT + HOP * (n - 1);
      const y = new Float64Array(total), env = new Float64Array(total), re = new Float64Array(NFFT), im = new Float64Array(NFFT), sc = Math.sqrt(NFFT);
      const rb = (4 * s + 2 * c) * 2048 * le, ib = (4 * s + 2 * c + 1) * 2048 * le;
      for (let fr = 0; fr < n; fr++) {
        const t = fr - 2, o = fr * HOP;
        if (t >= 0 && t < le) {
          for (let f = 0; f < 2048; f++) { re[f] = a[rb + f * le + t] * sc; im[f] = a[ib + f * le + t] * sc; }
          re[2048] = 0; im[2048] = 0; im[0] = 0;
          for (let f = 1; f < 2048; f++) { re[NFFT - f] = re[f]; im[NFFT - f] = -im[f]; }
          FFT.transform(re, im, true);
          for (let i = 0; i < NFFT; i++) y[o + i] += re[i] * hann[i];
        }
        for (let i = 0; i < NFFT; i++) env[o + i] += hann[i] * hann[i];
      }
      for (let i = 0; i < Lx; i++) { const j = NFFT / 2 + pad + i, e = env[j]; dst[i] += e > 1e-11 ? y[j] / e : 0; }
    }

    // ---- one segment: (2 x SEG) normalised mix → [4 sources][2 channels] ----
    async function segment(Lc, Rc) {
      const len = Lc.length, le = Math.ceil(len / HOP);
      const zv = stftCaC([Lc, Rc], le);
      let s = 0; for (let i = 0; i < zv.length; i++) s += zv[i];
      const mean = s / zv.length; let v = 0; for (let i = 0; i < zv.length; i++) { const d = zv[i] - mean; v += d * d; }
      const std = Math.sqrt(v / (zv.length - 1));
      for (let i = 0; i < zv.length; i++) zv[i] = (zv[i] - mean) / (1e-5 + std);
      let st = 0; for (let i = 0; i < len; i++) st += Lc[i] + Rc[i];
      const meant = st / (2 * len); let vt = 0; for (let i = 0; i < len; i++) vt += (Lc[i] - meant) ** 2 + (Rc[i] - meant) ** 2;
      const stdt = Math.sqrt(vt / (2 * len - 1));
      const xtv = new Float32Array(2 * len); { const k = 1 / (1e-5 + stdt); for (let i = 0; i < len; i++) { xtv[i] = (Lc[i] - meant) * k; xtv[len + i] = (Rc[i] - meant) * k; } }
      if (be.begin) be.begin();
      let x = T([4, 2048, le]); be.upload(x, zv);
      let xt = T([2, len]); be.upload(xt, xtv);
      const saved = [], savedT = [], lensT = [];
      for (let i = 0; i < 4; i++) {
        lensT.push(xt.shape[1]);
        const nt = encT(xt, i); if (i === 0) del(xt); xt = nt; savedT.push(xt);
        const nx = encF(x, i); if (i === 0) del(x); x = nx;
        if (i === 0) be.freqEmb(x, w('freq_emb.embedding.weight'), x.shape[0], x.shape[1], x.shape[2]);
        saved.push(x);
      }
      const xu = pointwise(x, 'channel_upsampler'), tu = pointwise(xt, 'channel_upsampler_t');
      const [xo, to] = transformer(xu, tu); del(xu, tu);
      x = pointwise(xo, 'channel_downsampler'); del(xo);
      xt = pointwise(to, 'channel_downsampler_t'); del(to);
      for (let i = 0; i < 4; i++) {
        x = decF(x, saved.pop(), i, i === 3);
        xt = decT(xt, savedT.pop(), i, lensT.pop(), i === 3);
      }
      be.scaleShift(x, size(x), std, mean);
      be.scaleShift(xt, size(xt), stdt, meant);
      if (be.end) await be.end();
      const xa = await be.read(x), ta = await be.read(xt);
      del(x, xt);
      for (let i = 0; i < ta.length; i += 997) if (!Number.isFinite(ta[i])) throw new Error('the network produced invalid numbers');
      for (let i = 0; i < xa.length; i += 997) if (!Number.isFinite(xa[i])) throw new Error('the network produced invalid numbers');
      const out = [];
      for (let s2 = 0; s2 < 4; s2++) {
        const pair = [];
        for (let c = 0; c < 2; c++) { const d = ta.slice((s2 * 2 + c) * len, (s2 * 2 + c + 1) * len); istftAdd(xa, s2, c, le, len, d); pair.push(d); }
        out.push(pair);
      }
      return out;
    }
    return { segment, SEG, meta, backend: be.kind, info: be.info || null, memBytes: be.memBytes || (() => 0), destroy: () => be.destroy && be.destroy() };
  }
  return { create, SEG };
})();
