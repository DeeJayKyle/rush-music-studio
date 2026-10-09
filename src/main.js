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
    const add = el('button', { class: 'icon-btn', title: 'Add to mix: new track after the last song, crossfaded', 'aria-label': 'Add to mix' }, icon('plus'));
    add.addEventListener('click', (e) => { e.stopPropagation(); setView('arrange'); Arrange.addToMix(A); });
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
        { label: 'Add to mix (crossfaded after the last song)', action: () => { setView('arrange'); Arrange.addToMix(A); } },
        { label: 'Add to new track at the cursor', action: () => { Arrange.placeAsset(A, P.tracks.length, P.cursor); setView('arrange'); } },
        { label: 'Open in Editor', action: () => Editor.open(A.id) },
        { label: 'Load to stems deck', action: () => { setView('stems'); Deck.load(A.id); } },
        { label: 'Separate again with AI (HTDemucs)', disabled: !(A.stems.state === 'done' && A.stems.engine !== 'ai' && AI.status === 'ready'), action: () => { A.stems = { state: 'none', buffers: null, peaks: null, promise: null, ms: 0 }; bus.emit('assets'); setView('stems'); Deck.load(A.id); } },
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
function updateLen() { const e = projectEndBeats(); $('#statusLen').textContent = 'Length ' + fmtShort(T.b2s(e)) + ' · ' + P.tracks.length + ' tracks'; }

