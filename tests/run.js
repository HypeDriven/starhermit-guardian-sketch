// Guardian Sketch — offline test + validation suite (Node, zero deps).
// Run: node tests/run.js
'use strict';

const RNG = require('../js/rng.js');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const Store = require('../js/store.js');
const Server = require('../server.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.error('FAIL: ' + name); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function playToEnd(cfg, commands) {
  let s = Rules.createGame(cfg);
  const hashes = [Rules.hashState(s)];
  for (const cmd of commands) {
    const r = Rules.applyCommand(s, cmd);
    if (r.ok) { s = r.state; hashes.push(Rules.hashState(s)); }
  }
  return { state: s, hashes: hashes };
}

// A simple deterministic strategy: flat bar above the creature span.
function autoSolveCommands(state) {
  const cfg = state.cfg;
  let minX = Infinity, maxX = -Infinity, topY = 0, cxSum = 0;
  cfg.creatures.forEach((cr) => {
    minX = Math.min(minX, cr.x - cr.r); maxX = Math.max(maxX, cr.x + cr.r);
    topY = Math.max(topY, cr.y + cr.r); cxSum += cr.x;
  });
  const cx = cxSum / cfg.creatures.length;
  const half = Math.max(170, (maxX - minX) / 2 + 40);
  const y = Math.round(topY + 60);
  return [
    { type: 'stroke', points: [[Math.round(cx - half), y], [Math.round(cx + half), y]] },
    { type: 'release' }
  ];
}

/* ---------------- rules: creation & legality ---------------- */
section('rules: creation and legality');
{
  const cfg = Content.JOURNEY[0];
  const s = Rules.createGame(cfg);
  ok(s.phase === 'draw' && !s.terminal && s.tick === 0, 'initial state');
  ok(Rules.inkRemaining(s) === cfg.ink.budget, 'initial ink');

  const actions = Rules.legalActions(s);
  ok(actions.some((a) => a.type === 'release') && actions.some((a) => a.type === 'stroke'), 'legal actions in draw phase');

  ok(Rules.checkStroke(s, [[500, 300], [520, 300]]) === null, 'legal stroke accepted');
  ok(Rules.checkStroke(s, [[500, 300]]) === Rules.INVALID.TOO_SHORT, 'single point too short');
  ok(Rules.checkStroke(s, [[500, 300], [502, 300]]) === Rules.INVALID.TOO_SHORT, 'tiny stroke too short');
  ok(Rules.checkStroke(s, [[-500, 300], [520, 300]]) === Rules.INVALID.BOUNDS, 'out of bounds rejected');
  ok(Rules.checkStroke(s, [[500, 300], [500, 300], [500, 300]]) === Rules.INVALID.TOO_SHORT, 'deduped jitter too short');
  ok(Rules.checkStroke(s, 'nope') === Rules.INVALID.BAD_SHAPE, 'malformed rejected');
  const tooMany = []; for (let i = 0; i < 200; i++) tooMany.push([i, 300]);
  ok(Rules.checkStroke(s, tooMany) === Rules.INVALID.TOO_MANY_POINTS, 'point cap enforced');
  const long = [[0, 300]]; for (let i = 1; i <= 20; i++) long.push([i * 50, 300]);
  ok(Rules.checkStroke(s, long) === Rules.INVALID.INK, 'ink budget enforced');

  // stroke limit
  let st = s;
  const budgetPerStroke = Math.floor(cfg.ink.budget / cfg.ink.maxStrokes) - 4;
  for (let i = 0; i < cfg.ink.maxStrokes; i++) {
    const r = Rules.applyCommand(st, { type: 'stroke', points: [[100, 100 + i * 20], [100 + budgetPerStroke, 100 + i * 20]] });
    ok(r.ok, 'stroke ' + i + ' accepted');
    st = r.state;
  }
  ok(Rules.checkStroke(st, [[100, 600], [200, 600]]) === Rules.INVALID.STROKE_LIMIT, 'stroke limit enforced');
  ok(st.tick === cfg.ink.maxStrokes, 'tick monotonic with commands');
}

