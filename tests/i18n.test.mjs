// Localization coverage: every English key the code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, the language follows sh-language.js and
// switches live. Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const require = createRequire(import.meta.url);
const Content = require('../js/content.js');

/** Content names and texts are translation keys (rendered through L()). */
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

function usedKeys() {
  const keys = new Set(contentKeys());
  for (const f of ['js/ui.js', 'js/main.js', 'js/platform.js']) codeKeys(read(f)).forEach((k) => keys.add(k));
  codeKeys(read('js/audio.js'), ['caption']).forEach((k) => keys.add(k));
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'GS_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'GSI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Settings'), 'Einstellungen');
  const msg = I18N.L('Lesson {n} of {total}', { n: 2, total: 5 });
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.equal(String(msg), 'Leçon 2 sur 5');
  I18N.language.setChoice('es-ES');
  assert.equal(I18N.T('Settings'), 'Ajustes');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
});

test('account strings cover the nine locales', async () => {
  const { PLATFORM_LOCALES } = await import('../js/platform-i18n.js');
  for (const l of LOCALES) assert.ok(PLATFORM_LOCALES.includes(l), l);
});
