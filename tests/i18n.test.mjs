// Localization coverage: every English key the engine client (native/*.ts)
// and the content show is translated in every locale (en-GB → en-US,
// es-ES → es-419, fr-CA → fr-FR inherit), placeholders survive, no table
// keeps a key nothing shows, and the classic js/i18n.js switches locale as
// native/i18n.ts drives it. Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const require = createRequire(import.meta.url);
const Content = require('../js/content.js');

/** Content names and texts are translation keys (shown through tr()). */
function contentKeys() {
  const keys = [];
  for (const hz of Object.values(Content.HAZARDS)) keys.push(hz.label);
  for (const t of Content.THEMES) keys.push(t.name);
  for (const c of Content.JOURNEY.concat(Content.CHALLENGES)) { keys.push(c.name); if (c.intro) keys.push(c.intro); }
  for (const p of Content.PRACTICE) keys.push(p.name, p.blurb);
  const storm = Content.makeStorm(1); keys.push(storm.name, storm.intro);
  keys.push(Content.dailyConfig('2026-10-16').intro);
  for (const l of Content.tutorialLessons()) keys.push(l.title, l.text);
  for (const a of Content.ACHIEVEMENTS) keys.push(a.name, a.desc);
  return keys;
}

export function usedKeys() {
  const keys = new Set(contentKeys());
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) codeKeys(read('native/' + f)).forEach((k) => keys.add(k));
  // Caption texts (native/audio.ts CAPTIONS, shown with tr()) and the board panel's phase names.
  const audio = read('native/audio.ts');
  const caps = audio.slice(audio.indexOf('const CAPTIONS'), audio.indexOf('};', audio.indexOf('const CAPTIONS')));
  for (const m of caps.matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
  const screens = read('native/screens.ts');
  const ph = screens.slice(screens.indexOf('const PHASE_NAME'), screens.indexOf('};', screens.indexOf('const PHASE_NAME')));
  for (const m of ph.matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact; nothing unused', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'GS_STRINGS'), usedKeys()), []);
});

test('the locale switches as the engine client sets it, with the regional tables', () => {
  const { I18N } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'GSI18N' });
  assert.equal(I18N.lang, 'en-US');
  assert.equal(I18N.setLocale('de-DE'), 'de-DE');
  assert.equal(I18N.T('Settings'), 'Einstellungen');
  I18N.setLocale('fr-CA');
  assert.equal(I18N.T('Lesson {n} of {total}', { n: 2, total: 5 }), 'Leçon 2 sur 5');
  I18N.setLocale('es-ES');
  assert.equal(I18N.T('Settings'), 'Ajustes');
  I18N.setLocale('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
  assert.equal(I18N.setLocale('xx-YY'), 'en-US');
});

test('account strings cover the nine locales', () => {
  const { PLATFORM_LOCALES, platformStrings } = require('../js/platform-strings.js');
  for (const l of LOCALES) assert.ok(PLATFORM_LOCALES.includes(l), l);
  assert.equal(platformStrings('de-AT').invite, 'Freund einladen');
});
