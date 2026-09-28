// Unit tests for the graphics quality model (js/gfx.js) and its strings. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, choosePreset, describe, PRESETS, CATEGORIES, clampScale } from '../js/gfx.js';
import { LOCALES, pickLocale, gfxStrings } from '../js/gfx-i18n.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2 Pro'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  assert.equal(detectPreset('Apple M2 Pro', true), 'balanced', 'touch devices cap Auto at balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
});

test('resolve: auto uses the detected preset; explicit preset wins', () => {
  const a = resolve({}, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.shadows, 'off');
  assert.equal(a.post, false, 'Low renders without the composer');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, presetTier('high', 'shadows'));
  assert.equal(h.post, true);
  assert.equal(resolve({ preset: 'bogus' }, 'nonsense').preset, 'balanced');
});

test('resolve: overrides replace preset tiers; invalid overrides are ignored', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'high', particles: 'huge' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'high');
  assert.equal(r.particles, presetTier('low', 'particles'));
  assert.equal(r.post, true, 'bloom override turns the post chain on');
  for (const cat of Object.keys(CATEGORIES)) {
    for (const p of PRESETS) assert.ok(CATEGORIES[cat].includes(presetTier(p, cat)), `${p}.${cat} is a valid tier`);
  }
});

test('resolve: render scale is clamped to 50–200% and multiplies the preset scale', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }, 'low').scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }, 'low').scale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }, 'low').scale, 1.25);
  assert.equal(clampScale('x'), 1);
  const d = resolve({}, 'low');
  assert.equal(d.adaptive, true);
  assert.equal(d.showFps, false);
  assert.equal(resolve({ adaptive: false, show_fps: true }, 'low').adaptive, false);
});

test('choosing a preset clears overrides but keeps scale, adaptive and fps', () => {
  const next = choosePreset({ preset: 'low', bloom: 'on', shadows: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'high');
  assert.deepEqual(next, { preset: 'high', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.deepEqual(choosePreset({ ao: 'high' }, 'auto'), { preset: 'auto' });
});

test('describe summarises cost', () => {
  const s = describe(resolve({ preset: 'high' }, 'low'), [1280, 800]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /SMAA/);
  assert.match(s, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' }, 'low')), /no shadows/);
});

test('graphics strings exist in every required locale', () => {
  const keys = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? keys(v, pre + k + '.') : [pre + k]);
  const base = keys(LOCALES['en-US']).sort();
  for (const tag of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(LOCALES[tag], tag);
    assert.deepEqual(keys(LOCALES[tag]).sort(), base, `${tag} has every key`);
  }
  for (const cat of Object.keys(CATEGORIES)) assert.ok(LOCALES['en-US'].cat[cat], cat);
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
  assert.equal(gfxStrings('de-AT').quality, 'Qualität');
});

test('legacy quality tier migrates to a graphics preset', async () => {
  const { createRequire } = await import('node:module');
  const Store = createRequire(import.meta.url)('../js/store.js');
  assert.deepEqual(Store.migrate({ v: 1, settings: { graphicsTier: 'medium' }, progress: {} }).settings.graphics, { preset: 'balanced' });
  assert.deepEqual(Store.migrate({ v: 1, settings: { graphicsTier: 'auto' }, progress: {} }).settings.graphics, { preset: 'auto' });
  const fresh = Store.migrate({ v: 1, settings: {}, progress: {} }).settings;
  assert.deepEqual(fresh.graphics, {});
  assert.equal('graphicsTier' in fresh, false);
});
