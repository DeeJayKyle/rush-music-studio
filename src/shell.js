// ---------------------------------------------------------------------------
// Studio shell (v1.3): preferences, project properties, real Save / Save As,
// recent projects, mastering export (WAV / MP3), Options and View menus.
// ---------------------------------------------------------------------------
const PREF = (() => {
  const D = {
    latency: 'interactive', sampleRate: 0, autosave: true,
    autoBeatmap: true, beatmapMin: 90, autoXfade: true, quickFade: true, ripple: false, snapOn: true, countIn: 1,
    previewAuto: true, previewVol: -6, previewSync: false,
    stemEngine: 'auto', aiOverlap: 0.25, aiDevice: 'auto',
    np: { bpm: 105, bpb: 4, artist: '', engineer: '', copyright: '', genre: '', remember: false },
    exp: { format: 'wav24', sr: 0, master: 'streaming', target: -14, ceiling: -1, dither: true, tail: true, dest: 'file' },
    showOverview: true, showMeters: true, showLibrary: true,
  };
  let v = {};
  try { v = JSON.parse(localStorage.getItem('rush.prefs') || '{}'); } catch (e) { }
  const merged = Object.assign({}, D, v);
  merged.np = Object.assign({}, D.np, v.np || {}); merged.exp = Object.assign({}, D.exp, v.exp || {});
  return merged;
})();
function savePrefs() { try { localStorage.setItem('rush.prefs', JSON.stringify(PREF)); } catch (e) { } bus.emit('prefs'); }

// ---- tiny IndexedDB key/value helper (shares the autosave database) ----------------
const KV = {
  async get(k) { try { const db = await Autosave.db(); return await new Promise((res) => { const r = db.transaction('kv', 'readonly').objectStore('kv').get(k); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); }); } catch (e) { return null; } },
  async set(k, v) { try { const db = await Autosave.db(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } },
};

// ---- recent projects + real file handles ---------------------------------------------
const Recent = {
  list: [],
  async load() { this.list = (await KV.get('recent')) || []; return this.list; },
  async add(name, handle) {
    await this.load();
    this.list = [{ name, handle: handle || null, when: Date.now(), title: P.name }, ...this.list.filter((r) => r.name !== name)].slice(0, 10);
    if (!(await KV.set('recent', this.list))) { this.list.forEach((r) => (r.handle = null)); await KV.set('recent', this.list); }
  },
  async clear() { this.list = []; await KV.set('recent', []); },
};
const FileIO = {
  handle: null,
  canPick: () => !!window.showSaveFilePicker && !FileIO.blocked,
  async save(as) {
    status('Saving project…');
    const blob = await Project.toBlob();
    let name = safeName(P.name) + '.rush';
    if (this.canPick()) {
      try {
        if (as || !this.handle) this.handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Rush project', accept: { 'application/x-rush-project': ['.rush'] } }] });
        if (this.handle.requestPermission && (await this.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to write the file was not given.');
        const w = await this.handle.createWritable(); await w.write(blob); await w.close();
        name = this.handle.name;
        await Recent.add(name, this.handle);
      } catch (e) {
        if (e && e.name === 'AbortError') { status('Save cancelled'); return false; }
        if (e && e.name === 'SecurityError') { this.blocked = true; return this.save(as); }
        toast('Could not save: ' + (e.message || e), 'err'); status('Save failed'); return false;
      }
    } else { downloadBlob(blob, name); await Recent.add(name, null); }
    S.dirty = false; $('#statusSave').textContent = 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    status('Saved ' + name + ' (' + (blob.size / 1048576).toFixed(1) + ' MB)');
    return true;
  },
  async open() {
    if (S.dirty && !(await confirmDialog('Open another project?', 'Unsaved changes in the current project will be lost.', 'Open', true))) return;
    if (window.showOpenFilePicker && !this.blocked) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'Rush project', accept: { 'application/x-rush-project': ['.rush'] } }] });
        await this.openHandle(h); return;
      } catch (e) { if (e && e.name === 'AbortError') return; this.blocked = true; }
    }
    $('#projInput').click();
  },
  async openHandle(h) {
    if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted' && (await h.requestPermission({ mode: 'read' })) !== 'granted') { toast('Permission to read ' + h.name + ' was not given.', 'err'); return; }
    const f = await h.getFile();
    await Project.load(f);
    this.handle = h; await Recent.add(h.name, h);
  },
  async openRecent(r) {
    if (!r.handle) { toast(r.name + ' was saved as a download. Use File › Open to pick it.', 'err'); return; }
    if (S.dirty && !(await confirmDialog('Open ' + r.name + '?', 'Unsaved changes in the current project will be lost.', 'Open', true))) return;
    try { await this.openHandle(r.handle); } catch (e) { toast('Could not open ' + r.name + ': ' + (e.message || e), 'err'); }
  },
};
Project.save = (as) => FileIO.save(as);

