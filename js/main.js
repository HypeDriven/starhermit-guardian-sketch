/* Guardian Sketch — bootstrap + session glue (ES module).
 * Owns the state machine, input, progression, replay envelopes, and the
 * optional same-origin server integration. Rules truth lives in GSRules.
 */
import { createRenderer } from './render.js';
import { createUI } from './ui.js';

/* global GSRNG, GSRules, GSContent, GSStore, GSAudio */

// ---------- constants ----------
const REPLAY_KEY = 'guardiansketch.lastreplay';
const TELEMETRY_KEY = 'guardiansketch.telemetry';
const PLAYER_KEY = 'guardiansketch.playername';
const BINDINGS = {
  'Arrow keys': 'Move the pen',
  'Shift + Arrow keys': 'Move the pen faster',
  'Space': 'Pen down / pen up (draw)',
  'R': 'Release the storm',
  'U': 'Undo last stroke',
  'H': 'Hint',
  'S': 'Skip storm playback',
  'P or Escape': 'Pause',
  'Enter': 'Confirm default button',
  'C': 'Reset camera framing',
  'Gamepad dpad/stick': 'Move the pen',
  'Gamepad A / B / Start': 'Draw or confirm / cancel / pause'
};
const PEN_STEP = 14, PEN_STEP_FAST = 42;

const $ = function (sel) { return document.querySelector(sel); };
const rootEl = document.getElementById('app');

// ---------- diagnostics / state machine ----------
let appState = 'boot';
function transition(to, reason) {
  if (appState === to) return;
  console.debug('[gs] ' + appState + ' -> ' + to + ' (' + reason + ')');
  appState = to;
}

// ---------- telemetry (anonymous funnel only) ----------
const sessionId = 's-' + Math.random().toString(36).slice(2, 10);
function telemetry(event) {
  try {
    const q = JSON.parse(localStorage.getItem(TELEMETRY_KEY) || '[]');
    q.push({ event: event, sessionId: sessionId, at: Date.now() });
    while (q.length > 60) q.shift();
    localStorage.setItem(TELEMETRY_KEY, JSON.stringify(q));
    fetch('/api/v1/telemetry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: event, sessionId: sessionId })
    }).catch(function () {});
  } catch (e) { /* offline / private mode: no-op */ }
}

// ---------- save doc ----------
let doc = GSStore.load();
let settings = doc.settings;
let progress = doc.progress;
function persist() { GSStore.save({ v: doc.v, settings: settings, progress: progress }); }

// ---------- launch token (never persisted) ----------
const params = new URLSearchParams(location.search);
const launchToken = params.get('launchToken'); // may be null; used only in-memory if needed
const launchScope = params.get('scope');

// ---------- capability detection ----------
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}
const glOk = webglAvailable();

// ---------- DOM scaffolding ----------
const canvasWrap = document.createElement('div');
canvasWrap.className = 'gs-canvas-wrap';
rootEl.appendChild(canvasWrap);

// ---------- server time ----------
let serverOffset = null; // serverNow - localNow
let serverNowMs = function () { return serverOffset != null ? Date.now() + serverOffset : Date.now(); };

async function fetchServerTime() {
  try {
    const t0 = Date.now();
    const r = await fetch('/api/v1/time');
    const t1 = Date.now();
    if (!r.ok) return;
    const j = await r.json();
    if (typeof j.now === 'number') serverOffset = j.now - Math.round((t0 + t1) / 2);
  } catch (e) { /* offline: local time */ }
}
function todayStr() { return GSContent.utcDateString(serverNowMs()); }

// ---------- ui handlers forward-declared ----------
let ui = null;
let renderer = null;

// ---------- session ----------
// session: {mode, cfg, state, commands, stateHashes, invalid, startPerf,
//           startedOffsetMs, ranked, board, lesson, lessonIdx, drawing}
let session = null;
let pendingStroke = null;   // in-progress pointer stroke
let lastCommitKey = null;   // double-commit guard
let practiceSeed = (Math.random() * 0xffffffff) >>> 0;
let lastSpawnSfx = 0, lastBounceSfx = 0;
let presenceTimer = null;
let releaseArmed = false;   // confirm-release assist

function inkLeft() { return session ? GSRules.inkRemaining(session.state) : 0; }

function themeForLevel(cfg) {
  const id = (settings.theme && cfg.kind !== 'journey' && cfg.kind !== 'tutorial') ? settings.theme : (cfg.theme || settings.theme);
  return GSContent.THEMES.find(function (t) { return t.id === id; }) || GSContent.THEMES[0];
}

function totalStars() {
  return Object.keys(progress.journeyStars).reduce(function (a, k) { return a + progress.journeyStars[k]; }, 0);
}

// ---------- audio helpers ----------
function sfx(name) { if (GSAudio.isStarted()) GSAudio.play(name); }
function startAudioOnce() {
  if (!GSAudio.isStarted() && GSAudio.start()) GSAudio.applySettings(settings);
}
function haptic() { if (settings.haptics && navigator.vibrate) navigator.vibrate(15); }

