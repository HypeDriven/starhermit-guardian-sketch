/* Guardian Sketch — persistence: versioned, checksummed local save document.
 * Never stores credentials or tokens. Classic script: global GSStore natively
 * (loadClassic, with a localStorage shim over the device storage), require() in Node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GSStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAVE_VERSION = 1;
  var KEY = 'guardiansketch.save.v1';
  var LB_KEY = 'guardiansketch.leaderboards.v1';

  var DEFAULT_SETTINGS = {
    music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8,
    muted: false, captions: false,
    graphics: {},               // {preset: auto|low|balanced|high|ultra, render_scale, adaptive, show_fps, <category>: tier}
    theme: 'graphite',
    reducedMotion: false,
    highContrast: false,
    colorPalette: 'standard',   // standard | high-visibility
    largeText: false,
    leftHanded: false,
    haptics: true,
    boardMirror: false,         // always-visible DOM board
    confirmRelease: false       // timing assistance: tap Release twice
  };

  function defaultProgress() {
    return {
      tutorialDone: {},        // lessonId -> true
      journeyStars: {},        // levelId -> 0..3
      journeyBest: {},         // levelId -> score
      challengeBest: {},       // challengeId -> score
      dailiesDone: {},         // dateStr -> score
      stormBest: 0,
      achievements: {},        // key -> unlockedAtMs
      stats: { rounds: 0, saves: 0, hazardsBlocked: 0, inkSpent: 0,
               bestClearance: 0, playMs: 0 },
      cosmetics: { theme: 'graphite' }
    };
  }

  function checksum(str) { // FNV-1a, decimal string
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function migrate(doc) {
    // v1 is current; older shapes are upgraded field-by-field here.
    if (!doc || typeof doc !== 'object') return null;
    if (doc.v > SAVE_VERSION) return null; // future format: don't clobber
    doc.v = SAVE_VERSION;
    var legacyTier = doc.settings && doc.settings.graphicsTier;
    doc.settings = Object.assign({}, DEFAULT_SETTINGS, doc.settings || {});
    if (legacyTier !== undefined) { // old single quality tier → graphics preset
      if (!doc.settings.graphics || !doc.settings.graphics.preset) {
        doc.settings.graphics = { preset: { low: 'low', medium: 'balanced', high: 'high' }[legacyTier] || 'auto' };
      }
      delete doc.settings.graphicsTier;
    }
    if (!doc.settings.graphics || typeof doc.settings.graphics !== 'object') doc.settings.graphics = {};
    doc.progress = Object.assign(defaultProgress(), doc.progress || {});
    doc.progress.stats = Object.assign(defaultProgress().stats, doc.progress.stats || {});
    return doc;
  }

  function fresh() {
    return { v: SAVE_VERSION, settings: Object.assign({}, DEFAULT_SETTINGS), progress: defaultProgress() };
  }

  var memoryFallback = null; // used when localStorage is unavailable

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (raw == null && memoryFallback) raw = memoryFallback;
    if (raw == null) return fresh();
    try {
      var doc = JSON.parse(raw);
      if (!doc || doc.sum !== checksum(doc.payload)) return fresh(); // corrupt → clean slate
      var migrated = migrate(JSON.parse(doc.payload));
      return migrated || fresh();
    } catch (e) { return fresh(); }
  }

  function save(doc) {
    doc.v = SAVE_VERSION;
    var payload = JSON.stringify(doc);
    var wrapped = JSON.stringify({ sum: checksum(payload), payload: payload });
    memoryFallback = wrapped;
    try { localStorage.setItem(KEY, wrapped); } catch (e) { /* memory fallback keeps session */ }
  }

  // ---------- leaderboards (local; host adapter may sync) ----------
  function loadBoards() {
    try {
      var raw = localStorage.getItem(LB_KEY);
      return raw ? JSON.parse(raw) : { entries: [] };
    } catch (e) { return { entries: [] }; }
  }
  function saveBoards(b) {
    try { localStorage.setItem(LB_KEY, JSON.stringify(b)); } catch (e) {}
  }

  // Ties: primary objective (won), higher score, fewer invalid actions,
  // lower elapsed, then stable session id. Returns sorted copy.
  function sortEntries(entries) {
    return entries.slice().sort(function (a, b) {
      if (!!b.won !== !!a.won) return (b.won ? 1 : 0) - (a.won ? 1 : 0);
      if (b.score !== a.score) return b.score - a.score;
      if ((a.invalid || 0) !== (b.invalid || 0)) return (a.invalid || 0) - (b.invalid || 0);
      if ((a.durationMs || 0) !== (b.durationMs || 0)) return (a.durationMs || 0) - (b.durationMs || 0);
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
  }

  // ---------- cloud-save conflict merge ----------
  // Another device saved since this one last loaded: keep the better value of
  // every record (stars, bests, dailies, storm best, stats), the union of
  // lessons and achievements (earliest unlock time), and this device's
  // cosmetics. Neither side's progress is dropped.
  function maxMap(a, b) {
    var out = {}, k;
    a = a || {}; b = b || {};
    for (k in a) if (typeof a[k] === 'number') out[k] = a[k];
    for (k in b) if (typeof b[k] === 'number') out[k] = k in out ? Math.max(out[k], b[k]) : b[k];
    return out;
  }
  function mergeProgress(remote, local) {
    var r = migrate({ v: SAVE_VERSION, progress: remote || {} }).progress;
    var l = migrate({ v: SAVE_VERSION, progress: local || {} }).progress;
    var ach = {}, k;
    for (k in r.achievements) ach[k] = r.achievements[k];
    for (k in l.achievements) ach[k] = k in ach ? Math.min(ach[k], l.achievements[k]) : l.achievements[k];
    var tut = {};
    for (k in r.tutorialDone) if (r.tutorialDone[k]) tut[k] = true;
    for (k in l.tutorialDone) if (l.tutorialDone[k]) tut[k] = true;
    return {
      tutorialDone: tut,
      journeyStars: maxMap(r.journeyStars, l.journeyStars),
      journeyBest: maxMap(r.journeyBest, l.journeyBest),
      challengeBest: maxMap(r.challengeBest, l.challengeBest),
      dailiesDone: maxMap(r.dailiesDone, l.dailiesDone),
      stormBest: Math.max(r.stormBest || 0, l.stormBest || 0),
      achievements: ach,
      stats: maxMap(r.stats, l.stats),
      cosmetics: l.cosmetics || r.cosmetics
    };
  }

  // ---------- the engine client (native/platform.ts) ----------
  // The engine save is { v: 1, progress }: this document without its settings
  // (the runtime's Options and the game's own settings below hold them now).
  function docFromSave(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.v > SAVE_VERSION) return null; // future format: don't clobber
    var d = migrate(JSON.parse(JSON.stringify(data)));
    return d ? { v: SAVE_VERSION, progress: d.progress } : null;
  }

  var bool = function (v) { return typeof v === 'boolean'; };
  var THEME_IDS = ['graphite', 'ember', 'tide', 'bloom', 'night'];
  /** The game's own settings (game.<key> in the runtime's settings) with their checks. */
  var GAME_SETTINGS = {
    theme: function (v) { return THEME_IDS.indexOf(v) >= 0; },
    colorPalette: function (v) { return v === 'standard' || v === 'high-visibility'; },
    captions: bool, leftHanded: bool, haptics: bool, boardMirror: bool, confirmRelease: bool
  };
  var GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
  /** What the browser build mirrored to the account's per-player settings (its SYNCED_SETTINGS). */
  var BROWSER_SETTING_KEYS = ['music', 'effects', 'ambience', 'voice', 'muted', 'captions', 'graphics', 'theme',
    'reducedMotion', 'highContrast', 'colorPalette', 'largeText', 'leftHanded', 'haptics', 'boardMirror', 'confirmRelease'];
  /** A valid value for one of the game's settings, else undefined. */
  function checkSetting(key, v) {
    var ok = GAME_SETTINGS[key];
    return ok && ok(v) ? v : undefined;
  }
  /** The game's settings among a browser-build settings object. */
  function gameSettingsFrom(s) {
    var out = {};
    if (!s || typeof s !== 'object') return out;
    GAME_SETTING_KEYS.forEach(function (k) { if (checkSetting(k, s[k]) !== undefined) out[k] = s[k]; });
    return out;
  }
  /** The browser build's cloud save (the SDK's save.json: the plain { v, settings, progress } JSON): its doc and game settings. */
  function fromBrowserSave(text) {
    var raw = null;
    try { raw = typeof text === 'string' ? JSON.parse(text) : null; } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.progress || typeof raw.progress !== 'object') return { doc: null, settings: null };
    var d = docFromSave(raw);
    if (!d) return { doc: null, settings: null };
    return { doc: d, settings: gameSettingsFrom(raw.settings) };
  }

  return {
    SAVE_VERSION: SAVE_VERSION,
    docFromSave: docFromSave,
    fromBrowserSave: fromBrowserSave,
    GAME_SETTING_KEYS: GAME_SETTING_KEYS,
    BROWSER_SETTING_KEYS: BROWSER_SETTING_KEYS,
    checkSetting: checkSetting,
    defaultProgress: defaultProgress,
    mergeProgress: mergeProgress,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    load: load, save: save, fresh: fresh, migrate: migrate,
    checksum: checksum,
    loadBoards: loadBoards, saveBoards: saveBoards, sortEntries: sortEntries
  };
});