// ---- project properties / new project ------------------------------------------------
const META_FIELDS = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album / mixtape'], ['genre', 'Genre'], ['year', 'Year'], ['engineer', 'Engineer'], ['copyright', 'Copyright']];
async function projectProps(isNew) {
  const m = isNew ? { artist: PREF.np.artist, engineer: PREF.np.engineer, copyright: PREF.np.copyright, genre: PREF.np.genre, year: String(new Date().getFullYear()) } : (P.meta || {});
  const fields = [
    { type: 'header', label: 'Summary' },
    ...META_FIELDS.map(([id, label]) => ({ id, label, value: id === 'title' ? (isNew ? '' : m.title || P.name) : m[id] || '', placeholder: id === 'title' ? 'Untitled project' : '' })),
    { id: 'comments', label: 'Comments', type: 'textarea', value: m.comments || '', full: true },
    { type: 'header', label: 'Audio' },
    { id: 'bpm', label: 'Tempo (BPM)', type: 'number', value: isNew ? PREF.np.bpm : P.bpm, min: 20, max: 300, step: 0.01 },
    { id: 'bpb', label: 'Beats per bar', type: 'select', value: String(isNew ? PREF.np.bpb : P.bpb), options: ['2', '3', '4', '5', '6', '7'] },
    { id: 'sr', label: 'Render sample rate', type: 'select', value: String((isNew ? PREF.exp.sr : P.sr) || 0), options: SR_OPTS },
  ];
  if (isNew) fields.push({ id: 'remember', label: 'Start all new projects with these settings', type: 'check', value: PREF.np.remember, full: true });
  const r = await showDialog({ title: isNew ? 'New project' : 'Project properties', wide: true, ok: isNew ? 'Create' : 'Apply', fields, desc: isNew ? 'Information is written into exported WAV and MP3 files.' : null });
  if (!r) return null;
  const meta = {}; for (const [id] of META_FIELDS) meta[id] = (r[id] || '').trim(); meta.comments = (r.comments || '').trim();
  if (isNew) {
    if (r.remember) Object.assign(PREF.np, { bpm: +r.bpm || 105, bpb: +r.bpb, artist: meta.artist, engineer: meta.engineer, copyright: meta.copyright, genre: meta.genre, remember: true });
    else PREF.np.remember = false;
    savePrefs();
  } else Hist.push();
  return { meta, bpm: clamp(+r.bpm || P.bpm, 20, 300), bpb: +r.bpb, sr: +r.sr };
}
const SR_OPTS = [{ value: '0', label: 'Same as the audio device' }, { value: '44100', label: '44.1 kHz' }, { value: '48000', label: '48 kHz' }, { value: '88200', label: '88.2 kHz' }, { value: '96000', label: '96 kHz' }];
function applyProps(r) {
  P.meta = r.meta; P.sr = r.sr;
  if (r.meta.title) P.name = r.meta.title;
  P.bpb = r.bpb;
  if (Math.abs(r.bpm - P.bpm) > 1e-6) setBpm(r.bpm);
  $('#projName').value = P.name; $('#bpbSel').value = P.bpb;
  bus.emit('project'); markDirty();
}
async function newProjectFlow() {
  if (S.dirty && !(await confirmDialog('Start a new project?', 'Unsaved changes in the current project will be lost.', 'New project', true))) return;
  const r = await projectProps(true); if (!r) return;
  Engine.halt(); Deck.unload();
  P = newProject(); S.assets.clear(); Hist.undo = []; Hist.redo = [];
  FileIO.handle = null;
  P.bpm = r.bpm; P.bpb = r.bpb; P.sr = r.sr; P.meta = r.meta; if (r.meta.title) P.name = r.meta.title;
  migrateProject();
  $('#bpmInput').value = P.bpm; $('#projName').value = P.name; $('#bpbSel').value = P.bpb; $('#snapSel').value = P.snap;
  Engine.syncTracks(); bus.emit('assets'); bus.emit('project'); bus.emit('transport');
  S.dirty = false; $('#statusSave').textContent = 'New project';
}