// ---- menus ------------------------------------------------------------------------
const MENUS = {
  file: () => SHELL_MENUS.file(),
  view: () => SHELL_MENUS.view(),
  options: () => SHELL_MENUS.options(),
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
    { label: 'Insert tempo change at cursor…', key: 'T', action: () => { setView('arrange'); Arrange.tempoDialog(null, P.cursor); } },
    { label: 'Insert marker at cursor', key: 'M', action: () => Arrange.addMarker(P.cursor) },
    { label: 'Crossfade all overlapping clips', key: 'Shift+X', action: () => Arrange.crossfadeAll() },
    { label: 'Mixtape settings…', action: () => Arrange.mixSettings() },
    { label: 'Go to…', key: 'Ctrl+G', action: goTo },
    '-',
    { label: 'Track effects…', key: 'Ctrl+K', action: () => { const t = P.tracks.find((x) => x.id === S.selTrack) || P.tracks[0]; if (t) Chainer.forTrack(t); } },
    { label: 'Master effects…', action: () => Chainer.forMaster() },
    { label: 'Starting tempo…', action: () => Arrange.tempoDialog(T.list()[0]) },
  ],
  process: () => [{ label: 'Editor', header: true }, ...Editor.processMenuItems(), '-', { label: 'Effects', header: true }, ...Editor.fxMenuItems()].map((it) => (typeof it === 'object' && it.action ? Object.assign({}, it, { action: () => { if (!Editor.asset) { Editor.ensure(); } setView('editor'); it.action(); } }) : it)),
  help: () => [
    { label: 'Keyboard shortcuts', action: showShortcuts },
    { label: 'About Rush Music Studio', action: showAbout },
  ],
};
async function goTo() {
  const r = await showDialog({ title: 'Go to', desc: 'Type a bar (e.g. 33 or 33.3) or a time (e.g. 4:30).', fields: [{ id: 'p', label: 'Position', value: fmtBars(P.cursor, P.bpb).replace(/\.000$/, '') }], ok: 'Go' });
  if (!r || !r.p) return;
  const v = r.p.trim();
  let b = null;
  const tm = v.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (tm) b = T.s2b(+tm[1] * 60 + +tm[2]);
  else { const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/); if (m) b = (m[1] - 1) * P.bpb + (m[2] ? m[2] - 1 : 0) + (m[3] ? m[3] / 1000 : 0); }
  if (b == null) { toast('Use a bar like 33.3 or a time like 4:30.', 'err'); return; }
  setView('arrange'); Arrange.setCursor(b);
}
function showShortcuts() {
  const groups = [
    ['Transport', [['Space', 'Play / pause'], ['Home / End', 'Start / end of project'], ['R', 'Record'], ['L', 'Loop on/off'], ['C', 'Metronome'], ['[  ]', 'Tempo −/+ 0.1 BPM (Shift: 1 BPM)'], ['Ctrl+G', 'Go to bar or time']]],
    ['Navigate', [['← →', 'Move cursor by snap (Shift: by bar)'], ['Ctrl+← / Ctrl+→', 'Previous / next marker or tempo change'], [', .', 'Previous / next marker or tempo change'], ['Tab / Shift+Tab', 'Next / previous clip'], ['↑ ↓', 'Zoom in / out'], ['Ctrl+↑ / Ctrl+↓', 'Taller / shorter tracks'], ['F', 'Fit whole project'], ['Z', 'Zoom to selected clip or loop'], ['PgUp / PgDn', 'Page left / right']]],
    ['Mouse & touchpad', [['Wheel', 'Scroll tracks'], ['Shift+wheel / swipe', 'Scroll left / right'], ['Ctrl+wheel / pinch', 'Zoom'], ['Alt+wheel', 'Track height'], ['Middle-drag', 'Pan'], ['Overview strip', 'Click or drag to jump'], ['Double-click ruler', 'Loop that bar'], ['Double-click tempo lane', 'Add tempo change']]],
    ['Edit', [['Double-click clip / Alt+Enter', 'Clip properties (tempo, beat grid, pitch)'], ['Shift+↑ / Shift+↓', 'Clip pitch ±1 semitone'], ['T / Shift+T', 'Insert / edit tempo change'], ['M', 'Insert marker'], ['E / Shift+E', 'Clip effects / track effects'], ['X / Shift+X', 'Crossfade clip / all overlaps'], ['S', 'Split'], ['Ctrl+C X V', 'Copy, cut, paste clip'], ['Ctrl+D', 'Duplicate clip'], ['Alt+← →', 'Nudge clip'], ['Alt-drag', 'Copy clip'], ['Shift-drag', 'Ignore snap'], ['V / P', 'Volume / pan envelope'], ['Shift+R', 'Reverse clip'], ['Shift+Q', 'Track EQ'], ['Del', 'Delete clip']]],
    ['Tools & options', [['A', 'Edit tool'], ['D', 'Draw tool'], ['G', 'Envelope tool'], ['I', 'Time selection tool'], ['U', 'Erase tool'], ['F8', 'Snapping on/off'], ['Ctrl+L', 'Ripple edits'], ['Ctrl+Shift+X', 'Automatic crossfades'], ['Shift+B', 'Bypass all effects']]],
    ['Explorer', [['Alt+1 / Alt+2', 'Media / Explorer'], ['↑ ↓', 'Select file (auto-preview)'], ['Enter', 'Add to mix'], ['Shift+Enter', 'Import only'], ['Space', 'Preview / stop'], ['← →', 'Skip 10 s · folder up / open'], ['Backspace', 'Up a folder']]],
    ['App', [['1 2 3 4', 'Arrange, Editor, Stems, Mixer'], ['Ctrl+K', 'Effects chain'], ['Ctrl+S / Ctrl+O', 'Save / open'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+N', 'New project'], ['Alt+Enter', 'Project properties (no clip selected)'], ['Ctrl+,', 'Preferences'], ['Ctrl+B', 'Show / hide library'], ['Ctrl+I', 'Import audio'], ['Ctrl+E', 'Export mix'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['?', 'This list']]],
  ];
  const bg = el('div', { class: 'modal-bg' });
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = (e) => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  const box = el('div', { class: 'modal shortcuts', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' },
    el('header', {}, el('h3', {}, 'Keyboard, mouse & touchpad'), el('p', {}, 'Rush is built to be driven from the keyboard while you mix.')),
    el('div', { class: 'sc-grid' }, groups.map(([g, rows]) => el('section', {}, el('h4', {}, g), el('dl', {}, rows.map(([k, d]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, d)]))))),
    el('footer', {}, el('div', { class: 'spacer' }), el('button', { class: 'btn primary', onclick: close }, 'Close')));
  bg.addEventListener('pointerdown', (e) => { if (e.target === bg) close(); });
  bg.append(box); document.body.append(bg);
}
function showShortcutsOld() {
  showDialog({ title: 'Keyboard shortcuts', cancel: null, ok: 'Close', desc: 'Ctrl+K effects (Plug-in Chainer) · Shift+M insert marker · , and . jump between markers · Editor: M marker, R region from selection · Space play/pause · Home go to start · R record · L loop · M metronome · 1–4 switch view · Ctrl+S save · Ctrl+O open · Ctrl+I import · Ctrl+E export · Ctrl+Z/Y undo/redo. Arrange: S split, Ctrl+D duplicate, Del delete, ←/→ nudge, +/− zoom, Alt-drag copies a clip, Shift-drag ignores snap, drag in the ruler to set a loop. Editor: drag to select, Shift-click extends, Ctrl+X/C/V, Ctrl+T trim, Ctrl+A select all, wheel scrolls, Ctrl+wheel zooms. Stems: Z vocals, X melody, C bass, V drums.' });
}
function showAbout() {
  showDialog({ title: 'Rush Music Studio', cancel: null, ok: 'Close', desc: 'An offline, open-source studio: a loop-based multitrack arranger with envelopes and markers, a sample-accurate audio editor with markers and regions, ' + Object.keys(Plugins.REG).length + ' original real-time plugins with a Plug-in Chainer, a real-time four-stem separator and a mixer. No licence key, no account, no internet needed. DSP runs on ' + Pool.size + ' background threads on this machine. Released under the MIT licence.' });
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
  $('#tFollow').setAttribute('aria-pressed', String(!!S.follow));
  showTempo(Engine.playing ? Engine.posBeats() : P.cursor);
  $('#tRec').setAttribute('aria-pressed', String(Engine.recording));
  $('#snapSel').value = String(P.snap);
  updatePos();
}
function showTempo(b) {
  const v = T.bpmAt(b), L = T.list(), i = T.indexAt(b), g = T.build()[i];
  const inp = $('#bpmInput');
  if (document.activeElement !== inp) inp.value = +v.toFixed(2);
  $('#bpmLabel').textContent = g && g.ramp ? 'Tempo ↗' : L.length > 1 ? 'Tempo · ' + (i + 1) + '/' + L.length : 'Tempo';
  const ov = $('#ovTempo'); if (ov) ov.textContent = '♩ ' + v.toFixed(1);
}
function updatePos() {
  const b = Engine.playing ? Engine.posBeats() : P.cursor;
  $('#posBars').textContent = fmtBars(b, P.bpb);
  $('#posTime').textContent = fmtTime(T.b2s(b));
}
function nudgeTempo(d) { setBpm(Math.round((T.bpmAt(Engine.playing ? Engine.posBeats() : P.cursor) + d) * 100) / 100); status('Tempo ' + T.bpmAt(P.cursor).toFixed(2) + ' BPM'); }
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
  $('#tFollow').addEventListener('click', () => { S.follow = !S.follow; bus.emit('transport'); status(S.follow ? 'The view follows the playhead' : 'The view stays put while playing'); });
  $('#tPrevM').addEventListener('click', () => { setView('arrange'); Arrange.jumpMarker(-1); });
  $('#tNextM').addEventListener('click', () => { setView('arrange'); Arrange.jumpMarker(1); });
  $('#addTempoBtn').addEventListener('click', () => { setView('arrange'); Arrange.tempoDialog(null, P.cursor); });
  $('#addMarkerBtn').addEventListener('click', () => { setView('arrange'); Arrange.addMarker(P.cursor); });
  $('#bpmUp').addEventListener('click', (e) => nudgeTempo(e.shiftKey ? 1 : 0.1));
  $('#bpmDown').addEventListener('click', (e) => nudgeTempo(e.shiftKey ? -1 : -0.1));
  $('#bpmInput').addEventListener('wheel', (e) => { e.preventDefault(); nudgeTempo((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 1 : 0.1)); }, { passive: false });
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
    const lbpm = Math.round(T.bpmAt(P.cursor) * 100) / 100;
    const buf = await LoopLab.generate({ style, part, key, bars, bpm: lbpm, bpb: P.bpb, seed: (Math.random() * 1e9) | 0 });
    const ks = key.replace(' minor', 'm').replace(' major', '');
    const A = addAsset(`${style} ${part.toLowerCase()} · ${ks}`, buf, { bpm: lbpm, beats: bars * P.bpb, isLoop: true, generated: true, key: null });
    toast('Generated ' + A.name + ' at ' + lbpm + ' BPM. Drag it onto the timeline.', 'ok');
  } catch (e) { toast('Could not generate the loop: ' + e.message, 'err'); }
  btn.disabled = false;
}

// ---- keyboard ---------------------------------------------------------------------------
function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && !['range', 'checkbox', 'button'].includes(e.target.type)) return;
  if (tag === 'select' || tag === 'textarea' || document.querySelector('.modal-bg')) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 's') { e.preventDefault(); FileIO.save(e.shiftKey); return; }
  if (mod && k === 'o') { e.preventDefault(); FileIO.open(); return; }
  if (mod && e.key === ',') { e.preventDefault(); showPrefs(); return; }
  if (mod && k === 'b') { e.preventDefault(); toggleView('showLibrary'); return; }
  if (e.key === 'F8') { e.preventDefault(); toggleSnap(); return; }
  if (e.altKey && !mod && (e.key === '1' || e.code === 'Digit1')) { e.preventDefault(); setSideTab('media'); return; }
  if (e.altKey && !mod && (e.key === '2' || e.code === 'Digit2')) { e.preventDefault(); setSideTab('explorer'); return; }
  if (e.altKey && e.key === 'Enter' && !(S.view === 'arrange' && Arrange.selected())) { e.preventDefault(); projectProps(false).then((r) => r && applyProps(r)); return; }
  if (!mod && e.shiftKey && k === 'b') { e.preventDefault(); toggleBypass(); return; }
  if (mod && k === 'l' && !e.shiftKey) { e.preventDefault(); PREF.ripple = !PREF.ripple; savePrefs(); status(PREF.ripple ? 'Ripple on: later clips follow your edits' : 'Ripple off'); return; }
  if (mod && e.shiftKey && k === 'x') { e.preventDefault(); PREF.autoXfade = !PREF.autoXfade; savePrefs(); status(PREF.autoXfade ? 'Automatic crossfades on' : 'Automatic crossfades off'); return; }
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
  if (k === 'home') { Arrange.setCursor(0); $('#tlScroll').scrollLeft = 0; return; }
  if (!mod && !e.shiftKey && k === 'r') { if (Engine.recording) Engine.pause(); else Engine.startRecord(); return; }
  if (!mod && k === 'l') { toggleLoop(); return; }
  if (!mod && k === 'c' && S.view === 'arrange') { P.metro = !P.metro; bus.emit('transport'); status(P.metro ? 'Metronome on' : 'Metronome off'); return; }
  if (!mod && (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}')) { e.preventDefault(); nudgeTempo((e.key === ']' || e.key === '}' ? 1 : -1) * (e.shiftKey ? 1 : 0.1)); return; }
  if (mod && k === 'g') { e.preventDefault(); goTo(); return; }
  if (e.key === '?' || e.key === 'F1') { e.preventDefault(); showShortcuts(); return; }
  if (k === 'end' && S.view !== 'arrange') return;
  if (k === 'escape') { S.selClip = null; Arrange.draw(); return; }
  if (S.view === 'arrange' && Arrange.key(e)) { e.preventDefault(); }
}