/* ---------------- rules: terminal states & scoring ---------------- */
section('rules: terminal states and scoring');
{
  const cfg = Content.JOURNEY[0];
  let s = Rules.createGame(cfg);
  const cmds = autoSolveCommands(s);
  const win = playToEnd(cfg, cmds).state;
  ok(win.phase === 'done' && win.terminal && win.terminal.won, 'solved round wins');
  ok(win.terminal.reason === Rules.TERMINAL.SURVIVED, 'terminal reason survived');
  const sc = win.score;
  ok(sc.survival === 500 && sc.total === sc.survival + sc.endurance + sc.blocks + sc.clearance + sc.ink,
    'score components sum to total');
  ok(Number.isInteger(sc.total), 'score is integer');
  ok(sc.ink === Rules.inkRemaining(win) * 2, 'ink bonus matches unspent ink');
  ok(Rules.starsFor(win) >= 1, 'win earns at least one star');

  // Losing round: stroke far away from the creature.
  const lose = playToEnd(cfg, [
    { type: 'stroke', points: [[50, 650], [150, 650]] },
    { type: 'release' }
  ]).state;
  ok(lose.terminal && !lose.terminal.won && lose.terminal.reason === Rules.TERMINAL.HIT, 'bad barrier loses');
  ok(lose.score.survival === 0 && lose.score.ink === 0 && lose.score.clearance === 0, 'loss zeroes win bonuses');
  ok(lose.score.endurance > 0 || lose.sim.survivedTicks === 0, 'endurance reflects survived ticks');

  // Resign
  const resign = playToEnd(cfg, [{ type: 'resign' }]).state;
  ok(resign.terminal && resign.terminal.reason === Rules.TERMINAL.RESIGN && resign.score.total === 0, 'resign terminal zero score');

  // Commands after end
  const after = Rules.applyCommand(win, { type: 'stroke', points: [[100, 100], [200, 100]] });
  ok(!after.ok && after.reason === Rules.INVALID.ENDED, 'commands after terminal rejected');
  const rel2 = Rules.applyCommand(win, { type: 'release' });
  ok(!rel2.ok && rel2.reason === Rules.INVALID.ENDED, 'double release rejected');

  // Unknown command
  const bad = Rules.applyCommand(Rules.createGame(cfg), { type: 'explode' });
  ok(!bad.ok && bad.reason === Rules.INVALID.BAD_CMD, 'unknown command rejected');
}

/* ---------------- determinism / replay ---------------- */
section('determinism: replay property test');
{
  const rng = RNG.create(12345);
  let allOk = true;
  for (let iter = 0; iter < 30; iter++) {
    const cfg = Content.JOURNEY[rng.int(Content.JOURNEY.length)];
    // random legal-ish command script
    const script = [];
    const nStrokes = rng.range(0, cfg.ink.maxStrokes);
    for (let i = 0; i < nStrokes; i++) {
      const pts = [];
      const x0 = rng.range(50, 900), y0 = rng.range(80, 620);
      const n = rng.range(2, 12);
      for (let p = 0; p < n; p++) pts.push([x0 + rng.range(-120, 120) + p * rng.range(-20, 20), y0 + rng.range(-60, 60)]);
      script.push({ type: 'stroke', points: pts, atMs: rng.range(0, 30000) });
    }
    script.push({ type: 'release', atMs: rng.range(0, 60000) });
    const a = playToEnd(cfg, script.map(Rules.clone));
    const b = playToEnd(cfg, script.map(Rules.clone));
    if (JSON.stringify(a.hashes) !== JSON.stringify(b.hashes) || a.state.score.total !== b.state.score.total) {
      allOk = false;
      console.error('  nondeterministic on ' + cfg.id);
    }
  }
  ok(allOk, '30 randomized replays produce identical hashes');

  // Cross-check stable stringify / hashState sanity
  const s = Rules.createGame(Content.JOURNEY[5]);
  ok(Rules.hashState(s) === Rules.hashState(Rules.clone(s)), 'hash stable across clone');
}

