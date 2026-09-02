/* Guardian Sketch — DOM shell (ES module).
 * Semantic HTML over/around the canvas: title, mode setup, journey map,
 * HUD, pause, settings, results, help, learn overlay, board mirror,
 * toasts, captions, live regions. UI never touches rules truth.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function btn(label, cls, onClick) {
  const b = el('button', 'gs-btn' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function hexCss(hex) { return '#' + ('000000' + hex.toString(16)).slice(-6); }

const INVALID_TEXT = {
  'ink-exhausted': 'Not enough ink',
  'out-of-bounds': 'Out of bounds',
  'stroke-too-short': 'Stroke too short',
  'too-many-points': 'Too many points',
  'stroke-limit': 'No strokes left',
  'wrong-phase': 'Not now',
  'game-ended': 'Round already ended',
  'unknown-command': 'Unknown action',
  'malformed-command': 'Malformed action'
};

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
  mirror.setAttribute('aria-label', 'Board state');
  root.append(livePolite, liveAssert, captionLine, toastBox, mirror);

  function announce(text) { livePolite.textContent = ''; livePolite.textContent = text; }
  function announceAssert(text) { liveAssert.textContent = ''; liveAssert.textContent = text; }

  let captionTimer = null;
  function caption(text) {
    captionLine.classList.remove('gs-hidden');
    captionLine.textContent = text;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(function () { captionLine.classList.add('gs-hidden'); }, 2200);
  }
  function setCaptionsVisible(on) { if (!on) captionLine.classList.add('gs-hidden'); }

  function toast(text) {
    const t = el('div', 'gs-toast', text);
    toastBox.appendChild(t);
    announceAssert(text);
    setTimeout(function () { t.classList.add('out'); }, 1800);
    setTimeout(function () { t.remove(); }, 2300);
  }
  function toastReason(reason) { toast(INVALID_TEXT[reason] || reason || 'Not allowed'); }

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
    if (focusable) focusable.focus();
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
  function showTitle(data) {
    hideAll();
    titleNode = el('div', 'gs-title');
    const card = el('div', 'gs-title-card');
    card.appendChild(el('h1', 'gs-logo', 'Guardian Sketch'));
    card.appendChild(el('p', 'gs-tagline', 'Draw ink. Shield the wisps. Weather the storm.'));

    const stats = el('p', 'gs-title-stats');
    stats.textContent = 'Journey stars: ' + data.totalStars + ' / 120' +
      (data.dailyDone ? '  ·  Today’s daily: done (' + data.dailyDone + ')' : '  ·  Today’s daily: open');
    card.appendChild(stats);

    dailyCountdownEl = el('p', 'gs-daily-countdown', data.nextDailyText || '');
    card.appendChild(dailyCountdownEl);

    const grid = el('div', 'gs-title-grid');
    const play = btn('Play', 'primary big', function () { clickSfx(); H('onPlay'); });
    grid.appendChild(play);
    [['Journey', 'onOpenJourney'], ['Daily', 'onOpenDaily'], ['Practice', 'onOpenPractice'],
     ['Challenges', 'onOpenChallenges'], ['Tempest Stand', 'onOpenStorm'], ['Learn', 'onOpenLearn'],
     ['Help', 'onOpenHelp'], ['Settings', 'onOpenSettings'], ['Scores', 'onOpenScores']]
      .forEach(function (pair) {
        grid.appendChild(btn(pair[0], null, function () { clickSfx(); H(pair[1]); }));
      });
    card.appendChild(grid);
    if (data.compatWarning) card.appendChild(el('p', 'gs-compat', data.compatWarning));
    titleNode.appendChild(card);
    root.appendChild(titleNode);
    play.focus();
    announce('Guardian Sketch title screen. Press Play to continue your journey.');
  }
  function updateDailyCountdown(text) { if (dailyCountdownEl) dailyCountdownEl.textContent = text; }

  // ---------- mode setup ----------
  function hazardLegend(cfg) {
    const seen = {};
    (cfg.emitters || []).forEach(function (e) { seen[e.type] = true; });
    const row = el('div', 'gs-legend');
    Object.keys(seen).forEach(function (t) {
      const hz = window.GSContent.HAZARDS[t];
      const chip = el('span', 'gs-chip', hz.icon + ' ' + hz.label);
      chip.style.borderColor = hexCss(hz.color);
      row.appendChild(chip);
    });
    return row;
  }

  function rulesSummary(cfg) {
    const ul = el('ul', 'gs-rules-summary');
    const items = [
      'Ink budget: ' + cfg.ink.budget + ' units · up to ' + cfg.ink.maxStrokes + ' strokes',
      'Storm length: ' + (cfg.simTicks / 60).toFixed(0) + ' seconds',
      'Creatures to protect: ' + cfg.creatures.length
    ];
    if (cfg.par) items.push('Par: ★★ at ' + cfg.par.score2 + ' · ★★★ at ' + cfg.par.score3);
    items.push('Assists: undo ' + (cfg.mechanics.undo ? 'on' : 'off') + ' · hint ' + (cfg.mechanics.hint ? 'on' : 'off'));
    items.forEach(function (t) { ul.appendChild(el('li', null, t)); });
    return ul;
  }

  function showModeSetup(data) {
    // data: {title, cfg, ranked, modeLabel, note, onStart}
    const p = panel(data.title);
    p.appendChild(el('p', 'gs-mode-label', data.modeLabel + (data.ranked ? ' · ranked' : ' · unranked')));
    if (data.note) p.appendChild(el('p', 'gs-note', data.note));
    if (data.cfg.intro) p.appendChild(el('p', 'gs-intro', data.cfg.intro));
    p.appendChild(hazardLegend(data.cfg));
    p.appendChild(rulesSummary(data.cfg));
    p.appendChild(el('p', 'gs-note', 'Expected duration: under a minute.'));
    const row = el('div', 'gs-row');
    row.appendChild(btn('Start', 'primary', function () { clickSfx(); closeModal(); data.onStart(); }));
    row.appendChild(btn('Cancel', null, function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- journey map ----------
  function showJourney(data) {
    // data: {levels:[{cfg, stars, locked, mastery, themeName}], onPick(cfg)}
    const p = panel('Journey');
    const grid = el('div', 'gs-journey-grid');
    data.levels.forEach(function (lv) {
      const b = btn('', 'gs-level' + (lv.locked ? ' locked' : ''), null);
      b.disabled = lv.locked;
      const num = el('span', 'gs-level-num', String(lv.cfg.index + 1));
      const stars = el('span', 'gs-stars', '★'.repeat(lv.stars) + '☆'.repeat(3 - lv.stars));
      b.append(num, stars);
      b.title = lv.cfg.name + (lv.mastery ? ' (Mastery)' : '') + ' — ' + lv.themeName +
        (lv.locked ? ' — locked: earn a star on the previous stage' : '');
      if (lv.mastery) b.classList.add('mastery');
      if (!lv.locked) b.addEventListener('click', function () { clickSfx(); closeModal(); data.onPick(lv.cfg); });
      grid.appendChild(b);
    });
    p.appendChild(grid);
    const row = el('div', 'gs-row');
    row.appendChild(btn('Back', null, function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- practice setup ----------
  function showPractice(data) {
    // data: {presets, seed, onStart(presetId, seed), onNewSeed()}
    const p = panel('Practice');
    p.appendChild(el('p', 'gs-note', 'Unranked. Undo and hints are on. Restarting with the same seed gives the same layout.'));
    const sel = el('select', 'gs-select');
    data.presets.forEach(function (pr) {
      const o = el('option', null, pr.name + ' — ' + pr.blurb);
      o.value = pr.id;
      sel.appendChild(o);
    });
    sel.setAttribute('aria-label', 'Difficulty');
    p.appendChild(sel);
    const seedRow = el('div', 'gs-row gs-seedrow');
    const seedLabel = el('span', 'gs-seed', 'Seed: ' + data.seed);
    seedRow.appendChild(seedLabel);
    seedRow.appendChild(btn('New seed', null, function () { clickSfx(); data.onNewSeed(); }));
    p.appendChild(seedRow);
    const row = el('div', 'gs-row');
    row.appendChild(btn('Start', 'primary', function () { clickSfx(); closeModal(); data.onStart(sel.value); }));
    row.appendChild(btn('Cancel', null, function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
    return { setSeed: function (s) { seedLabel.textContent = 'Seed: ' + s; } };
  }

  // ---------- challenges list ----------
  function showChallenges(data) {
    // data: {items:[{cfg, best}], onPick(cfg)}
    const p = panel('Challenges');
    const list = el('div', 'gs-challenge-list');
    data.items.forEach(function (it) {
      const b = btn('', 'gs-challenge', null);
      b.appendChild(el('strong', null, it.cfg.name));
      b.appendChild(el('span', null, it.cfg.intro || ''));
      b.appendChild(el('span', 'gs-note', it.best != null ? 'Best: ' + it.best : 'Not attempted'));
      b.addEventListener('click', function () { clickSfx(); closeModal(); data.onPick(it.cfg); });
      list.appendChild(b);
    });
    p.appendChild(list);
    const row = el('div', 'gs-row');
    row.appendChild(btn('Back', null, function () { clickSfx(); closeModal(); }));
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
  const btnRelease = btn('Release', 'primary', function () { H('onRelease'); });
  const btnUndo = btn('Undo', null, function () { clickSfx(); H('onUndo'); });
  const btnHint = btn('Hint', null, function () { clickSfx(); H('onHint'); });
  const btnSkip = btn('Skip ⏩', null, function () { clickSfx(); H('onSkip'); });
  const btnPause = btn('❚❚ Pause', 'ghost-btn', function () { clickSfx(); H('onPause'); });
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
    inkLabel.textContent = Math.round(d.ink) + ' ink · ' + d.strokesLeft + ' strokes';
    hudStatus.textContent = d.countdown != null ? '⏱ ' + d.countdown.toFixed(1) + 's' : '';
    btnRelease.classList.toggle('gs-hidden', d.phase !== 'draw');
    btnUndo.classList.toggle('gs-hidden', !(d.phase === 'draw' && d.undo));
    btnHint.classList.toggle('gs-hidden', !(d.phase === 'draw' && d.hint));
    btnSkip.classList.toggle('gs-hidden', d.phase !== 'resolving');
  }

  // ---------- pause ----------
  function showPause() {
    if (isModalOpen()) return;
    const p = panel('Paused');
    const col = el('div', 'gs-col');
    col.appendChild(btn('Resume', 'primary', function () { clickSfx(); closeModal(); H('onResume'); }));
    col.appendChild(btn('Settings', null, function () { clickSfx(); H('onOpenSettings'); }));
    col.appendChild(btn('Help', null, function () { clickSfx(); H('onOpenHelp'); }));
    col.appendChild(btn('Restart', null, function () { clickSfx(); closeModal(); H('onRestart'); }));
    col.appendChild(btn('Quit to title', null, function () { clickSfx(); closeModal(); H('onQuitToTitle'); }));
    p.appendChild(col);
    openModal(p, { dismissable: false });
    announce('Paused');
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

  function showSettings(data) {
    // data: {settings, themes:[{id,name,locked}], onChange(settings), onResetSave()}
    const s = Object.assign({}, data.settings);
    const emit = function () { data.onChange(Object.assign({}, s)); };
    const p = panel('Settings');

    const audioSec = el('section', 'gs-setsec');
    audioSec.appendChild(el('h3', null, 'Audio'));
    [['music', 'Music'], ['effects', 'Effects'], ['ambience', 'Ambience'], ['voice', 'Voice']].forEach(function (pair) {
      audioSec.appendChild(sliderRow(pair[1], s[pair[0]], function (v) { s[pair[0]] = v; emit(); }));
    });
    audioSec.appendChild(toggleRow('Mute all', s.muted, function (v) { s.muted = v; emit(); }));
    audioSec.appendChild(toggleRow('Captions', s.captions, function (v) { s.captions = v; setCaptionsVisible(v); emit(); }));
    p.appendChild(audioSec);

    const gfxSec = el('section', 'gs-setsec');
    gfxSec.appendChild(el('h3', null, 'Graphics'));
    gfxSec.appendChild(selectRow('Quality tier', s.graphicsTier, [
      { value: 'auto', label: 'Auto' }, { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }
    ], function (v) { s.graphicsTier = v; emit(); }));
    gfxSec.appendChild(selectRow('Theme', s.theme, data.themes.map(function (t) {
      return { value: t.id, label: t.name + (t.locked ? ' 🔒' : ''), disabled: t.locked };
    }), function (v) { s.theme = v; emit(); }));
    p.appendChild(gfxSec);

    const a11y = el('section', 'gs-setsec');
    a11y.appendChild(el('h3', null, 'Accessibility'));
    a11y.appendChild(toggleRow('Reduced motion', s.reducedMotion, function (v) { s.reducedMotion = v; emit(); }));
    a11y.appendChild(toggleRow('High contrast', s.highContrast, function (v) { s.highContrast = v; emit(); }));
    a11y.appendChild(selectRow('Color palette', s.colorPalette, [
      { value: 'standard', label: 'Standard' }, { value: 'high-visibility', label: 'High visibility' }
    ], function (v) { s.colorPalette = v; emit(); }));
    a11y.appendChild(toggleRow('Large text', s.largeText, function (v) { s.largeText = v; emit(); }));
    a11y.appendChild(toggleRow('Left-handed controls', s.leftHanded, function (v) { s.leftHanded = v; emit(); }));
    a11y.appendChild(toggleRow('Haptics', s.haptics, function (v) { s.haptics = v; emit(); }));
    a11y.appendChild(toggleRow('Always-on board state panel', s.boardMirror, function (v) { s.boardMirror = v; emit(); }));
    a11y.appendChild(toggleRow('Confirm before release', s.confirmRelease, function (v) { s.confirmRelease = v; emit(); }));
    p.appendChild(a11y);

    const helpSec = el('section', 'gs-setsec');
    helpSec.appendChild(el('h3', null, 'Controls'));
    helpSec.appendChild(el('p', 'gs-note',
      'Drag to draw. Keyboard: arrows move the pen, Space draws, R release, U undo, H hint, S skip, P pause.'));
    p.appendChild(helpSec);

    const row = el('div', 'gs-row');
    row.appendChild(btn('Done', 'primary', function () { clickSfx(); closeModal(); }));
    row.appendChild(btn('Reset save data', 'danger', function () {
      if (confirm('Erase all local progress and settings?')) { clickSfx(); closeModal(); data.onResetSave(); }
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

    const starsEl = el('div', 'gs-big-stars', starString(d.stars));
    p.appendChild(starsEl);

    const tbl = el('div', 'gs-scoretable');
    [['Survival', d.score.survival], ['Endurance', d.score.endurance], ['Blocks', d.score.blocks],
     ['Clearance', d.score.clearance], ['Ink bonus', d.score.ink]].forEach(function (pair) {
      const r = el('div', 'row');
      r.append(el('span', null, pair[0]), el('span', null, String(pair[1])));
      tbl.appendChild(r);
    });
    const tot = el('div', 'row gs-scoretotal');
    tot.append(el('span', null, 'Total'), el('span', null, String(d.score.total)));
    tbl.appendChild(tot);
    if (d.par) tbl.appendChild(el('p', 'gs-note', 'Par ★★ ' + d.par.score2 + ' · ★★★ ' + d.par.score3));
    p.appendChild(tbl);

    if (d.best != null) {
      p.appendChild(el('p', 'gs-note', (d.isNewBest ? 'New personal best! ' : 'Personal best: ') + d.best));
    }
    if (d.achievements && d.achievements.length) {
      const ul = el('ul', 'gs-ach-list');
      d.achievements.forEach(function (a) { ul.appendChild(el('li', null, '🏅 ' + a.name + ' — ' + a.desc)); });
      p.appendChild(ul);
    }

    if (d.entries && d.entries.length) {
      p.appendChild(el('h3', null, 'Leaderboard' + (d.boardLabel ? ' (' + d.boardLabel + ')' : '')));
      const ol = el('ol', 'gs-board');
      d.entries.slice(0, 10).forEach(function (e) {
        ol.appendChild(el('li', e.self ? 'self' : null, e.name + ' — ' + e.score + (e.won ? ' ✓' : '')));
      });
      p.appendChild(ol);
    } else if (d.ranked) {
      p.appendChild(el('p', 'gs-note', 'Board: ' + (d.boardLabel || 'casual (unvalidated)')));
    }

    const row = el('div', 'gs-row');
    row.appendChild(btn('Retry', null, function () { clickSfx(); closeModal(); d.onRetry(); }));
    if (d.canNext) row.appendChild(btn('Next level', 'primary', function () { clickSfx(); closeModal(); d.onNext(); }));
    if (d.seed != null && (d.mode === 'storm' || d.mode === 'daily')) {
      row.appendChild(btn('Copy seed', null, function () { clickSfx(); d.onCopySeed(); }));
    }
    row.appendChild(btn('Back', null, function () { clickSfx(); closeModal(); d.onBack(); }));
    p.appendChild(row);
    openModal(p, { dismissable: false });
    announceAssert(d.headline + '. Score ' + d.score.total + ', ' + d.stars + ' stars.');
  }

  // ---------- help ----------
  function showHelp(data) {
    // data: {bindings:{key:desc}, onClose?}
    const p = panel('How to play');
    const cards = el('div', 'gs-help-cards');
    [
      ['Draw', 'Drag on the page to sketch ink barriers. Ink is limited — the gauge shows what is left.'],
      ['Release', 'When your defenses are ready, press Release. The storm plays out and the wisps must stay untouched.'],
      ['Ink', 'Shorter barriers leave unspent ink, which becomes bonus points when you win.'],
      ['Scoring', 'Score = survival + endurance + blocks + clearance + ink bonus. Beat par marks for ★★ and ★★★.']
    ].forEach(function (c) {
      const card = el('div', 'gs-help-card');
      card.append(el('h4', null, c[0]), el('p', null, c[1]));
      cards.appendChild(card);
    });
    p.appendChild(cards);

    p.appendChild(el('h3', null, 'Hazards'));
    const legend = el('div', 'gs-legend');
    Object.keys(window.GSContent.HAZARDS).forEach(function (t) {
      const hz = window.GSContent.HAZARDS[t];
      const chip = el('span', 'gs-chip', hz.icon + ' ' + hz.label);
      chip.style.borderColor = hexCss(hz.color);
      legend.appendChild(chip);
    });
    p.appendChild(legend);

    p.appendChild(el('h3', null, 'Keyboard & gamepad'));
    const tbl = el('dl', 'gs-bindings');
    Object.keys(data.bindings).forEach(function (k) {
      tbl.appendChild(el('dt', null, k));
      tbl.appendChild(el('dd', null, data.bindings[k]));
    });
    p.appendChild(tbl);

    const row = el('div', 'gs-row');
    row.appendChild(btn('Close', 'primary', function () { clickSfx(); closeModal(); }));
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
    card.appendChild(el('p', 'gs-learn-progress', 'Lesson ' + (d.index + 1) + ' of ' + d.total));
    card.appendChild(el('h3', null, d.title));
    card.appendChild(el('p', null, d.text));
    const row = el('div', 'gs-row');
    row.appendChild(btn('Skip lesson', null, function () { clickSfx(); d.onSkip(); }));
    row.appendChild(btn('Quit lessons', null, function () { clickSfx(); d.onQuit(); }));
    card.appendChild(row);
    learnNode.appendChild(card);
    root.appendChild(learnNode);
    announce('Lesson ' + (d.index + 1) + ': ' + d.title);
  }
  function hideLearn() { if (learnNode) { learnNode.remove(); learnNode = null; } }
  function celebrateLearn(text) { toast(text || 'Lesson complete!'); }

  // ---------- scores panel ----------
  function showScores(data) {
    // data: {boards:[{id,label}], entries, tab, onBoard(id), onTab(tab)}
    const p = panel('Scores');
    const tabs = el('div', 'gs-row');
    ['global', 'device'].forEach(function (t) {
      const b = btn(t === 'global' ? 'Global' : 'This device', data.tab === t ? 'primary' : null,
        function () { clickSfx(); data.onTab(t); });
      tabs.appendChild(b);
    });
    p.appendChild(tabs);
    const sel = selectRow('Board', data.board, data.boards.map(function (b) {
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
      p.appendChild(el('p', 'gs-note', data.emptyText || 'No entries yet.'));
    }
    const row = el('div', 'gs-row');
    row.appendChild(btn('Close', 'primary', function () { clickSfx(); closeModal(); }));
    p.appendChild(row);
    openModal(p);
  }

  // ---------- board mirror ----------
  function setBoardMirror(lines) {
    if (!lines) { mirror.classList.add('gs-hidden'); mirror.innerHTML = ''; return; }
    mirror.classList.remove('gs-hidden');
    mirror.innerHTML = '<h3>Board</h3>';
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
    hideAll: hideAll
  };
}