// ---------- mode meta ----------
function modeMeta(cfg) {
  switch (cfg.kind) {
    case 'journey': return { mode: 'journey', ranked: true, board: 'journey-' + cfg.id, label: 'Journey stage ' + (cfg.index + 1) };
    case 'daily': return { mode: 'daily', ranked: true, board: 'daily-' + cfg.date, label: 'Daily challenge' };
    case 'practice': return { mode: 'practice', ranked: false, board: null, label: 'Practice' };
    case 'challenge': return { mode: 'challenge', ranked: true, board: 'challenge-' + cfg.id, label: 'Challenge' };
    case 'score': return { mode: 'storm', ranked: true, board: 'storm', label: 'Tempest Stand' };
    case 'tutorial': return { mode: 'tutorial', ranked: false, board: null, label: 'Learn' };
    default: return { mode: 'practice', ranked: false, board: null, label: cfg.kind || 'Round' };
  }
}

// ---------- level lifecycle ----------
function beginLevel(cfg, opts) {
  opts = opts || {};
  const meta = modeMeta(cfg);
  transition('preparing', 'begin ' + meta.mode + ' ' + cfg.id);
  const state = GSRules.createGame(cfg);
  session = {
    mode: meta.mode, cfg: state.cfg, state: state,
    commands: [], stateHashes: [GSRules.hashState(state)],
    invalid: 0, startPerf: performance.now(),
    startedOffsetMs: serverOffset != null ? Math.round(serverOffset) : 0,
    ranked: meta.ranked, board: meta.board,
    lesson: opts.lesson || null, lessonIdx: opts.lessonIdx != null ? opts.lessonIdx : null,
    drawing: false
  };
  pendingStroke = null;
  releaseArmed = false;
  lastSpawnSfx = lastBounceSfx = 0;
  if (renderer) {
    renderer.setLevel(session.cfg);
    renderer.setTheme(themeForLevel(session.cfg).palette, { highContrast: settings.highContrast });
    renderer.setViewportInsets({ bottom: 0.11 }); // keep the subject clear of the action tray
    renderer.resize();
  }
  GSAudio.setAvRng(GSRNG.derive(session.cfg.seed, GSRNG.STREAM_AV));
  ui.hideAll();
  ui.showHUD({
    objective: objectiveText(),
    undo: session.cfg.mechanics.undo,
    hint: session.cfg.mechanics.hint
  });
  if (session.lesson) showLessonCard();
  updateHUD();
  updateMirror('level started');
  transition('active', 'draw phase open');
  startPresence();
  telemetry('start');
}

function objectiveText() {
  const n = session ? session.cfg.creatures.length : 1;
  return 'Protect ' + (n > 1 ? n + ' wisps' : 'Wisp') + ' — draw barriers, then Release';
}

function restartLevel() {
  if (!session) return;
  sfx('ui');
  telemetry('retry');
  if (session.mode === 'tutorial' && session.lessonIdx != null) {
    startLesson(session.lessonIdx);
  } else {
    beginLevel(session.cfg, {});
  }
}

// ---------- commands ----------
function applyValidated(cmd) {
  const shape = GSRules.validateCommandShape(cmd);
  if (shape) { onInvalid(shape); return null; }
  const res = GSRules.applyCommand(session.state, cmd);
  if (!res.ok) { onInvalid(res.reason); return null; }
  session.state = res.state;
  session.commands.push(cmd);
  session.stateHashes.push(GSRules.hashState(res.state));
  return res;
}

function onInvalid(reason) {
  if (session) session.invalid++;
  sfx('invalid');
  ui.toastReason(reason);
  updateMirror('invalid: ' + reason);
}

function elapsedMs() { return performance.now() - (session ? session.startPerf : 0); }

function commitStroke(points) {
  if (!session || session.state.phase !== 'draw' || session.state.terminal) return;
  const key = points.length + ':' + (points[0] || [0, 0]).join(',') + ':' + (points[points.length - 1] || [0, 0]).join(',');
  if (key === lastCommitKey) return; // double-commit guard (same pointer sequence)
  const cmd = { type: 'stroke', points: points, atMs: elapsedMs(), id: 'cmd-' + (session.commands.length + 1) };
  const res = applyValidated(cmd);
  if (res) {
    lastCommitKey = key;
    sfx('stroke');
    haptic();
    const st = session.state.strokes[session.state.strokes.length - 1];
    if (renderer) renderer.addStroke(st.pts, session.state.strokes.length - 1);
    lessonEvent('stroke');
    updateHUD();
    updateMirror('stroke ' + st.len + 'u');
  }
}

function undoStroke() {
  if (!session || !session.cfg.mechanics.undo || session.state.phase !== 'draw' || session.state.terminal) return;
  const strokes = session.commands.filter(function (c) { return c.type === 'stroke'; });
  if (!strokes.length) { onInvalid('stroke-limit'); return; }
  // replay commands minus the last stroke
  const kept = session.commands.slice();
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].type === 'stroke') { kept.splice(i, 1); break; }
  }
  let st = GSRules.createGame(session.cfg);
  const hashes = [GSRules.hashState(st)];
  for (let i = 0; i < kept.length; i++) {
    const res = GSRules.applyCommand(st, kept[i]);
    if (!res.ok) return;
    st = res.state;
    hashes.push(GSRules.hashState(st));
  }
  session.state = st;
  session.commands = kept;
  session.stateHashes = hashes;
  if (renderer) { renderer.removeLastStroke(); renderer.showHint(null); }
  sfx('undo');
  lessonEvent('undo');
  updateHUD();
  updateMirror('undo');
}

