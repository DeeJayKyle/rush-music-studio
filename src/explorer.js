// ---------------------------------------------------------------------------
// Explorer — browse music folders on this computer, see file details
// (length, format, tempo, key), audition through the preview bus and add
// songs to the mix with a double-click, Enter or drag-and-drop.
// Uses the File System Access API (folders are remembered), with a folder
// upload fallback for browsers that do not have it.
// ---------------------------------------------------------------------------
const Explorer = (() => {
  const AUDIO = /\.(wav|wave|mp3|flac|ogg|oga|opus|m4a|aac|aif|aiff|webm|weba|mp4)$/i;
  const X = { roots: [], path: [], items: [], sel: -1, filter: '', cache: new Map(), info: new Map(), ready: false, playing: null, tok: 0 };
  // a node is { name, kind:'dir'|'file', handle?, file?, children? (fallback tree) }
  const nodeKey = (n) => X.path.map((p) => p.name).join('/') + '/' + n.name;

  async function loadRoots() {
    const saved = (await KV.get('explorerRoots')) || [];
    X.roots = saved.filter((r) => r && r.handle).map((r) => ({ name: r.name, kind: 'dir', handle: r.handle, root: true }));
  }
  const saveRoots = () => KV.set('explorerRoots', X.roots.filter((r) => r.handle).map((r) => ({ name: r.name, handle: r.handle })));

  async function addRoot() {
    if (window.showDirectoryPicker && !X.blocked) {
      try {
        const h = await window.showDirectoryPicker({ id: 'rush-music', mode: 'read' });
        if (!X.roots.some((r) => r.name === h.name)) X.roots.push({ name: h.name, kind: 'dir', handle: h, root: true });
        await saveRoots();
        await openPath([X.roots.find((r) => r.name === h.name)]);
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; X.blocked = true; }
    }
    $('#exFolderInput').click();
  }
  // fallback: a folder chosen through <input webkitdirectory> becomes an in-memory tree
  function fromFileList(files) {
    files = [...files].filter((f) => AUDIO.test(f.name));
    if (!files.length) { toast('No audio files found in that folder.', 'err'); return; }
    const rootName = (files[0].webkitRelativePath || files[0].name).split('/')[0] || 'Folder';
    const root = { name: rootName, kind: 'dir', children: [], root: true, mem: true };
    for (const f of files) {
      const parts = (f.webkitRelativePath || f.name).split('/').slice(1);
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) { let d = cur.children.find((c) => c.kind === 'dir' && c.name === parts[i]); if (!d) { d = { name: parts[i], kind: 'dir', children: [] }; cur.children.push(d); } cur = d; }
      cur.children.push({ name: parts[parts.length - 1] || f.name, kind: 'file', file: f });
    }
    X.roots = X.roots.filter((r) => r.name !== rootName); X.roots.push(root);
    openPath([root]);
  }

  async function listDir(n) {
    if (n.children) return n.children.slice();
    const h = n.handle, out = [];
    if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted') {
      if ((await h.requestPermission({ mode: 'read' })) !== 'granted') throw new Error('Permission to read ' + n.name + ' was not given.');
    }
    for await (const [name, ch] of h.entries()) {
      if (name.startsWith('.')) continue;
      if (ch.kind === 'directory') out.push({ name, kind: 'dir', handle: ch });
      else if (AUDIO.test(name)) out.push({ name, kind: 'file', handle: ch });
    }
    return out;
  }
  async function getFile(n) { return n.file || (n.file = await n.handle.getFile()); }

  async function openPath(path) {
    stop();
    X.path = path; X.sel = -1; X.filter = ''; $('#exFilter').value = '';
    if (!path.length) { X.items = X.roots.slice(); render(); return; }
    $('#exList').innerHTML = ''; $('#exList').append(el('div', { class: 'ex-empty' }, 'Reading folder…'));
    try {
      const items = await listDir(path[path.length - 1]);
      items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
      X.items = items;
    } catch (e) { X.items = []; toast(e.message || String(e), 'err'); }
    render();
    if (X.items.length) select(X.items.findIndex((i) => i.kind === 'file') >= 0 ? -1 : -1);
  }
  const up = () => { if (X.path.length) openPath(X.path.slice(0, -1)); };
  const visible = () => { const f = X.filter.toLowerCase(); return X.items.map((n, i) => [n, i]).filter(([n]) => !f || n.name.toLowerCase().includes(f)); };

  function render() {
    const crumbs = $('#exPath'); crumbs.innerHTML = '';
    crumbs.append(el('button', { class: 'crumb', onclick: () => openPath([]) }, 'Folders'));
    X.path.forEach((p, i) => crumbs.append(el('span', { class: 'sep' }, '›'), el('button', { class: 'crumb', onclick: () => openPath(X.path.slice(0, i + 1)) }, p.name)));
    $('#exUp').disabled = !X.path.length;
    const list = $('#exList'); list.innerHTML = '';
    const vis = visible();
    if (!X.path.length && !X.roots.length) {
      list.append(el('div', { class: 'ex-empty' }, el('p', {}, 'Add your music folders to browse, preview and drop songs straight into the mix.'), el('button', { class: 'btn primary sm', onclick: addRoot }, icon('plus'), 'Add a music folder')));
    } else if (!vis.length) list.append(el('div', { class: 'ex-empty' }, X.filter ? 'Nothing matches “' + X.filter + '”.' : 'No audio files in this folder.'));
    for (const [n, i] of vis) {
      const inf = X.info.get(nodeKey(n));
      const row = el('div', { class: 'ex-row ' + n.kind + (i === X.sel ? ' sel' : ''), role: 'option', 'aria-selected': String(i === X.sel), draggable: n.kind === 'file' ? 'true' : null, 'data-i': i, title: n.kind === 'file' ? 'Double-click or Enter to add to the mix · drag onto the timeline' : 'Open folder' },
        icon(n.kind === 'dir' ? 'folder' : 'wave'), el('span', { class: 'nm' }, n.name),
        n.root ? el('button', { class: 'icon-btn x', title: 'Remove from the Explorer', 'aria-label': 'Remove folder', onclick: (e) => { e.stopPropagation(); X.roots = X.roots.filter((r) => r !== n); saveRoots(); openPath([]); } }, icon('close')) :
          inf && inf.bpm ? el('span', { class: 'bpm' }, inf.bpm.toFixed(1)) : null);
      row.addEventListener('click', () => select(i, true));
      row.addEventListener('dblclick', () => activate(i));
      row.addEventListener('dragstart', (e) => { X.drag = n; e.dataTransfer.setData('text/x-rush-explorer', nodeKey(n)); e.dataTransfer.effectAllowed = 'copy'; });
      list.append(row);
    }
    renderInfo();
  }
  async function select(i, user) {
    X.sel = i;
    $$('#exList .ex-row').forEach((r) => { const on = +r.dataset.i === i; r.classList.toggle('sel', on); r.setAttribute('aria-selected', String(on)); if (on && !user) r.scrollIntoView({ block: 'nearest' }); });
    const n = X.items[i];
    stop();
    renderInfo();
    if (!n || n.kind !== 'file') return;
    const tok = ++X.tok;
    try {
      const buf = await decode(n);
      if (tok !== X.tok) return;
      renderInfo();
      if (PREF.previewAuto) play();
      analyze(n, buf, tok);
    } catch (e) { if (tok === X.tok) { X.info.set(nodeKey(n), { err: true }); renderInfo(); } }
  }
  async function decode(n) {
    const k = nodeKey(n);
    if (X.cache.has(k)) { const b = X.cache.get(k); X.cache.delete(k); X.cache.set(k, b); return b; }
    const f = await getFile(n);
    const info = X.info.get(k) || {}; info.size = f.size; info.type = (n.name.split('.').pop() || '').toUpperCase(); info.mod = f.lastModified;
    X.info.set(k, info);
    const ab = await f.arrayBuffer();
    info.srcRate = sniffRate(ab);
    const buf = await Engine.ensure(false).decodeAudioData(ab);
    info.dur = buf.duration; info.ch = buf.numberOfChannels; info.peaks = computePeaks(buf);
    X.cache.set(k, buf);
    while (X.cache.size > 6) X.cache.delete(X.cache.keys().next().value);   // keep memory in check
    return buf;
  }
  // original sample rate from WAV / FLAC headers (decoding resamples to the device rate)
  function sniffRate(ab) {
    try {
      const u = new Uint8Array(ab, 0, Math.min(ab.byteLength, 64)), dv = new DataView(ab);
      const tag = String.fromCharCode(u[0], u[1], u[2], u[3]);
      if (tag === 'RIFF') { let o = 12; while (o + 8 < ab.byteLength && o < 4096) { const id = String.fromCharCode(...new Uint8Array(ab, o, 4)), sz = dv.getUint32(o + 4, true); if (id === 'fmt ') return { sr: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) }; o += 8 + sz + (sz & 1); } }
      if (tag === 'fLaC') { const b = new Uint8Array(ab, 18, 4); return { sr: (b[0] << 12) | (b[1] << 4) | (b[2] >> 4), bits: (((b[3] >> 4) & 1) | ((b[2] & 1) << 4)) + 1 }; }
    } catch (e) { }
    return null;
  }
  async function analyze(n, buf, tok) {
    const k = nodeKey(n), info = X.info.get(k);
    if (!info || info.bpm || info.analyzing) return;
    info.analyzing = true;
    try {
      // the first 90 s are plenty for tempo and key and keep browsing snappy
      const len = Math.min(buf.length, buf.sampleRate * 90);
      const ch = bufferChannels(buf).map((c) => c.slice(0, len));
      const r = await Pool.run('analyze', { ch, sr: buf.sampleRate }, ch.map((c) => c.buffer));
      Object.assign(info, { bpm: r.bpm, key: r.key, isLoop: r.isLoop && buf.duration < 40, firstBeat: r.firstBeat || 0 });
    } catch (e) { }
    info.analyzing = false;
    if (tok === X.tok) renderInfo();
    const row = $('#exList .ex-row[data-i="' + X.items.indexOf(n) + '"]');
    if (row && info.bpm && !row.querySelector('.bpm')) row.append(el('span', { class: 'bpm' }, info.bpm.toFixed(1)));
  }
  function renderInfo() {
    const box = $('#exInfo'); box.innerHTML = '';
    const n = X.items[X.sel];
    if (!n || n.kind !== 'file') { box.hidden = true; return; }
    box.hidden = false;
    const inf = X.info.get(nodeKey(n)) || {};
    const kv = (k, v) => (v ? el('div', {}, el('span', {}, k), el('b', {}, v)) : null);
    const cv = el('canvas', { class: 'ex-wave', title: 'Click to preview from here' });
    cv.addEventListener('pointerdown', (e) => { const r = cv.getBoundingClientRect(); if (inf.dur) play(clamp((e.clientX - r.left) / r.width, 0, 1) * inf.dur); });
    box.append(el('div', { class: 'ex-name' }, n.name), cv,
      el('div', { class: 'ex-kv' },
        kv('Length', inf.dur ? fmtTime(inf.dur, 1) : inf.err ? 'cannot decode' : '…'),
        kv('Format', [inf.type, inf.srcRate ? (inf.srcRate.sr / 1000).toFixed(1) + ' kHz' : null, inf.srcRate && inf.srcRate.bits ? inf.srcRate.bits + '-bit' : null, inf.ch ? (inf.ch > 1 ? 'stereo' : 'mono') : null].filter(Boolean).join(' · ')),
        kv('Tempo', inf.bpm ? inf.bpm.toFixed(2) + ' BPM' : inf.analyzing ? 'analysing…' : ''),
        kv('Key', inf.key ? inf.key.name + ' · ' + inf.key.camelot : ''),
        kv('Size', inf.size ? (inf.size / 1048576).toFixed(1) + ' MB' : ''),
        kv('Modified', inf.mod ? new Date(inf.mod).toLocaleDateString() : '')),
      el('div', { class: 'ex-acts' },
        el('button', { class: 'btn sm primary', onclick: () => activate(X.sel), title: 'Enter' }, icon('plus'), 'Add to mix'),
        el('button', { class: 'btn sm', onclick: () => importOnly(n), title: 'Shift+Enter' }, 'Import'),
        el('button', { class: 'btn sm ghost', onclick: () => (X.playing ? stop() : play()), title: 'Space' }, X.playing ? 'Stop' : 'Preview')));
    requestAnimationFrame(drawWave);
  }
  function drawWave() {
    const cv = $('#exInfo .ex-wave'); if (!cv) return;
    const n = X.items[X.sel], inf = n && X.info.get(nodeKey(n));
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!inf || !inf.peaks) return;
    const pk = inf.peaks, ch = pk.chs ? pk.chs[0] : pk[0];
    const mn = ch.min || ch.mn || ch[0], mx = ch.max || ch.mx || ch[1];
    if (!mn || !mx) return;
    ctx.fillStyle = C.accent; ctx.globalAlpha = 0.85;
    const N = mn.length;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(x / w * N), b = Math.max(a + 1, Math.floor((x + 1) / w * N));
      let lo = 0, hi = 0; for (let i = a; i < b && i < N; i++) { if (mn[i] < lo) lo = mn[i]; if (mx[i] > hi) hi = mx[i]; }
      ctx.fillRect(x, h / 2 - hi * h / 2, 1, Math.max(1, (hi - lo) * h / 2));
    }
    ctx.globalAlpha = 1;
    const p = Engine.auditionPos();
    if (X.playing && p != null && inf.dur) { ctx.fillStyle = C.fg; ctx.fillRect(Math.round(p / inf.dur * w), 0, 1.5, h); }
  }
  function tick() { if (X.playing) { drawWave(); requestAnimationFrame(tick); } }
  async function play(at) {
    const n = X.items[X.sel]; if (!n || n.kind !== 'file') return;
    let buf; try { buf = await decode(n); } catch (e) { return; }
    const inf = X.info.get(nodeKey(n)) || {};
    // optional: audition at the project tempo (varispeed) so you can hear whether it fits
    const rate = PREF.previewSync && inf.bpm ? clamp(T.bpmAt(P.cursor) / inf.bpm, 0.5, 2) : 1;
    if (Engine.playing && PREF.previewAuto && at == null) { /* audition over the mix, cue-style */ }
    X.playing = Engine.audition(buf, { offset: at || 0, rate, onEnd: () => { X.playing = null; renderInfo(); } });
    renderInfo(); requestAnimationFrame(tick);
  }
  function stop() { if (X.playing) { X.playing = null; Engine.stopAudition(); } }

  async function toAsset(n) {
    const k = nodeKey(n);
    const existing = [...S.assets.values()].find((A) => A.srcKey === k);
    if (existing) return existing;
    status('Importing ' + n.name + '…');
    const buf = await decode(n);
    const inf = X.info.get(k) || {};
    const A = addAsset(n.name.replace(/\.[^.]+$/, ''), buf, inf.bpm && buf.duration <= 95 ? { bpm: inf.bpm, beats: buf.duration * inf.bpm / 60, isLoop: inf.isLoop, key: inf.key, downbeat: inf.isLoop ? 0 : inf.firstBeat } : {});
    A.srcKey = k;
    status('Ready');
    return A;
  }
  async function importOnly(n) { if (n && n.kind === 'file') { const A = await toAsset(n); toast('Imported ' + A.name, 'ok'); } }
  async function activate(i) {
    const n = X.items[i]; if (!n) return;
    if (n.kind === 'dir') { openPath([...X.path, n]); return; }
    stop();
    try { const A = await toAsset(n); setView('arrange'); await whenAnalyzed(A); Arrange.addToMix(A); }
    catch (e) { toast(n.name + ' could not be decoded.', 'err'); }
  }
  const whenAnalyzed = (A) => new Promise((res) => { if (!A.analyzing) return res(); const f = (x) => { if (x === A) res(); }; bus.on('assetMeta', f); setTimeout(res, 20000); });
  // called by the arrange view when an Explorer file is dropped on the timeline
  async function dropped(ti, beat) {
    const n = X.drag; X.drag = null; if (!n || n.kind !== 'file') return;
    try { const A = await toAsset(n); await whenAnalyzed(A); Arrange.placeAsset(A, ti, beat); } catch (e) { toast(n.name + ' could not be decoded.', 'err'); }
  }

  function key(e) {
    const vis = visible().map(([, i]) => i); if (!vis.length && e.key !== 'Backspace') return false;
    const pos = vis.indexOf(X.sel);
    if (e.key === 'ArrowDown') { select(vis[Math.min(vis.length - 1, pos + 1)] ?? vis[0]); return true; }
    if (e.key === 'ArrowUp') { select(vis[Math.max(0, pos - 1)] ?? vis[0]); return true; }
    if (e.key === 'Home') { select(vis[0]); return true; }
    if (e.key === 'End') { select(vis[vis.length - 1]); return true; }
    if (e.key === 'Enter') { const n = X.items[X.sel]; if (n && e.shiftKey) importOnly(n); else activate(X.sel); return true; }
    if (e.key === 'ArrowRight') { const n = X.items[X.sel]; if (n && n.kind === 'dir') activate(X.sel); else if (n) { const p = Engine.auditionPos(); play((p || 0) + 10); } return true; }
    if (e.key === 'ArrowLeft') { const n = X.items[X.sel]; if (X.playing && n && n.kind === 'file') { const p = Engine.auditionPos(); play(Math.max(0, (p || 0) - 10)); } else up(); return true; }
    if (e.key === 'Backspace') { up(); return true; }
    if (e.key === ' ') { X.playing ? stop() : play(); renderInfo(); return true; }
    return false;
  }

  async function init() {
    $('#exAdd').addEventListener('click', addRoot);
    $('#exUp').addEventListener('click', up);
    $('#exFolderInput').addEventListener('change', (e) => { const f = e.target.files; if (f && f.length) fromFileList(f); e.target.value = ''; });
    $('#exFilter').addEventListener('input', (e) => { X.filter = e.target.value; render(); });
    $('#exFilter').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); $('#exList').focus(); key(e); } if (e.key === 'Escape') { e.target.value = ''; X.filter = ''; render(); } });
    $('#exList').addEventListener('keydown', (e) => { if (key(e)) { e.preventDefault(); e.stopPropagation(); } });
    const vol = $('#exVol');
    vol.value = PREF.previewVol;
    vol.addEventListener('input', () => { PREF.previewVol = +vol.value; Engine.setPreviewVol(PREF.previewVol); vol.title = 'Preview volume ' + fmtDb(PREF.previewVol) + ' dB'; });
    vol.addEventListener('change', savePrefs);
    $('#exAuto').setAttribute('aria-pressed', String(PREF.previewAuto));
    $('#exAuto').addEventListener('click', () => { PREF.previewAuto = !PREF.previewAuto; savePrefs(); $('#exAuto').setAttribute('aria-pressed', String(PREF.previewAuto)); if (!PREF.previewAuto) stop(); });
    bus.on('prefs', () => { $('#exAuto').setAttribute('aria-pressed', String(PREF.previewAuto)); vol.value = PREF.previewVol; });
  }
  async function show() {
    if (!X.ready) { X.ready = true; await loadRoots(); if (!X.path.length) { X.items = X.roots.slice(); render(); } }
  }
  return { init, show, addRoot, dropped, stop, key, get playing() { return !!X.playing; } };
})();