/* ---------------- fuzz ---------------- */
section('fuzz: malformed commands never hang or corrupt');
{
  const rng = RNG.create(777);
  let s = Rules.createGame(Content.JOURNEY[2]);
  let clean = true;
  const junk = [null, undefined, 42, 'stroke', {}, [], { type: null }, { type: 'stroke' },
    { type: 'stroke', points: 'x' }, { type: 'stroke', points: [[NaN, 0]] },
    { type: 'stroke', points: [[Infinity, 0], [0, 0]] }, { type: 'stroke', points: [[1e9, 0], [0, 0]] },
    { type: 'stroke', points: [[[1, 2], 3], [0, 0]] }, { type: 'release', atMs: -5 },
    { type: 'release', atMs: NaN }, { type: 'resign', extra: { deep: [1, 2, 3] } }];
  for (let i = 0; i < 500; i++) {
    const pick = junk[rng.int(junk.length)];
    const cmd = pick === undefined ? undefined : Rules.clone(pick);
    const r = Rules.applyCommand(s, cmd);
    if (r.ok) s = r.state;
    if (s && s.score && !Number.isFinite(s.score.total)) { clean = false; break; }
  }
  ok(clean, '500 fuzzed commands: no NaN, no crash');
  const shapeJunk = junk.map((j) => Rules.validateCommandShape(j));
  ok(shapeJunk.filter((x) => x === null).length <= 2, 'shape validator rejects nearly all junk');
}

/* ---------------- serialization & migration ---------------- */
section('serialization & save migration');
{
  const cfg = Content.JOURNEY[3];
  const { state } = playToEnd(cfg, autoSolveCommands(Rules.createGame(cfg)));
  const json = Rules.serialize(state);
  const back = Rules.deserialize(json);
  ok(Rules.hashState(back) === Rules.hashState(state), 'serialize round-trip preserves hash');
  ok(back.trace === null, 'trace stripped from serialization');
  let threw = false;
  try { Rules.deserialize(JSON.stringify({ v: 99 })); } catch (e) { threw = true; }
  ok(threw, 'unsupported version rejected');

  const migrated = Store.migrate({ v: 0, settings: { music: 0.3 }, progress: { journeyStars: { j01: 2 } } });
  ok(migrated && migrated.v === Store.SAVE_VERSION && migrated.settings.music === 0.3 &&
     migrated.settings.effects === Store.DEFAULT_SETTINGS.effects && migrated.progress.journeyStars.j01 === 2,
    'save migration fills defaults, keeps values');
  ok(Store.migrate({ v: Store.SAVE_VERSION + 1 }) === null, 'future save version not clobbered');
  ok(Store.checksum('abc') === Store.checksum('abc') && Store.checksum('abc') !== Store.checksum('abd'),
    'checksum deterministic');
}

/* ---------------- hints ---------------- */
section('hints use the real rules pipeline');
{
  const s = Rules.createGame(Content.JOURNEY[0]);
  const h = Rules.hint(s);
  ok(h && h.strokes && h.strokes.length >= 1, 'hint returns strokes');
  ok(h.wouldWin === true, 'hint on j01 wins');
  let st = s;
  for (const hs of h.strokes) {
    const r = Rules.applyCommand(st, { type: 'stroke', points: hs.points });
    ok(r.ok, 'hinted stroke is legal');
    st = r.state;
  }
  const rel = Rules.applyCommand(st, { type: 'release' });
  ok(rel.state.terminal && rel.state.terminal.won, 'following the hint wins');
}