function showHintNow() {
  if (!session || !session.cfg.mechanics.hint || session.state.phase !== 'draw' || session.state.terminal) return;
  const h = GSRules.hint(session.state); // expensive: on demand only
  if (!h) { ui.toast('No hint available'); return; }
  sfx('hint');
  if (renderer) renderer.showHint(h.strokes);
  ui.announce('Hint shown: ' + (h.wouldWin ? 'a shield that should hold' : 'a best-effort shield') + ', ' + h.len + ' ink.');
}

function doRelease() {
  if (!session || session.state.phase !== 'draw' || session.state.terminal) return;
  if (settings.confirmRelease && !releaseArmed) {
    releaseArmed = true;
    ui.toast('Tap Release again to confirm');
    setTimeout(function () { releaseArmed = false; }, 2500);
    return;
  }
  releaseArmed = false;
  const cmd = { type: 'release', atMs: elapsedMs(), id: 'cmd-' + (session.commands.length + 1) };
  const res = applyValidated(cmd);
  if (!res) return;
  sfx('release');
  transition('resolving', 'released');
  updateHUD();
  updateMirror('storm released');
  const won = session.state.terminal && session.state.terminal.won;
  const simEvents = res.events.filter(function (e) { return e.tick != null; });
  if (renderer && session.state.trace) {
    renderer.playTrace(session.state.trace, session.cfg, {
      speed: 1,
      reducedMotion: settings.reducedMotion,
      events: simEvents,
      onEvent: onTraceEvent,
      onDone: function () { onResolved(won); }
    });
  } else {
    onResolved(won); // no renderer: resolve instantly
  }
}

function onTraceEvent(ev) {
  const now = performance.now();
  if (ev.type === 'spawn') {
    if (now - lastSpawnSfx > 90) { sfx('spawn'); lastSpawnSfx = now; }
  } else if (ev.type === 'block') {
    sfx('block');
  } else if (ev.type === 'bounce') {
    if (now - lastBounceSfx > 140) { sfx('bounce'); lastBounceSfx = now; }
  } else if (ev.type === 'hit') {
    sfx('hit');
    haptic();
  }
  updateMirror('storm: ' + ev.type);
}

function skipPlayback() {
  if (appState !== 'resolving') return;
  sfx('skip');
  if (renderer) renderer.skipTrace(); // lands exactly on terminal state via onDone
}

function onResolved(won) {
  if (!session || appState === 'results') return;
  transition('results', won ? 'survived' : (session.state.terminal ? session.state.terminal.reason : 'ended'));
  if (won) { sfx('win'); if (renderer) renderer.celebrate(); }
  else sfx('lose');
  if (session.mode === 'tutorial') lessonEvent(won ? 'win' : 'lose');
  finalizeProgress(won);
  const envelope = session.ranked ? buildEnvelope() : null;
  if (session.ranked && envelope) {
    try { localStorage.setItem(REPLAY_KEY, JSON.stringify(envelope)); } catch (e) {}
    submitScore(envelope, function (entries, boardLabel) {
      showResults(won, entries, boardLabel);
    });
  } else {
    showResults(won, null, null);
  }
}

// ---------- progression / achievements ----------
function unlock(key, unlocked) {
  if (progress.achievements[key]) return;
  progress.achievements[key] = Date.now();
  unlocked.push(GSContent.ACHIEVEMENTS.find(function (a) { return a.key === key; }));
  sfx('star');
}

function finalizeProgress(won) {
  const st = session.state;
  const score = st.score.total;
  const stats = progress.stats;
  stats.rounds++;
  if (won) stats.saves++;
  stats.hazardsBlocked += st.sim ? st.sim.blocked : 0;
  stats.inkSpent += st.inkUsed;
  if (won && st.sim && st.sim.minClear > stats.bestClearance) stats.bestClearance = st.sim.minClear;
  stats.playMs += Math.round(elapsedMs());

  const unlocked = [];
  if (won) unlock('first-save', unlocked);
  if (stats.hazardsBlocked >= 50) unlock('blocks-50', unlocked);
  if (won && session.cfg.creatures.length >= 2) unlock('twins-save', unlocked);
  if (score >= 2000) unlock('score-2000', unlocked);

  if (session.mode === 'journey') {
    const stars = GSRules.starsFor(st);
    const id = session.cfg.id;
    if (stars > (progress.journeyStars[id] || 0)) {
      for (let i = progress.journeyStars[id] || 0; i < stars; i++) sfx('star');
      progress.journeyStars[id] = stars;
    }
    if (score > (progress.journeyBest[id] || 0)) progress.journeyBest[id] = score;
    const doneCount = GSContent.JOURNEY.filter(function (l) { return (progress.journeyStars[l.id] || 0) >= 1; }).length;
    if (doneCount >= 20) unlock('journey-half', unlocked);
    if (doneCount >= 40) unlock('journey-done', unlocked);
  } else if (session.mode === 'daily') {
    const date = session.cfg.date;
    if (!(date in progress.dailiesDone) || score > progress.dailiesDone[date]) progress.dailiesDone[date] = score;
    if (Object.keys(progress.dailiesDone).length >= 7) unlock('daily-7', unlocked);
  } else if (session.mode === 'challenge') {
    if (score > (progress.challengeBest[session.cfg.id] || 0)) progress.challengeBest[session.cfg.id] = score;
  } else if (session.mode === 'storm') {
    if (score > progress.stormBest) progress.stormBest = score;
    if (score >= 1000) unlock('storm-stand', unlocked);
  } else if (session.mode === 'tutorial' && session.lesson) {
    if (won || session.lesson.goal.event === 'undo') {
      progress.tutorialDone[session.lesson.id] = true;
      const all = GSContent.tutorialLessons().every(function (l) { return progress.tutorialDone[l.id]; });
      if (all) unlock('lessons-done', unlocked);
    }
  }
  session.newAchievements = unlocked.filter(Boolean);
  persist();
}

