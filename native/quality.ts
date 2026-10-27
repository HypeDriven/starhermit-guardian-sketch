// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the sparks and dust motes scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level. The runtime owns the rest of what the old Graphics panel did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the shadow-map size and
// MSAA samples it holds to the level. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Lit surfaces: Lambert, standard PBR, or physical ink/wisps/hazards (clear coat, sheen). */
  material: "lambert" | "standard" | "physical";
  /** Desk wood-grain canvas texture size in px (Surface detail). */
  wood: number;
  /** Ink tube radial segments; tubeLen multiplies its length segments. */
  tube: number;
  tubeLen: number;
  /** Wisp body sphere segments (hazards, eyes and rings scale with it). */
  sphere: number;
  /** Live sparks (Particles high; low caps it at 40). */
  sparks: number;
  /** Drifting dust motes (Ambient motion). */
  dust: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Desk wood grain, paper relief, two loose sheets, clear-coat ink, wisp sheen and halo, rim light. */
  detailed: boolean;
  /** Burst sizes and HDR-bright sparks (the old Particles "high"). */
  richParticles: boolean;
  /** Dust in the lamp light and the halo pulse (the old Ambient motion "animated"). */
  animated: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, richParticles: false, animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, richParticles: true, animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, richParticles: true, animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, richParticles: true, animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", wood: 128, tube: 5, tubeLen: 0.5, sphere: 12, sparks: 40, dust: 24, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", wood: 256, tube: 6, tubeLen: 0.75, sphere: 16, sparks: 90, dust: 40, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", wood: 512, tube: 8, tubeLen: 1, sphere: 24, sparks: 140, dust: 90, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", wood: 1024, tube: 12, tubeLen: 1.5, sphere: 32, sparks: 200, dust: 160, bloomRes: 1, aoRes: 1 },
};
/** js/gfx.js PARTICLE_CAP and DUST_MAX. */
const SPARK_CAP = { low: 40, high: 600 };
export const DUST_MAX = 320;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const row = TABLE[preset];
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the
  // level above the tier's first, at most four times the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(row.richParticles ? SPARK_CAP.high : SPARK_CAP.low, Math.round(b.sparks * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return { preset, ...row, budget: b };
}