// ---- animation loop: playhead, meters, clocks ----------------------------------------
function frame() {
  if (Engine.playing) {
    updatePos();
    const pb = Engine.posBeats(); if (!frame._t || performance.now() - frame._t > 120) { frame._t = performance.now(); showTempo(pb); if (S.view === 'arrange') Arrange.drawOverview(); }
    if (S.view === 'arrange') { Arrange.follow(); Arrange.drawOverlay(); Arrange.tickMeters(); }
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
    t.clips.push({ id: uid('c'), asset: A.id, start: s, len: e - s, offset: 0, offB: 0, sync: true, loop: true, gain: 0, fadeIn: 0, fadeOut: 0, fadeCurve: 'eq', fx: [] });
    P.tracks.push(t);
  });
  P.loop = { on: false, start: 16, end: 32 };
  // a gentle tempo lift in the second half shows off the tempo lane
  P.tempo = [{ id: uid('tm'), b: 0, bpm: 105, ramp: false }, { id: uid('tm'), b: 32, bpm: 105, ramp: false }, { id: uid('tm'), b: 48, bpm: 108, ramp: true }];
  P.markers = [{ id: uid('m'), b: 0, name: 'Intro' }, { id: uid('m'), b: 16, name: 'Groove' }, { id: uid('m'), b: 48, name: 'Lift' }];
  P.tracks[3].clips[0].fx = [Plugins.instance('filter', { type: 'lowpass', freq: 1800, q: 1.2, rate: 0.12, depth: 60 })];
  migrateProject();
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
  initShell();
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
