// Guardian Sketch — authoritative server + static file host.
// Zero dependencies (Node core only). Serves the distribution, validates
// ranked score claims by replaying the deterministic input log through the
// same rules engine the client uses, and stores leaderboards on disk.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const DATA_DIR = path.join(ROOT, 'data');
const BOARD_FILE = path.join(DATA_DIR, 'leaderboards.json');

const RNG = require('./js/rng.js');
const Rules = require('./js/rules.js');
const Content = require('./js/content.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.opus': 'audio/ogg'
};

// ---------- persistence ----------
function loadBoards() {
  try { return JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); }
  catch (e) { return { v: 1, entries: [] }; }
}
function saveBoards(b) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BOARD_FILE, JSON.stringify(b));
  } catch (e) { /* disk trouble: keep serving reads */ }
}

// ---------- tiny utils ----------
function send(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}
function sendError(res, code, msg) { send(res, code, { error: msg }); }

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (cap || 65536)) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Naive per-IP sliding-window rate limiter (recoverable 429s).
const rateBuckets = new Map();
function rateLimited(ip, key, limit, windowMs) {
  const k = ip + '|' + key;
  const now = Date.now();
  let arr = rateBuckets.get(k);
  if (!arr) { arr = []; rateBuckets.set(k, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) return true;
  arr.push(now);
  return false;
}
setInterval(() => { // keep the map bounded
  const now = Date.now();
  for (const [k, arr] of rateBuckets) {
    while (arr.length && now - arr[0] > 600000) arr.shift();
    if (!arr.length) rateBuckets.delete(k);
  }
}, 60000).unref();

// ---------- config registry (authoritative content resolution) ----------
function configForBoard(board) {
  if (typeof board !== 'string' || board.length > 64) return null;
  if (board === 'storm') {
    // Tempest Stand is ranked per-seed; the seed arrives inside the envelope.
    return 'storm';
  }
  let m = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(board);
  if (m) return Content.dailyConfig(m[1]);
  m = /^challenge-([a-z0-9-]+)$/.exec(board);
  if (m) {
    const c = Content.CHALLENGES.find((x) => x.id === m[1]);
    return c || null;
  }
  m = /^journey-([a-z0-9]+)$/.exec(board);
  if (m) {
    const j = Content.JOURNEY.find((x) => x.id === m[1]);
    return j || null;
  }
  return null;
}

// ---------- replay validation ----------
// envelope: {schema, contentVersion, seed, cfgId, initialHash,
//            startedOffsetMs, commands:[{id,type,points?,atMs?}],
//            stateHashes:[...], result:{score,won,terminalReason}}
function validateEnvelope(board, env) {
  if (!env || typeof env !== 'object') return { error: 'malformed-envelope' };
  if (env.schema !== 1) return { error: 'unsupported-schema' };
  if (env.contentVersion !== Content.CONTENT_VERSION) return { error: 'stale-content-version' };

  let cfg = configForBoard(board);
  if (!cfg) return { error: 'unknown-board' };
  if (cfg === 'storm') {
    if (!Number.isInteger(env.seed) || env.seed < 0) return { error: 'bad-seed' };
    cfg = Content.makeStorm(env.seed >>> 0);
  } else {
    if ((env.seed >>> 0) !== (cfg.seed >>> 0)) return { error: 'seed-mismatch' };
    if (env.cfgId !== cfg.id) return { error: 'config-mismatch' };
  }

  if (!Array.isArray(env.commands) || env.commands.length > 64) return { error: 'bad-command-log' };
  if (!env.result || typeof env.result !== 'object') return { error: 'missing-result' };

  let state;
  try { state = Rules.createGame(cfg); } catch (e) { return { error: 'bad-config' } };
  if (Rules.hashState(state) !== env.initialHash) return { error: 'initial-hash-mismatch' };

  const seen = new Set();
  let invalid = 0;
  for (let i = 0; i < env.commands.length; i++) {
    const cmd = env.commands[i];
    const shapeErr = Rules.validateCommandShape(cmd);
    if (shapeErr) return { error: 'malformed-command', detail: shapeErr };
    const cid = cmd.id != null ? cmd.id : 'cmd-' + i;
    if (seen.has(cid)) continue; // idempotent duplicates are ignored, like the client
    seen.add(cid);
    const r = Rules.applyCommand(state, cmd);
    if (!r.ok) {
      invalid++;
      if (invalid > 8) return { error: 'too-many-invalid-commands' };
      continue;
    }
    state = r.state;
    if (Array.isArray(env.stateHashes) && env.stateHashes[i] != null &&
        env.stateHashes[i] !== Rules.hashState(state)) {
      return { error: 'state-hash-mismatch', detail: 'command ' + i };
    }
  }

  if (!state.terminal) return { error: 'incomplete-replay' };
  const score = state.score.total;
  const won = !!state.terminal.won;
  if (env.result.score !== score || env.result.won !== won) return { error: 'result-mismatch' };

  const dur = Number.isFinite(env.durationMs) ? env.durationMs : (env.startedOffsetMs | 0);
  return {
    ok: true,
    score: score,
    won: won,
    invalid: invalid,
    durationMs: Math.max(0, Math.min(3600000, dur)),
    contentVersion: env.contentVersion,
    seed: env.seed >>> 0
  };
}

// ---------- API ----------
async function handleApi(req, res, url, ip) {
  if (url.pathname === '/api/v1/time' && req.method === 'GET') {
    send(res, 200, { now: Date.now() });
    return;
  }
  if (url.pathname === '/api/v1/daily' && req.method === 'GET') {
    const date = Content.utcDateString(Date.now());
    send(res, 200, { date: date, config: Content.dailyConfig(date) });
    return;
  }
  if (url.pathname === '/api/v1/leaderboard' && req.method === 'GET') {
    const board = url.searchParams.get('board') || '';
    if (!configForBoard(board)) { sendError(res, 404, 'unknown-board'); return; }
    const boards = loadBoards();
    const entries = boards.entries
      .filter((e) => e.board === board)
      .sort(compareEntries)
      .slice(0, 50);
    send(res, 200, { board: board, entries: entries, validated: true });
    return;
  }
  if (url.pathname === '/api/v1/score' && req.method === 'POST') {
    if (rateLimited(ip, 'score', 20, 60000)) { sendError(res, 429, 'rate-limited'); return; }
    let body;
    try { body = JSON.parse(await readBody(req, 200000)); }
    catch (e) { sendError(res, 400, 'bad-json'); return; }
    const board = body && body.board;
    const name = String((body && body.name) || 'guest').slice(0, 24) || 'guest';
    if (!configForBoard(board)) { sendError(res, 404, 'unknown-board'); return; }
    const v = validateEnvelope(board, body.envelope);
    if (v.error) { send(res, 422, { error: v.error, detail: v.detail || null }); return; }

    const boards = loadBoards();
    const sessionId = String((body && body.sessionId) || '').slice(0, 64) ||
      RNG.hashString(JSON.stringify(body.envelope.commands)).toString(36);
    // Idempotent: identical sessionId+board replaces rather than duplicates.
    const existing = boards.entries.findIndex((e) => e.board === board && e.sessionId === sessionId);
    const entry = {
      board: board, name: name, sessionId: sessionId,
      score: v.score, won: v.won, invalid: v.invalid, durationMs: v.durationMs,
      contentVersion: v.contentVersion, seed: v.seed,
      date: Content.utcDateString(Date.now()), ts: Date.now()
    };
    if (existing >= 0) {
      if (compareEntries(entry, boards.entries[existing]) < 0) boards.entries[existing] = entry;
    } else {
      boards.entries.push(entry);
    }
    boards.entries = boards.entries.sort(compareEntries).slice(0, 2000);
    saveBoards(boards);
    const ranked = boards.entries.filter((e) => e.board === board);
    const position = ranked.findIndex((e) => e.sessionId === sessionId) + 1;
    send(res, 200, { ok: true, position: position, of: ranked.length, top: ranked.slice(0, 10) });
    return;
  }
  // Presence / activity / telemetry: accepted, not persisted beyond a count.
  if (url.pathname === '/api/v1/presence' && req.method === 'POST') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/api/v1/activity' && req.method === 'POST') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/api/v1/telemetry' && req.method === 'POST') {
    if (rateLimited(ip, 'telemetry', 60, 60000)) { sendError(res, 429, 'rate-limited'); return; }
    try { await readBody(req, 16384); } catch (e) { /* ignore */ }
    res.writeHead(204); res.end(); return;
  }
  sendError(res, 404, 'unknown-route');
}

