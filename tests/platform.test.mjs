// js/platform.js (GSPlatform) on the real StarHermit SDK with a stubbed fetch
// and launch URL. Run: node --test tests/platform.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SDK = require('../starhermit-sdk.js');
const GSPlatform = require('../js/platform.js');
const Store = require('../js/store.js');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = 'h.' + b64u({ sub: 'ink-12345678', game_scope: 'guardian-id', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';

function harness(href, routes = {}, hooks = {}) {
  const calls = [], store = {}, url = new URL(href);
  const win = { location: { hash: url.hash, search: url.search, pathname: url.pathname, origin: url.origin, hostname: url.hostname, href }, history: { replaceState: (a, b, u) => { win.replaced = u; } } };
  const fetch = async (path, init = {}) => {
    const method = init.method || 'GET'; calls.push({ path, method, body: init.body });
    if (path.includes('/cloud-saves/')) {
      const key = decodeURIComponent(path.split('/cloud-saves/')[1]);
      if (key.endsWith('/info')) return new Response(JSON.stringify({ exists: !!store[key.slice(0, -5)] }), { status: 200 });
      if (method === 'PUT') { store[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return new Response('{}', { status: 200 }); }
      return store[key] ? new Response(store[key], { status: 200 }) : new Response('', { status: 404 });
    }
    const hit = Object.entries(routes).find(([k]) => `${method} ${path}`.endsWith(k));
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response('', { status: 404 });
  };
  const sh = SDK.create({ window: win, fetch, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; } });
  return { platform: GSPlatform.createPlatform(hooks, sh), sh, calls, store, win };
}

test('hosted: token, nickname, game:<slug> save round-trip, settings KV, key bindings', async () => {
  const statuses = [];
  const h = harness('https://guardian-id.starhermit.com/#game_token=' + TOKEN, {
    'GET /api/v1/users/ink-12345678/profile': { username: 'raw', nickname: 'Inkwell' },
    'GET /api/v1/games/guardian-id/settings': { settings: { music: 0.2, theme: 'sepia', haptics: 'no' } },
    'PATCH /api/v1/games/guardian-id/settings': {},
    'GET /api/v1/games/guardian-id/controls': { actions: [{ action: 'release', codes: ['KeyE'] }] },
  }, { onSyncStatus: (s) => statuses.push(s) });
  const p = h.platform;
  assert.equal(p.hosted(), true); assert.equal(p.gameSlug(), 'guardian-id'); assert.equal(p.userId(), 'ink-12345678');
  assert.equal(h.win.replaced, '/');
  assert.equal(await p.loadProfile(), 'Inkwell'); assert.equal(p.displayName(), 'Inkwell');
  assert.equal(await p.loadCloudSave(), null, 'empty slot');
  const doc = Store.fresh ? Store.fresh() : { v: 1, settings: { music: 0.6 }, progress: { stormBest: 3 } };
  p.scheduleCloudSave(doc);
  assert.equal(await p.flushCloudSave(), true);
  assert.equal(p.syncStatus(), 'synced'); assert.ok(statuses.includes('saving'));
  assert.deepEqual(Object.keys(h.store), ['game:guardian-id']);
  assert.ok(h.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/me/cloud-saves/' + encodeURIComponent('game:guardian-id')));
  assert.deepEqual(await p.loadCloudSave(), JSON.parse(JSON.stringify(doc)));

  const settings = { music: 0.6, effects: 0.9, theme: 'graphite', haptics: true, graphics: {} };
  assert.equal(GSPlatform.applyRemoteSettings(settings, await p.loadSettings()), true);
  assert.equal(settings.music, 0.2); assert.equal(settings.theme, 'sepia'); assert.equal(settings.haptics, true);
  p.baselineSettings(settings);
  p.syncSettings(settings);
  assert.equal(h.calls.filter((c) => c.method === 'PATCH').length, 0, 'unchanged settings are not patched');
  settings.effects = 0.3; p.syncSettings(settings);
  const patch = h.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.path, '/api/v1/games/guardian-id/settings'); assert.equal(JSON.parse(patch.body).settings.effects, 0.3);
  await p.loadKeys();
  assert.equal(p.actionForCode('KeyE'), 'release'); assert.equal(p.actionForCode('KeyR'), null);
  assert.equal(p.actionForCode('Escape'), 'pause');
  assert.match(p.inviteLink(), /\/game-invite\/ink-12345678\/guardian-id$/);
});

test('hosted leaderboard read resolves nicknames', async () => {
  const h = harness('https://x.example/#game_token=' + TOKEN, {
    'GET /api/v1/games/guardian-id': { leaderboardId: 'lb-1' },
    'GET /api/v1/leaderboards/lb-1/entries?page=1&pageSize=50': { items: [{ userId: 'ink-12345678', score: 900 }] },
    'GET /api/v1/users/ink-12345678/profile': { nickname: 'Inkwell' },
  });
  assert.deepEqual(await h.platform.hostedBoardEntries(), [{ name: 'Inkwell', score: 900, won: false, self: true, sessionId: 'ink-12345678' }]);
});

test('renewal refused: back to local play', () => {
  let out = 0;
  const h = harness('https://x.example/#game_token=' + TOKEN, {}, { onSignedOut: () => out++ });
  h.sh.signOut('expired');
  assert.equal(h.platform.hosted(), false); assert.equal(out, 1); assert.equal(h.platform.displayName(), null);
});

test('standalone: offline, default keys, no network calls', async () => {
  const h = harness('http://127.0.0.1:8080/');
  const p = h.platform;
  assert.equal(p.hosted(), false); assert.equal(p.syncStatus(), 'offline'); assert.equal(p.canSignIn(), false);
  p.scheduleCloudSave({ v: 1 }); await p.flushCloudSave();
  assert.equal(await p.loadCloudSave(), null); assert.deepEqual(await p.loadSettings(), {});
  p.syncSettings({ music: 1 }); await p.loadKeys();
  assert.equal(p.actionForCode('Space'), 'penToggle'); assert.equal(p.actionForCode('KeyR'), 'release');
  assert.equal(await p.hostedBoardEntries(), null); assert.equal(p.inviteLink(), null);
  assert.equal(h.calls.length, 0);
  assert.equal(harness('https://guardian-id.starhermit.com/').platform.canSignIn(), true);
});
