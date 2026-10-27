// The engine save and the migration from the browser build: the old cloud
// slot's save.json (the { v, settings, progress } document the JS SDK's
// saveJSON stored) becomes { v: 1, progress } plus the game's own settings;
// two devices' copies merge to the better of both; the settings checks.
// (native/platform.ts wires these into starhermit:storage; signed-in paths
// cannot run here, so their logic is covered by these tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
const Store = require('../js/store.js');

function browserSave(progress, settings) {
  const doc = Store.fresh();
  Object.assign(doc.progress, progress);
  Object.assign(doc.settings, settings);
  return JSON.stringify(doc); // what StarHermit.saveJSON stored as save.json
}

test('the browser build\'s cloud save converts to the engine save and the game settings', () => {
  const text = browserSave({ journeyStars: { j01: 2 }, tutorialDone: { t1: true }, stormBest: 1200, achievements: { 'first-save': 5 } },
    { theme: 'tide', colorPalette: 'high-visibility', haptics: false, confirmRelease: true, music: 0.2, graphics: { preset: 'high' }, reducedMotion: true });
  const { doc, settings } = Store.fromBrowserSave(text);
  assert.equal(doc.v, 1);
  assert.deepEqual(Object.keys(doc), ['v', 'progress']);
  assert.equal(doc.progress.journeyStars.j01, 2);
  assert.equal(doc.progress.tutorialDone.t1, true);
  assert.equal(doc.progress.stormBest, 1200);
  assert.deepEqual(settings, { theme: 'tide', colorPalette: 'high-visibility', captions: false, leftHanded: false, haptics: false, boardMirror: false, confirmRelease: true });
  assert.equal(settings.music, undefined, 'volumes are the runtime\'s now');
  assert.equal(settings.graphics, undefined, 'graphics are the runtime\'s now');
});

test('a legacy graphicsTier save still converts', () => {
  const raw = JSON.parse(browserSave({ journeyBest: { j02: 900 } }, {}));
  raw.settings.graphicsTier = 'medium';
  const { doc } = Store.fromBrowserSave(JSON.stringify(raw));
  assert.equal(doc.progress.journeyBest.j02, 900);
});

test('a corrupt, foreign or newer save is ignored', () => {
  assert.deepEqual(Store.fromBrowserSave('not json'), { doc: null, settings: null });
  assert.deepEqual(Store.fromBrowserSave(JSON.stringify({ sum: 'x', payload: '{}' })), { doc: null, settings: null });
  assert.deepEqual(Store.fromBrowserSave(JSON.stringify({ v: 99, settings: {}, progress: {} })), { doc: null, settings: null });
  assert.deepEqual(Store.fromBrowserSave(null), { doc: null, settings: null });
  assert.equal(Store.docFromSave([1, 2]), null);
  assert.equal(Store.docFromSave({ v: 2, progress: {} }), null);
});

test('the engine save reads back with defaults filled in', () => {
  const d = Store.docFromSave({ v: 1, progress: { journeyStars: { j03: 1 } } });
  assert.equal(d.progress.journeyStars.j03, 1);
  assert.equal(d.progress.stats.rounds, 0);
  assert.equal(d.progress.cosmetics.theme, 'graphite');
});

test('two devices merge to the better of both; this device keeps its cosmetics', () => {
  const remote = { ...Store.defaultProgress(), journeyStars: { j01: 3, j02: 1 }, journeyBest: { j01: 1500 }, stormBest: 800,
    achievements: { 'first-save': 100 }, tutorialDone: { t1: true }, stats: { rounds: 9, saves: 4, hazardsBlocked: 60, inkSpent: 5000, bestClearance: 80, playMs: 9000 },
    cosmetics: { theme: 'night' } };
  const local = { ...Store.defaultProgress(), journeyStars: { j01: 1, j03: 2 }, journeyBest: { j01: 1600 }, stormBest: 900,
    achievements: { 'first-save': 50, 'blocks-50': 70 }, tutorialDone: { t2: true }, cosmetics: { theme: 'tide' } };
  const m = Store.mergeProgress(remote, local);
  assert.deepEqual(m.journeyStars, { j01: 3, j02: 1, j03: 2 });
  assert.equal(m.journeyBest.j01, 1600);
  assert.equal(m.stormBest, 900);
  assert.deepEqual(m.achievements, { 'first-save': 50, 'blocks-50': 70 });
  assert.deepEqual(m.tutorialDone, { t1: true, t2: true });
  assert.equal(m.stats.rounds, 9);
  assert.equal(m.cosmetics.theme, 'tide');
});

test('the game\'s settings are checked', () => {
  assert.equal(Store.checkSetting('theme', 'bloom'), 'bloom');
  assert.equal(Store.checkSetting('theme', 'paper'), undefined);
  assert.equal(Store.checkSetting('colorPalette', 'high-visibility'), 'high-visibility');
  assert.equal(Store.checkSetting('haptics', 'yes'), undefined);
  assert.equal(Store.checkSetting('confirmRelease', true), true);
  assert.equal(Store.checkSetting('music', 0.5), undefined);
  assert.deepEqual(Store.GAME_SETTING_KEYS, ['theme', 'colorPalette', 'captions', 'leftHanded', 'haptics', 'boardMirror', 'confirmRelease']);
  for (const k of Store.GAME_SETTING_KEYS) assert.ok(Store.BROWSER_SETTING_KEYS.includes(k), k);
});
