// The browser build's pure game scripts, shared with the Node tests and the
// replay-validating server.js: the seeded random streams, the rules (state,
// legality, the fixed-step storm, scoring, stars, the hint search), the
// content, the save document and local board (store), the string tables
// (js/*.js, UMD), evaluated as classic scripts so their globals are this
// module's exports.
//
// js/store.js keeps the device's local leaderboard in `localStorage`: here
// that is a small shim over the device's starhermit:storage, installed
// before the scripts run. Progress itself is the game's save (platform.ts).
import { storage } from "starhermit:storage";
import { loadClassic } from "starhermit:script";

const shim = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

for (const f of ["js/rng.js", "js/rules.js", "js/content.js", "js/store.js", "js/strings.js", "js/i18n.js", "js/platform-strings.js"]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type Pt = [number, number];
export type HazardType = "drop" | "pebble" | "ember" | "gale";
export interface Creature { x: number; y: number; r: number }
export interface Emitter { x: number; y: number; dx: number; dy: number; speed: number; r: number; start: number; every: number; count: number; grav: number; rest: number; type: HazardType }
export interface Obstacle { x1: number; y1: number; x2: number; y2: number; th?: number }
export interface Cfg {
  id: string; kind: string; name: string; index?: number; version?: number; seed: number; date?: string; theme?: string; intro?: string;
  world?: { w: number; h: number; gravity?: number };
  creatures: Creature[]; emitters: Emitter[]; obstacles: Obstacle[];
  ink: { budget: number; maxStrokes: number; thickness: number };
  simTicks: number; par: { score2: number; score3: number } | null;
  mechanics: { undo: boolean; hint: boolean }; mastery?: boolean;
}
export interface Stroke { pts: Pt[]; len: number }
export interface Spawn { type: "spawn"; tick: number; id: number; hazard: HazardType; x: number; y: number; r: number }
export interface Trace { sample: number; ticks: number; frames: [number, number, number][][]; spawns: Spawn[]; hitTick: number | null }
export interface Ev { type: string; tick?: number; id?: number; creature?: number; hazard?: HazardType; reason?: string; len?: number }
export interface Score { survival: number; endurance: number; blocks: number; clearance: number; ink: number; total: number }
export interface State {
  v: number; cfg: Cfg; seed: number; tick: number; phase: "draw" | "done";
  strokes: Stroke[]; inkUsed: number; elapsedDrawMs: number;
  sim: { survivedTicks: number; blocked: number; minClear: number; hitCreature: number | null } | null;
  trace: Trace | null; score: Score; terminal: { reason: string; won: boolean } | null; events: Ev[];
}
export interface Cmd { type: string; points?: Pt[]; atMs?: number; id?: string }
export interface ApplyResult { ok: boolean; reason?: string; state: State; events: Ev[] }
export interface Hint { strokes: { points: Pt[]; len: number }[]; len: number; wouldWin: boolean }
export interface Lesson { id: string; title: string; text: string; goal: { event: string; count: number }; cfg: Cfg }
export interface Theme { id: string; name: string; unlockStars: number; palette: Record<"desk" | "paper" | "paperEdge" | "ink" | "creature" | "light" | "accent" | "fog", number> }
export interface Hazard { label: string; icon: string; color: number; colorHC: number }
export interface Achievement { key: string; name: string; desc: string }
export interface Preset { id: string; name: string; blurb: string }
export interface Progress {
  tutorialDone: Record<string, boolean>; journeyStars: Record<string, number>; journeyBest: Record<string, number>;
  challengeBest: Record<string, number>; dailiesDone: Record<string, number>; stormBest: number;
  achievements: Record<string, number>;
  stats: { rounds: number; saves: number; hazardsBlocked: number; inkSpent: number; bestClearance: number; playMs: number };
  cosmetics: { theme: string };
}
export interface Doc { v: number; progress: Progress }
export interface BoardEntry { name: string; score: number; won: boolean; invalid: number; durationMs: number; sessionId: string; board: string; date: string }

interface RulesApi {
  TERMINAL: { SURVIVED: string; HIT: string; RESIGN: string };
  MAX_POINTS: number;
  createGame(cfg: Cfg): State;
  applyCommand(s: State, cmd: Cmd): ApplyResult;
  validateCommandShape(cmd: Cmd): string | null;
  hint(s: State): Hint | null;
  starsFor(s: State): number;
  inkRemaining(s: State): number;
  polyLength(pts: Pt[]): number;
  hashState(s: State): string;
  clone<T>(o: T): T;
}
interface ContentApi {
  CONTENT_VERSION: number;
  HAZARDS: Record<HazardType, Hazard>;
  THEMES: Theme[]; JOURNEY: Cfg[]; CHALLENGES: Cfg[]; PRACTICE: Preset[]; ACHIEVEMENTS: Achievement[];
  makePractice(id: string, seed: number): Cfg;
  makeStorm(seed: number): Cfg;
  dailyConfig(date: string): Cfg;
  utcDateString(ms: number): string;
  tutorialLessons(): Lesson[];
}
interface StoreApi {
  SAVE_VERSION: number;
  docFromSave(d: unknown): Doc | null;
  fromBrowserSave(text: string | null): { doc: Doc | null; settings: Record<string, unknown> | null };
  GAME_SETTING_KEYS: string[]; BROWSER_SETTING_KEYS: string[];
  checkSetting(key: string, v: unknown): unknown;
  defaultProgress(): Progress;
  /** Merge two devices' progress (the best of every record); `local`'s cosmetics win. */
  mergeProgress(remote: Progress, local: Progress): Progress;
  loadBoards(): { entries: BoardEntry[] };
  saveBoards(b: { entries: BoardEntry[] }): void;
  sortEntries(e: BoardEntry[]): BoardEntry[];
}
export interface Rng { next(): number }
interface RngApi { derive(seed: number, stream: number): Rng; hashString(s: string): number; STREAM_DECOR: number; STREAM_AV: number }
interface I18nApi {
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): string;
  readonly lang: string;
  locales: string[];
}
interface PlatformStringsApi {
  platformStrings(lang: string): Record<string, string>;
  fmtPlatform(s: string, vars?: Record<string, string | number>): string;
}

const g = globalThis as unknown as {
  GSRules: RulesApi; GSContent: ContentApi; GSStore: StoreApi; GSRNG: RngApi; GSI18N: I18nApi; PlatformStrings: PlatformStringsApi;
};
export const Rules = g.GSRules;
export const Content = g.GSContent;
export const Store = g.GSStore;
export const RNG = g.GSRNG;
export const I18n = g.GSI18N;
export const PlatformStrings = g.PlatformStrings;