// ---------- results ----------
function showResults(won, entries, boardLabel) {
  const st = session.state;
  const stars = GSRules.starsFor(st);
  let headline;
  if (st.terminal.reason === GSRules.TERMINAL.SURVIVED) headline = 'Saved!';
  else if (st.terminal.reason === GSRules.TERMINAL.HIT) headline = 'Hit at ' + ((st.sim.survivedTicks / 60).toFixed(1)) + 's';
  else headline = 'Resigned';

  let best = null, isNewBest = false;
  if (session.mode === 'journey') best = progress.journeyBest[session.cfg.id];
  else if (session.mode === 'daily') best = progress.dailiesDone[session.cfg.date];
  else if (session.mode === 'challenge') best = progress.challengeBest[session.cfg.id];
  else if (session.mode === 'storm') best = progress.stormBest;
  if (best != null) isNewBest = best === st.score.total && st.score.total > 0;

  const isJourney = session.mode === 'journey';
  const nextIdx = isJourney ? session.cfg.index + 1 : -1;
  const canNext = isJourney && won && nextIdx < GSContent.JOURNEY.length;

  ui.showResults({
    headline: headline,
    score: st.score,
    stars: stars,
    par: session.cfg.par,
    best: best,
    isNewBest: isNewBest,
    ranked: session.ranked,
    boardLabel: boardLabel,
    entries: entries,
    achievements: session.newAchievements || [],
    canNext: canNext,
    seed: session.cfg.seed,
    mode: session.mode,
    onRetry: restartLevel,
    onNext: function () { startJourneyLevel(nextIdx); },
    onBack: toTitle,
    onCopySeed: copySeed
  });
  stopPresence();
}

function copySeed() {
  const text = 'guardian-sketch ' + session.mode + ' seed ' + session.cfg.seed;
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { ui.toast('Seed copied'); }, function () { ui.toast(text); });
  else ui.toast(text);
}

// ---------- replay envelope + score submission ----------
function buildEnvelope() {
  return {
    schema: 1,
    contentVersion: GSContent.CONTENT_VERSION,
    seed: session.cfg.seed,
    cfgId: session.cfg.id,
    initialHash: GSRules.hashState(GSRules.createGame(session.cfg)),
    startedOffsetMs: session.startedOffsetMs,
    durationMs: Math.round(elapsedMs()),
    commands: session.commands.map(function (c) { return GSRules.clone(c); }),
    stateHashes: session.stateHashes.slice(1), // aligned with commands[] (initial hash is separate)
    result: {
      score: session.state.score.total,
      won: !!(session.state.terminal && session.state.terminal.won),
      terminalReason: session.state.terminal ? session.state.terminal.reason : null
    }
  };
}

function playerName() {
  let n = null;
  try { n = localStorage.getItem(PLAYER_KEY); } catch (e) {}
  if (!n) {
    n = 'guest-' + sessionId.slice(2, 6);
    try { localStorage.setItem(PLAYER_KEY, n); } catch (e) {}
  }
  return n;
}

function storeLocalEntry(board, score, won) {
  const boards = GSStore.loadBoards();
  boards.entries.push({
    name: playerName(), score: score, won: won, invalid: session.invalid,
    durationMs: Math.round(elapsedMs()), sessionId: sessionId,
    board: board, date: new Date(serverNowMs()).toISOString().slice(0, 10)
  });
  while (boards.entries.length > 400) boards.entries.shift();
  GSStore.saveBoards(boards);
}

function localEntries(board) {
  return GSStore.loadBoards().entries.filter(function (e) { return e.board === board; });
}

async function submitScore(envelope, done) {
  const board = session.board;
  const score = session.state.score.total;
  const won = !!(session.state.terminal && session.state.terminal.won);
  storeLocalEntry(board, score, won);
  const local = GSStore.sortEntries(localEntries(board)).map(function (e) {
    return Object.assign({}, e, { self: e.sessionId === sessionId });
  });
  async function attempt() {
    const r = await fetch('/api/v1/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board: board, name: playerName(), envelope: envelope })
    });
    if (r.status === 429) throw { retry: true };
    const j = await r.json();
    if (j && j.error) throw { msg: j.error };
    return j;
  }
  try {
    let j;
    try { j = await attempt(); }
    catch (e) {
      if (e && e.retry) { await new Promise(function (rs) { setTimeout(rs, 1200); }); j = await attempt(); }
      else throw e;
    }
    if (j && j.ok) {
      const remote = (j.top || []).map(function (e) { return Object.assign({}, e); });
      const merged = GSStore.sortEntries(remote.concat(localEntries(board))).map(function (e) {
        return Object.assign({}, e, { self: e.sessionId === sessionId });
      });
      done(merged.slice(0, 10), null);
      return;
    }
    throw { msg: 'unexpected response' };
  } catch (e) {
    if (e && e.msg) ui.toast('Score service: ' + e.msg);
    done(local.slice(0, 10), 'casual (unvalidated)');
  }
}

