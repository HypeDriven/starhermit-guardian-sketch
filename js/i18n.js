/* Guardian Sketch — localization runtime (classic script, window.GSI18N).
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; js/strings.js holds the tables (en-GB,
 * es-ES and fr-CA carry only their differences from en-US, es-419 and fr-FR).
 * The locale comes from the game's Language setting through sh-language.js
 * (explicit choice → StarHermit account preference → navigator.languages →
 * en-US); ?lang= forces one for the page load (QA links) and hides the selector.
 *
 * T(key, vars) translates now. L(key, vars) is a deferred message: UI nodes
 * given one (setText/setAttr, or el()/btn() in ui.js) are re-rendered in place
 * when the language changes, so a switch never rebuilds panels or restarts a
 * round. `gs-language` fires on document after every change.
 */
(function (root) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var TABLES = root.GS_STRINGS || {};
  var hasOwn = Object.prototype.hasOwnProperty;
  var lang = 'en-US';

  function lookup(key) {
    for (var l = lang; l; l = PARENT[l]) {
      var t = TABLES[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  }

  /** Translate an English source string; {name} placeholders come from vars (messages render too). */
  function T(key, vars) {
    var s = lookup(String(key));
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return hasOwn.call(vars, k) ? text(vars[k]) : m; });
    return s;
  }

  /** A deferred message: renders in the current language whenever it is shown. */
  function L(key, vars) {
    return { __gsMsg: true, key: key, vars: vars, toString: function () { return T(key, vars); } };
  }

  function dynamic(x) { return typeof x === 'function' || !!(x && x.__gsMsg); }
  function text(x) { return x == null ? '' : typeof x === 'function' ? text(x()) : String(x); }

  function paint(node, slot, x) {
    var v = text(x);
    if (slot === 'text') { if (node.textContent !== v) node.textContent = v; }
    else if (node.getAttribute(slot) !== v) node.setAttribute(slot, v);
  }
  function put(node, slot, x) {
    var map = node.__gsI18n;
    if (dynamic(x)) {
      if (!map) { map = node.__gsI18n = {}; node.setAttribute('data-gs-i18n', ''); }
      map[slot] = x;
    } else if (map) delete map[slot];
    paint(node, slot, x);
  }
  /** Set a node's text; a message (or function) keeps following the language. */
  function setText(node, x) { put(node, 'text', x); }
  /** Set an attribute (aria-label, title…); a message keeps following the language. */
  function setAttr(node, attr, x) { put(node, attr, x); }

  /** Re-render every bound node under scope (default: the whole document). */
  function relabel(scope) {
    var nodes = (scope || document).querySelectorAll('[data-gs-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var map = nodes[i].__gsI18n;
      if (map) for (var slot in map) paint(nodes[i], slot, map[slot]);
    }
  }

  function setLocale(next) {
    lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
    if (typeof document === 'undefined') return;
    document.documentElement.lang = lang;
    if (document.body) relabel();
    document.dispatchEvent(new CustomEvent('gs-language', { detail: { lang: lang } }));
  }

  var forced = null;
  try { forced = new URLSearchParams(root.location.search).get('lang'); } catch (e) { /* opaque origin */ }
  var SL = root.StarHermitLanguage;
  var forcedLocale = forced && SL ? SL.match(forced, LOCALES) : null;
  var language = SL ? SL.create({
    game: 'guardian-sketch', supported: LOCALES, panel: !forcedLocale,
    apply: function (locale) { setLocale(forcedLocale || locale); }
  }) : null;
  if (!language) setLocale('en-US');

  root.GSI18N = {
    T: T, L: L, text: text, dynamic: dynamic, setText: setText, setAttr: setAttr, relabel: relabel,
    get lang() { return lang; },
    locales: LOCALES,
    language: language,
    tables: TABLES
  };
})(typeof self !== 'undefined' ? self : this);