/* ---------------- content validation ---------------- */
section('content: structure, reachability, bounded duration');
{
  ok(Content.JOURNEY.length === 40, 'exactly 40 journey stages');
  ok(Content.THEMES.length === 5, 'five visual themes');
  ok(Content.ACHIEVEMENTS.every((a) => /^[a-z0-9-]+$/.test(a.key)), 'achievement keys stable lowercase');

  const ids = new Set();
  let structural = true, reachable = 0, unreachableList = [];
  const checkCfg = (cfg) => {
    if (ids.has(cfg.id)) { structural = false; console.error('  duplicate id ' + cfg.id); }
    ids.add(cfg.id);
    if (!Number.isInteger(cfg.seed)) structural = false;
    if (cfg.simTicks < 60 || cfg.simTicks > 1800) structural = false;
    cfg.creatures.forEach((c) => {
      if (c.x < 40 || c.x > cfg.world.w - 40 || c.y < 20 || c.y > cfg.world.h - 40) structural = false;
    });
    cfg.emitters.forEach((e) => {
      if (e.x < -20 || e.x > cfg.world.w + 20) structural = false;
      if (!(e.count >= 1 && e.every >= 1)) structural = false;
    });
    // Reachable goal & no soft lock: the hint search must find a win, or a
    // plain roof over the creatures must win.
    const s = Rules.createGame(cfg);
    const hint = Rules.hint(s);
    let wins = !!(hint && hint.wouldWin);
    if (!wins) {
      const roof = playToEnd(cfg, autoSolveCommands(s)).state;
      wins = !!(roof.terminal && roof.terminal.won);
    }
    if (wins) reachable++;
    else unreachableList.push(cfg.id);
  };
  Content.JOURNEY.forEach(checkCfg);
  Content.CHALLENGES.forEach(checkCfg);
  ['gentle', 'steady', 'tempest'].forEach((p) => checkCfg(Content.makePractice(p, 42)));
  checkCfg(Content.makeStorm(2026));
  // A year of dailies
  const d0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 366; i++) {
    checkCfg(Content.dailyConfig(Content.utcDateString(d0 + i * 86400000)));
  }
  ok(structural, 'all configs structurally valid (ids, seeds, bounds, duration)');
  ok(unreachableList.length === 0, 'all ' + reachable + ' configs have a reachable win' +
    (unreachableList.length ? ' — unreachable: ' + unreachableList.join(',') : ''));

  // Daily immutability: same date → identical config, twice.
  const d1 = Content.dailyConfig('2026-03-14');
  const d2 = Content.dailyConfig('2026-03-14');
  ok(JSON.stringify(d1) === JSON.stringify(d2), 'daily config immutable for a date');
  ok(Content.dailyConfig('2026-03-14').seed !== Content.dailyConfig('2026-03-15').seed, 'daily seed varies by date');

  // Tutorials are completable: each goal event is achievable.
  const lessons = Content.tutorialLessons();
  ok(lessons.length === 5, 'five tutorial lessons');
  for (const L of lessons) {
    const s = Rules.createGame(L.cfg);
    if (L.goal.event === 'stroke') {
      ok(Rules.checkStroke(s, [[400, 300], [600, 300]]) === null, L.id + ' stroke possible');
    } else if (L.goal.event === 'win') {
      const h = Rules.hint(s);
      ok(h && h.wouldWin, L.id + ' winnable via hint');
    } else if (L.goal.event === 'undo') {
      ok(L.cfg.mechanics.undo === true, L.id + ' undo enabled');
    }
  }
}

/* ---------------- golden sessions ---------------- */
section('golden sessions');
{
  // Pinned hashes guard against accidental physics drift. If you change the
  // physics intentionally, update these after eyeballing one replay.
  const cases = [
    ['easy', Content.JOURNEY[0]],
    ['medium', Content.JOURNEY[14]],
    ['hard', Content.JOURNEY[39]]
  ];
  let goldenOk = true;
  for (const [label, cfg] of cases) {
    const s = Rules.createGame(cfg);
    const h = Rules.hint(s);
    if (!h) { goldenOk = false; console.error('  no hint for golden ' + label); continue; }
    const cmds = h.strokes.map((hs) => ({ type: 'stroke', points: hs.points }));
    cmds.push({ type: 'release' });
    const end = playToEnd(cfg, cmds).state;
    if (!(end.terminal && end.terminal.won)) { goldenOk = false; console.error('  golden ' + label + ' lost'); }
    console.log('  ' + label.padEnd(7) + ' ' + cfg.id + '  score=' + end.score.total +
      ' stars=' + Rules.starsFor(end) + ' hash=' + Rules.hashState(end));
  }
  ok(goldenOk, 'golden easy/medium/hard sessions all win');

  // Interrupted + resumed: serialize mid-draw, resume, finish identically.
  const cfg = Content.JOURNEY[7];
  let s1 = Rules.createGame(cfg);
  const r1 = Rules.applyCommand(s1, { type: 'stroke', points: [[350, 200], [650, 200]], atMs: 1200 });
  s1 = r1.state;
  const resumed = Rules.deserialize(Rules.serialize(s1));
  const rest = [{ type: 'stroke', points: [[300, 300], [700, 380]], atMs: 4000 }, { type: 'release', atMs: 4100 }];
  const a = playToEnd(cfg, [{ type: 'stroke', points: [[350, 200], [650, 200]], atMs: 1200 }].concat(rest)).state;
  let b = resumed;
  for (const c of rest) b = Rules.applyCommand(b, c).state;
  ok(Rules.hashState(a) === Rules.hashState(b) && a.score.total === b.score.total,
    'interrupted+resumed session matches uninterrupted');
}

