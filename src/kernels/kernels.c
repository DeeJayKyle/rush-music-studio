// Rush stems engine: CPU kernels for neural source separation (WebAssembly SIMD128).
// Original code, MIT licence. Built with: clang --target=wasm32 -O3 -msimd128 -nostdlib
#include <wasm_simd128.h>
#include <stdint.h>

#define EXPORT __attribute__((visibility("default")))
#ifdef RELAXED
#define MADD(c, a, b) wasm_f32x4_relaxed_madd(a, b, c)
#else
#define MADD(c, a, b) wasm_f32x4_add(c, wasm_f32x4_mul(a, b))
#endif

void *memset(void *d, int c, unsigned long n) { unsigned char *p = d; while (n--) *p++ = (unsigned char)c; return d; }
void *memcpy(void *d, const void *s, unsigned long n) { unsigned char *p = d; const unsigned char *q = s; while (n--) *p++ = *q++; return d; }

static inline float h2f(uint16_t h) {
  uint32_t s = (uint32_t)(h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff, r;
  if (e == 0) {
    if (m == 0) r = s;
    else { e = 127 - 15 + 1; while (!(m & 0x400)) { m <<= 1; e--; } m &= 0x3ff; r = s | (e << 23) | (m << 13); }
  } else if (e == 31) r = s | 0x7f800000 | (m << 13);
  else r = s | ((e + 127 - 15) << 23) | (m << 13);
  union { uint32_t u; float f; } v; v.u = r; return v.f;
}
static inline float fast_exp(float x) {
  if (x < -87.f) return 0.f; if (x > 88.f) x = 88.f;
  float t = x * 1.4426950408889634f; float fi = __builtin_floorf(t); float f = t - fi;
  float p = 1.f + f * (0.6931471806f + f * (0.2402265070f + f * (0.0555041087f + f * (0.0096181291f + f * (0.0013333558f + f * 0.0001540353f)))));
  union { uint32_t u; float f; } v; v.u = (uint32_t)((int32_t)fi + 127) << 23; return p * v.f;
}
static inline v128_t exp4(v128_t x) {
  x = wasm_f32x4_max(wasm_f32x4_min(x, wasm_f32x4_splat(88.f)), wasm_f32x4_splat(-87.f));
  v128_t t = wasm_f32x4_mul(x, wasm_f32x4_splat(1.4426950408889634f));
  v128_t fi = wasm_f32x4_floor(t), f = wasm_f32x4_sub(t, fi);
  v128_t p = wasm_f32x4_splat(0.0001540353f);
  p = wasm_f32x4_add(wasm_f32x4_mul(p, f), wasm_f32x4_splat(0.0013333558f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, f), wasm_f32x4_splat(0.0096181291f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, f), wasm_f32x4_splat(0.0555041087f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, f), wasm_f32x4_splat(0.2402265070f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, f), wasm_f32x4_splat(0.6931471806f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, f), wasm_f32x4_splat(1.f));
  v128_t e = wasm_i32x4_shl(wasm_i32x4_add(wasm_i32x4_trunc_sat_f32x4(fi), wasm_i32x4_splat(127)), 23);
  return wasm_f32x4_mul(p, e);
}
static inline float erf_(float x) {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  float s = x < 0 ? -1.f : 1.f; x = x < 0 ? -x : x;
  float t = 1.f / (1.f + 0.3275911f * x);
  float y = 1.f - (((((1.061405429f * t - 1.453152027f) * t) + 1.421413741f) * t - 0.284496736f) * t + 0.254829592f) * t * fast_exp(-x * x);
  return s * y;
}

// ---------------------------------------------------------------------------------
// Generic packed GEMM: C (+)= A[M,K] * B[K,N]
//  A element (m,k) at a + m*ars + k*acs              (f32 or f16)
//  B element (k,n) at b + k*brs + (n/bnb)*bs1 + (n%bnb)*bs2   (f32 or f16)
//  C element (m,n) at c + m*crs + (n/cnb)*cs1 + (n%cnb)*cs2   (accumulates when acc != 0)
// ---------------------------------------------------------------------------------
#define MR 4
#define NR 16
#define KC 256
#define MC 4096
#define NC 1024
static float *Apack, *Bpack;
static int *colB, *colC;
// scratch: (MC*KC + KC*NC) floats + 2*NC ints, 16-byte aligned, provided by the host
EXPORT int scratch_bytes(void) { return (MC * KC + KC * NC) * 4 + 2 * NC * 4; }
EXPORT void set_scratch(char *p) { Apack = (float *)p; Bpack = Apack + MC * KC; colB = (int *)(Bpack + KC * NC); colC = colB + NC; }

// exact fp16 -> fp32 for 4 lanes (finite values incl. subnormals): magic-number scaling
static inline v128_t h2f4(v128_t h32) {
  v128_t sign = wasm_i32x4_shl(wasm_v128_and(h32, wasm_i32x4_splat(0x8000)), 16);
  v128_t mag = wasm_i32x4_shl(wasm_v128_and(h32, wasm_i32x4_splat(0x7fff)), 13);
  v128_t f = wasm_f32x4_mul(mag, wasm_f32x4_splat(5.192296858534828e33f));   // 2^112
  return wasm_v128_or(f, sign);
}
static void packA(const void *a, int f16, int ars, int acs, int m0, int mc, int k0, int kc) {
  float *dst = Apack;
  for (int i = 0; i < mc; i += MR) {
    int rows = mc - i < MR ? mc - i : MR;
    if (f16 && acs == 1 && rows == MR) {
      const uint16_t *r0 = (const uint16_t *)a + (long)(m0 + i) * ars + k0, *r1 = r0 + ars, *r2 = r1 + ars, *r3 = r2 + ars;
      int k = 0;
      for (; k + 4 <= kc; k += 4) {
        // load 4 halves from each row, convert, transpose 4x4 into k-major order
        v128_t a0 = h2f4(wasm_u32x4_load16x4(r0 + k)), a1 = h2f4(wasm_u32x4_load16x4(r1 + k)), a2 = h2f4(wasm_u32x4_load16x4(r2 + k)), a3 = h2f4(wasm_u32x4_load16x4(r3 + k));
        v128_t t0 = wasm_i32x4_shuffle(a0, a1, 0, 4, 1, 5), t1 = wasm_i32x4_shuffle(a2, a3, 0, 4, 1, 5), t2 = wasm_i32x4_shuffle(a0, a1, 2, 6, 3, 7), t3 = wasm_i32x4_shuffle(a2, a3, 2, 6, 3, 7);
        wasm_v128_store(dst, wasm_i32x4_shuffle(t0, t1, 0, 1, 4, 5)); wasm_v128_store(dst + 4, wasm_i32x4_shuffle(t0, t1, 2, 3, 6, 7));
        wasm_v128_store(dst + 8, wasm_i32x4_shuffle(t2, t3, 0, 1, 4, 5)); wasm_v128_store(dst + 12, wasm_i32x4_shuffle(t2, t3, 2, 3, 6, 7));
        dst += 16;
      }
      for (; k < kc; k++) { dst[0] = h2f(r0[k]); dst[1] = h2f(r1[k]); dst[2] = h2f(r2[k]); dst[3] = h2f(r3[k]); dst += 4; }
      continue;
    }
    for (int k = 0; k < kc; k++) {
      for (int r = 0; r < MR; r++) {
        int m = i + r;
        float v = 0.f;
        if (m < mc) {
          long idx = (long)(m0 + m) * ars + (long)(k0 + k) * acs;
          v = f16 ? h2f(((const uint16_t *)a)[idx]) : ((const float *)a)[idx];
        }
        *dst++ = v;
      }
    }
  }
}
static void packB(const void *b, int f16, int brs, int k0, int kc, int nc) {
  float *dst = Bpack;
  for (int j = 0; j < nc; j += NR) {
    int w = nc - j < NR ? nc - j : NR;
    for (int k = 0; k < kc; k++) {
      long row = (long)(k0 + k) * brs;
      if (f16) {
        const uint16_t *bb = (const uint16_t *)b;
        int contiguous = w == NR && colB[j + NR - 1] - colB[j] == NR - 1;
        if (contiguous) { const uint16_t *s = bb + row + colB[j]; for (int q = 0; q < NR; q += 4) wasm_v128_store(dst + q, h2f4(wasm_u32x4_load16x4(s + q))); }
        else for (int q = 0; q < w; q++) dst[q] = h2f(bb[row + colB[j + q]]);
      } else {
        const float *bb = (const float *)b;
        int contiguous = w == NR && colB[j + NR - 1] - colB[j] == NR - 1;
        if (contiguous) { const float *s = bb + row + colB[j]; wasm_v128_store(dst, wasm_v128_load(s)); wasm_v128_store(dst + 4, wasm_v128_load(s + 4)); wasm_v128_store(dst + 8, wasm_v128_load(s + 8)); wasm_v128_store(dst + 12, wasm_v128_load(s + 12)); }
        else for (int q = 0; q < w; q++) dst[q] = bb[row + colB[j + q]];
      }
      for (int q = w; q < NR; q++) dst[q] = 0.f;
      dst += NR;
    }
  }
}
static inline void micro(int kc, const float *ap, const float *bp, float *cbuf) {
  v128_t c00 = wasm_f32x4_splat(0), c01 = c00, c02 = c00, c03 = c00, c10 = c00, c11 = c00, c12 = c00, c13 = c00;
  v128_t c20 = c00, c21 = c00, c22 = c00, c23 = c00, c30 = c00, c31 = c00, c32 = c00, c33 = c00;
  for (int k = 0; k < kc; k++) {
    v128_t b0 = wasm_v128_load(bp), b1 = wasm_v128_load(bp + 4), b2 = wasm_v128_load(bp + 8), b3 = wasm_v128_load(bp + 12);
    v128_t a0 = wasm_f32x4_splat(ap[0]), a1 = wasm_f32x4_splat(ap[1]), a2 = wasm_f32x4_splat(ap[2]), a3 = wasm_f32x4_splat(ap[3]);
    c00 = MADD(c00, a0, b0); c01 = MADD(c01, a0, b1); c02 = MADD(c02, a0, b2); c03 = MADD(c03, a0, b3);
    c10 = MADD(c10, a1, b0); c11 = MADD(c11, a1, b1); c12 = MADD(c12, a1, b2); c13 = MADD(c13, a1, b3);
    c20 = MADD(c20, a2, b0); c21 = MADD(c21, a2, b1); c22 = MADD(c22, a2, b2); c23 = MADD(c23, a2, b3);
    c30 = MADD(c30, a3, b0); c31 = MADD(c31, a3, b1); c32 = MADD(c32, a3, b2); c33 = MADD(c33, a3, b3);
    ap += MR; bp += NR;
  }
  wasm_v128_store(cbuf, c00); wasm_v128_store(cbuf + 4, c01); wasm_v128_store(cbuf + 8, c02); wasm_v128_store(cbuf + 12, c03);
  wasm_v128_store(cbuf + 16, c10); wasm_v128_store(cbuf + 20, c11); wasm_v128_store(cbuf + 24, c12); wasm_v128_store(cbuf + 28, c13);
  wasm_v128_store(cbuf + 32, c20); wasm_v128_store(cbuf + 36, c21); wasm_v128_store(cbuf + 40, c22); wasm_v128_store(cbuf + 44, c23);
  wasm_v128_store(cbuf + 48, c30); wasm_v128_store(cbuf + 52, c31); wasm_v128_store(cbuf + 56, c32); wasm_v128_store(cbuf + 60, c33);
}

EXPORT void gemm(int M, int N, int K,
                 const void *a, int af16, int ars, int acs,
                 const void *b, int bf16, int brs, int bnb, int bs1, int bs2,
                 float *c, int crs, int cnb, int cs1, int cs2, int acc, float alpha) {
  float cbuf[MR * NR] __attribute__((aligned(16)));
  if (!acc) {
    if (cs2 == 1 && cnb >= N) { for (int m = 0; m < M; m++) { float *r = c + (long)m * crs; for (int n = 0; n < N; n++) r[n] = 0.f; } }
    else for (int m = 0; m < M; m++) for (int n = 0; n < N; n++) c[(long)m * crs + (long)(n / cnb) * cs1 + (long)(n % cnb) * cs2] = 0.f;
  }
  for (int ic = 0; ic < M; ic += MC) {
    int mc = M - ic < MC ? M - ic : MC;
  for (int pc = 0; pc < K; pc += KC) {
    int kc = K - pc < KC ? K - pc : KC;
    packA(a, af16, ars, acs, ic, mc, pc, kc);
    for (int jc = 0; jc < N; jc += NC) {
      int nc = N - jc < NC ? N - jc : NC;
      for (int q = 0; q < nc; q++) { int n = jc + q; colB[q] = (n / bnb) * bs1 + (n % bnb) * bs2; colC[q] = (n / cnb) * cs1 + (n % cnb) * cs2; }
      packB(b, bf16, brs, pc, kc, nc);
      {
        for (int ib = 0; ib < mc; ib += 64)
        for (int jr = 0; jr < nc; jr += NR) {
          int nr = nc - jr < NR ? nc - jr : NR;
          int ie = ib + 64 < mc ? ib + 64 : mc;
          for (int ir = ib; ir < ie; ir += MR) {
            int mr = mc - ir < MR ? mc - ir : MR;
            micro(kc, Apack + ir * kc, Bpack + jr * kc, cbuf);
            for (int r = 0; r < mr; r++) {
              float *crow = c + (long)(ic + ir + r) * crs;
              const float *src = cbuf + r * NR;
              if (nr == NR && colC[jr + NR - 1] - colC[jr] == NR - 1) {
                float *d = crow + colC[jr];
                v128_t al = wasm_f32x4_splat(alpha);
                for (int q = 0; q < NR; q += 4) wasm_v128_store(d + q, wasm_f32x4_add(wasm_v128_load(d + q), wasm_f32x4_mul(al, wasm_v128_load(src + q))));
              } else for (int q = 0; q < nr; q++) crow[colC[jr + q]] += alpha * src[q];
            }
          }
        }
      }
    }
  }
  }
}

// ---------------------------------------------------------------------------------
// element-wise and normalisation kernels
// ---------------------------------------------------------------------------------
static inline v128_t erf4(v128_t x) {
  v128_t sgn = wasm_v128_and(x, wasm_i32x4_splat(0x80000000)); v128_t ax = wasm_f32x4_abs(x);
  v128_t t = wasm_f32x4_div(wasm_f32x4_splat(1.f), wasm_f32x4_add(wasm_f32x4_splat(1.f), wasm_f32x4_mul(wasm_f32x4_splat(0.3275911f), ax)));
  v128_t p = wasm_f32x4_splat(1.061405429f);
  p = wasm_f32x4_add(wasm_f32x4_mul(p, t), wasm_f32x4_splat(-1.453152027f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, t), wasm_f32x4_splat(1.421413741f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, t), wasm_f32x4_splat(-0.284496736f));
  p = wasm_f32x4_add(wasm_f32x4_mul(p, t), wasm_f32x4_splat(0.254829592f));
  p = wasm_f32x4_mul(p, t);
  v128_t y = wasm_f32x4_sub(wasm_f32x4_splat(1.f), wasm_f32x4_mul(p, exp4(wasm_f32x4_neg(wasm_f32x4_mul(ax, ax)))));
  return wasm_v128_or(y, sgn);
}
EXPORT void gelu(float *x, int n) {
  int i = 0; v128_t h = wasm_f32x4_splat(0.5f), r2 = wasm_f32x4_splat(0.70710678118654752f), one = wasm_f32x4_splat(1.f);
  for (; i + 4 <= n; i += 4) { v128_t v = wasm_v128_load(x + i); wasm_v128_store(x + i, wasm_f32x4_mul(wasm_f32x4_mul(h, v), wasm_f32x4_add(one, erf4(wasm_f32x4_mul(v, r2))))); }
  for (; i < n; i++) { float v = x[i]; x[i] = 0.5f * v * (1.f + erf_(v * 0.70710678118654752f)); }
}
// y[c, i] = x[c, i] * sigmoid(x[c + C, i])   for c < C, i < inner
EXPORT void glu(const float *x, float *y, int C, int inner) {
  for (int c = 0; c < C; c++) {
    const float *a = x + (long)c * inner, *g = x + (long)(c + C) * inner; float *o = y + (long)c * inner;
    int i = 0; v128_t one = wasm_f32x4_splat(1.f);
    for (; i + 4 <= inner; i += 4) wasm_v128_store(o + i, wasm_f32x4_div(wasm_v128_load(a + i), wasm_f32x4_add(one, exp4(wasm_f32x4_neg(wasm_v128_load(g + i))))));
    for (; i < inner; i++) o[i] = a[i] / (1.f + fast_exp(-g[i]));
  }
}
// bias broadcast: x[c, i] = b[c]  (f16 bias)
EXPORT void fill_bias(float *x, const uint16_t *b, int C, int inner) { for (int c = 0; c < C; c++) { float v = b ? h2f(b[c]) : 0.f; float *o = x + (long)c * inner; for (int i = 0; i < inner; i++) o[i] = v; } }
// bias per column for token-major (N, C) tensors
EXPORT void add_bias_rows(float *x, const uint16_t *b, int N, int C) { for (int n = 0; n < N; n++) { float *o = x + (long)n * C; for (int c = 0; c < C; c++) o[c] += h2f(b[c]); } }
EXPORT void add(float *x, const float *y, int n) { for (int i = 0; i < n; i++) x[i] += y[i]; }
// x[c, i] += s[c] * y[c, i]   (channel-major layer scale)
EXPORT void add_scaled_cm(float *x, const float *y, const uint16_t *s, int C, int inner) { for (int c = 0; c < C; c++) { float v = h2f(s[c]); float *o = x + (long)c * inner; const float *q = y + (long)c * inner; for (int i = 0; i < inner; i++) o[i] += v * q[i]; } }
// x[n, c] += s[c] * y[n, c]   (token-major layer scale)
EXPORT void add_scaled_tm(float *x, const float *y, const uint16_t *s, int N, int C) { for (int n = 0; n < N; n++) { float *o = x + (long)n * C; const float *q = y + (long)n * C; for (int c = 0; c < C; c++) o[c] += h2f(s[c]) * q[c]; } }
// GroupNorm(1) on blocks: tensor laid out (C, R, T); stats over (C, T) for each r (R=1 for whole tensor)
EXPORT void groupnorm_rows(float *x, int C, int R, int T, const uint16_t *w, const uint16_t *b) {
  for (int r = 0; r < R; r++) {
    double s = 0, s2 = 0;
    for (int c = 0; c < C; c++) { const float *p = x + ((long)c * R + r) * T; for (int t = 0; t < T; t++) { s += p[t]; s2 += (double)p[t] * p[t]; } }
    double n = (double)C * T, mean = s / n, var = s2 / n - mean * mean; if (var < 0) var = 0;
    float inv = 1.f / __builtin_sqrtf((float)var + 1e-5f), mu = (float)mean;
    for (int c = 0; c < C; c++) { float g = h2f(w[c]) * inv, bb = h2f(b[c]); float *p = x + ((long)c * R + r) * T; for (int t = 0; t < T; t++) p[t] = (p[t] - mu) * g + bb; }
  }
}
// GroupNorm(1) on token-major (N, C)
EXPORT void groupnorm_tm(float *x, int N, int C, const uint16_t *w, const uint16_t *b) {
  double s = 0, s2 = 0; long n = (long)N * C;
  for (long i = 0; i < n; i++) { s += x[i]; s2 += (double)x[i] * x[i]; }
  double mean = s / n, var = s2 / n - mean * mean; if (var < 0) var = 0;
  float inv = 1.f / __builtin_sqrtf((float)var + 1e-5f), mu = (float)mean;
  for (int t = 0; t < N; t++) { float *p = x + (long)t * C; for (int c = 0; c < C; c++) p[c] = (p[c] - mu) * inv * h2f(w[c]) + h2f(b[c]); }
}
// LayerNorm over C for (N, C), out may alias
EXPORT void layernorm(const float *x, float *y, int N, int C, const uint16_t *w, const uint16_t *b) {
  for (int t = 0; t < N; t++) {
    const float *p = x + (long)t * C; float *o = y + (long)t * C; float s = 0, s2 = 0;
    for (int c = 0; c < C; c++) s += p[c];
    float mu = s / C; for (int c = 0; c < C; c++) { float d = p[c] - mu; s2 += d * d; }
    float inv = 1.f / __builtin_sqrtf(s2 / C + 1e-5f);
    for (int c = 0; c < C; c++) o[c] = (p[c] - mu) * inv * h2f(w[c]) + h2f(b[c]);
  }
}
// row softmax in place
EXPORT void softmax_rows(float *x, int R, int N) {
  for (int r = 0; r < R; r++) {
    float *p = x + (long)r * N, m = p[0];
    { v128_t vm = wasm_f32x4_splat(p[0]); int i = 0; for (; i + 4 <= N; i += 4) vm = wasm_f32x4_max(vm, wasm_v128_load(p + i)); m = wasm_f32x4_extract_lane(vm, 0); for (int q = 1; q < 4; q++) { float v = q == 1 ? wasm_f32x4_extract_lane(vm, 1) : q == 2 ? wasm_f32x4_extract_lane(vm, 2) : wasm_f32x4_extract_lane(vm, 3); if (v > m) m = v; } for (; i < N; i++) if (p[i] > m) m = p[i]; }
    v128_t vm = wasm_f32x4_splat(m), vs = wasm_f32x4_splat(0); int i = 0;
    for (; i + 4 <= N; i += 4) { v128_t e = exp4(wasm_f32x4_sub(wasm_v128_load(p + i), vm)); wasm_v128_store(p + i, e); vs = wasm_f32x4_add(vs, e); }
    float s = wasm_f32x4_extract_lane(vs, 0) + wasm_f32x4_extract_lane(vs, 1) + wasm_f32x4_extract_lane(vs, 2) + wasm_f32x4_extract_lane(vs, 3);
    for (; i < N; i++) { float e = fast_exp(p[i] - m); p[i] = e; s += e; }
    float inv = 1.f / s; v128_t vi = wasm_f32x4_splat(inv); i = 0;
    // flush negligible probabilities to zero: denormals would make the next GEMM crawl
    v128_t tiny = wasm_f32x4_splat(1e-20f);
    for (; i + 4 <= N; i += 4) { v128_t v = wasm_f32x4_mul(wasm_v128_load(p + i), vi); wasm_v128_store(p + i, wasm_v128_and(v, wasm_f32x4_gt(v, tiny))); }
    for (; i < N; i++) { float v = p[i] * inv; p[i] = v > 1e-20f ? v : 0.f; }
  }
}
// transpose (R, Cc) -> (Cc, R)
EXPORT void transpose(const float *x, float *y, int R, int Cc) {
  for (int r0 = 0; r0 < R; r0 += 32) for (int c0 = 0; c0 < Cc; c0 += 32) {
    int r1 = r0 + 32 < R ? r0 + 32 : R, c1 = c0 + 32 < Cc ? c0 + 32 : Cc;
    for (int r = r0; r < r1; r++) for (int c = c0; c < c1; c++) y[(long)c * R + r] = x[(long)r * Cc + c];
  }
}
// zero-pad along the middle axis: x (C, F, T) -> y (C, F + pl + pr, T + ql + qr)
EXPORT void pad3(const float *x, float *y, int C, int F, int T, int pl, int pr, int ql, int qr) {
  int F2 = F + pl + pr, T2 = T + ql + qr;
  for (int c = 0; c < C; c++) for (int f = 0; f < F2; f++) {
    float *o = y + ((long)c * F2 + f) * T2; int fs = f - pl;
    if (fs < 0 || fs >= F) { for (int t = 0; t < T2; t++) o[t] = 0; continue; }
    const float *s = x + ((long)c * F + fs) * T;
    for (int t = 0; t < ql; t++) o[t] = 0;
    for (int t = 0; t < T; t++) o[ql + t] = s[t];
    for (int t = 0; t < qr; t++) o[ql + T + t] = 0;
  }
}
// copy a channel-major slice with offset/length along the last axis: y[c, i] = x[c, off + i]
EXPORT void slice_last(const float *x, float *y, int C, int L, int off, int n) { for (int c = 0; c < C; c++) { const float *s = x + (long)c * L + off; float *o = y + (long)c * n; for (int i = 0; i < n; i++) o[i] = s[i]; } }
// add per-channel bias (f16) to (C, inner)
EXPORT void add_bias_cm(float *x, const uint16_t *b, int C, int inner) { for (int c = 0; c < C; c++) { float v = h2f(b[c]); float *o = x + (long)c * inner; for (int i = 0; i < inner; i++) o[i] += v; } }
EXPORT void scale_shift(float *x, int n, float a, float b) { for (int i = 0; i < n; i++) x[i] = x[i] * a + b; }
EXPORT float h2f_export(int h) { return h2f((uint16_t)h); }
