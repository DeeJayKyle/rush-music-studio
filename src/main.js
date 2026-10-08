// ---------------------------------------------------------------------------
// App shell: views, menus, transport, media pool, keyboard, boot
// ---------------------------------------------------------------------------
function setView(v) {
  S.view = v;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  for (const n of ['arrange', 'editor', 'stems', 'mixer']) $('#view-' + n).hidden = n !== v;
  requestAnimationFrame(() => {
    if (v === 'arrange') { Arrange.layout(); Arrange.draw(); }
    if (v === 'editor') { Editor.ensure(); Editor.draw(); }
    if (v === 'stems') { Deck.draw(); if (!Deck.asset && S.assets.size) { const pick = [...S.assets.values()].find((a) => !a.isLoop) || S.assets.values().next().value; $('#dkAsset').value = pick.id; } }
    if (v === 'mixer') Mixer.render();
  });
  try { localStorage.setItem('rush.view', v); } catch (e) { }
}

// ---- theme ----------------------------------------------------------------------
function applyTheme(t) {
  if (!['dark', 'light', 'classic'].includes(t)) t = 'dark';
  document.documentElement.setAttribute('data-theme', t);
  $('#themeBtn').innerHTML = ''; $('#themeBtn').append(icon(t === 'dark' ? 'moon' : 'sun'));
  $('#themeBtn').title = 'Theme: ' + t[0].toUpperCase() + t.slice(1);
  refreshColors();
  try { localStorage.setItem('rush.theme', t); } catch (e) { }
  Arrange.draw(); Editor.draw(); Deck.draw();
}

// ---- media pool -----------------------------------------------------------------
function renderPool() {
  const pool = $('#pool'); pool.innerHTML = '';
  if (!S.assets.size) pool.append(el('div', { style: { color: 'var(--faint)', padding: '12px 6px', fontSize: '12px' } }, 'Your imported files, recordings and generated loops appear here.'));
  for (const A of S.assets.values()) {
    const meta = [fmtShort(A.buffer.duration)];
    const tags = [];
    if (A.analyzing) tags.push(el('span', { class: 'tag' }, 'analysing…'));
    else {
      if (A.bpm) tags.push(el('span', { class: 'tag' }, A.bpm.toFixed(A.isLoop ? 1 : 1) + ' BPM'));
      if (A.key) tags.push(el('span', { class: 'tag', title: A.key.name }, A.key.camelot + ' · ' + A.key.short));
      if (A.isLoop) tags.push(el('span', { class: 'tag' }, Math.round(A.beats) + ' beats'));
    }
    if (A.stems.state === 'done') tags.push(el('span', { class: 'tag stems' }, 'stems'));
    if (A.stems.state === 'running') tags.push(el('span', { class: 'tag' }, 'separating…'));
    const add = el('button', { class: 'icon-btn', title: 'Add to a new track at the cursor', 'aria-label': 'Add to arrangement' }, icon('plus'));
    add.addEventListener('click', (e) => { e.stopPropagation(); Arrange.placeAsset(A, P.tracks.length, P.cursor); setView('arrange'); });
    const ed = el('button', { class: 'icon-btn', title: 'Open in Editor', 'aria-label': 'Open in Editor' }, icon('edit'));
    ed.addEventListener('click', (e) => { e.stopPropagation(); Editor.open(A.id); });
    const st = el('button', { class: 'icon-btn', title: 'Separate stems', 'aria-label': 'Separate stems' }, icon('stems'));
    st.addEventListener('click', (e) => { e.stopPropagation(); setView('stems'); Deck.load(A.id); });
    const row = el('div', { class: 'asset' + (Editor.asset === A || Deck.asset === A ? ' active' : ''), role: 'listitem', draggable: 'true', tabindex: '0', title: 'Drag onto the timeline' },
      el('div', { class: 'nm' }, A.name), el('div', { class: 'acts' }, add, ed, st),
      el('div', { class: 'meta' }, meta.join(' '), ...tags));
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-rush-asset', A.id); e.dataTransfer.effectAllowed = 'copy'; });
    row.addEventListener('dblclick', () => Editor.open(A.id));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') Editor.open(A.id); });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Add to new track', action: () => { Arrange.placeAsset(A, P.tracks.length, P.cursor); setView('arrange'); } },
        { label: 'Open in Editor', action: () => Editor.open(A.id) },
        { label: 'Load to stems deck', action: () => { setView('stems'); Deck.load(A.id); } },
        { label: 'Preview', action: () => { Engine.halt(); Engine.playBuffer(A.buffer); } },
        { label: 'Stop preview', action: () => Engine.stopPreview() },
        { label: 'Rename', action: async () => { const r = await showDialog({ title: 'Rename file', fields: [{ id: 'n', label: 'Name', value: A.name }], ok: 'Rename' }); if (r && r.n) { A.name = r.n; bus.emit('assets'); Arrange.draw(); markDirty(); } } },
        { label: 'Export as WAV', action: () => downloadBlob(encodeWav(bufferChannels(A.buffer), A.buffer.sampleRate, 24), safeName(A.name) + '.wav') },
        '-',
        { label: 'Remove from project', action: async () => { if (await confirmDialog('Remove ' + A.name + '?', 'Clips that use this file are removed from the arrangement too. You can undo this in Arrange.', 'Remove', true)) removeAsset(A); } },
      ]);
    });
    pool.append(row);
  }
  updateLen();
}
function updateLen() { const e = projectEndBeats(); $('#statusLen').textContent = 'Length ' + fmtShort(e * spb()) + ' · ' + P.tracks.length + ' tracks'; }

