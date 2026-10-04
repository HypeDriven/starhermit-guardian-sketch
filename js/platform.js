/* Guardian Sketch — StarHermit platform glue over window.StarHermit
 * (starhermit-sdk.js, loaded by index.html before this file): launch token,
 * account profile, cloud save mirror, synced preferences, key bindings,
 * sign-in, invite link and the read-only hosted leaderboard. The SDK reads
 * the token (#game_token=… library launch or #access_token=… sign-in return),
 * strips it, renews it and owns the cloud slot game:<slug>. Hosted mode
 * activates iff it holds a token; otherwise every call is a no-op and no
 * request is made. Browser global: window.GSPlatform.
 * Node-requireable (no DOM at require time) so tests can pass an SDK instance.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GSPlatform = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Keyboard actions → KeyboardEvent.code lists (control.* in starhermit.txt). */
  var DEFAULT_KEYS = {
    penLeft: ['ArrowLeft'], penRight: ['ArrowRight'], penUp: ['ArrowUp'], penDown: ['ArrowDown'],
    penFast: ['ShiftLeft', 'ShiftRight'], penToggle: ['Space'], release: ['KeyR'], undo: ['KeyU'],
    hint: ['KeyH'], skip: ['KeyS'], pause: ['KeyP', 'Escape'], camera: ['KeyC']
  };

  /** Preferences mirrored to the settings KV (same keys as the save doc's settings). */
  var SYNCED_SETTINGS = ['music', 'effects', 'ambience', 'voice', 'muted', 'captions', 'graphics', 'theme',
    'reducedMotion', 'highContrast', 'colorPalette', 'largeText', 'leftHanded', 'haptics', 'boardMirror', 'confirmRelease'];

  function subset(settings) {
    var out = {};
    SYNCED_SETTINGS.forEach(function (k) { out[k] = settings[k]; });
    return out;
  }

  /** Apply platform values over local settings (type-checked); true when any changed. */
  function applyRemoteSettings(settings, remote) {
    var changed = false;
    SYNCED_SETTINGS.forEach(function (k) {
      var v = remote && remote[k];
      if (v === undefined || v === null) return;
      var ok = k === 'graphics' ? (typeof v === 'object' && !Array.isArray(v)) : typeof v === typeof settings[k];
      if (ok && JSON.stringify(v) !== JSON.stringify(settings[k])) { settings[k] = v; changed = true; }
    });
    return changed;
  }

  function createPlatform(hooks, sh) {
    hooks = hooks || {};
    sh = sh || (typeof window !== 'undefined' ? window.StarHermit : null) || null;
    if (sh && !sh.__guardianInit) { sh.__guardianInit = true; sh.init(); }
    var nickname = null;
    var syncStatus = 'offline'; // offline | saving | synced | error
    var keys = clone(DEFAULT_KEYS);
    var lastSettings = null;

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function hosted() { return !!(sh && sh.signedIn && sh.userId && sh.slug); }
    function setSync(status) {
      syncStatus = status;
      if (hooks.onSyncStatus) hooks.onSyncStatus(status);
    }
    if (sh) {
      sh.on('saved', function (ok) { setSync(ok ? 'synced' : 'error'); });
      // Renewal refused: local play continues on the local save.
      sh.on('auth', function (a) {
        if (a.signedIn) return;
        nickname = null; keys = clone(DEFAULT_KEYS); syncStatus = 'offline';
        if (hooks.onSignedOut) hooks.onSignedOut();
      });
    }

    /* ---------- account profile (nickname, "Player <id>" fallback; never /api/v1/me) ---------- */
    async function nicknameFor(id) {
      var p = hosted() ? await sh.profile(String(id)).catch(function () { return null; }) : null;
      return (p && p.displayName) || ('Player ' + String(id).slice(0, 6));
    }
    async function loadProfile() {
      if (!hosted()) return null;
      nickname = await nicknameFor(sh.userId);
      return nickname;
    }
    // Display name for the game's name slot: platform nickname when hosted,
    // null offline (the caller's guest name applies then).
    function displayName() {
      if (!hosted()) return null;
      return nickname || ('Player ' + String(sh.userId).slice(0, 6));
    }

    /* ---------- cloud save (slot game:<slug>; localStorage stays the cache) ---------- */
    function scheduleCloudSave(doc) {
      if (!hosted()) return;
      setSync('saving');
      sh.saveJSON(doc); // {v, settings, progress}; debounced ~2 s
    }
    function flushCloudSave() { return hosted() ? sh.flushSave(true) : Promise.resolve(false); }
    // Remote-preferred load: no slot (or any failure) keeps the local cache.
    async function loadCloudSave() {
      if (!hosted()) return null;
      try {
        var info = await sh.saveInfo();
        if (info && info.exists === false) return null;
        var doc = await sh.loadJSON();
        if (doc && typeof doc === 'object' && doc.settings && doc.progress) { setSync('synced'); return doc; }
        return null;
      } catch (e) { return null; }
    }
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.addEventListener('pagehide', flushCloudSave);
      document.addEventListener('visibilitychange', function () { if (document.hidden) flushCloudSave(); });
    }

    /* ---------- preferences (settings KV) and key bindings ---------- */
    async function loadSettings() { return hosted() ? sh.getSettings().catch(function () { return {}; }) : {}; }
    function baselineSettings(settings) { lastSettings = JSON.stringify(subset(settings)); }
    function syncSettings(settings) {
      if (!hosted() || lastSettings === null) return;
      var s = subset(settings), json = JSON.stringify(s);
      if (json === lastSettings) return;
      lastSettings = json;
      sh.patchSettings(s);
    }
    async function loadKeys() {
      if (hosted()) keys = await sh.loadBindings(DEFAULT_KEYS).catch(function () { return clone(DEFAULT_KEYS); });
      return keys;
    }
    function keyMap() { return keys; }
    function actionForCode(code) {
      for (var a in keys) if (keys[a].indexOf(code) >= 0) return a;
      return null;
    }

    /* ---------- sign-in and invite link ---------- */
    function canSignIn() { return !!(sh && sh.canSignIn()); }
    function signIn() { return !!(sh && sh.signIn()); }
    function inviteLink() { return hosted() ? sh.inviteLink() : null; }

    /* ---------- hosted leaderboards (read-only; clients never submit) ---------- */
    async function hostedBoardEntries() {
      if (!hosted()) return null;
      try {
        var game = await sh.getGame();
        if (!game || game.leaderboardId == null) return null;
        var data = await sh.leaderboardEntries(String(game.leaderboardId), { pageSize: 50 });
        var list = Array.isArray(data) ? data : ((data && (data.entries || data.items)) || []);
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var e = list[i] || {};
          var uid = e.userId != null ? String(e.userId) : (e.user_id != null ? String(e.user_id) : null);
          out.push({
            name: uid ? await nicknameFor(uid) : (e.name != null ? String(e.name) : 'Player'),
            score: Number(e.score) || 0, won: !!e.won,
            self: uid != null && uid === sh.userId, sessionId: uid || ('hosted-' + i)
          });
        }
        return out;
      } catch (e) { return null; }
    }

    if (hosted()) syncStatus = 'saving'; // not yet mirrored; first load/push settles it (no hook: the caller is still constructing)

    return {
      hosted: hosted,
      gameSlug: function () { return hosted() ? sh.slug : null; },
      userId: function () { return hosted() ? sh.userId : null; },
      sessionId: function () { return sh ? sh.launchSessionId : null; },
      displayName: displayName,
      loadProfile: loadProfile,
      syncStatus: function () { return syncStatus; },
      loadCloudSave: loadCloudSave,
      scheduleCloudSave: scheduleCloudSave,
      flushCloudSave: flushCloudSave,
      loadSettings: loadSettings,
      baselineSettings: baselineSettings,
      syncSettings: syncSettings,
      loadKeys: loadKeys,
      keyMap: keyMap,
      actionForCode: actionForCode,
      canSignIn: canSignIn,
      signIn: signIn,
      inviteLink: inviteLink,
      hostedBoardEntries: hostedBoardEntries
    };
  }

  return {
    createPlatform: createPlatform,
    applyRemoteSettings: applyRemoteSettings,
    DEFAULT_KEYS: DEFAULT_KEYS,
    SYNCED_SETTINGS: SYNCED_SETTINGS
  };
});