// ---------- input: pointer drawing ----------
function bindPointer(canvas) {
  let activeId = null;
  let downPos = null, downTime = 0;
  let pts = null;
  let overInk = false;

  function pushPoint(w) {
    const last = pts[pts.length - 1];
    const dx = w.x - last[0], dy = w.y - last[1];
    if (dx * dx + dy * dy < 4) return; // dedupe ≥2 world units
    if (pts.length >= GSRules.MAX_POINTS) { onInvalid('too-many-points'); return; }
    if (!overInk) {
      const used = GSRules.polyLength(pts.concat([[w.x, w.y]]));
      if (used > inkLeft()) { overInk = true; onInvalid('ink-exhausted'); return; }
    } else return;
    pts.push([Math.round(w.x), Math.round(w.y)]);
    if (renderer && pts.length > 1) renderer.showGhost(pts);
  }

  canvas.addEventListener('pointerdown', function (ev) {
    startAudioOnce();
    if (!session || session.state.phase !== 'draw' || session.state.terminal) return;
    if (activeId != null) return;
    const w = renderer.screenToWorld(ev.clientX, ev.clientY);
    if (!w) return;
    activeId = ev.pointerId;
    downPos = { x: ev.clientX, y: ev.clientY };
    downTime = performance.now();
    pts = [[Math.round(w.x), Math.round(w.y)]];
    overInk = false;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointers */ }
    sfx('draw-start');
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (ev.pointerId !== activeId || !pts) return;
    const w = renderer.screenToWorld(ev.clientX, ev.clientY);
    if (w) pushPoint(w);
    updateHUD();
  });

  function endStroke(ev, cancel) {
    if (ev.pointerId !== activeId) return;
    activeId = null;
    const drawn = pts;
    pts = null;
    // quick tap (<10px, <250ms): harmless, no accidental stroke
    const dist = downPos ? Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) : 999;
    const dt = performance.now() - downTime;
    if (renderer) renderer.showGhost(null);
    if (cancel || !drawn || drawn.length < 2 || (dist < 10 && dt < 250)) {
      if (!cancel && drawn && drawn.length >= 2) onInvalid('stroke-too-short');
      return;
    }
    commitStroke(drawn);
  }
  canvas.addEventListener('pointerup', function (ev) { endStroke(ev, false); });
  canvas.addEventListener('pointercancel', function (ev) { endStroke(ev, true); });
}

// ---------- input: keyboard pen ----------
const pen = { x: 500, y: 350, down: false, active: false };
const keysDown = {};
let penMarker = null;

function ensurePenMarker() {
  if (penMarker || !renderer) return;
  penMarker = document.createElement('div');
  penMarker.className = 'gs-pen gs-hidden';
  penMarker.textContent = '✎';
  rootEl.appendChild(penMarker);
}
function updatePenMarker() {
  if (!penMarker || !renderer) return;
  if (!pen.active || !session || appState !== 'active') { penMarker.classList.add('gs-hidden'); return; }
  penMarker.classList.remove('gs-hidden');
  const s = renderer.worldToScreen(pen.x, pen.y);
  const rect = rootEl.getBoundingClientRect();
  penMarker.style.left = (s.x - rect.left) + 'px';
  penMarker.style.top = (s.y - rect.top) + 'px';
  penMarker.classList.toggle('down', pen.down);
}

function penMove(dx, dy) {
  pen.active = true;
  pen.x = Math.max(0, Math.min(1000, pen.x + dx));
  pen.y = Math.max(0, Math.min(700, pen.y + dy));
  if (pen.down && session && session.state.phase === 'draw') {
    if (!pen.pts) pen.pts = [[Math.round(pen.x), Math.round(pen.y)]];
    const last = pen.pts[pen.pts.length - 1];
    if (Math.hypot(pen.x - last[0], pen.y - last[1]) >= 2 && pen.pts.length < GSRules.MAX_POINTS) {
      if (GSRules.polyLength(pen.pts.concat([[pen.x, pen.y]])) <= inkLeft()) {
        pen.pts.push([Math.round(pen.x), Math.round(pen.y)]);
        if (renderer) renderer.showGhost(pen.pts);
      } else onInvalid('ink-exhausted');
    }
  }
  updatePenMarker();
}
function penToggle() {
  if (!session || session.state.phase !== 'draw') return;
  pen.active = true;
  pen.down = !pen.down;
  if (pen.down) { pen.pts = [[Math.round(pen.x), Math.round(pen.y)]]; sfx('draw-start'); }
  else {
    const drawn = pen.pts;
    pen.pts = null;
    if (renderer) renderer.showGhost(null);
    if (drawn && drawn.length > 1) commitStroke(drawn);
    else if (drawn) onInvalid('stroke-too-short');
  }
  updatePenMarker();
}

window.addEventListener('keydown', function (ev) {
  startAudioOnce();
  if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.tagName === 'TEXTAREA')) return;
  keysDown[ev.key] = true;
  const k = ev.key;
  if (k === ' ') { ev.preventDefault(); if (!ev.repeat) penToggle(); return; }
  if (k === 'Enter') return; // native button activation
  if (ui.isModalOpen()) return;
  if (k === 'r' || k === 'R') { if (appState === 'active') doRelease(); }
  else if (k === 'u' || k === 'U') { if (appState === 'active') undoStroke(); }
  else if (k === 'h' || k === 'H') { if (appState === 'active') showHintNow(); }
  else if (k === 's' || k === 'S') { if (appState === 'resolving') skipPlayback(); }
  else if (k === 'p' || k === 'P' || k === 'Escape') {
    if (appState === 'active') pauseGame('key');
    else if (appState === 'paused') resumeGame();
  } else if (k === 'c' || k === 'C') { if (renderer) renderer.resize(); }
});
window.addEventListener('keyup', function (ev) { keysDown[ev.key] = false; });