// ---- MP3 encoder thread (LAME via lamejs, LGPL, loaded unmodified from its own script) ----
const Mp3 = {
  url: null,
  encode(chs, sr, kbps, meta, onProgress) {
    if (!this.url) { const s = document.getElementById('rush-mp3-src'); if (!s) throw new Error('MP3 encoder is not available in this build.'); this.url = URL.createObjectURL(new Blob([s.textContent], { type: 'text/javascript' })); }
    return new Promise((resolve, reject) => {
      const w = new Worker(this.url);
      w.onmessage = (e) => { const m = e.data; if (m.progress != null) { onProgress && onProgress(m.progress); return; } w.terminate(); m.ok ? resolve(m.result) : reject(new Error(m.error)); };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'MP3 encoder failed')); };
      w.postMessage({ id: 1, ch: chs, sr, kbps, meta }, chs.map((c) => c.buffer));
    });
  },
};

// ---- mastering export -------------------------------------------------------------------
const MASTER_PRESETS = {
  off: { label: 'Off (no loudness processing)' },
  streaming: { label: 'Streaming: −14 LUFS · −1 dBTP', target: -14, ceiling: -1 },
  apple: { label: 'Apple Music / podcasts: −16 LUFS · −1 dBTP', target: -16, ceiling: -1 },
  mixtape: { label: 'Mixtape / DJ: −10 LUFS · −0.5 dBTP', target: -10, ceiling: -0.5 },
  club: { label: 'Club loud: −8 LUFS · −0.3 dBTP', target: -8, ceiling: -0.3 },
  broadcast: { label: 'Broadcast EBU R128: −23 LUFS · −1 dBTP', target: -23, ceiling: -1 },
  peak: { label: 'True-peak limit only: −1 dBTP', ceiling: -1 },
  custom: { label: 'Custom…' },
};
const FORMATS = {
  wav16: { label: 'WAV 16-bit PCM (CD quality)', ext: 'wav', bits: 16 },
  wav24: { label: 'WAV 24-bit PCM (studio master)', ext: 'wav', bits: 24 },
  wav32: { label: 'WAV 32-bit float (lossless, no clipping)', ext: 'wav', bits: 32 },
  mp3_320: { label: 'MP3 320 kbps (best)', ext: 'mp3', kbps: 320 },
  mp3_256: { label: 'MP3 256 kbps', ext: 'mp3', kbps: 256 },
  mp3_192: { label: 'MP3 192 kbps', ext: 'mp3', kbps: 192 },
  mp3_128: { label: 'MP3 128 kbps (small)', ext: 'mp3', kbps: 128 },
};
const fmtLu = (v) => (isFinite(v) ? v.toFixed(1) : '−∞');
function masterOpts(v) {
  const p = MASTER_PRESETS[v.master] || {};
  if (v.master === 'off') return {};
  if (v.master === 'custom') return { targetLufs: v.target === '' || v.target == null || isNaN(+v.target) ? null : +v.target, ceilingDb: clamp(+v.ceiling || -1, -12, 0) };
  return { targetLufs: p.target ?? null, ceilingDb: p.ceiling };
}
async function renderForExport(v) {
  const range = v.range === 'loop' ? { fromBeat: P.loop.start, toBeat: P.loop.end } : v.range === 'cursor' ? { fromBeat: P.cursor } : {};
  const fmt = FORMATS[v.format];
  let sr = +v.sr || P.sr || (Engine.ctx ? Engine.ctx.sampleRate : 48000);
  if (fmt.ext === 'mp3' && sr > 48000) sr = 48000;          // MP3 tops out at 48 kHz
  const mo = masterOpts(v);
  return { buf: await Engine.render(Object.assign(range, { sr, tail: v.tail ? 2 : 0, noLimiter: mo.ceilingDb != null })), mo, fmt, sr };
}
async function exportMix(toMedia) {
  if (!projectEndBeats()) { toast('The arrangement is empty. Add clips before exporting.', 'err'); return; }
  if (toMedia === true) {
    const buf = await Engine.render({ tail: 2 });
    addAsset(P.name + ' (mix)', buf, { bpm: P.bpm, beats: buf.duration * P.bpm / 60 }); toast('Bounced mix to Media', 'ok'); return;
  }
  const E = PREF.exp, meta = P.meta || {};
  const fields = [
    { type: 'header', label: 'Output' },
    { id: 'format', label: 'Format', type: 'select', value: E.format, options: Object.entries(FORMATS).map(([value, f]) => ({ value, label: f.label })) },
    { id: 'sr', label: 'Sample rate', type: 'select', value: String(E.sr || P.sr || 0), options: SR_OPTS },
    { id: 'range', label: 'Range', type: 'select', value: P.loop.on && P.loop.end > P.loop.start ? 'loop' : 'all', options: [{ value: 'all', label: 'Whole project' }, { value: 'loop', label: 'Loop region' }, { value: 'cursor', label: 'From the cursor to the end' }] },
    { id: 'dest', label: 'Send to', type: 'select', value: E.dest, options: [{ value: 'file', label: 'File on this computer' }, { value: 'media', label: 'Media pool (bounce)' }, { value: 'both', label: 'Both' }] },
    { id: 'tail', label: 'Include reverb and echo tails (2 s)', type: 'check', value: E.tail },
    { id: 'dither', label: 'Dither (TPDF, noise-shaped)', type: 'check', value: E.dither, show: (v) => v.format !== 'wav32' },
    { type: 'header', label: 'Mastering' },
    { id: 'master', label: 'Loudness target', type: 'select', value: E.master, full: true, options: Object.entries(MASTER_PRESETS).map(([value, p]) => ({ value, label: p.label })), hint: 'Measured to ITU-R BS.1770-4 / EBU R128 and limited with a 4× oversampled true-peak limiter.' },
    { id: 'target', label: 'Integrated loudness (LUFS)', type: 'number', value: E.target, step: 0.5, min: -40, max: -4, show: (v) => v.master === 'custom' },
    { id: 'ceiling', label: 'True-peak ceiling (dBTP)', type: 'number', value: E.ceiling, step: 0.1, min: -12, max: 0, show: (v) => v.master === 'custom' },
    { type: 'header', label: 'Metadata', show: (v) => v.dest !== 'media' },
    { id: 'title', label: 'Title', value: meta.title || P.name, show: (v) => v.dest !== 'media' },
    { id: 'artist', label: 'Artist', value: meta.artist || '', show: (v) => v.dest !== 'media' },
    { id: 'album', label: 'Album / mixtape', value: meta.album || '', show: (v) => v.dest !== 'media' },
    { id: 'genre', label: 'Genre', value: meta.genre || '', show: (v) => v.dest !== 'media' },
    { id: 'year', label: 'Year', value: meta.year || '', show: (v) => v.dest !== 'media' },
    { id: 'copyright', label: 'Copyright', value: meta.copyright || '', show: (v) => v.dest !== 'media' },
    { id: 'comments', label: 'Comments', type: 'textarea', rows: 2, value: meta.comments || '', full: true, show: (v) => v.dest !== 'media' },
  ];
  const measure = async (v, ui) => {
    ui.note('Rendering and measuring…');
    try {
      const { buf, mo } = await renderForExport(v);
      const chs = bufferChannels(buf).map((c) => c.slice());
      const r = await Pool.run('master', { ch: chs, sr: buf.sampleRate, opts: Object.assign({ format: 'none' }, mo) }, chs.map((c) => c.buffer));
      const s = r.stats;
      ui.note('Mix as rendered:  ' + fmtLu(s.lufsIn) + ' LUFS integrated · true peak ' + fmtLu(s.tpIn) + ' dBTP' +
        (mo.targetLufs != null || mo.ceilingDb != null ? '\nAfter mastering: ' + fmtLu(s.lufsOut) + ' LUFS · ' + fmtLu(s.tpOut) + ' dBTP · gain ' + (s.gainDb >= 0 ? '+' : '') + s.gainDb.toFixed(1) + ' dB · peak limiting ' + s.reduction.toFixed(1) + ' dB' : ''));
    } catch (e) { ui.note('Could not measure: ' + e.message); }
  };
  const v = await showDialog({ title: 'Export mix', wide: true, ok: 'Export', fields, extra: [{ label: 'Measure loudness', action: measure }], desc: 'Renders faster than real time with every effect, then masters the result in high precision before writing the file.' });
  if (!v) return;
  Object.assign(PREF.exp, { format: v.format, sr: +v.sr, master: v.master, target: +v.target, ceiling: +v.ceiling, dither: v.dither !== false, tail: v.tail, dest: v.dest }); savePrefs();
  const metaOut = { title: v.title, artist: v.artist, album: v.album, genre: v.genre, year: v.year, copyright: v.copyright, comments: v.comments, engineer: meta.engineer, bpm: T.bpmAt(0) };
  if (v.dest !== 'media') { P.meta = Object.assign({}, P.meta || {}, { title: v.title, artist: v.artist, album: v.album, genre: v.genre, year: v.year, copyright: v.copyright, comments: v.comments }); markDirty(); }
  const t0 = performance.now();
  status('Rendering mix…');
  try {
    const { buf, mo, fmt, sr } = await renderForExport(v);
    status('Mastering…');
    let chs = bufferChannels(buf).map((c) => c.slice());
    const wantWav = fmt.ext === 'wav' && v.dest !== 'media';
    const r = await Pool.run('master', { ch: chs, sr, opts: Object.assign({ format: wantWav && v.dest === 'file' ? 'wav' : 'none', bits: fmt.bits, dither: v.dither !== false, meta: metaOut }, mo) }, chs.map((c) => c.buffer));
    const s = r.stats;
    let file = null, outChs = r.chs;
    if (v.dest !== 'file') addAsset((v.title || P.name) + ' (master)', makeBuffer(outChs, sr), { bpm: T.bpmAt(0), beats: outChs[0].length / sr * T.bpmAt(0) / 60 });
    const base = safeName(v.title || P.name);
    if (v.dest !== 'media') {
      let blob;
      if (fmt.ext === 'mp3') {
        status('Encoding MP3…');
        const mp3 = await Mp3.encode(outChs.map((c) => c.slice()), sr, fmt.kbps, metaOut, (p) => status('Encoding MP3… ' + Math.round(p * 100) + '%'));
        blob = new Blob([mp3], { type: 'audio/mpeg' });
        file = await saveBlobAs(blob, base + '.mp3', 'MP3 audio', 'audio/mpeg', '.mp3');
      } else {
        const wav = r.wav || (await Pool.run('master', { ch: outChs.map((c) => c.slice()), sr, opts: { format: 'wav', bits: fmt.bits, dither: v.dither !== false, meta: metaOut } })).wav;
        blob = new Blob([wav], { type: 'audio/wav' });
        file = await saveBlobAs(blob, base + '.wav', 'WAV audio', 'audio/wav', '.wav');
      }
      if (!file) { status('Export cancelled'); return; }
    }
    const secs = (performance.now() - t0) / 1000;
    status('Exported ' + fmtShort(buf.duration) + ' in ' + secs.toFixed(1) + ' s (' + (buf.duration / secs).toFixed(0) + '× real-time)');
    const missed = s.capped || (mo.targetLufs != null && isFinite(s.lufsOut) && Math.abs(s.lufsOut - mo.targetLufs) > 0.5);
    showDialog({ title: 'Export complete', cancel: null, ok: 'Done', desc: (file ? file + ' · ' : 'Added to Media · ') + (sr / 1000).toFixed(1) + ' kHz · ' + fmtShort(buf.duration) + ' · rendered in ' + secs.toFixed(1) + ' s',
      footerNote: missed ? 'The mix has very sharp peaks, so Rush stopped at ' + fmtLu(s.lufsOut) + ' LUFS instead of ' + mo.targetLufs + ' to keep peak limiting under 10 dB (more sounds crushed). A compressor in Edit › Master effects gets it louder cleanly.' : null,
      fields: [{ type: 'html', node: el('div', { class: 'xp-report' },
        [['Integrated loudness', fmtLu(s.lufsOut) + ' LUFS'], ['True peak', fmtLu(s.tpOut) + ' dBTP'], ['Loudest 3 s', fmtLu(s.shortMax) + ' LUFS'], ['Before mastering', fmtLu(s.lufsIn) + ' LUFS · ' + fmtLu(s.tpIn) + ' dBTP'], ['Gain applied', (s.gainDb >= 0 ? '+' : '') + s.gainDb.toFixed(1) + ' dB'], ['Peak limiting', s.reduction > 0.05 ? s.reduction.toFixed(1) + ' dB max' : 'none']]
          .map(([k, val]) => el('div', {}, el('span', {}, k), el('b', {}, val)))) }] });
  } catch (e) { console.error(e); toast('Export failed: ' + e.message, 'err'); status('Export failed'); }
}

