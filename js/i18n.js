/* Guardian Sketch — localization runtime (classic script, global GSI18N).
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; js/strings.js holds the tables (en-GB,
 * es-ES and fr-CA carry only their differences from en-US, es-419 and fr-FR).
 * The engine client (native/i18n.ts) picks the locale from the runtime's
 * interface language and calls setLocale; every string drawn is looked up
 * with T() each frame, so a change shows at once.
 * Loaded with loadClassic natively and through vm in the Node tests.
 */
(function (root) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var hasOwn = Object.prototype.hasOwnProperty;
  var lang = 'en-US';

  function lookup(key) {
    var tables = root.GS_STRINGS || {};
    for (var l = lang; l; l = PARENT[l]) {
      var t = tables[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  }

  /** Translate an English source string; {name} placeholders come from vars. */
  function T(key, vars) {
    var s = lookup(String(key));
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return hasOwn.call(vars, k) ? String(vars[k]) : m; });
    return s;
  }

  /** Switch the locale (unknown tags fall back to en-US); returns the locale in use. */
  function setLocale(next) {
    lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
    return lang;
  }

  root.GSI18N = {
    T: T,
    setLocale: setLocale,
    get lang() { return lang; },
    locales: LOCALES,
    get tables() { return root.GS_STRINGS || {}; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