// held-arrow pen movement + gamepad polling, driven by rAF
let padPrev = {};
function inputTick() {
  if (session && appState === 'active' && !ui.isModalOpen()) {
    const fast = keysDown['Shift'];
    const step = fast ? PEN_STEP_FAST : PEN_STEP;
    let dx = 0, dy = 0;
    if (keysDown['ArrowLeft']) dx -= step;
    if (keysDown['ArrowRight']) dx += step;
    if (keysDown['ArrowUp']) dy += step;   // world is y-up
    if (keysDown['ArrowDown']) dy -= step;
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[0];
    if (gp) {
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (Math.abs(ax) > 0.25) dx += ax * step;
      if (Math.abs(ay) > 0.25) dy += -ay * step;
      if (gp.buttons[12] && gp.buttons[12].pressed) dy += step;
      if (gp.buttons[13] && gp.buttons[13].pressed) dy -= step;
      if (gp.buttons[14] && gp.buttons[14].pressed) dx -= step;
      if (gp.buttons[15] && gp.buttons[15].pressed) dx += step;
      const pressed = function (i) { return gp.buttons[i] && gp.buttons[i].pressed; };
      if (pressed(0) && !padPrev[0]) penToggle();            // A
      if (pressed(1) && !padPrev[1] && pen.down) penToggle(); // B: cancel/pen up
      if (pressed(9) && !padPrev[9]) pauseGame('gamepad');    // Start
      padPrev = { 0: pressed(0), 1: pressed(1), 9: pressed(9) };
    }
    if (dx || dy) penMove(dx, dy);
  }
  requestAnimationFrame(inputTick);
}

// ---------- pause / resume / visibility ----------
function pauseGame(reason) {
  if (appState !== 'active' && appState !== 'resolving') return;
  transition('paused', reason);
  ui.showPause();
  updateMirror('paused');
}
function resumeGame() {
  if (appState !== 'paused') return;
  ui.closeModal();
  transition(session && session.state.phase === 'done' ? 'resolving' : 'active', 'resume');
}
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    if (renderer) renderer.setVisible(false);
    GSAudio.suspend();
    if (appState === 'active') pauseGame('backgrounded');
  } else {
    if (renderer) renderer.setVisible(true);
    GSAudio.resume();
  }
});
window.addEventListener('resize', function () { if (renderer) renderer.resize(); updatePenMarker(); });

// ---------- presence / activity ----------
function startPresence() {
  stopPresence();
  presenceTimer = setInterval(function () {
    if (appState === 'active') {
      fetch('/api/v1/presence', { method: 'POST' }).catch(function () {});
    }
  }, 30000);
}
function stopPresence() { if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; } }

let activitySent = false;
function sendActivityStart() {
  if (activitySent || !navigator.sendBeacon) return;
  activitySent = true;
  try { navigator.sendBeacon('/api/v1/activity', JSON.stringify({ event: 'start' })); } catch (e) {}
}
window.addEventListener('pagehide', function () {
  if (navigator.sendBeacon) {
    try { navigator.sendBeacon('/api/v1/activity', JSON.stringify({ event: 'end' })); } catch (e) {}
  }
});

// ---------- HUD / mirror ----------
function updateHUD() {
  if (!session) return;
  const st = session.state;
  let countdown = null;
  if (appState === 'resolving' && renderer && renderer.isPlaying()) {
    countdown = (st.cfg.simTicks / 60) * (1 - renderer.traceProgress());
  }
  ui.updateHUD({
    ink: inkLeft(),
    inkBudget: st.cfg.ink.budget,
    strokesLeft: st.cfg.ink.maxStrokes - st.strokes.length,
    countdown: countdown,
    phase: appState === 'resolving' ? 'resolving' : st.phase,
    undo: st.cfg.mechanics.undo,
    hint: st.cfg.mechanics.hint
  });
  updatePenMarker();
}
setInterval(updateHUD, 250);

function updateMirror(lastEvent) {
  if (!settings.boardMirror || !session) { ui.setBoardMirror(null); return; }
  const st = session.state;
  ui.setBoardMirror([
    'Phase: ' + (appState === 'resolving' ? 'storm' : st.phase),
    'Strokes: ' + st.strokes.length + ' / ' + st.cfg.ink.maxStrokes,
    'Ink left: ' + Math.round(inkLeft()),
    'Creatures: ' + st.cfg.creatures.map(function (c, i) { return 'wisp ' + (i + 1) + ' at ' + c.x + ',' + c.y; }).join('; '),
    'Emitters: ' + st.cfg.emitters.length,
    'Last: ' + (lastEvent || '—')
  ]);
}

