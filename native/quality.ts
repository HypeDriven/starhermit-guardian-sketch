// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, the wood grain, tube and sphere segments,
// sparks, dust, reflections, detail, motion) is the browser build's four
// presets and budgets (js/gfx.js TABLE / BUDGETS) keyed by the level's
// quality tier, with the sparks and dust motes scaled within the tier by the
// level's particle budget against the tier's anchor level (quantum,
// molecular, terrestrial, galactic), at most four times the tier's. The
// runtime owns the rest of what the old Graphics panel did: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution,
// the frame-rate limit and readout. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Lit surfaces: Lambert, standard PBR, or physical ink/wisps/hazards (clear coat, sheen). */
  material: "lambert" | "standard" | "physical";
  /** Desk wood-grain canvas texture size in px (Surface detail), within the level's largest texture. */
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
}
export interface Look {
  preset: Preset;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "detailed" | "richParticles" | "animated">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, detailed: false, richParticles: false, animated: false },
  balanced: { reflections: true, detailed: true, richParticles: true, animated: true },
  high: { reflections: true, detailed: true, richParticles: true, animated: true },
  ultra: { reflections: true, detailed: true, richParticles: true, animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", wood: 128, tube: 5, tubeLen: 0.5, sphere: 12, sparks: 40, dust: 24 },
  balanced: { material: "standard", wood: 256, tube: 6, tubeLen: 0.75, sphere: 16, sparks: 90, dust: 40 },
  high: { material: "physical", wood: 512, tube: 8, tubeLen: 1, sphere: 24, sparks: 140, dust: 90 },
  ultra: { material: "physical", wood: 1024, tube: 12, tubeLen: 1.5, sphere: 32, sparks: 200, dust: 160 },
};
/** js/gfx.js PARTICLE_CAP and DUST_MAX. */
const SPARK_CAP = { low: 40, high: 600 };
export const DUST_MAX = 320;
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const row = ART[preset];
  const b = { ...BUDGETS[preset] };
  // Sparks and dust grow with the level's particle budget above the tier's anchor, at most 4×.
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.wood = Math.min(b.wood, s.maxTextureSize);
  b.sparks = Math.min(row.richParticles ? SPARK_CAP.high : SPARK_CAP.low, Math.round(b.sparks * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return {
    preset, ...row,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