// Leaderboard ties: won first, higher score, fewer invalid actions,
// lower duration, then stable session id. Matches the client sorter.
function compareEntries(a, b) {
  if (!!b.won !== !!a.won) return (b.won ? 1 : 0) - (a.won ? 1 : 0);
  if (b.score !== a.score) return b.score - a.score;
  if ((a.invalid || 0) !== (b.invalid || 0)) return (a.invalid || 0) - (b.invalid || 0);
  if ((a.durationMs || 0) !== (b.durationMs || 0)) return (a.durationMs || 0) - (b.durationMs || 0);
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

// ---------- static ----------
const STATIC_ALLOW = new Set(['.html', '.js', '.mjs', '.css', '.json', '.png', '.svg', '.txt', '.ico', '.opus']);
function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === '/' || p.endsWith('/')) p = '/index.html';
  const file = path.normalize(path.join(ROOT, p.replace(/^\/+/, '')));
  if (!file.startsWith(ROOT) || file.includes(`${path.sep}data${path.sep}`)) {
    sendError(res, 403, 'forbidden');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  if (!STATIC_ALLOW.has(ext)) { sendError(res, 404, 'not-found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { sendError(res, 404, 'not-found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { sendError(res, 400, 'bad-url'); return; }
  const ip = req.socket.remoteAddress || 'unknown';
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url, ip).catch(() => sendError(res, 500, 'internal'));
  } else {
    serveStatic(req, res, url);
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Guardian Sketch server on http://localhost:${PORT}`));
}
module.exports = { server, validateEnvelope, compareEntries, configForBoard };