// ---- menus ------------------------------------------------------------------------
const MENUS = {
  file: () => [
    { label: 'New project', key: 'Ctrl+N', action: newProjectFlow },
    { label: 'Open project…', key: 'Ctrl+O', action: () => $('#projInput').click() },
    { label: 'Save project', key: 'Ctrl+S', action: () => Project.save() },
    '-',
    { label: 'Import audio…', key: 'Ctrl+I', action: () => $('#fileInput').click() },
    { label: 'Export mix as WAV…', key: 'Ctrl+E', action: exportMix },
    { label: 'Export mix to Media (bounce)', action: () => exportMix(true) },
    '-',
    { label: 'Restore last autosave', action: restoreAutosave },
  ],
  edit: () => S.view === 'editor' ? [
    { label: 'Undo', key: 'Ctrl+Z', action: Editor.ops.undo }, { label: 'Redo', key: 'Ctrl+Y', action: Editor.ops.redo }, '-', ...Editor.editMenuItems(),
  ] : [
    { label: 'Undo', key: 'Ctrl+Z', action: () => Hist.doUndo(), disabled: !Hist.undo.length },
    { label: 'Redo', key: 'Ctrl+Y', action: () => Hist.doRedo(), disabled: !Hist.redo.length },
    '-',
    { label: 'Split at cursor', key: 'S', action: () => Arrange.key({ key: 's' }) },
    { label: 'Duplicate clip', key: 'Ctrl+D', action: () => Arrange.key({ key: 'd', ctrlKey: true }) },
    { label: 'Delete clip', key: 'Del', action: () => Arrange.key({ key: 'Delete' }) },
    '-',
    { label: 'Add track', action: () => Arrange.addTrack() },
    { label: 'Insert marker', key: 'Shift+M', action: () => Arrange.addMarker(P.cursor) },
    { label: 'Track effects…', key: 'Ctrl+K', action: () => { const t = P.tracks.find((x) => x.id === S.selTrack) || P.tracks[0]; if (t) Chainer.forTrack(t); } },
    { label: 'Master effects…', action: () => Chainer.forMaster() },
    { label: 'Project tempo…', action: tempoDialog },
  ],
  process: () => [{ label: 'Editor', header: true }, ...Editor.processMenuItems(), '-', { label: 'Effects', header: true }, ...Editor.fxMenuItems()].map((it) => (typeof it === 'object' && it.action ? Object.assign({}, it, { action: () => { if (!Editor.asset) { Editor.ensure(); } setView('editor'); it.action(); } }) : it)),
  help: () => [
    { label: 'Keyboard shortcuts', action: showShortcuts },
    { label: 'About Rush Music Studio', action: showAbout },
  ],
};
async function tempoDialog() { const r = await showDialog({ title: 'Project tempo', fields: [{ id: 'b', label: 'BPM', type: 'number', value: P.bpm, step: 0.01, min: 40, max: 240 }] }); if (r) setBpm(r.b); }
function showShortcuts() {
  showDialog({ title: 'Keyboard shortcuts', cancel: null, ok: 'Close', desc: 'Ctrl+K effects (Plug-in Chainer) · Shift+M insert marker · , and . jump between markers · Editor: M marker, R region from selection · Space play/pause · Home go to start · R record · L loop · M metronome · 1–4 switch view · Ctrl+S save · Ctrl+O open · Ctrl+I import · Ctrl+E export · Ctrl+Z/Y undo/redo. Arrange: S split, Ctrl+D duplicate, Del delete, ←/→ nudge, +/− zoom, Alt-drag copies a clip, Shift-drag ignores snap, drag in the ruler to set a loop. Editor: drag to select, Shift-click extends, Ctrl+X/C/V, Ctrl+T trim, Ctrl+A select all, wheel scrolls, Ctrl+wheel zooms. Stems: Z vocals, X melody, C bass, V drums.' });
}
function showAbout() {
  showDialog({ title: 'Rush Music Studio', cancel: null, ok: 'Close', desc: 'An offline, open-source studio: a loop-based multitrack arranger with envelopes and markers, a sample-accurate audio editor with markers and regions, ' + Object.keys(Plugins.REG).length + ' original real-time plugins with a Plug-in Chainer, a real-time four-stem separator and a mixer. No licence key, no account, no internet needed. DSP runs on ' + Pool.size + ' background threads on this machine. Released under the MIT licence.' });
}
async function newProjectFlow() {
  if (S.dirty && !(await confirmDialog('Start a new project?', 'Unsaved changes in the current project will be lost.', 'New project', true))) return;
  Engine.halt(); Deck.unload();
  P = newProject(); S.assets.clear(); Hist.undo = []; Hist.redo = [];
  $('#bpmInput').value = P.bpm; $('#projName').value = P.name; $('#bpbSel').value = P.bpb; $('#snapSel').value = P.snap;
  Engine.syncTracks(); bus.emit('assets'); bus.emit('project'); bus.emit('transport');
  S.dirty = false; $('#statusSave').textContent = 'New project';
}
async function exportMix(toMedia) {
  if (!projectEndBeats()) { toast('The arrangement is empty. Add clips before exporting.', 'err'); return; }
  let opts = { bits: '24', range: 'all', tail: true };
  if (toMedia !== true) {
    const r = await showDialog({ title: 'Export mix', desc: 'Renders faster than real time, with every effect and the master limiter applied.', ok: 'Export WAV', fields: [
      { id: 'range', label: 'Range', type: 'select', value: P.loop.end > P.loop.start && P.loop.on ? 'loop' : 'all', options: [{ value: 'all', label: 'Whole project' }, { value: 'loop', label: 'Loop region only' }] },
      { id: 'bits', label: 'Bit depth', type: 'select', value: '24', options: [{ value: '16', label: '16-bit PCM (CD)' }, { value: '24', label: '24-bit PCM' }, { value: '32', label: '32-bit float' }] },
      { id: 'tail', label: 'Include reverb/echo tail (2 s)', type: 'check', value: true }] });
    if (!r) return; opts = r;
  }
  const t0 = performance.now();
  status('Rendering mix…');
  try {
    const buf = await Engine.render(opts.range === 'loop' ? { fromBeat: P.loop.start, toBeat: P.loop.end, tail: opts.tail ? 2 : 0 } : { tail: opts.tail ? 2 : 0 });
    const secs = (performance.now() - t0) / 1000;
    if (toMedia === true) { addAsset(P.name + ' (mix)', buf, { bpm: P.bpm, beats: buf.duration / spb() }); toast('Bounced mix to Media', 'ok'); }
    else downloadBlob(encodeWav(bufferChannels(buf), buf.sampleRate, +opts.bits), safeName(P.name) + '.wav');
    status('Rendered ' + fmtShort(buf.duration) + ' in ' + secs.toFixed(1) + ' s (' + (buf.duration / secs).toFixed(0) + '× real-time)');
  } catch (e) { toast(e.message, 'err'); status('Export failed'); }
}
async function restoreAutosave() {
  const s = await Autosave.get();
  if (!s) { toast('No autosave found on this computer yet.'); return; }
  await Project.fromBuffer(await s.blob.arrayBuffer());
  toast('Restored autosave from ' + new Date(s.when).toLocaleString(), 'ok');
}