// ---- preferences ---------------------------------------------------------------------------
async function showPrefs() {
  const r = await showDialog({ title: 'Preferences', wide: true, ok: 'Save', fields: [
    { type: 'header', label: 'Audio' },
    { id: 'latency', label: 'Playback latency', type: 'select', value: PREF.latency, options: [{ value: 'interactive', label: 'Lowest (live play and recording)' }, { value: 'balanced', label: 'Balanced' }, { value: 'playback', label: 'Safest (big projects, no dropouts)' }] },
    { id: 'sampleRate', label: 'Engine sample rate', type: 'select', value: String(PREF.sampleRate), options: SR_OPTS },
    { id: 'countIn', label: 'Recording count-in', type: 'select', value: String(PREF.countIn), options: [{ value: '0', label: 'None' }, { value: '1', label: '1 bar' }, { value: '2', label: '2 bars' }] },
    { id: 'previewVol', label: 'Preview volume', type: 'range', min: -40, max: 6, step: 0.5, value: PREF.previewVol, format: (x) => fmtDb(x) + ' dB' },
    { type: 'header', label: 'Editing' },
    { id: 'snapOn', label: 'Snap to grid (F8)', type: 'check', value: PREF.snapOn },
    { id: 'autoXfade', label: 'Automatic crossfades when clips overlap on a track', type: 'check', value: PREF.autoXfade },
    { id: 'ripple', label: 'Ripple edits (later clips follow deletes and trims)', type: 'check', value: PREF.ripple },
    { id: 'quickFade', label: 'Quick fade clip edges (5 ms, removes clicks at cuts)', type: 'check', value: PREF.quickFade },
    { id: 'previewAuto', label: 'Auto-preview files in the Explorer', type: 'check', value: PREF.previewAuto },
    { id: 'previewSync', label: 'Preview in project tempo (when the file’s tempo is known)', type: 'check', value: PREF.previewSync },
    { type: 'header', label: 'Stem separation' },
    { id: 'stemEngine', label: 'Separator', type: 'select', value: PREF.stemEngine, options: [{ value: 'auto', label: 'AI (HTDemucs) when available' }, { value: 'dsp', label: 'Fast (signal processing only)' }], hint: AI.describe() },
    { id: 'aiOverlap', label: 'AI quality', type: 'select', value: String(PREF.aiOverlap), options: [{ value: '0.25', label: 'Best (25% window overlap)' }, { value: '0.5', label: 'Maximum (50% overlap, 1.5× slower)' }, { value: '0.1', label: 'Faster (10% overlap)' }] },
    { id: 'aiDevice', label: 'AI runs on', type: 'select', value: PREF.aiDevice, options: [{ value: 'auto', label: 'Graphics card when available, else CPU' }, { value: 'cpu', label: 'CPU only' }], hint: 'Takes effect the next time Rush starts.' },
    { type: 'header', label: 'Songs and beatmapping' },
    { id: 'autoBeatmap', label: 'Open the Beatmapper for long songs added to the arrangement', type: 'check', value: PREF.autoBeatmap },
    { id: 'beatmapMin', label: 'A song is “long” from (seconds)', type: 'number', value: PREF.beatmapMin, min: 10, max: 900, step: 5, show: (v) => v.autoBeatmap },
    { id: 'autosave', label: 'Autosave for crash recovery', type: 'check', value: PREF.autosave },
  ] });
  if (!r) return;
  const audioChanged = r.latency !== PREF.latency || +r.sampleRate !== PREF.sampleRate;
  Object.assign(PREF, { latency: r.latency, sampleRate: +r.sampleRate, countIn: +r.countIn, previewVol: r.previewVol, snapOn: r.snapOn, autoXfade: r.autoXfade, ripple: r.ripple, quickFade: r.quickFade, previewAuto: r.previewAuto, previewSync: r.previewSync, stemEngine: r.stemEngine, aiOverlap: +r.aiOverlap, aiDevice: r.aiDevice, autoBeatmap: r.autoBeatmap, beatmapMin: clamp(+r.beatmapMin || 90, 10, 900), autosave: r.autosave });
  Autosave.enabled = PREF.autosave;
  savePrefs();
  if (audioChanged) { await Engine.recreate(); toast('Audio engine restarted at ' + (Engine.ctx.sampleRate / 1000).toFixed(1) + ' kHz', 'ok'); }
  Arrange.draw();
}
function toggleSnap() { PREF.snapOn = !PREF.snapOn; savePrefs(); status(PREF.snapOn ? 'Snapping on' : 'Snapping off (F8)'); $('#snapSel').classList.toggle('off', !PREF.snapOn); }
function toggleBypass() {
  Plugins.bypassAll = !Plugins.bypassAll;
  Engine.applyAll(); for (const set of Engine.clipChains.values()) for (const ch of set) ch.set(ch.fx);
  document.body.classList.toggle('fx-bypassed', Plugins.bypassAll);
  status(Plugins.bypassAll ? 'All effects bypassed (exports still include them)' : 'Effects active');
}

