// MP3 encoder worker (runs the unmodified LAME/lamejs library, LGPL — see vendor/LAMEJS-LICENSE.txt)
// message: { id, ch:[Float32Array...], sr, kbps, meta } → { id, ok, result: ArrayBuffer (ID3v2.3 tag + MP3 frames) }
function id3(meta) {
  const frames = [], enc = (s) => { const u = [0xFF, 0xFE]; for (const c of s) { const k = c.charCodeAt(0); u.push(k & 255, k >> 8); } return u; };
  const text = (id, v) => { if (!v) return; frames.push([id, [1, ...enc(String(v))]]); };
  text('TIT2', meta.title); text('TPE1', meta.artist); text('TALB', meta.album); text('TCON', meta.genre);
  text('TYER', meta.year); text('TCOP', meta.copyright); text('TBPM', meta.bpm ? String(Math.round(meta.bpm)) : '');
  text('TKEY', meta.key); text('TSSE', 'Rush Music Studio (LAME encoder)');
  if (meta.comments) frames.push(['COMM', [1, 0x65, 0x6e, 0x67, 0xFF, 0xFE, 0, 0, ...enc(meta.comments)]]);
  let size = 0; for (const [, d] of frames) size += 10 + d.length;
  const out = new Uint8Array(10 + size); out.set([0x49, 0x44, 0x33, 3, 0, 0], 0);
  out[6] = (size >> 21) & 127; out[7] = (size >> 14) & 127; out[8] = (size >> 7) & 127; out[9] = size & 127;
  let o = 10;
  for (const [id, d] of frames) {
    for (let i = 0; i < 4; i++) out[o + i] = id.charCodeAt(i);
    out[o + 4] = (d.length >>> 24) & 255; out[o + 5] = (d.length >>> 16) & 255; out[o + 6] = (d.length >>> 8) & 255; out[o + 7] = d.length & 255;
    o += 10; out.set(d, o); o += d.length;
  }
  return out;
}
self.onmessage = (ev) => {
  const m = ev.data;
  try {
    const nch = Math.min(2, m.ch.length), n = m.ch[0].length;
    const enc = new lamejs.Mp3Encoder(nch, m.sr, m.kbps || 320);
    // float → 16-bit with TPDF dither (the encoder's input is 16-bit)
    const toI16 = (x) => { const y = new Int16Array(x.length); for (let i = 0; i < x.length; i++) { let v = Math.round(x[i] * 32767 + Math.random() - Math.random()); y[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; } return y; };
    const L = toI16(m.ch[0]), R = nch > 1 ? toI16(m.ch[1]) : null;
    const parts = [id3(m.meta || {})], blk = 1152 * 16;
    let last = 0;
    for (let i = 0; i < n; i += blk) {
      const b = R ? enc.encodeBuffer(L.subarray(i, i + blk), R.subarray(i, i + blk)) : enc.encodeBuffer(L.subarray(i, i + blk));
      if (b.length) parts.push(new Uint8Array(b.buffer, b.byteOffset, b.length).slice());
      const p = Math.floor(i / n * 20); if (p !== last) { last = p; self.postMessage({ id: m.id, progress: i / n }); }
    }
    const f = enc.flush(); if (f.length) parts.push(new Uint8Array(f.buffer, f.byteOffset, f.length).slice());
    let len = 0; for (const p of parts) len += p.length;
    const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    self.postMessage({ id: m.id, ok: true, result: out.buffer }, [out.buffer]);
  } catch (e) { self.postMessage({ id: m.id, ok: false, error: String(e && e.message || e) }); }
};