// ---- transport UI -------------------------------------------------------------------
function updateTransportUI() {
  const pb = $('#tPlay'); pb.innerHTML = ''; pb.append(icon(Engine.playing ? 'pause' : 'play')); pb.setAttribute('aria-label', Engine.playing ? 'Pause' : 'Play');
  $('#tLoop').setAttribute('aria-pressed', String(P.loop.on));
  $('#tMetro').setAttribute('aria-pressed', String(P.metro));
  $('#tRec').setAttribute('aria-pressed', String(Engine.recording));
  $('#snapSel').value = String(P.snap);
  updatePos();
}
function updatePos() {
  const b = Engine.playing ? Engine.posBeats() : P.cursor;
  $('#posBars').textContent = fmtBars(b, P.bpb);
  $('#posTime').textContent = fmtTime(b * spb());
}
const taps = [];
function tap() {
  const t = performance.now();
  if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(t); if (taps.length > 8) taps.shift();
  if (taps.length >= 3) { const d = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); setBpm(Math.round(60000 / d * 10) / 10); }
}

function bindShell() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $$('.menu-btn').forEach((b) => b.addEventListener('click', () => { if (b.getAttribute('aria-expanded') === 'true') { closeMenu(); return; } const r = b.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, MENUS[b.dataset.menu](), b); }));
  $('#themeBtn').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect(), cur = document.documentElement.getAttribute('data-theme');
    showMenu(r.right - 220, r.bottom + 4, [{ label: 'Theme', header: true }, ...[['dark', 'Dark'], ['light', 'Light'], ['classic', 'Classic (2000s studio)']].map(([k, l]) => ({ label: (cur === k ? '✓  ' : '    ') + l, action: () => applyTheme(k) }))]);
  });
  $('#sideToggle').addEventListener('click', () => $('#main').classList.toggle('side-open'));
  $('#projName').addEventListener('change', (e) => { P.name = e.target.value || 'Untitled project'; markDirty(); });
  $('#projName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); });
  $('#tPlay').addEventListener('click', () => { if (S.view === 'stems') { Deck.play(); return; } Engine.toggle(); });
  $('#tStop').addEventListener('click', () => { Engine.stop(); Deck.pause(); Engine.stopPreview(); });
  $('#tStart').addEventListener('click', () => { P.cursor = 0; if (Engine.playing) Engine.play(0); bus.emit('transport'); $('#tlScroll').scrollLeft = 0; });
  $('#tRec').addEventListener('click', () => { if (Engine.recording) Engine.pause(); else Engine.startRecord(); });
  $('#tLoop').addEventListener('click', () => { toggleLoop(); });
  $('#tMetro').addEventListener('click', () => { P.metro = !P.metro; bus.emit('transport'); markDirty(); });
  $('#bpmInput').addEventListener('change', (e) => setBpm(parseFloat(e.target.value)));
  $('#bpmInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
  $('#bpbSel').addEventListener('change', (e) => { Hist.push(); P.bpb = +e.target.value; bus.emit('project'); });
  $('#snapSel').addEventListener('change', (e) => { P.snap = parseFloat(e.target.value); markDirty(); });
  $('#tapBtn').addEventListener('click', tap);
  $('#importBtn').addEventListener('click', () => $('#fileInput').click());
  $('#dropHint').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => { const f = [...e.target.files]; e.target.value = ''; await importFiles(f); });
  $('#projInput').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await Project.load(f); });
  // global drag & drop of files
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dropping'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dropping'); });
  window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => { dragDepth = 0; document.body.classList.remove('dropping'); if (e.dataTransfer.files.length) { e.preventDefault(); await importFiles([...e.dataTransfer.files]); } });
  // loop lab
  LoopLab.fillKeys($('#llKey'));
  $('#llStyle').addEventListener('change', () => { const st = LoopLab.STYLES[$('#llStyle').value]; if (st && !P.tracks.length) setBpm(st.bpm); });
  $('#llGen').addEventListener('click', generateLoop);
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { Autosave.save(); e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('resize', () => { closeMenu(); });
}
function toggleLoop() {
  if (!(P.loop.end > P.loop.start)) { P.loop.start = 0; P.loop.end = P.bpb * 4; }
  P.loop.on = !P.loop.on; Engine.refresh(); bus.emit('transport'); Arrange.draw(); markDirty();
}
async function generateLoop() {
  const style = $('#llStyle').value, part = $('#llPart').value, key = $('#llKey').value, bars = +$('#llBars').value;
  const btn = $('#llGen'); btn.disabled = true;
  try {
    const buf = await LoopLab.generate({ style, part, key, bars, bpm: P.bpm, bpb: P.bpb, seed: (Math.random() * 1e9) | 0 });
    const ks = key.replace(' minor', 'm').replace(' major', '');
    const A = addAsset(`${style} ${part.toLowerCase()} · ${ks}`, buf, { bpm: P.bpm, beats: bars * P.bpb, isLoop: true, generated: true, key: null });
    toast('Generated ' + A.name + ' at ' + P.bpm + ' BPM. Drag it onto the timeline.', 'ok');
  } catch (e) { toast('Could not generate the loop: ' + e.message, 'err'); }
  btn.disabled = false;
}