const SHELL_MENUS = {
  file: () => [
    { label: 'New project…', key: 'Ctrl+N', action: newProjectFlow },
    { label: 'Open project…', key: 'Ctrl+O', action: () => FileIO.open() },
    { label: 'Open recent', sub: () => Recent.list.length ? [...Recent.list.map((r) => ({ label: r.name + (r.handle ? '' : ' (download)'), action: () => FileIO.openRecent(r) })), '-', { label: 'Clear recent projects', action: () => Recent.clear() }] : [{ label: 'No recent projects', disabled: true }] },
    { label: 'Save project', key: 'Ctrl+S', action: () => FileIO.save(false) },
    { label: 'Save project as…', key: 'Ctrl+Shift+S', action: () => FileIO.save(true) },
    { label: 'Project properties…', key: 'Alt+Enter', action: async () => { const r = await projectProps(false); if (r) applyProps(r); } },
    '-',
    { label: 'Import audio…', key: 'Ctrl+I', action: () => $('#fileInput').click() },
    { label: 'Explorer: open a music folder…', action: () => { setSideTab('explorer'); Explorer.addRoot(); } },
    { label: 'Export mix (WAV / MP3, mastering)…', key: 'Ctrl+E', action: exportMix },
    { label: 'Bounce mix to Media', action: () => exportMix(true) },
    '-',
    { label: 'Restore last autosave', action: restoreAutosave },
  ],
  view: () => [
    { label: 'Arrange', key: '1', action: () => setView('arrange') },
    { label: 'Editor', key: '2', action: () => setView('editor') },
    { label: 'Stems', key: '3', action: () => setView('stems') },
    { label: 'Mixer', key: '4', action: () => setView('mixer') },
    '-',
    { label: 'Library sidebar', key: 'Ctrl+B', checked: PREF.showLibrary, action: () => toggleView('showLibrary') },
    { label: 'Overview strip', checked: PREF.showOverview, action: () => toggleView('showOverview') },
    { label: 'Track meters', checked: PREF.showMeters, action: () => toggleView('showMeters') },
    { label: 'Media', key: 'Alt+1', action: () => setSideTab('media') },
    { label: 'Explorer', key: 'Alt+2', action: () => setSideTab('explorer') },
    '-',
    { label: 'Follow playhead', checked: !!S.follow, action: () => $('#tFollow').click() },
    { label: 'Zoom to fit project', key: 'F', action: () => { setView('arrange'); Arrange.zoomFit(); } },
    { label: 'Keyboard shortcuts', key: '?', action: showShortcuts },
  ],
  options: () => [
    { label: 'Snapping', key: 'F8', checked: PREF.snapOn, action: toggleSnap },
    { label: 'Automatic crossfades', key: 'Ctrl+Shift+X', checked: PREF.autoXfade, action: () => { PREF.autoXfade = !PREF.autoXfade; savePrefs(); } },
    { label: 'Quick fade clip edges (no clicks)', checked: PREF.quickFade, action: () => { PREF.quickFade = !PREF.quickFade; savePrefs(); Engine.refresh(); } },
    { label: 'Ripple edits', key: 'Ctrl+L', checked: PREF.ripple, action: () => { PREF.ripple = !PREF.ripple; savePrefs(); status(PREF.ripple ? 'Ripple on: later clips follow your edits' : 'Ripple off'); } },
    '-',
    { label: 'Loop playback', key: 'L', checked: P.loop.on, action: toggleLoop },
    { label: 'Metronome', key: 'C', checked: P.metro, action: () => { P.metro = !P.metro; bus.emit('transport'); } },
    { label: 'Count-in when recording', checked: PREF.countIn > 0, action: () => { PREF.countIn = PREF.countIn ? 0 : 1; savePrefs(); } },
    { label: 'Bypass all effects', key: 'Shift+B', checked: Plugins.bypassAll, action: toggleBypass },
    '-',
    { label: 'Beatmapper for long songs', checked: PREF.autoBeatmap, action: () => { PREF.autoBeatmap = !PREF.autoBeatmap; savePrefs(); } },
    { label: 'Auto-preview in Explorer', checked: PREF.previewAuto, action: () => { PREF.previewAuto = !PREF.previewAuto; savePrefs(); } },
    '-',
    { label: 'Preferences…', key: 'Ctrl+,', action: showPrefs },
  ],
};
function toggleView(k) { PREF[k] = !PREF[k]; savePrefs(); applyViewPrefs(); }
function applyViewPrefs() {
  document.body.classList.toggle('no-overview', !PREF.showOverview);
  document.body.classList.toggle('no-meters', !PREF.showMeters);
  $('#main').classList.toggle('side-hidden', !PREF.showLibrary);
  requestAnimationFrame(() => { Arrange.layout(); Arrange.draw(); });
}
function setSideTab(t) {
  $$('.side-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.side === t)));
  $('#sideMedia').hidden = t !== 'media'; $('#sideExplorer').hidden = t !== 'explorer';
  $('.sidebar').classList.toggle('ex-mode', t === 'explorer');
  if (t !== 'explorer') Explorer.stop();
  if (!PREF.showLibrary) toggleView('showLibrary');
  $('#main').classList.add('side-open');
  if (t === 'explorer') Explorer.show();
  try { localStorage.setItem('rush.side', t); } catch (e) { }
}

function initShell() {
  setTimeout(() => { if (PREF.stemEngine !== 'dsp') AI.ready(); }, 1500);
  Autosave.enabled = PREF.autosave;
  Recent.load();
  Explorer.init();
  $$('.side-tab').forEach((b) => b.addEventListener('click', () => setSideTab(b.dataset.side)));
  $$('.tool-btn').forEach((b) => b.addEventListener('click', () => { setView('arrange'); Arrange.setTool(b.dataset.tool); }));
  $('#projInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) { FileIO.handle = null; Recent.add(f.name, null); } });
  let side = 'media'; try { side = localStorage.getItem('rush.side') || 'media'; } catch (e) { }
  if (side === 'explorer') { setSideTab('explorer'); $('#main').classList.remove('side-open'); }
  applyViewPrefs();
  $('#snapSel').classList.toggle('off', !PREF.snapOn);
}
