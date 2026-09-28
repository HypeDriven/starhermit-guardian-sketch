/* Guardian Sketch — graphics quality model (ES module, pure: no three.js, no DOM).
 * Presets, per-category overrides, GPU detection and a cost summary, so the
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
export const PARTICLE_CAP = { low: 60, high: 300 };

/** Best preset for this GPU (unmasked renderer string). Touch devices cap Auto at balanced. */
export function detectPreset(gpu, touch) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  if (touch && (p === 'high' || p === 'ultra')) p = 'balanced';
  return p;
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
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = { preset: preset, auto: auto, dprCap: DPR_CAP[preset], scale: row.scale * clampScale(s.render_scale) };
  Object.keys(CATEGORIES).forEach(function (cat) {
    out[cat] = CATEGORIES[cat].includes(s[cat]) ? s[cat] : row[cat];
  });
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
