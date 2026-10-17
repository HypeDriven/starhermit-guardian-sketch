// Unit tests for the graphics quality model (js/gfx.js) and its strings. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { detectPreset, detectLevel, presetForLevel, resolve, presetTier, choosePreset, describe, PRESETS, CATEGORIES, clampScale, LEVELS, BUDGETS, PARTICLE_CAP, budgetFor } from '../js/gfx.js';
import { LOCALES, pickLocale, gfxStrings } from '../js/gfx-i18n.js';
// js/gpu-level.js is a classic script in the page (window.StarHermitGpu); in Node it exports the same API.
globalThis.StarHermitGpu = createRequire(import.meta.url)('../js/gpu-level.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(9), 'balanced');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'wood', 'tube', 'tubeLen', 'sphere', 'sparks', 'dust', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) {
    for (const k of keys) if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, { ...BUDGETS.high }, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget, 'manual Ultra on a weak GPU keeps the Ultra floor budget');
  const b4 = budgetFor('balanced', 4, 'high'), b9 = budgetFor('balanced', 9, 'high');
  assert.ok(b9.sparks > b4.sparks && b9.dust > b4.dust, 'counts scale up within the preset');
  assert.ok(budgetFor('ultra', 20, 'high').sparks <= BUDGETS.ultra.sparks * 4);
  assert.ok(budgetFor('ultra', 20, 'low').sparks <= PARTICLE_CAP.low, 'Particles low caps the sparks');
  assert.equal(resolve({}, 'low').budget.material, 'lambert');
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