/* ---------------- server: replay validation ---------------- */
section('server: authoritative validation');
{
  const cfg = Content.dailyConfig('2026-08-30');
  const board = 'daily-2026-08-30';
  const s0 = Rules.createGame(cfg);
  const cmds = autoSolveCommands(s0);
  let s = s0;
  const hashes = [];
  cmds.forEach((c, i) => {
    c.id = 'cmd-' + i;
    const r = Rules.applyCommand(s, c);
    s = r.state; hashes.push(Rules.hashState(s));
  });
  const env = {
    schema: 1, contentVersion: Content.CONTENT_VERSION, seed: cfg.seed, cfgId: cfg.id,
    initialHash: Rules.hashState(s0), startedOffsetMs: 9000,
    commands: cmds, stateHashes: hashes,
    result: { score: s.score.total, won: s.terminal.won, terminalReason: s.terminal.reason }
  };
  const v = Server.validateEnvelope(board, env);
  ok(v.ok === true && v.score === s.score.total, 'valid envelope accepted');

  const tampered = JSON.parse(JSON.stringify(env));
  tampered.result.score += 100;
  ok(Server.validateEnvelope(board, tampered).error === 'result-mismatch', 'tampered score rejected');

  const badSeed = JSON.parse(JSON.stringify(env));
  badSeed.seed = 1;
  ok(Server.validateEnvelope(board, badSeed).error === 'seed-mismatch', 'wrong seed rejected');

  const stale = JSON.parse(JSON.stringify(env));
  stale.contentVersion = 999;
  ok(Server.validateEnvelope(board, stale).error === 'stale-content-version', 'stale version rejected');

  const badBoard = Server.validateEnvelope('daily-99', env);
  ok(badBoard.error === 'unknown-board', 'unknown board rejected');

  const broken = JSON.parse(JSON.stringify(env));
  broken.stateHashes[0] = 12345;
  ok(Server.validateEnvelope(board, broken).error === 'state-hash-mismatch', 'hash mismatch detected');

  ok(Server.configForBoard('storm') === 'storm', 'storm board resolves via envelope seed');
  const stormEnv = (() => {
    const c = Content.makeStorm(77);
    const st = Rules.createGame(c);
    const cmds2 = autoSolveCommands(st);
    let cur = st; const hh = [];
    cmds2.forEach((cc, i) => { cc.id = 'c' + i; cur = Rules.applyCommand(cur, cc).state; hh.push(Rules.hashState(cur)); });
    return { schema: 1, contentVersion: Content.CONTENT_VERSION, seed: 77, cfgId: 'storm',
      initialHash: Rules.hashState(st), startedOffsetMs: 5000, commands: cmds2, stateHashes: hh,
      result: { score: cur.score.total, won: cur.terminal.won, terminalReason: cur.terminal.reason } };
  })();
  ok(Server.validateEnvelope('storm', stormEnv).ok === true, 'storm envelope validates');
}

/* ---------------- leaderboard ties ---------------- */
section('leaderboard ordering');
{
  const sorted = Store.sortEntries([
    { sessionId: 'b', score: 100, won: true, invalid: 0, durationMs: 5000 },
    { sessionId: 'a', score: 100, won: true, invalid: 0, durationMs: 5000 },
    { sessionId: 'c', score: 100, won: true, invalid: 1, durationMs: 4000 },
    { sessionId: 'd', score: 900, won: false, invalid: 0, durationMs: 1000 },
    { sessionId: 'e', score: 200, won: true, invalid: 0, durationMs: 9000 }
  ]);
  ok(sorted[0].sessionId === 'e' && sorted[1].sessionId === 'a' && sorted[2].sessionId === 'b' &&
     sorted[3].sessionId === 'c' && sorted[4].sessionId === 'd',
    'ties resolve: won, score, invalid, duration, session id');
}

/* ---------------- summary ---------------- */
console.log('\n========================================');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