// ---- keyboard ---------------------------------------------------------------------------
function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && !['range', 'checkbox', 'button'].includes(e.target.type)) return;
  if (tag === 'select' || tag === 'textarea' || document.querySelector('.modal-bg')) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 's') { e.preventDefault(); Project.save(); return; }
  if (mod && k === 'o') { e.preventDefault(); $('#projInput').click(); return; }
  if (mod && k === 'i') { e.preventDefault(); $('#fileInput').click(); return; }
  if (mod && k === 'e') { e.preventDefault(); exportMix(); return; }
  if (mod && k === 'n') { e.preventDefault(); newProjectFlow(); return; }
  if (mod && k === 'k' && S.view !== 'editor') { e.preventDefault(); const t = P.tracks.find((x) => x.id === S.selTrack) || P.tracks[0]; t ? Chainer.forTrack(t) : Chainer.forMaster(); return; }
  if (!mod && !e.altKey && ['1', '2', '3', '4'].includes(k)) { setView(['arrange', 'editor', 'stems', 'mixer'][+k - 1]); e.preventDefault(); return; }
  if (S.view === 'editor' && Editor.key(e)) { e.preventDefault(); return; }
  if (S.view === 'stems' && Deck.key(e)) { e.preventDefault(); return; }
  if (k === ' ') { e.preventDefault(); Engine.toggle(); return; }
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); Hist.doUndo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); Hist.doRedo(); return; }
  if (k === 'home') { P.cursor = 0; if (Engine.playing) Engine.play(0); bus.emit('transport'); return; }
  if (!mod && k === 'r') { if (Engine.recording) Engine.pause(); else Engine.startRecord(); return; }
  if (!mod && k === 'l') { toggleLoop(); return; }
  if (!mod && !e.shiftKey && k === 'm') { P.metro = !P.metro; bus.emit('transport'); return; }
  if (k === 'escape') { S.selClip = null; Arrange.draw(); return; }
  if (S.view === 'arrange' && Arrange.key(e)) { e.preventDefault(); }
}

