/* Guardian Sketch — StarHermit platform glue: launch token, account
 * profile, cloud save mirror, hosted (read-only) leaderboards, and the
 * game's own replay-validating server endpoints with graceful fallback.
 * Hosted mode activates iff a launch token was read; every other mode is
 * identical to offline play. Browser global: window.GSPlatform.
 * Node-requireable (no DOM at require time) so tests can use the helpers.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GSPlatform = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- stored-zip helpers (no compression, CRC32) ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipStore(name, dataBytes) {
    var enc = new TextEncoder();
    var nameB = enc.encode(name);
    var crc = crc32(dataBytes);
    var out = [];
    var u16 = function (v) { out.push(v & 0xff, (v >> 8) & 0xff); };
    var u32 = function (v) { out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    var head = new Uint8Array(out);
    var cd = [];
    var c16 = function (v) { cd.push(v & 0xff, (v >> 8) & 0xff); };
    var c32 = function (v) { cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
    var cdHead = new Uint8Array(cd);
    var cdOff = head.length + nameB.length + dataBytes.length;
    var parts = [head, nameB, dataBytes, cdHead, nameB];
    var eocd = [];
    var e32 = function (v) { eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    var e16 = function (v) { eocd.push(v & 0xff, (v >> 8) & 0xff); };
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    var total = parts.reduce(function (n, p) { return n + p.length; }, 0);
    var buf = new Uint8Array(total);
    var o = 0;
    for (var pi = 0; pi < parts.length; pi++) { buf.set(parts[pi], o); o += parts[pi].length; }
    return buf;
  }

  function unzipFirstEntry(zipBytes) {
    // Stored single-entry reader: scan local headers for compression 0.
    var dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    var off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      var method = dv.getUint16(off + 8, true);
      var size = dv.getUint32(off + 18, true);
      var nameLen = dv.getUint16(off + 26, true);
      var extraLen = dv.getUint16(off + 28, true);
      var dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }

  function bytesToBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function base64ToBytes(b64) {
    var s = atob(b64);
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  /* ---------------- launch token ---------------- */
  // JWT payload is base64url JSON; decoded, never verified. Claims used:
  // sub (user id), game_scope (this game's slug).
  function decodeJwtPayload(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var json = JSON.parse(atob(b64));
      return json && typeof json === 'object' ? json : null;
    } catch (e) { return null; }
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (resolve, reject) {
        setTimeout(function () { reject(new Error('timeout')); }, ms);
      })
    ]);
  }

  /* ---------------- platform instance ---------------- */
  function createPlatform(hooks) {
    hooks = hooks || {};
    var token = null, sessionId = null, sub = null, slug = null;
    var nickname = null;
    var syncStatus = 'offline'; // offline | saving | synced | error
    var profileCache = {};
    var leaderboardId = null, leaderboardTried = false;
    var ownState = 'unknown'; // unknown | ok | off — own-server.js capability
    var saveTimer = null, saveInFlight = false, saveQueued = false, lastSaveDoc = null;

    function readToken() {
      if (typeof location === 'undefined') return;
      // Primary: fragment #game_token=<jwt>[&session_id=<guid>], read once
      // and stripped so it is neither persisted nor shared via link.
      var frag = location.hash || '';
      if (frag.length > 1) {
        var f = new URLSearchParams(frag.slice(1));
        var ft = f.get('game_token');
        if (ft) {
          token = ft;
          sessionId = f.get('session_id');
          try { history.replaceState(null, '', location.pathname + location.search); }
          catch (e) { /* strip is best-effort */ }
        }
      }
      // Local-dev fallbacks only; a real platform launch never needs these.
      if (!token) {
        var q = new URLSearchParams(location.search);
        token = q.get('launchToken') || q.get('token') || q.get('launch');
        if (token) slug = q.get('scope');
      }
      if (!token) { token = null; return; }
      var claims = decodeJwtPayload(token);
      if (claims && claims.sub != null) sub = String(claims.sub);
      if (claims && claims.game_scope != null) slug = String(claims.game_scope);
      if (!sub || !slug) token = null; // unusable without both
    }

    function hosted() { return !!token; }
    function gameSlug() { return slug; }
    function userId() { return sub; }

    function setSync(status) {
      syncStatus = status;
      if (hooks.onSyncStatus) hooks.onSyncStatus(status);
    }

    function authHeaders(extra) {
      var h = extra || {};
      if (token) h.Authorization = 'Bearer ' + token;
      return h;
    }

    // Token lifetime is 60 min; re-mint scoped at 45 min, retry ~60 s.
    function scheduleRefresh() {
      if (!hosted()) return;
      setTimeout(refreshToken, 45 * 60 * 1000);
    }
    async function refreshToken() {
      try {
        var r = await fetch('/api/v1/games/' + encodeURIComponent(slug) + '/launch-token', {
          method: 'POST', headers: authHeaders()
        });
        if (r.ok) {
          var j = await r.json();
          if (j && typeof j.token === 'string' && j.token) token = j.token;
          scheduleRefresh();
          return;
        }
      } catch (e) { /* network down: retry below */ }
      setTimeout(refreshToken, 60 * 1000);
    }

    /* ---------- account profile (NEVER /api/v1/me, never usernames) ---------- */
    async function nicknameFor(id) {
      id = String(id);
      if (profileCache[id]) return profileCache[id];
      var name = 'Player ' + id.slice(0, 8);
      try {
        var r = await fetch('/api/v1/users/' + encodeURIComponent(id) + '/profile', { headers: authHeaders() });
        if (r.ok) {
          var j = await r.json();
          if (j && j.nickname) name = String(j.nickname);
        }
      } catch (e) { /* keep the fallback */ }
      profileCache[id] = name;
      return name;
    }

    async function loadProfile() {
      if (!hosted()) return null;
      nickname = await nicknameFor(sub);
      return nickname;
    }

    // Display name for the game's name slot: platform nickname when hosted,
    // null offline (the caller's guest name applies then).
    function displayName() {
      if (!hosted()) return null;
      return nickname || ('Player ' + String(sub).slice(0, 8));
    }

    /* ---------- cloud save (platform slot; localStorage stays the cache) ---------- */
    function cloudKey() { return '/api/v1/me/cloud-saves/' + encodeURIComponent(slug); }

    function scheduleCloudSave(doc) {
      if (!hosted()) return;
      lastSaveDoc = doc; // {v, settings, progress}
      setSync('saving');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(pushCloudSave, 2000);
    }

    async function pushCloudSave() {
      if (!hosted()) return;
      if (saveInFlight) { saveQueued = true; return; }
      var doc = lastSaveDoc;
      if (!doc) return;
      saveInFlight = true;
      try {
        var bytes = new TextEncoder().encode(JSON.stringify(doc));
        var body = JSON.stringify({ dataBase64: bytesToBase64(zipStore('guardiansketch.save.json', bytes)) });
        var r = await fetch(cloudKey(), {
          method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: body, keepalive: true
        });
        setSync(r.ok ? 'synced' : 'error');
      } catch (e) { setSync('error'); }
      saveInFlight = false;
      if (saveQueued) { saveQueued = false; await pushCloudSave(); }
    }

    function flushCloudSave() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      pushCloudSave();
    }

    // Remote-preferred load: 404 (or any failure) = keep the local cache.
    async function loadCloudSave() {
      if (!hosted()) return null;
      try {
        var r = await withTimeout(fetch(cloudKey(), { headers: authHeaders() }), 6000);
        if (!r.ok) return null;
        var zip = new Uint8Array(await r.arrayBuffer());
        var doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(zip)));
        if (doc && typeof doc === 'object' && doc.settings && doc.progress) return doc;
        return null;
      } catch (e) { return null; }
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.addEventListener('pagehide', flushCloudSave);
      document.addEventListener('visibilitychange', function () { if (document.hidden) flushCloudSave(); });
    }

    /* ---------- hosted leaderboards (read-only; clients never submit) ---------- */
    async function hostedBoardEntries() {
      if (!hosted()) return null;
      if (!leaderboardTried) {
        leaderboardTried = true;
        try {
          var g = await withTimeout(
            fetch('/api/v1/games/' + encodeURIComponent(slug), { headers: authHeaders() }), 6000);
          if (g.ok) {
            var gj = await g.json();
            if (gj && gj.leaderboardId != null) leaderboardId = String(gj.leaderboardId);
          }
        } catch (e) { /* no leaderboard on-platform: local records only */ }
      }
      if (!leaderboardId) return null;
      try {
        var r = await withTimeout(
          fetch('/api/v1/leaderboards/' + encodeURIComponent(leaderboardId) +
            '/entries?pageSize=50', { headers: authHeaders() }), 6000);
        if (!r.ok) return null;
        var j = await r.json();
        var list = Array.isArray(j) ? j : ((j && j.entries) || []);
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var e = list[i] || {};
          var uid = e.userId != null ? String(e.userId) : (e.user_id != null ? String(e.user_id) : null);
          var name = uid ? await nicknameFor(uid) : (e.name != null ? String(e.name) : 'Player');
          out.push({
            name: name, score: Number(e.score) || 0, won: !!e.won,
            self: uid != null && uid === sub, sessionId: uid || ('hosted-' + i)
          });
        }
        return out;
      } catch (e) { return null; }
    }

    /* ---------- the game's own replay-validating server (local dev / own host) ---------- */
    // server.js implements these on the game's own deployment; on the
    // platform they 404, so any failure degrades to on-device records.
    async function submitEnvelope(board, envelope, name, sid) {
      if (hosted() || ownState === 'off') return null;
      try {
        var r = await withTimeout(fetch('/api/v1/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ board: board, name: name, sessionId: sid, envelope: envelope })
        }), 6000);
        if (!r.ok) { ownState = 'off'; return null; }
        ownState = 'ok';
        var j = await r.json();
        var top = (j && j.top) || [];
        return {
          entries: top.map(function (e) {
            return {
              name: String(e.name || 'guest'), score: Number(e.score) || 0,
              won: !!e.won, self: e.sessionId === sid, sessionId: e.sessionId
            };
          })
        };
      } catch (e) { ownState = 'off'; return null; }
    }

    async function ownBoardEntries(board, sid) {
      if (hosted() || ownState === 'off') return null;
      try {
        var r = await withTimeout(
          fetch('/api/v1/leaderboard?board=' + encodeURIComponent(board)), 6000);
        if (!r.ok) { ownState = 'off'; return null; }
        ownState = 'ok';
        var j = await r.json();
        var list = (j && j.entries) || [];
        return {
          entries: list.map(function (e) {
            return {
              name: String(e.name || 'guest'), score: Number(e.score) || 0,
              won: !!e.won, self: e.sessionId === sid, sessionId: e.sessionId
            };
          })
        };
      } catch (e) { ownState = 'off'; return null; }
    }

    readToken();
    if (hosted()) {
      setSync('saving'); // not yet mirrored; first load/push settles it
      scheduleRefresh();
    }

    return {
      hosted: hosted,
      gameSlug: gameSlug,
      userId: userId,
      sessionId: function () { return sessionId; },
      displayName: displayName,
      loadProfile: loadProfile,
      syncStatus: function () { return syncStatus; },
      loadCloudSave: loadCloudSave,
      scheduleCloudSave: scheduleCloudSave,
      flushCloudSave: flushCloudSave,
      hostedBoardEntries: hostedBoardEntries,
      submitEnvelope: submitEnvelope,
      ownBoardEntries: ownBoardEntries
    };
  }

  return {
    createPlatform: createPlatform,
    zipStore: zipStore,
    unzipFirstEntry: unzipFirstEntry,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    decodeJwtPayload: decodeJwtPayload
  };
});