// ---------- tutorial (Learn) ----------
const lessons = GSContent.tutorialLessons();
function startLesson(idx) {
  const lesson = lessons[idx];
  if (!lesson) { toTitle(); return; }
  transition('tutorial', 'lesson ' + lesson.id);
  beginLevel(lesson.cfg, { lesson: lesson, lessonIdx: idx });
}
function showLessonCard() {
  ui.showLearn({
    title: session.lesson.title,
    text: session.lesson.text,
    index: session.lessonIdx,
    total: lessons.length,
    onSkip: function () { startLesson(session.lessonIdx + 1); },
    onQuit: toTitle
  });
}
function lessonEvent(eventName) {
  if (!session || !session.lesson) return;
  const goal = session.lesson.goal;
  if (goal.event !== eventName) return;
  session.lessonHits = (session.lessonHits || 0) + 1;
  telemetry('tutorial-step');
  if (session.lessonHits >= goal.count) {
    progress.tutorialDone[session.lesson.id] = true;
    const all = lessons.every(function (l) { return progress.tutorialDone[l.id]; });
    if (all && !progress.achievements['lessons-done']) {
      progress.achievements['lessons-done'] = Date.now();
      session.newAchievements = [GSContent.ACHIEVEMENTS.find(function (a) { return a.key === 'lessons-done'; })];
    }
    persist();
    ui.celebrateLearn('Lesson complete! ' + session.lesson.title);
    sfx('win');
    setTimeout(function () {
      if (session && session.lesson) startLesson(session.lessonIdx + 1);
    }, 1600);
  }
}

// ---------- screens ----------
function toTitle() {
  transition('title', 'show title');
  stopPresence();
  if (renderer) { renderer.stopTrace(); renderer.clearStrokes(); renderer.setViewportInsets({ bottom: 0 }); }
  session = null;
  pendingStroke = null;
  const dailyDone = progress.dailiesDone[todayStr()];
  ui.showTitle({
    totalStars: totalStars(),
    dailyDone: dailyDone != null ? dailyDone : null,
    nextDailyText: nextDailyText(),
    compatWarning: glOk ? null : 'WebGL is unavailable — menus work, but the 3D page cannot be shown.'
  });
  updateMirror(null);
}

function nextDailyText() {
  const now = serverNowMs();
  const next = Math.floor(now / 86400000) * 86400000 + 86400000;
  const s = Math.max(0, Math.floor((next - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return 'Next daily in ' + h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}
setInterval(function () { if (appState === 'title') ui.updateDailyCountdown(nextDailyText()); }, 1000);

function firstUncompletedJourney() {
  for (let i = 0; i < GSContent.JOURNEY.length; i++) {
    if (!(progress.journeyStars[GSContent.JOURNEY[i].id] >= 1)) return i;
  }
  return GSContent.JOURNEY.length - 1;
}

function confirmAndStart(cfg, extra) {
  const meta = modeMeta(cfg);
  transition('mode-select', 'setup ' + meta.mode);
  ui.showModeSetup({
    title: cfg.name,
    cfg: cfg,
    ranked: meta.ranked,
    modeLabel: meta.label,
    note: (extra && extra.note) || null,
    onStart: function () {
      sendActivityStart();
      beginLevel(cfg, extra && extra.lesson ? { lesson: extra.lesson, lessonIdx: extra.lessonIdx } : {});
    }
  });
}

function startJourneyLevel(idx) {
  const cfg = GSContent.JOURNEY[idx];
  if (cfg) confirmAndStart(cfg);
}

let dailyCfgCache = null;
async function openDaily() {
  const date = todayStr();
  let cfg = dailyCfgCache;
  if (!cfg || cfg.date !== date) {
    try {
      const r = await fetch('/api/v1/daily');
      const j = r.ok ? await r.json() : null;
      if (j && j.config && j.date === date) cfg = j.config;
    } catch (e) {}
    if (!cfg) cfg = GSContent.dailyConfig(date); // offline fallback
    dailyCfgCache = cfg;
  }
  const done = progress.dailiesDone[date];
  confirmAndStart(cfg, { note: done != null ? 'Already played today (score ' + done + ') — replay to improve.' : null });
}

function openJourney() {
  const levels = GSContent.JOURNEY.map(function (cfg, i) {
    const prevOk = i === 0 || (progress.journeyStars[GSContent.JOURNEY[i - 1].id] || 0) >= 1;
    const theme = GSContent.THEMES.find(function (t) { return t.id === cfg.theme; });
    return {
      cfg: cfg,
      stars: progress.journeyStars[cfg.id] || 0,
      locked: !prevOk,
      mastery: !!cfg.mastery,
      themeName: theme ? theme.name : ''
    };
  });
  ui.showJourney({ levels: levels, onPick: function (cfg) { confirmAndStart(cfg); } });
}

function openPractice() {
  const ref = ui.showPractice({
    presets: GSContent.PRACTICE,
    seed: practiceSeed,
    onNewSeed: function () {
      practiceSeed = (Math.random() * 0xffffffff) >>> 0;
      if (ref) ref.setSeed(practiceSeed);
    },
    onStart: function (presetId) {
      confirmAndStart(GSContent.makePractice(presetId, practiceSeed));
    }
  });
}

function openChallenges() {
  ui.showChallenges({
    items: GSContent.CHALLENGES.map(function (cfg) {
      return { cfg: cfg, best: progress.challengeBest[cfg.id] != null ? progress.challengeBest[cfg.id] : null };
    }),
    onPick: function (cfg) { confirmAndStart(cfg); }
  });
}

function openStorm() {
  // Daily-rotating storm seed keeps scores comparable per day; shareable.
  const seed = GSRNG.hashString('storm-' + todayStr());
  confirmAndStart(GSContent.makeStorm(seed));
}

// ---------- settings ----------
function unlockedThemes() {
  const stars = totalStars();
  return GSContent.THEMES.map(function (t) {
    return { id: t.id, name: t.name, locked: stars < t.unlockStars };
  });
}

function applySettings(next) {
  const themeChanged = next.theme !== settings.theme;
  settings = Object.assign({}, settings, next);
  doc.settings = settings;
  persist();
  ui.applySettingsClasses(settings);
  GSAudio.applySettings(settings);
  GSAudio.setCaptions(settings.captions, function (text) { ui.caption(text); });
  if (renderer) {
    renderer.setQuality(settings.graphicsTier);
    renderer.setReducedMotion(settings.reducedMotion);
    if (themeChanged || session) {
      const pal = session ? themeForLevel(session.cfg).palette
        : (GSContent.THEMES.find(function (t) { return t.id === settings.theme; }) || GSContent.THEMES[0]).palette;
      renderer.setTheme(pal, { highContrast: settings.highContrast });
    }
  }
  if (session) updateHUD();
  updateMirror('settings applied');
  telemetry('settings-change');
}

function openSettings() {
  ui.showSettings({
    settings: settings,
    themes: unlockedThemes(),
    onChange: applySettings,
    onResetSave: function () {
      try { localStorage.removeItem(REPLAY_KEY); } catch (e) {}
      doc = GSStore.fresh();
      settings = doc.settings;
      progress = doc.progress;
      persist();
      applySettings(settings);
      toTitle();
      ui.toast('Save data reset');
    }
  });
}

// ---------- scores panel ----------
let scoresTab = 'global', scoresBoard = 'storm';
function openScores() {
  const date = todayStr();
  const boards = [
    { id: 'storm', label: 'Tempest Stand' },
    { id: 'daily-' + date, label: 'Daily ' + date }
  ].concat(GSContent.CHALLENGES.map(function (c) { return { id: 'challenge-' + c.id, label: c.name }; }));
  function render(entries, emptyText) {
    ui.showScores({
      boards: boards, board: scoresBoard, tab: scoresTab, entries: entries, emptyText: emptyText,
      onBoard: function (id) { scoresBoard = id; openScores(); },
      onTab: function (t) { scoresTab = t; openScores(); }
    });
  }
  if (scoresTab === 'device') {
    render(GSStore.sortEntries(localEntries(scoresBoard)), 'No local entries for this board yet.');
  } else {
    fetch('/api/v1/leaderboard?board=' + encodeURIComponent(scoresBoard))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.entries) render(j.entries);
        else render(null, 'Global scores unavailable (offline).');
      })
      .catch(function () { render(null, 'Global scores unavailable (offline).'); });
  }
}