// ---- animation loop: playhead, meters, clocks ----------------------------------------
function frame() {
  if (Engine.playing) {
    updatePos();
    if (S.view === 'arrange') { Arrange.follow(); Arrange.drawOverlay(); }
  }
  if (Engine.ctx && Engine.master) {
    const cv = $('#masterMini');
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    [Engine.master.anL, Engine.master.anR].forEach((an, i) => {
      const f = clamp((gainToDb(Mixer.peakOf(an)) + 60) / 63, 0, 1);
      const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, C.ok); g.addColorStop(0.8, C.ok); g.addColorStop(0.92, C.accent); g.addColorStop(1, C.rec);
      ctx.fillStyle = g; ctx.fillRect(2, 4 + i * (h / 2 - 2), f * (w - 4), h / 2 - 6);
    });
    if (S.view === 'mixer') Mixer.tick();
  }
  requestAnimationFrame(frame);
}

// ---- demo content so the studio opens in a working state -------------------------------
async function buildDemo() {
  P.bpm = 105; $('#bpmInput').value = 105; P.name = 'Kampala Nights (demo)'; $('#projName').value = P.name;
  const parts = [['Drums', 'Afrobeat', 4], ['Percussion', 'Afrobeat', 4], ['Bass', 'Afrobeat', 4], ['Chords', 'Afrobeat', 4]];
  const assets = [];
  for (const [part, style, bars] of parts) {
    const buf = await LoopLab.generate({ style, part, key: 'A minor', bars, bpm: 105, bpb: 4, seed: 4242 + assets.length });
    assets.push(addAsset(`${style} ${part.toLowerCase()} · Am`, buf, { bpm: 105, beats: bars * 4, isLoop: true, generated: true }));
  }
  const names = ['Drums', 'Percussion', 'Bass', 'Keys'];
  const plan = [[0, 64], [16, 64], [8, 64], [0, 64]];
  assets.forEach((A, i) => {
    const t = newTrack(names[i]);
    if (i === 3) { t.rev = 0.25; t.dly = 0.12; t.vol = -4; }
    if (i === 1) { t.pan = -0.15; t.vol = -3; }
    const [s, e] = plan[i];
    t.clips.push({ id: uid('c'), asset: A.id, start: s, len: e - s, offset: 0, sync: true, loop: true, gain: 0, fadeIn: 0, fadeOut: 0 });
    P.tracks.push(t);
  });
  P.loop = { on: false, start: 16, end: 32 };
  Hist.undo = []; Hist.redo = [];
  bus.emit('project');
}

