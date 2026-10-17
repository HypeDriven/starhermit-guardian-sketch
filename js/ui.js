/* Guardian Sketch — DOM shell (ES module).
 * Semantic HTML over/around the canvas: title, mode setup, journey map,
 * HUD, pause, settings, results, help, learn overlay, board mirror,
 * toasts, captions, live regions. UI never touches rules truth.
 */

import { PRESETS, CATEGORIES as GFX_CATEGORIES, presetTier, resolve as resolveGfx, choosePreset, clampScale } from './gfx.js';
import { gfxStrings, fmt } from './gfx-i18n.js';
import { platformStrings } from './platform-i18n.js';

const I18N = window.GSI18N;
const T = I18N.T, L = I18N.L;

// Text may be a plain string or a message (L(...) / function): messages are
// re-rendered in place when the language changes.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) I18N.setText(n, text);
  return n;
}
function btn(label, cls, onClick) {
  const b = el('button', 'gs-btn' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function hexCss(hex) { return '#' + ('000000' + hex.toString(16)).slice(-6); }
// Decorative illustration that removes itself if the asset fails to load,
// so layouts never show a broken-image box.
function art(src, cls) {
  const img = el('img', cls);
  img.src = src;
  img.alt = '';
  img.decoding = 'async';
  img.setAttribute('aria-hidden', 'true');
  img.addEventListener('error', function () { img.remove(); });
  return img;
}

const INVALID_TEXT = {
  'ink-exhausted': L('Not enough ink'),
  'out-of-bounds': L('Out of bounds'),
  'stroke-too-short': L('Stroke too short'),
  'too-many-points': L('Too many points'),
  'stroke-limit': L('No strokes left'),
  'wrong-phase': L('Not now'),
  'game-ended': L('Round already ended'),
  'unknown-command': L('Unknown action'),
  'malformed-command': L('Malformed action')
};
/** Player-facing text for a rejected-command reason (a message). */
export function reasonText(reason) { return INVALID_TEXT[reason] || (reason ? reason : L('Not allowed')); }

export function createUI(root, handlers) {
  handlers = handlers || {};
  const H = function (name, arg) { if (handlers[name]) handlers[name](arg); };
  const clickSfx = function () { H('onUiSound'); };

  // ---------- persistent chrome ----------
  const livePolite = el('div', 'gs-live');
  livePolite.setAttribute('aria-live', 'polite');
  const liveAssert = el('div', 'gs-live');
  liveAssert.setAttribute('aria-live', 'assertive');
  const captionLine = el('div', 'gs-caption gs-hidden');
  captionLine.setAttribute('aria-live', 'assertive');
  const toastBox = el('div', 'gs-toasts');
  toastBox.setAttribute('aria-hidden', 'true');
  const mirror = el('aside', 'gs-mirror gs-hidden');
  I18N.setAttr(mirror, 'aria-label', L('Board state'));
  root.append(livePolite, liveAssert, captionLine, toastBox, mirror);

  function announce(text) { livePolite.textContent = ''; livePolite.textContent = I18N.text(text); }
  function announceAssert(text) { liveAssert.textContent = ''; liveAssert.textContent = I18N.text(text); }

  let captionTimer = null;
  function caption(text) {
    captionLine.classList.remove('gs-hidden');
    captionLine.textContent = I18N.text(text);
    clearTimeout(captionTimer);
    captionTimer = setTimeout(function () { captionLine.classList.add('gs-hidden'); }, 2200);
  }
  function setCaptionsVisible(on) { if (!on) captionLine.classList.add('gs-hidden'); }

  function toast(text) {
    const t = el('div', 'gs-toast', I18N.text(text));
    toastBox.appendChild(t);
    fitToasts();
    announceAssert(text);
    setTimeout(function () { t.classList.add('out'); }, 1800);
    setTimeout(function () { t.remove(); fitToasts(); }, 2300);
  }
  // While a modal is open the toasts sit at the top edge and the overlay
  // reserves their height (layout px of the equally zoomed stack), so a toast
  // never covers a panel heading or button.
  function fitToasts() {
    const h = toastBox.offsetHeight;
    document.documentElement.style.setProperty('--gs-toast-h', h ? (h + 8) + 'px' : '0px');
  }
  function toastReason(reason) { toast(reasonText(reason)); }

  // ---------- modal stack ----------
  const overlayRoot = el('div', 'gs-overlay-root');
  root.appendChild(overlayRoot);
  const modalStack = []; // {node, restoreFocus}

  function openModal(node, opts) {
    opts = opts || {};
    const wrap = el('div', 'gs-overlay');
    wrap.appendChild(node);
    overlayRoot.appendChild(wrap);
    const rec = { node: wrap, restoreFocus: document.activeElement, dismissable: opts.dismissable !== false };
    modalStack.push(rec);
    wrap.addEventListener('mousedown', function (ev) {
      if (ev.target === wrap && rec.dismissable) closeModal();
    });
    const focusable = node.querySelector('button, [href], input, select, [tabindex]');
    // no scroll: a first button low in a tall panel (results on a phone) would
    // otherwise open the panel scrolled past its heading
    if (focusable) focusable.focus({ preventScroll: true });
    node.scrollTop = 0;
    return rec;
  }
  function closeModal() {
    const rec = modalStack.pop();
    if (!rec) return;
    rec.node.remove();
    if (rec.restoreFocus && rec.restoreFocus.focus) rec.restoreFocus.focus();
    if (!modalStack.length && handlers.onModalClosed) handlers.onModalClosed();
  }
  function closeAllModals() { while (modalStack.length) closeModal(); }
  function isModalOpen() { return modalStack.length > 0; }

  root.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && modalStack.length) {
      const top = modalStack[modalStack.length - 1];
      if (top.dismissable) { ev.stopPropagation(); closeModal(); }
    }
  });

  function panel(titleText) {
    const p = el('section', 'gs-panel');
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-modal', 'true');
    const h = el('h2', null, titleText);
    h.id = 'gs-panel-title-' + Math.random().toString(36).slice(2, 8);
    p.setAttribute('aria-labelledby', h.id);
    p.appendChild(h);
    return p;
  }

  // ---------- title ----------
  let titleNode = null;
  let dailyCountdownEl = null;
  let syncStatusEl = null;
  function showTitle(data) {
    hideAll();
    titleNode = el('div', 'gs-title');
    const card = el('div', 'gs-title-card');
    // two halves: display:contents everywhere except short landscape, where
    // they become side-by-side columns so the whole title fits without scrolling
    const head = el('div', 'gs-title-col gs-title-head');
    const menu = el('div', 'gs-title-col gs-title-menu');
    card.append(head, menu);
    head.appendChild(art('./assets/key-art.webp', 'gs-title-art'));
    head.appendChild(el('h1', 'gs-logo', 'Guardian Sketch'));
    head.appendChild(el('p', 'gs-tagline', L('Draw ink. Shield the wisps. Weather the storm.')));

    const stats = el('p', 'gs-title-stats', function () {
      return T('Journey stars: {n} / 120', { n: data.totalStars }) + '  ·  ' +
        (data.dailyDone ? T('Today’s daily: done ({score})', { score: data.dailyDone }) : T('Today’s daily: open'));
    });
    head.appendChild(stats);

    dailyCountdownEl = el('p', 'gs-daily-countdown', data.nextDailyText || '');
    head.appendChild(dailyCountdownEl);

    syncStatusEl = el('p', 'gs-sync-status', data.syncText || '');
    head.appendChild(syncStatusEl);

    const grid = el('div', 'gs-title-grid');
    const play = btn(L('Play'), 'primary big', function () { clickSfx(); H('onPlay'); });
    grid.appendChild(play);
    [[L('Journey'), 'onOpenJourney'], [L('Daily'), 'onOpenDaily'], [L('Practice'), 'onOpenPractice'],
     [L('Challenges'), 'onOpenChallenges'], [L('Tempest Stand'), 'onOpenStorm'], [L('Learn'), 'onOpenLearn'],
     [L('Help'), 'onOpenHelp'], [L('Settings'), 'onOpenSettings'], [L('Scores'), 'onOpenScores']]
      .forEach(function (pair) {
        grid.appendChild(btn(pair[0], null, function () { clickSfx(); H(pair[1]); }));
      });
    menu.appendChild(grid);
    // StarHermit: sign-in on the platform host without a token; invite link when signed in.
    if (data.canSignIn || data.signedIn) {
      const acct = el('div', 'gs-row gs-account-row');
      if (data.canSignIn) acct.appendChild(btn(function () { return platformStrings().signIn; }, null, function () { clickSfx(); H('onSignIn'); }));
      if (data.signedIn) acct.appendChild(btn(function () { return platformStrings().invite; }, null, function () { clickSfx(); H('onInvite'); }));
      menu.appendChild(acct);
    }
    if (data.compatWarning) menu.appendChild(el('p', 'gs-compat', data.compatWarning));
    titleNode.appendChild(card);
    root.appendChild(titleNode);
    play.focus();
    announce(L('Guardian Sketch title screen. Press Play to continue your journey.'));
  }
  function updateDailyCountdown(text) { if (dailyCountdownEl) I18N.setText(dailyCountdownEl, text); }
  function updateSyncStatus(text) { if (syncStatusEl) I18N.setText(syncStatusEl, text); }

  // ---------- mode setup ----------
  function hazardLegend(cfg) {
    const seen = {};
    (cfg.emitters || []).forEach(function (e) { seen[e.type] = true; });
    const row = el('div', 'gs-legend');
    Object.keys(seen).forEach(function (t) {
      const hz = window.GSContent.HAZARDS[t];
      const chip = el('span', 'gs-chip', function () { return hz.icon + ' ' + T(hz.label); });
      chip.style.borderColor = hexCss(hz.color);
      row.appendChild(chip);
    });
    return row;
  }

  function rulesSummary(cfg) {
    const ul = el('ul', 'gs-rules-summary');
    const items = [
      L('Ink budget: {budget} units · up to {strokes} strokes', { budget: cfg.ink.budget, strokes: cfg.ink.maxStrokes }),
      L('Storm length: {s} seconds', { s: (cfg.simTicks / 60).toFixed(0) }),
      L('Creatures to protect: {n}', { n: cfg.creatures.length })
    ];
    if (cfg.par) items.push(L('Par: ★★ at {two} · ★★★ at {three}', { two: cfg.par.score2, three: cfg.par.score3 }));
    items.push(L('Assists: undo {undo} · hint {hint}', { undo: cfg.mechanics.undo ? L('on') : L('off'), hint: cfg.mechanics.hint ? L('on') : L('off') }));
    items.forEach(function (t) { ul.appendChild(el('li', null, t)); });
    return ul;
  }

  function showModeSetup(data) {
    // data: {title, cfg, ranked, modeLabel, note, onStart}
    const p = panel(data.title);
    p.appendChild(el('p', 'gs-mode-label', L(data.ranked ? '{mode} · ranked' : '{mode} · unranked', { mode: data.modeLabel })));
    if (data.note) p.appendChild(el('p', 'gs-note', data.note));
    if (data.cfg.intro) p.appendChild(el('p', 'gs-intro', L(data.cfg.intro)));
    p.appendChild(hazardLegend(data.cfg));
    p.appendChild(rulesSummary(data.cfg));
    p.appendChild(el('p', 'gs-note', L('Expected duration: under a minute.')));
    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Start'), 'primary', function () { clickSfx(); closeModal(); data.onStart(); }));
    row.appendChild(btn(L('Cancel'), null, function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- journey map ----------
  function showJourney(data) {
    // data: {levels:[{cfg, stars, locked, mastery, themeName}], onPick(cfg)}
    const p = panel(L('Journey'));
    const grid = el('div', 'gs-journey-grid');
    data.levels.forEach(function (lv) {
      const b = btn('', 'gs-level' + (lv.locked ? ' locked' : ''), null);
      b.disabled = lv.locked;
      const num = el('span', 'gs-level-num', String(lv.cfg.index + 1));
      const stars = el('span', 'gs-stars', '★'.repeat(lv.stars) + '☆'.repeat(3 - lv.stars));
      b.append(num, stars);
      I18N.setAttr(b, 'title', function () {
        let s = T(lv.cfg.name);
        if (lv.mastery) s = T('{name} (Mastery)', { name: s });
        s = T('{name} — {theme}', { name: s, theme: L(lv.themeName) });
        return lv.locked ? T('{label} — locked: earn a star on the previous stage', { label: s }) : s;
      });
      if (lv.mastery) b.classList.add('mastery');
      if (!lv.locked) b.addEventListener('click', function () { clickSfx(); closeModal(); data.onPick(lv.cfg); });
      grid.appendChild(b);
    });
    p.appendChild(grid);
    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Back'), null, function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- practice setup ----------
  function showPractice(data) {
    // data: {presets, seed, onStart(presetId, seed), onNewSeed()}
    const p = panel(L('Practice'));
    p.appendChild(el('p', 'gs-note', L('Unranked. Undo and hints are on. Restarting with the same seed gives the same layout.')));
    const sel = el('select', 'gs-select');
    data.presets.forEach(function (pr) {
      const o = el('option', null, L('{name} — {blurb}', { name: L(pr.name), blurb: L(pr.blurb) }));
      o.value = pr.id;
      sel.appendChild(o);
    });
    I18N.setAttr(sel, 'aria-label', L('Difficulty'));
    p.appendChild(sel);
    const seedRow = el('div', 'gs-row gs-seedrow');
    const seedLabel = el('span', 'gs-seed', L('Seed: {seed}', { seed: data.seed }));
    seedRow.appendChild(seedLabel);
    seedRow.appendChild(btn(L('New seed'), null, function () { clickSfx(); data.onNewSeed(); }));
    p.appendChild(seedRow);
    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Start'), 'primary', function () { clickSfx(); closeModal(); data.onStart(sel.value); }));
    row.appendChild(btn(L('Cancel'), null, function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
    return { setSeed: function (s) { I18N.setText(seedLabel, L('Seed: {seed}', { seed: s })); } };
  }

  // ---------- challenges list ----------
  function showChallenges(data) {
    // data: {items:[{cfg, best}], onPick(cfg)}
    const p = panel(L('Challenges'));
    const list = el('div', 'gs-challenge-list');
    data.items.forEach(function (it) {
      const b = btn('', 'gs-challenge', null);
      b.appendChild(el('strong', null, L(it.cfg.name)));
      b.appendChild(el('span', null, it.cfg.intro ? L(it.cfg.intro) : ''));
      b.appendChild(el('span', 'gs-note', it.best != null ? L('Best: {score}', { score: it.best }) : L('Not attempted')));
      b.addEventListener('click', function () { clickSfx(); closeModal(); data.onPick(it.cfg); });
      list.appendChild(b);
    });
    p.appendChild(list);
    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Back'), null, function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- HUD ----------
  const hud = el('div', 'gs-hud gs-hidden');
  const hudObjective = el('div', 'hud-left');
  const hudStatus = el('div', 'hud-status');
  hud.append(hudObjective, hudStatus);

  const inkWrap = el('div', 'gs-ink');
  const inkBar = el('div', 'gs-ink-fill');
  const inkLabel = el('span', 'gs-ink-label');
  inkWrap.append(inkBar, inkLabel);

  const tray = el('div', 'gs-bar gs-hidden');
  const btnRelease = btn(L('Release'), 'primary', function () { H('onRelease'); });
  const btnUndo = btn(L('Undo'), null, function () { clickSfx(); H('onUndo'); });
  const btnHint = btn(L('Hint'), null, function () { clickSfx(); H('onHint'); });
  const btnSkip = btn(L('Skip ⏩'), null, function () { clickSfx(); H('onSkip'); });
  const btnPause = btn(L('❚❚ Pause'), 'ghost-btn', function () { clickSfx(); H('onPause'); });
  tray.append(btnRelease, btnUndo, btnHint, btnSkip, btnPause);
  root.append(hud, tray);

  function showHUD(data) {
    // data: {objective, undo, hint}
    hud.classList.remove('gs-hidden');
    tray.classList.remove('gs-hidden');
    hudObjective.innerHTML = '';
    hudObjective.appendChild(el('b', null, data.objective));
    btnUndo.classList.toggle('gs-hidden', !data.undo);
    btnHint.classList.toggle('gs-hidden', !data.hint);
    btnSkip.classList.add('gs-hidden');
    hud.appendChild(inkWrap);
  }
  function hideHUD() {
    hud.classList.add('gs-hidden');
    tray.classList.add('gs-hidden');
  }
  function updateHUD(d) {
    // d: {ink, inkBudget, strokesLeft, countdown (s or null), phase}
    const pct = d.inkBudget ? Math.max(0, Math.min(1, d.ink / d.inkBudget)) : 0;
    inkBar.style.width = (pct * 100).toFixed(1) + '%';
    I18N.setText(inkLabel, L('{ink} ink · {strokes} strokes', { ink: Math.round(d.ink), strokes: d.strokesLeft }));
    hudStatus.textContent = d.countdown != null ? '⏱ ' + d.countdown.toFixed(1) + 's' : '';
    btnRelease.classList.toggle('gs-hidden', d.phase !== 'draw');
    btnUndo.classList.toggle('gs-hidden', !(d.phase === 'draw' && d.undo));
    btnHint.classList.toggle('gs-hidden', !(d.phase === 'draw' && d.hint));
    btnSkip.classList.toggle('gs-hidden', d.phase !== 'resolving');
  }

  // ---------- pause ----------
  function showPause() {
    if (isModalOpen()) return;
    const p = panel(L('Paused'));
    const col = el('div', 'gs-col');
    col.appendChild(btn(L('Resume'), 'primary', function () { clickSfx(); closeModal(); H('onResume'); }));
    col.appendChild(btn(L('Settings'), null, function () { clickSfx(); H('onOpenSettings'); }));
    col.appendChild(btn(L('Help'), null, function () { clickSfx(); H('onOpenHelp'); }));
    col.appendChild(btn(L('Restart'), null, function () { clickSfx(); closeModal(); H('onRestart'); }));
    col.appendChild(btn(L('Quit to title'), null, function () { clickSfx(); closeModal(); H('onQuitToTitle'); }));
    p.appendChild(col);
    const rec = openModal(p, { dismissable: false });
    rec.isPause = true;
    announce(L('Paused'));
  }
  function isPauseOpen() {
    return modalStack.length > 0 && !!modalStack[modalStack.length - 1].isPause;
  }

  // ---------- settings ----------
  function sliderRow(label, value, onInput) {
    const row = el('label', 'gs-setrow gs-slider');
    row.appendChild(el('span', null, label));
    const input = el('input');
    input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.05';
    input.value = String(value);
    input.addEventListener('input', function () { onInput(parseFloat(input.value)); });
    row.appendChild(input);
    return row;
  }
  function toggleRow(label, value, onChange, opts) {
    const row = el('label', 'gs-setrow');
    row.appendChild(el('span', null, label));
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!value;
    if (opts && opts.disabled) input.disabled = true;
    input.addEventListener('change', function () { onChange(input.checked); });
    row.appendChild(input);
    return row;
  }
  function selectRow(label, value, options, onChange) {
    const row = el('label', 'gs-setrow');
    row.appendChild(el('span', null, label));
    const sel = el('select', 'gs-select');
    options.forEach(function (o) {
      const opt = el('option', null, o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      if (o.disabled) opt.disabled = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    row.appendChild(sel);
    return row;
  }

  // Graphics quality: preset, render scale, per-category overrides, adaptive
  // resolution, frame-rate readout and a live cost summary (strings localized).
  function graphicsControls(s, emit, infoFn) {
    let T = gfxStrings(I18N.lang);
    const box = el('div', 'gs-gfx');
    box.id = 'gfx-controls';
    let timer = null;
    const info = function () { try { return infoFn ? infoFn() : null; } catch (e) { return null; } };
    const tierName = function (t) { return T.tier[t] || t; };

    function idRow(id, label, control) {
      const row = el('div', 'gs-setrow');
      const lab = el('label', null, label);
      lab.htmlFor = id;
      control.id = id;
      row.append(lab, control);
      return row;
    }
    function select(options, value, onChange) {
      const sel = el('select', 'gs-select');
      options.forEach(function (o) {
        const opt = el('option', null, o.label);
        opt.value = o.value;
        if (o.value === value) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function () { onChange(sel.value); });
      return sel;
    }
    function set(next, keepFocusId) {
      s.graphics = next;
      emit();
      build(keepFocusId);
    }

    function build(focusId) {
      T = gfxStrings(I18N.lang);
      box.textContent = '';
      const g = s.graphics || {};
      const inf = info();
      const detected = inf ? inf.detected : 'balanced';
      const resolved = resolveGfx(g, detected);

      const presetSel = select([{ value: 'auto', label: fmt(T.auto, { tier: tierName(detected) }) }]
        .concat(PRESETS.map(function (p) { return { value: p, label: tierName(p) }; })),
      PRESETS.indexOf(g.preset) >= 0 ? g.preset : 'auto',
      function (v) { set(choosePreset(s.graphics, v), 'gfx-preset'); });
      box.appendChild(idRow('gfx-preset', T.quality, presetSel));

      const range = el('input');
      range.type = 'range'; range.min = '50'; range.max = '200'; range.step = '5';
      range.value = String(Math.round(clampScale(g.render_scale) * 100));
      const rowS = idRow('gfx-render-scale', T.renderScale, range);
      rowS.classList.add('gs-slider');
      const out = el('output', 'gs-gfx-value', range.value + '%');
      out.htmlFor = 'gfx-render-scale';
      const wrap = el('span', 'gs-gfx-range');
      rowS.replaceChild(wrap, range);
      wrap.append(range, out);
      range.addEventListener('input', function () { out.textContent = range.value + '%'; });
      range.addEventListener('change', function () {
        set(Object.assign({}, s.graphics, { render_scale: parseInt(range.value, 10) / 100 }), 'gfx-render-scale');
      });
      box.appendChild(rowS);

      Object.keys(GFX_CATEGORIES).forEach(function (cat) {
        const cur = GFX_CATEGORIES[cat].indexOf(g[cat]) >= 0 ? g[cat] : 'preset';
        const sel = select([{ value: 'preset', label: fmt(T.fromPreset, { tier: tierName(presetTier(resolved.preset, cat)) }) }]
          .concat(GFX_CATEGORIES[cat].map(function (t) { return { value: t, label: tierName(t) }; })), cur,
        function (v) {
          const next = Object.assign({}, s.graphics);
          if (v === 'preset') delete next[cat]; else next[cat] = v;
          set(next, 'gfx-' + cat);
        });
        sel.dataset.gfxCategory = cat;
        box.appendChild(idRow('gfx-' + cat, T.cat[cat], sel));
      });

      const toggle = function (id, label, checked, onChange) {
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.addEventListener('change', function () { onChange(cb.checked); });
        box.appendChild(idRow(id, label, cb));
      };
      toggle('gfx-adaptive', T.adaptive, g.adaptive !== false, function (v) {
        const next = Object.assign({}, s.graphics);
        if (v) delete next.adaptive; else next.adaptive = false;
        set(next, 'gfx-adaptive');
      });
      toggle('gfx-show-fps', T.showFps, !!g.show_fps, function (v) {
        const next = Object.assign({}, s.graphics);
        if (v) next.show_fps = true; else delete next.show_fps;
        set(next, 'gfx-show-fps');
      });

      const summary = el('p', 'gs-note gs-gfx-summary');
      summary.id = 'gfx-summary';
      summary.setAttribute('aria-live', 'polite');
      box.appendChild(summary);
      const note = el('p', 'gs-note gs-gfx-warn', T.postFailed);
      note.id = 'gfx-post-note';
      box.appendChild(note);
      refresh();
      if (focusId) { const f = box.querySelector('#' + focusId); if (f) f.focus(); }
    }

    function refresh() {
      if (!box.isConnected && timer) { clearInterval(timer); timer = null; return; }
      const inf = info();
      const summary = box.querySelector('#gfx-summary');
      const note = box.querySelector('#gfx-post-note');
      if (summary) {
        summary.textContent = inf ? [inf.gpu || T.unknownGpu, inf.level != null ? fmt(T.level, { n: inf.level }) : null, inf.summary].filter(Boolean).join(' · ') : '';
        summary.dataset.gfxPreset = inf ? inf.resolved.preset : '';
      }
      if (note) note.hidden = !(inf && inf.postFailed);
    }
    build();
    timer = setInterval(refresh, 1000);
    // A language change redraws only this inner box; the shared Sound/FPS/Language
    // sections that game-options.js mounts beside it stay in place.
    const onLanguage = function () {
      if (!box.isConnected) { document.removeEventListener('gs-language', onLanguage); return; }
      build();
    };
    document.addEventListener('gs-language', onLanguage);
    return box;
  }

  function showSettings(data) {
    // data: {settings, themes:[{id,name,locked}], onChange(settings), onResetSave()}
    const s = Object.assign({}, data.settings);
    const emit = function () { data.onChange(Object.assign({}, s)); };
    const p = panel(L('Settings'));

    const audioSec = el('section', 'gs-setsec');
    audioSec.appendChild(el('h3', null, L('Audio')));
    [['music', L('Music')], ['effects', L('Effects')], ['ambience', L('Ambience')], ['voice', L('Voice')]].forEach(function (pair) {
      audioSec.appendChild(sliderRow(pair[1], s[pair[0]], function (v) { s[pair[0]] = v; emit(); }));
    });
    audioSec.appendChild(toggleRow(L('Mute all'), s.muted, function (v) { s.muted = v; emit(); }));
    audioSec.appendChild(toggleRow(L('Captions'), s.captions, function (v) { s.captions = v; setCaptionsVisible(v); emit(); }));
    p.appendChild(audioSec);

    const gfxSec = el('section', 'gs-setsec');
    gfxSec.appendChild(el('h3', null, L('Graphics')));
    gfxSec.appendChild(selectRow(L('Theme'), s.theme, data.themes.map(function (t) {
      return { value: t.id, label: t.locked ? L('{name} 🔒', { name: L(t.name) }) : L(t.name), disabled: t.locked };
    }), function (v) { s.theme = v; emit(); }));
    gfxSec.appendChild(graphicsControls(s, emit, data.graphicsInfo));
    p.appendChild(gfxSec);

    const a11y = el('section', 'gs-setsec');
    a11y.appendChild(el('h3', null, L('Accessibility')));
    a11y.appendChild(toggleRow(L('Reduced motion'), s.reducedMotion, function (v) { s.reducedMotion = v; emit(); }));
    a11y.appendChild(toggleRow(L('High contrast'), s.highContrast, function (v) { s.highContrast = v; emit(); }));
    a11y.appendChild(selectRow(L('Color palette'), s.colorPalette, [
      { value: 'standard', label: L('Standard') }, { value: 'high-visibility', label: L('High visibility') }
    ], function (v) { s.colorPalette = v; emit(); }));
    a11y.appendChild(toggleRow(L('Large text'), s.largeText, function (v) { s.largeText = v; emit(); }));
    a11y.appendChild(toggleRow(L('Left-handed controls'), s.leftHanded, function (v) { s.leftHanded = v; emit(); }));
    a11y.appendChild(toggleRow(L('Haptics'), s.haptics, function (v) { s.haptics = v; emit(); }));
    a11y.appendChild(toggleRow(L('Always-on board state panel'), s.boardMirror, function (v) { s.boardMirror = v; emit(); }));
    a11y.appendChild(toggleRow(L('Confirm before release'), s.confirmRelease, function (v) { s.confirmRelease = v; emit(); }));
    p.appendChild(a11y);

    const helpSec = el('section', 'gs-setsec');
    helpSec.appendChild(el('h3', null, L('Controls')));
    helpSec.appendChild(el('p', 'gs-note',
      L('Drag to draw. Keyboard: arrows move the pen, Space draws, R release, U undo, H hint, S skip, P pause.')));
    p.appendChild(helpSec);

    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Done'), 'primary', function () { clickSfx(); closeModal(); }));
    row.appendChild(btn(L('Reset save data'), 'danger', function () {
      if (confirm(T('Erase all local progress and settings?'))) { clickSfx(); closeModal(); data.onResetSave(); }
    }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- results ----------
  function starString(n) { return '★'.repeat(n) + '☆'.repeat(3 - n); }

  function showResults(d) {
    // d: {headline, score{...}, stars, par, best, isNewBest, ranked, boardLabel,
    //     entries, achievements, canNext, seed, mode, onRetry, onNext, onBack, onCopySeed}
    hideHUD();
    const p = panel(d.headline);
    p.setAttribute('aria-live', 'polite');
    p.appendChild(art(d.won ? './assets/results-saved.webp' : './assets/results-hit.webp', 'gs-result-art'));

    const starsEl = el('div', 'gs-big-stars', starString(d.stars));
    p.appendChild(starsEl);

    const tbl = el('div', 'gs-scoretable');
    [[L('Survival'), d.score.survival], [L('Endurance'), d.score.endurance], [L('Blocks'), d.score.blocks],
     [L('Clearance'), d.score.clearance], [L('Ink bonus'), d.score.ink]].forEach(function (pair) {
      const r = el('div', 'row');
      r.append(el('span', null, pair[0]), el('span', null, String(pair[1])));
      tbl.appendChild(r);
    });
    const tot = el('div', 'row gs-scoretotal');
    tot.append(el('span', null, L('Total')), el('span', null, String(d.score.total)));
    tbl.appendChild(tot);
    if (d.par) tbl.appendChild(el('p', 'gs-note', L('Par ★★ {two} · ★★★ {three}', { two: d.par.score2, three: d.par.score3 })));
    p.appendChild(tbl);

    if (d.best != null) {
      p.appendChild(el('p', 'gs-note', L(d.isNewBest ? 'New personal best! {best}' : 'Personal best: {best}', { best: d.best })));
    }
    if (d.achievements && d.achievements.length) {
      const ul = el('ul', 'gs-ach-list');
      d.achievements.forEach(function (a) { ul.appendChild(el('li', null, L('🏅 {name} — {desc}', { name: L(a.name), desc: L(a.desc) }))); });
      p.appendChild(ul);
    }

    if (d.entries && d.entries.length) {
      p.appendChild(el('h3', null, d.boardLabel ? L('Leaderboard ({board})', { board: d.boardLabel }) : L('Leaderboard')));
      const ol = el('ol', 'gs-board');
      d.entries.slice(0, 10).forEach(function (e) {
        ol.appendChild(el('li', e.self ? 'self' : null, e.name + ' — ' + e.score + (e.won ? ' ✓' : '')));
      });
      p.appendChild(ol);
    } else if (d.ranked) {
      p.appendChild(el('p', 'gs-note', L('Board: {board}', { board: d.boardLabel || L('casual (unvalidated)') })));
    }

    const lb = el('p', 'gs-note', '');
    lb.id = 'results-lb';
    lb.setAttribute('role', 'status');
    lb.hidden = true;
    p.appendChild(lb);

    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Retry'), null, function () { clickSfx(); closeModal(); d.onRetry(); }));
    if (d.canNext) row.appendChild(btn(L('Next level'), 'primary', function () { clickSfx(); closeModal(); d.onNext(); }));
    if (d.seed != null && (d.mode === 'storm' || d.mode === 'daily')) {
      row.appendChild(btn(L('Copy seed'), null, function () { clickSfx(); d.onCopySeed(); }));
    }
    row.appendChild(btn(L('Back'), null, function () { clickSfx(); closeModal(); d.onBack(); }));
    p.appendChild(row);
    openModal(p, { dismissable: false });
    announceAssert(T('{headline}. Score {score}, {stars} stars.', { headline: d.headline, score: d.score.total, stars: d.stars }));
  }

  // ---------- help ----------
  function showHelp(data) {
    // data: {bindings:{key:desc}, onClose?}
    const p = panel(L('How to play'));
    const cards = el('div', 'gs-help-cards');
    [
      [L('Draw'), L('Drag on the page to sketch ink barriers. Ink is limited — the gauge shows what is left.')],
      [L('Release'), L('When your defenses are ready, press Release. The storm plays out and the wisps must stay untouched.')],
      [L('Ink'), L('Shorter barriers leave unspent ink, which becomes bonus points when you win.')],
      [L('Scoring'), L('Score = survival + endurance + blocks + clearance + ink bonus. Beat par marks for ★★ and ★★★.')]
    ].forEach(function (c) {
      const card = el('div', 'gs-help-card');
      card.append(el('h4', null, c[0]), el('p', null, c[1]));
      cards.appendChild(card);
    });
    p.appendChild(cards);

    p.appendChild(el('h3', null, L('Hazards')));
    const legend = el('div', 'gs-legend');
    Object.keys(window.GSContent.HAZARDS).forEach(function (t) {
      const hz = window.GSContent.HAZARDS[t];
      const chip = el('span', 'gs-chip', function () { return hz.icon + ' ' + T(hz.label); });
      chip.style.borderColor = hexCss(hz.color);
      legend.appendChild(chip);
    });
    p.appendChild(legend);

    p.appendChild(el('h3', null, L('Keyboard & gamepad')));
    const tbl = el('dl', 'gs-bindings');
    data.bindings.forEach(function (pair) { // [keys, action], each text or a message
      tbl.appendChild(el('dt', null, pair[0]));
      tbl.appendChild(el('dd', null, pair[1]));
    });
    p.appendChild(tbl);

    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Close'), 'primary', function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- learn (tutorial) overlay ----------
  let learnNode = null;
  function showLearn(d) {
    // d: {title, text, index, total, onSkip, onQuit}
    hideLearn();
    learnNode = el('div', 'gs-learn');
    const card = el('div', 'gs-learn-card');
    card.appendChild(el('p', 'gs-learn-progress', L('Lesson {n} of {total}', { n: d.index + 1, total: d.total })));
    card.appendChild(el('h3', null, L(d.title)));
    card.appendChild(el('p', null, L(d.text)));
    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Skip lesson'), null, function () { clickSfx(); d.onSkip(); }));
    row.appendChild(btn(L('Quit lessons'), null, function () { clickSfx(); d.onQuit(); }));
    card.appendChild(row);
    learnNode.appendChild(card);
    root.appendChild(learnNode);
    announce(T('Lesson {n}: {title}', { n: d.index + 1, title: L(d.title) }));
  }
  function hideLearn() { if (learnNode) { learnNode.remove(); learnNode = null; } }
  function celebrateLearn(text) { toast(text || L('Lesson complete!')); }

  // ---------- scores panel ----------
  function showScores(data) {
    // data: {boards:[{id,label}], entries, tab, onBoard(id), onTab(tab)}
    const p = panel(L('Scores'));
    const tabs = el('div', 'gs-row');
    ['global', 'device'].forEach(function (t) {
      const b = btn(t === 'global' ? L('Global') : L('This device'), data.tab === t ? 'primary' : null,
        function () { clickSfx(); data.onTab(t); });
      tabs.appendChild(b);
    });
    p.appendChild(tabs);
    const sel = selectRow(L('Board'), data.board, data.boards.map(function (b) {
      return { value: b.id, label: b.label };
    }), function (v) { data.onBoard(v); });
    p.appendChild(sel);
    if (data.entries && data.entries.length) {
      const ol = el('ol', 'gs-board');
      data.entries.slice(0, 20).forEach(function (e) {
        ol.appendChild(el('li', e.self ? 'self' : null, e.name + ' — ' + e.score + (e.won ? ' ✓' : '')));
      });
      p.appendChild(ol);
    } else {
      p.appendChild(el('p', 'gs-note', data.emptyText || L('No entries yet.')));
    }
    const row = el('div', 'gs-row');
    row.appendChild(btn(L('Close'), 'primary', function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- board mirror ----------
  function setBoardMirror(lines) {
    if (!lines) { mirror.classList.add('gs-hidden'); mirror.innerHTML = ''; return; }
    mirror.classList.remove('gs-hidden');
    mirror.textContent = '';
    mirror.appendChild(el('h3', null, L('Board')));
    const ul = el('ul');
    lines.forEach(function (l) { ul.appendChild(el('li', null, l)); });
    mirror.appendChild(ul);
  }

  // ---------- settings classes on <body> ----------
  function applySettingsClasses(s) {
    document.body.classList.toggle('high-contrast', !!s.highContrast);
    document.body.classList.toggle('large-text', !!s.largeText);
    document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
    document.body.classList.toggle('left-handed', !!s.leftHanded);
  }

  function hideAll() {
    closeAllModals();
    hideHUD();
    hideLearn();
    if (titleNode) { titleNode.remove(); titleNode = null; dailyCountdownEl = null; }
  }

  return {
    announce: announce,
    announceAssert: announceAssert,
    caption: caption,
    toast: toast,
    toastReason: toastReason,
    showTitle: showTitle,
    updateDailyCountdown: updateDailyCountdown,
    updateSyncStatus: updateSyncStatus,
    showModeSetup: showModeSetup,
    showJourney: showJourney,
    showPractice: showPractice,
    showChallenges: showChallenges,
    showHUD: showHUD,
    updateHUD: updateHUD,
    hideHUD: hideHUD,
    showPause: showPause,
    showSettings: showSettings,
    showResults: showResults,
    showHelp: showHelp,
    showLearn: showLearn,
    hideLearn: hideLearn,
    celebrateLearn: celebrateLearn,
    showScores: showScores,
    setBoardMirror: setBoardMirror,
    applySettingsClasses: applySettingsClasses,
    closeModal: closeModal,
    closeAllModals: closeAllModals,
    isModalOpen: isModalOpen,
    isPauseOpen: isPauseOpen,
    hideAll: hideAll
  };
}