// ---------- boot ----------
function boot() {
  transition('boot', 'init');
  ui = createUI(rootEl, {
    onUiSound: function () { sfx('ui'); },
    onPlay: function () { startJourneyLevel(firstUncompletedJourney()); },
    onOpenJourney: openJourney,
    onOpenDaily: openDaily,
    onOpenPractice: openPractice,
    onOpenChallenges: openChallenges,
    onOpenStorm: openStorm,
    onOpenLearn: function () {
      const next = lessons.findIndex(function (l) { return !progress.tutorialDone[l.id]; });
      startLesson(next === -1 ? 0 : next);
    },
    onOpenHelp: function () { ui.showHelp({ bindings: BINDINGS }); },
    onOpenSettings: openSettings,
    onOpenScores: openScores,
    onRelease: doRelease,
    onUndo: undoStroke,
    onHint: showHintNow,
    onSkip: skipPlayback,
    onPause: function () { pauseGame('button'); },
    onResume: resumeGame,
    onRestart: restartLevel,
    onQuitToTitle: toTitle
  });

  // respects prefers-* on very first load
  if (!localStorage.getItem('guardiansketch.save.v1')) {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) settings.reducedMotion = true;
    if (window.matchMedia && matchMedia('(prefers-contrast: more)').matches) settings.highContrast = true;
  }
  applySettings(settings);

  if (glOk) {
    renderer = createRenderer(canvasWrap, {
      onUnsupported: function () { ui.toast('WebGL unavailable'); },
      onContextLost: function () {
        ui.toast('Graphics context lost — attempting recovery');
        telemetry('error-category');
      }
    });
    if (renderer) {
      renderer.setQuality(settings.graphicsTier);
      renderer.setReducedMotion(settings.reducedMotion);
      const theme = GSContent.THEMES.find(function (t) { return t.id === settings.theme; }) || GSContent.THEMES[0];
      renderer.setTheme(theme.palette, { highContrast: settings.highContrast });
      // ambient title backdrop: an empty page
      renderer.setLevel({
        id: 'title', seed: 1, world: { w: 1000, h: 700 },
        creatures: [{ x: 500, y: 120, r: 34 }], emitters: [], obstacles: [],
        ink: { budget: 1, maxStrokes: 0, thickness: 12 }, simTicks: 60,
        mechanics: { undo: false, hint: false }
      });
      bindPointer(renderer.canvas);
    }
  }
  ensurePenMarker();
  requestAnimationFrame(inputTick);
  fetchServerTime().then(function () { if (appState === 'title') ui.updateDailyCountdown(nextDailyText()); });
  transition('profile-ready', 'guest profile loaded');
  toTitle();
}

boot();
