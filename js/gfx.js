/* Guardian Sketch — graphics quality model (ES module, pure: no three.js, no DOM).
 * Presets, per-category overrides, hardware-level detection, per-preset budgets and a cost summary, so the
 * Settings panel and the renderer agree on what every option means.
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],       // image-based lighting (room environment)
  detail: ['plain', 'detailed'],    // desk wood grain, paper relief, glossy ink, wisp halo
  particles: ['low', 'high'],       // burst sizes + live particle cap, glowing sparks
  background: ['static', 'animated'] // drifting dust in the lamp light, halo pulse
};

// Each preset is a row of tiers plus a render scale (multiplies the capped device pixel ratio).
const TABLE = {
  low: { scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low', background: 'static' },
  balanced: { scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
  high: { scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
  ultra: { scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' }
};

// Device pixel ratio cap per preset (Low stays as cheap as the original low tier).
export const DPR_CAP = { low: 1, balanced: 1.5, high: 2, ultra: 2 };
export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_CAP = { low: 40, high: 600 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/gpu-level.js → window.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
// Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  if (!G) return LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Gameplay is
 * identical on every preset — only visuals change.
 *   material   lit-surface shading: 'lambert' | 'standard' | 'physical' (clearcoat ink/wisps/drops, sheen)
 *   wood       desk wood-grain canvas texture size in px (Surface detail: detailed)
 *   tube       ink-stroke tube radial segments; tubeLen multiplies its length segments
 *   sphere     wisp body sphere segments (width; height is ¾); hazards and eyes scale with it
 *   sparks     live spark cap at the floor level (Particles high; low caps it at PARTICLE_CAP.low)
 *   dust       drifting dust motes at the floor level (Ambient motion: animated)
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', wood: 128, tube: 5, tubeLen: 0.5, sphere: 12, sparks: 40, dust: 24, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', wood: 256, tube: 6, tubeLen: 0.75, sphere: 16, sparks: 90, dust: 40, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', wood: 512, tube: 8, tubeLen: 1, sphere: 24, sparks: 140, dust: 90, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', wood: 1024, tube: 12, tubeLen: 1.5, sphere: 32, sparks: 200, dust: 160, bloomRes: 1, aoRes: 1 }
};
export const DUST_MAX = 320;

/** A preset's concrete budget for a hardware level and Particles tier (counts scale ≤ 4× within the preset). */
export function budgetFor(preset, level, particles) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? G.scaleBudget(1, lv, floor) : 1;
  b.sparks = Math.min(PARTICLE_CAP[particles] || PARTICLE_CAP.high, Math.round(b.sparks * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return b;
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

/** Clamp a saved render_scale (fraction, 0.5–2). */
export function clampScale(v) {
  const n = Number(v);
  return clamp(isFinite(n) && n > 0 ? n : 1, 0.5, 2);
}

/**
 * Resolve saved settings into concrete tiers.
 * saved: {preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier}.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = { preset: preset, auto: auto, dprCap: DPR_CAP[preset], scale: row.scale * clampScale(s.render_scale) };
  Object.keys(CATEGORIES).forEach(function (cat) {
    out[cat] = CATEGORIES[cat].includes(s[cat]) ? s[cat] : row[cat];
  });
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level, out.particles);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The composer runs only when something needs it; otherwise the canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset] ? TABLE[preset][cat] : undefined;
}

/** Choosing a preset clears every override but keeps scale / adaptive / fps choices. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: preset === 'auto' || PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale != null) out.render_scale = clampScale(s.render_scale);
  if (s.adaptive === false) out.adaptive = false;
  if (s.show_fps) out.show_fps = true;
  return out;
}

/** Short cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : SHADOW_MAP[r.shadows] + '² shadows',
    r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
    pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
  ];
  return parts.filter(Boolean).join(' · ');
}
