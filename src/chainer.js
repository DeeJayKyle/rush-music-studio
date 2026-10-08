// ---------------------------------------------------------------------------
// Plug-in Chainer — edit an effect chain (live on a track/master, or to apply
// destructively in the Editor)
// ---------------------------------------------------------------------------
const Chainer = (() => {
  function open({ title, fx, live = true, onChange, onPreview, applyLabel = 'Apply' }) {
    return new Promise((resolve) => {
      let sel = fx.length ? fx[0].id : null;
      let raf = 0;
      const changed = () => { if (!onChange) return; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => onChange(fx)); };
      const bg = el('div', { class: 'modal-bg' });
      const box = el('div', { class: 'modal chainer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
      const listEl = el('div', { class: 'ch-list', role: 'list' });
      const paramsEl = el('div', { class: 'ch-params' });
      const addSel = el('select', { 'aria-label': 'Add a plugin' }, el('option', { value: '' }, '+ Add plugin…'),
        Plugins.list().map((g) => el('optgroup', { label: g.cat }, g.items.map((d) => el('option', { value: d.type }, d.name)))));
      addSel.addEventListener('change', () => {
        if (!addSel.value) return;
        const inst = Plugins.instance(addSel.value);
        fx.push(inst); sel = inst.id; addSel.value = '';
        renderList(); renderParams(); changed();
      });
      function renderList() {
        listEl.innerHTML = '';
        if (!fx.length) listEl.append(el('div', { class: 'ch-empty' }, 'The chain is empty. Add a plugin to start.'));
        fx.forEach((f, i) => {
          const d = Plugins.REG[f.type];
          const on = el('input', { type: 'checkbox', checked: f.on ? true : null, 'aria-label': 'Enable ' + d.name, title: 'Bypass' });
          on.addEventListener('change', (e) => { e.stopPropagation(); f.on = on.checked; changed(); row.classList.toggle('off', !f.on); });
          on.addEventListener('click', (e) => e.stopPropagation());
          const btn = (ic, label, fn, dis) => { const b = el('button', { class: 'icon-btn', title: label, 'aria-label': label, disabled: dis ? true : null }, ic); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
          const row = el('div', { class: 'ch-row' + (f.id === sel ? ' sel' : '') + (f.on ? '' : ' off'), role: 'listitem', tabindex: '0' },
            on, el('span', { class: 'ch-num' }, String(i + 1)), el('span', { class: 'ch-name' }, d.name),
            btn('▲', 'Move up', () => { fx.splice(i - 1, 0, fx.splice(i, 1)[0]); renderList(); changed(); }, i === 0),
            btn('▼', 'Move down', () => { fx.splice(i + 1, 0, fx.splice(i, 1)[0]); renderList(); changed(); }, i === fx.length - 1),
            btn('✕', 'Remove', () => { fx.splice(i, 1); if (sel === f.id) sel = fx.length ? fx[Math.max(0, i - 1)].id : null; renderList(); renderParams(); changed(); }));
          row.addEventListener('click', () => { sel = f.id; renderList(); renderParams(); });
          row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { sel = f.id; renderList(); renderParams(); } });
          listEl.append(row);
        });
      }
      function renderParams() {
        paramsEl.innerHTML = '';
        const f = fx.find((x) => x.id === sel);
        if (!f) { paramsEl.append(el('div', { class: 'ch-empty' }, 'Select a plugin in the chain to adjust it.')); return; }
        const d = Plugins.REG[f.type];
        // presets
        const pr = Plugins.presets(f.type);
        const psel = el('select', { 'aria-label': 'Preset' }, el('option', { value: '' }, 'Presets…'),
          el('optgroup', { label: 'Factory' }, el('option', { value: 'f:__default' }, 'Default'), Object.keys(pr.factory).map((n) => el('option', { value: 'f:' + n }, n))),
          Object.keys(pr.user).length ? el('optgroup', { label: 'My presets' }, Object.keys(pr.user).map((n) => el('option', { value: 'u:' + n }, n))) : null);
        psel.addEventListener('change', () => {
          const v = psel.value; if (!v) return;
          const name = v.slice(2);
          const base = Plugins.defaults(f.type);
          f.params = Object.assign(base, v === 'f:__default' ? {} : v[0] === 'f' ? pr.factory[name] : pr.user[name]);
          renderParams(); changed(); status('Loaded preset ' + (v === 'f:__default' ? 'Default' : name));
        });
        const saveBtn = el('button', { class: 'btn sm' }, 'Save preset');
        saveBtn.addEventListener('click', async () => {
          const r = await showDialog({ title: 'Save preset', fields: [{ id: 'n', label: 'Preset name', value: '' }], ok: 'Save' });
          if (r && r.n) { Plugins.savePreset(f.type, r.n, { ...f.params }); renderParams(); toast('Saved preset ' + r.n, 'ok'); }
        });
        const delBtn = el('button', { class: 'btn sm ghost', disabled: Object.keys(pr.user).length ? null : true }, 'Delete preset');
        delBtn.addEventListener('click', () => { const v = psel.value; if (!v.startsWith('u:')) { toast('Pick one of your presets in the list first.'); return; } Plugins.deletePreset(f.type, v.slice(2)); renderParams(); });
        paramsEl.append(
          el('div', { class: 'ch-head' }, el('div', {}, el('h4', {}, d.name), el('p', {}, d.desc)), el('label', { class: 'ch-on' }, (() => { const c = el('input', { type: 'checkbox', checked: f.on ? true : null }); c.addEventListener('change', () => { f.on = c.checked; renderList(); changed(); }); return c; })(), 'On')),
          el('div', { class: 'ch-presets' }, psel, saveBtn, delBtn));
        const grid = el('div', { class: 'ch-knobs' });
        for (const p of d.params) {
          if (p.options) {
            const s = el('select', { 'aria-label': p.label }, p.options.map((o) => el('option', { value: o.value, selected: String(f.params[p.id]) === String(o.value) ? true : null }, o.label)));
            s.addEventListener('change', () => { f.params[p.id] = s.value; changed(); });
            grid.append(el('div', { class: 'ch-opt' }, el('span', { class: 'lbl' }, p.label), s));
            continue;
          }
          const lg = !!p.log;
          const toN = (v) => (lg ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
          const fromN = (n) => { const v = lg ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min); return p.step ? Math.round(v / p.step) * p.step : v; };
          const fmt = p.fmt || ((v) => v.toFixed(1));
          const k = knob({ label: p.label, min: 0, max: 1, step: 0.001, value: clamp(toN(f.params[p.id]), 0, 1), def: clamp(toN(p.def), 0, 1), format: (n) => fmt(fromN(n)), onInput: (n) => { f.params[p.id] = fromN(n); changed(); } });
          grid.append(k.el);
        }
        paramsEl.append(grid);
      }
      const done = (v) => { cancelAnimationFrame(raf); if (onChange && v) onChange(fx); bg.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(live ? fx : null); } };
      document.addEventListener('keydown', onKey, true);
      const footer = el('footer', {},
        onPreview ? el('button', { type: 'button', class: 'btn', onclick: () => onPreview(fx) }, icon('play'), 'Preview') : null,
        onPreview ? el('button', { type: 'button', class: 'btn ghost', onclick: () => Engine.stopPreview() }, 'Stop') : null,
        el('div', { class: 'spacer' }),
        live ? null : el('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'Cancel'),
        el('button', { type: 'button', class: 'btn primary', onclick: () => done(fx) }, live ? 'Done' : applyLabel));
      box.append(
        el('header', {}, el('h3', {}, title), el('p', {}, live ? 'Changes are heard immediately. Effects run in the order listed.' : 'Shape the sound, preview it, then apply it to the selection (or the whole file).')),
        el('div', { class: 'ch-body' }, el('div', { class: 'ch-left' }, listEl, addSel), paramsEl),
        footer);
      bg.addEventListener('pointerdown', (e) => { if (e.target === bg) done(live ? fx : null); });
      bg.append(box); document.body.append(bg);
      renderList(); renderParams();
      if (!fx.length) addSel.focus();
    });
  }

  async function forTrack(t) {
    Hist.push();
    t.fx = t.fx || [];
    await open({ title: 'Effects · ' + t.name, fx: t.fx, live: true, onChange: () => { Engine.applyAll(); bus.emit('tracks'); markDirty(); } });
    bus.emit('tracks'); Arrange.renderHeads(); if (S.view === 'mixer') Mixer.render();
  }
  async function forMaster() {
    Hist.push();
    P.master.fx = P.master.fx || [];
    await open({ title: 'Effects · Master', fx: P.master.fx, live: true, onChange: () => { Engine.applyAll(); markDirty(); } });
    if (S.view === 'mixer') Mixer.render();
  }
  return { open, forTrack, forMaster };
})();