async function boot() {
  S.booting = true;
  let theme = 'dark';
  try { theme = localStorage.getItem('rush.theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); } catch (e) { }
  document.documentElement.setAttribute('data-theme', theme);
  refreshColors();
  $('#threadsTxt').textContent = Pool.size + ' DSP threads';
  $('#threadsChip').title = 'Stem separation, time-stretch and analysis run on ' + Pool.size + ' background threads';
  Pool.init();
  Arrange.init(); Editor.init(); Deck.init(); Mixer.init();
  bindShell();
  applyTheme(theme);
  bus.on('assets', renderPool);
  bus.on('project', () => { updateLen(); updateTransportUI(); });
  bus.on('transport', updateTransportUI);
  bus.on('stemsDone', (A) => { toast('Stems ready for ' + A.name, 'ok'); Arrange.draw(); });
  document.addEventListener('keydown', onKey);
  renderPool(); Arrange.renderHeads(); Arrange.layout(); Arrange.draw(); updateTransportUI();
  requestAnimationFrame(frame);
  // restore session or show demo
  const saved = await Autosave.get();
  status('Building demo loops…');
  try { await buildDemo(); } catch (e) { console.error(e); }
  S.dirty = false; $('#statusSave').textContent = 'Demo project';
  status('Ready · drop audio files anywhere to import');
  S.booting = false;
  let v = 'arrange'; try { v = localStorage.getItem('rush.view') || 'arrange'; } catch (e) { }
  setView(v);
  if (saved && saved.blob && saved.blob.size > 64) {
    const ok = await showDialog({ title: 'Restore your last session?', desc: '"' + (saved.name || 'Untitled') + '" was autosaved on ' + new Date(saved.when).toLocaleString() + '.', ok: 'Restore', cancel: 'Keep demo' });
    if (ok) { await Project.fromBuffer(await saved.blob.arrayBuffer()); toast('Session restored', 'ok'); }
  }
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot); else boot();
