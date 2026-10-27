// Guardian Sketch on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, save document and local
// board are the browser build's js/*.js, unchanged in what they decide; this
// module is what js/main.js did around them — the state machine (title →
// setup → drawing ⇄ paused → the storm ⇄ paused → results → retry / next
// stage / title; lessons wrap a round), the command log and its state hashes
// (undo replays it minus the last stroke), the pointer and keyboard pen and
// gamepad input, the storm playback and its cues, progression, stars, bests
// and achievements, the local board and posting to the high-score board,
// lessons and their goals, toasts, captions and the board state panel.
// The screens and HUD are drawn by screens.ts (starhermit:ui), the page by
// render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the storm, the round's
// duration, the confirm-release window and the lesson hand-off count them,
// so pauses, a hidden window and slow frames never change a round and play
// scripts replay exactly.
import "./classic.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { isDown, onAction, onPointerButton, onPointerMove, onTouch, value, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onPlayerChange, onSessionEnded, requestSignIn } from "starhermit:platform";
import { storage } from "starhermit:storage";
import {
  Content as C, RNG, Rules as R, Store as S,
  type Achievement, type BoardEntry, type Cfg, type Cmd, type Ev, type HazardType, type Lesson, type Pt, type State,
} from "./classic.ts";
import * as audio from "./audio.ts";
import * as hints from "./hint.ts";
import { tr, N, pt, onLocaleChange } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { initStyles } from "./style.ts";

export type Phase = "title" | "active" | "resolving" | "results";
export type OverlayName = "setup" | "journey" | "practice" | "challenges" | "pause" | "settings" | "help" | "scores" | "results" | "reset";
export type Mode = "journey" | "daily" | "practice" | "challenge" | "storm" | "tutorial";
export interface Toast { text: () => string; until: number }

const STEP_MS = 1000 / 60;
const PEN_STEP = 14, PEN_STEP_FAST = 42;
const PLAYER_KEY = "guardiansketch.playername";

export interface Session {
  mode: Mode; cfg: Cfg; state: State; commands: Cmd[]; stateHashes: string[]; invalid: number;
  steps: number; ranked: boolean; board: string | null; label: () => string;
  lesson: Lesson | null; lessonIdx: number | null; lessonHits: number; lessonDoneIn: number;
  prevBest: number | null; newAchievements: Achievement[];
}
export interface Results {
  headline: () => string; won: boolean; stars: number; best: number | null; isNewBest: boolean;
  entries: { name: string; score: number; won: boolean; self: boolean }[] | null; boardLabel: (() => string) | null;
  canNext: boolean; nextIdx: number;
}
export const app = {
  phase: "title" as Phase,
  /** Open dialogs, innermost last (Settings and Help open over Pause). */
  overlays: [] as OverlayName[],
  /** Frame the top dialog opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  setup: null as { cfg: Cfg; note: (() => string) | null; lesson: Lesson | null; lessonIdx: number | null } | null,
  toasts: [] as Toast[],
  caption: null as { text: string; until: number } | null,
  results: null as Results | null,
  lb: null as { state: "lbPosting" | "lbRank" | "lbPosted" | "lbNotPosted"; rank?: number | null } | null,
  practiceIdx: 0,
  practiceSeed: (Math.random() * 0xffffffff) >>> 0,
  scoresTab: "global" as "global" | "device",
  scoresBoard: "storm",
  scoresRows: null as { name: string; score: number; won: boolean; self: boolean }[] | null,
  scoresState: "idle" as "idle" | "loading" | "done",
  signedOut: false,
  mirrorLast: null as (() => string) | null,
  hintPending: false,
};
export const settings = platform.settings;
export let sess: Session | null = null;
export const pen = { x: 500, y: 350, down: false, active: false, pts: null as Pt[] | null, inkWarned: false };
let releaseArmedUntil = -1;
let lastCommitKey: string | null = null;
let suspended = false;
let stepCount = 0;
let lastSpawnSfx = -1e9, lastBounceSfx = -1e9;
let spawnTypeById = new Map<number, HazardType>();
const sessionId = "s-" + Math.random().toString(36).slice(2, 10);
const now = (): number => frame().time;
const lessons = C.tutorialLessons();

// ------------------------------------------------------------------ text helpers
export function announce(text: string, kind: "polite" | "assertive" = "polite"): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: kind });
}
/** A toast (2.3 s, stacked); `text` re-reads in the current language. */
export function toast(text: () => string): void {
  app.toasts.push({ text, until: now() + 2.3 });
  while (app.toasts.length > 3) app.toasts.shift();
  announce(text(), "assertive");
}
const INVALID_TEXT: Record<string, string> = {
  "ink-exhausted": N("Not enough ink"), "out-of-bounds": N("Out of bounds"), "stroke-too-short": N("Stroke too short"),
  "too-many-points": N("Too many points"), "stroke-limit": N("No strokes left"), "wrong-phase": N("Not now"),
  "game-ended": N("Round already ended"), "unknown-command": N("Unknown action"), "malformed-command": N("Malformed action"),
};
/** Player-facing text for a rejected command. */
export function reasonText(reason: string): string { return INVALID_TEXT[reason] ? tr(INVALID_TEXT[reason]!) : reason || tr("Not allowed"); }
function haptic(): void { if (settings.haptics) vibrate(15); }
export function progress(): ReturnType<typeof platform.getDoc>["progress"] { return platform.getDoc().progress; }
export function totalStars(): number { let n = 0; for (const v of Object.values(progress().journeyStars)) n += v; return n; }
export function today(): string { return C.utcDateString(platform.nowMs()); }
export function inkLeft(): number { return sess ? R.inkRemaining(sess.state) : 0; }
export function hazardName(t: HazardType): string { return C.HAZARDS[t] ? C.HAZARDS[t].icon + " " + tr(C.HAZARDS[t].label) : t; }

/** Display name of a round: content names are translation keys; practice and daily names are composed. */
export function cfgName(cfg: Cfg): string {
  if (cfg.kind === "practice") {
    const base = C.PRACTICE.find((p) => "practice-" + p.id === cfg.id);
    if (base) return tr("{name} practice", { name: tr(base.name) });
  }
  if (cfg.kind === "daily") return tr("Daily {date}", { date: cfg.date ?? "" });
  return tr(cfg.name);
}
interface Meta { mode: Mode; ranked: boolean; board: string | null; label: () => string }
export function modeMeta(cfg: Cfg): Meta {
  switch (cfg.kind) {
    case "journey": return { mode: "journey", ranked: true, board: "journey-" + cfg.id, label: () => tr("Journey stage {n}", { n: (cfg.index ?? 0) + 1 }) };
    case "daily": return { mode: "daily", ranked: true, board: "daily-" + cfg.date, label: () => tr("Daily challenge") };
    case "practice": return { mode: "practice", ranked: false, board: null, label: () => tr("Practice") };
    case "challenge": return { mode: "challenge", ranked: true, board: "challenge-" + cfg.id, label: () => tr("Challenge") };
    case "score": return { mode: "storm", ranked: true, board: "storm", label: () => tr("Tempest Stand") };
    case "tutorial": return { mode: "tutorial", ranked: false, board: null, label: () => tr("Learn") };
    default: return { mode: "practice", ranked: false, board: null, label: () => tr("Round") };
  }
}
export function themeFor(cfg: Cfg | null): (typeof C.THEMES)[number] {
  const id = cfg && (cfg.kind === "journey" || cfg.kind === "tutorial") ? (cfg.theme || settings.theme) : settings.theme;
  return C.THEMES.find((t) => t.id === id) || C.THEMES[0]!;
}

// ------------------------------------------------------------------ dialogs
export function topOverlay(): OverlayName | null { return app.overlays[app.overlays.length - 1] ?? null; }
export function openOverlay(name: OverlayName, focus: string | null = null): void {
  if (app.overlays.includes(name)) return;
  app.overlays.push(name);
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  if (name === "scores") refreshScores();
}
export function closeOverlay(name?: OverlayName): void {
  const o = name ?? topOverlay();
  if (!o) return;
  app.overlays = app.overlays.filter((x) => x !== o);
  app.openedFrame = frame().frame;
}
export function modalOpen(): boolean { return app.overlays.length > 0; }

// ------------------------------------------------------------------ title and setup
export function toTitle(): void {
  render.stopTrace();
  sess = null;
  app.phase = "title";
  app.overlays = [];
  app.results = null;
  app.lb = null;
  pen.down = false; pen.pts = null; pen.active = false;
  pointerStroke = null;
  render.setInsetBottom(0);
  render.setTheme(themeFor(null).palette);
  // ambient title backdrop: an empty page with a wisp
  render.setLevel({
    id: "title", kind: "title", name: "", seed: 1, world: { w: 1000, h: 700 },
    creatures: [{ x: 500, y: 120, r: 34 }], emitters: [], obstacles: [],
    ink: { budget: 1, maxStrokes: 0, thickness: 12 }, simTicks: 60, par: null, mechanics: { undo: false, hint: false },
  });
  app.openedFrame = frame().frame;
  app.focusNext = "btn-play";
  announce(tr("Guardian Sketch title screen. Press Play to continue your journey."));
}
export function firstUncompletedJourney(): number {
  for (let i = 0; i < C.JOURNEY.length; i++) if (!((progress().journeyStars[C.JOURNEY[i]!.id] ?? 0) >= 1)) return i;
  return C.JOURNEY.length - 1;
}
/** The setup panel for a round (name, mode, intro, hazards, rules, Start / Cancel). */
export function openSetup(cfg: Cfg, note: (() => string) | null = null): void {
  app.setup = { cfg, note, lesson: null, lessonIdx: null };
  app.overlays = app.overlays.filter((o) => o === "pause");
  openOverlay("setup", "btn-setup-start");
}
export function startJourneyLevel(idx: number): void { const cfg = C.JOURNEY[idx]; if (cfg) openSetup(cfg); }
export function openDaily(): void {
  const date = today();
  const done = progress().dailiesDone[date];
  openSetup(C.dailyConfig(date), done != null ? () => tr("Already played today (score {score}) — replay to improve.", { score: done }) : null);
}
export function openStorm(): void { openSetup(C.makeStorm(RNG.hashString("storm-" + today()))); }
export function startPractice(): void { openSetup(C.makePractice(C.PRACTICE[app.practiceIdx]!.id, app.practiceSeed)); }
export function newPracticeSeed(): void { app.practiceSeed = (Math.random() * 0xffffffff) >>> 0; }
export function openLearn(): void {
  const next = lessons.findIndex((l) => !progress().tutorialDone[l.id]);
  startLesson(next === -1 ? 0 : next);
}
export function startFromSetup(): void {
  const s = app.setup;
  closeOverlay("setup");
  if (s) beginLevel(s.cfg, s.lesson, s.lessonIdx);
}

// ------------------------------------------------------------------ the round
export function beginLevel(cfg: Cfg, lesson: Lesson | null = null, lessonIdx: number | null = null): void {
  const meta = modeMeta(cfg);
  const state = R.createGame(cfg);
  sess = {
    mode: meta.mode, cfg: state.cfg, state, commands: [], stateHashes: [R.hashState(state)], invalid: 0,
    steps: 0, ranked: meta.ranked, board: meta.board, label: meta.label,
    lesson, lessonIdx, lessonHits: 0, lessonDoneIn: -1, prevBest: null, newAchievements: [],
  };
  releaseArmedUntil = -1;
  lastCommitKey = null; // the guard is per round; identical strokes in a new round must commit
  pen.down = false; pen.pts = null;
  pointerStroke = null;
  lastSpawnSfx = lastBounceSfx = -1e9;
  app.overlays = [];
  app.results = null;
  app.lb = null;
  app.hintPending = false;
  cancelHint();
  render.setTheme(themeFor(sess.cfg).palette);
  render.setLevel(sess.cfg);
  render.setInsetBottom(0.11); // keep the subject clear of the action tray
  audio.setAvRng(RNG.derive(sess.cfg.seed, RNG.STREAM_AV));
  app.phase = "active";
  app.openedFrame = frame().frame;
  app.focusNext = null;
  ui.setFocus(null);
  mirror(() => tr("level started"));
  announce(cfgName(cfg) + ". " + objectiveText());
  if (lesson) announce(tr("Lesson {n}: {title}", { n: (lessonIdx ?? 0) + 1, title: tr(lesson.title) }));
}
export function objectiveText(): string {
  const n = sess ? sess.cfg.creatures.length : 1;
  return n > 1 ? tr("Protect {n} wisps — draw barriers, then Release", { n }) : tr("Protect Wisp — draw barriers, then Release");
}
export function restartLevel(): void {
  if (!sess) return;
  audio.play("ui");
  if (sess.mode === "tutorial" && sess.lessonIdx != null) startLesson(sess.lessonIdx);
  else beginLevel(sess.cfg);
}
export function elapsedMs(): number { return sess ? Math.round(sess.steps * STEP_MS) : 0; }
function drawing(): boolean { return !!sess && app.phase === "active" && sess.state.phase === "draw" && !sess.state.terminal; }
export function canDraw(): boolean { return drawing() && !modalOpen(); }

function applyValidated(cmd: Cmd): ReturnType<typeof R.applyCommand> | null {
  const shape = R.validateCommandShape(cmd);
  if (shape) { onInvalid(shape); return null; }
  const res = R.applyCommand(sess!.state, cmd);
  if (!res.ok) { onInvalid(res.reason ?? "unknown-command"); return null; }
  sess!.state = res.state;
  sess!.commands.push(cmd);
  sess!.stateHashes.push(R.hashState(res.state));
  return res;
}
export function onInvalid(reason: string): void {
  if (sess) sess.invalid++;
  audio.play("invalid");
  toast(() => reasonText(reason));
  mirror(() => tr("invalid: {reason}", { reason: reasonText(reason) }));
}
function commitStroke(points: Pt[]): void {
  if (!drawing()) return;
  const first = points[0] ?? [0, 0], last = points[points.length - 1] ?? [0, 0];
  const keyStr = `${points.length}:${first.join(",")}:${last.join(",")}`;
  if (keyStr === lastCommitKey) return; // double-commit guard (same pointer sequence)
  const cmd: Cmd = { type: "stroke", points, atMs: elapsedMs(), id: "cmd-" + (sess!.commands.length + 1) };
  const res = applyValidated(cmd);
  if (!res) return;
  lastCommitKey = keyStr;
  audio.play("stroke");
  haptic();
  const st = sess!.state.strokes[sess!.state.strokes.length - 1]!;
  render.addStroke(st.pts);
  cancelHint();
  lessonEvent("stroke");
  mirror(() => tr("stroke of {len} ink", { len: st.len }));
}
export function canUndo(): boolean { return drawing() && sess!.cfg.mechanics.undo; }
export function canHint(): boolean { return drawing() && sess!.cfg.mechanics.hint; }
export function undoStroke(): void {
  if (!canUndo() || modalOpen()) return;
  const s = sess!;
  if (!s.commands.some((c) => c.type === "stroke")) { toast(() => tr("Nothing to undo")); return; } // not a rejected command
  // replay the command log minus the last stroke
  const kept = s.commands.slice();
  for (let i = kept.length - 1; i >= 0; i--) if (kept[i]!.type === "stroke") { kept.splice(i, 1); break; }
  let st = R.createGame(s.cfg);
  const hashes = [R.hashState(st)];
  for (const c of kept) {
    const res = R.applyCommand(st, c);
    if (!res.ok) return;
    st = res.state;
    hashes.push(R.hashState(st));
  }
  s.state = st; s.commands = kept; s.stateHashes = hashes;
  render.removeLastStroke();
  cancelHint();
  audio.play("undo");
  lessonEvent("undo");
  mirror(() => tr("undo"));
}
let hintCancel: (() => void) | null = null;
function cancelHint(): void { if (hintCancel) hintCancel(); hintCancel = null; app.hintPending = false; render.showHint(null); }
export function showHintNow(): void {
  if (!canHint() || modalOpen() || app.hintPending) return;
  const s = sess!;
  const at = s.stateHashes[s.stateHashes.length - 1];
  app.hintPending = true;
  hintCancel = hints.request(s.state, (h) => {
    hintCancel = null;
    app.hintPending = false;
    if (sess !== s || !drawing() || s.stateHashes[s.stateHashes.length - 1] !== at) return; // the page changed meanwhile
    if (!h) { toast(() => tr("No hint available")); return; }
    audio.play("hint");
    render.showHint(h.strokes);
    announce(tr(h.wouldWin ? "Hint shown: a shield that should hold, {ink} ink." : "Hint shown: a best-effort shield, {ink} ink.", { ink: h.len }));
  });
}
export function doRelease(): void {
  if (!drawing() || modalOpen()) return;
  if (settings.confirmRelease && releaseArmedUntil < stepCount) {
    releaseArmedUntil = stepCount + 150; // 2.5 s
    toast(() => tr("Tap Release again to confirm"));
    return;
  }
  releaseArmedUntil = -1;
  if (pen.down) { pen.down = false; pen.pts = null; render.showGhost(null); }
  pointerStroke = null;
  render.showGhost(null);
  cancelHint();
  const res = applyValidated({ type: "release", atMs: elapsedMs(), id: "cmd-" + (sess!.commands.length + 1) });
  if (!res) return;
  audio.play("release");
  app.phase = "resolving";
  mirror(() => tr("storm released"));
  const s = sess!;
  const won = !!(s.state.terminal && s.state.terminal.won);
  spawnTypeById = new Map();
  for (const sp of (s.state.trace && s.state.trace.spawns) || []) spawnTypeById.set(sp.id, sp.hazard);
  if (s.state.trace) render.playTrace(s.state.trace, res.events, onTraceEvent, () => onResolved(won));
  else onResolved(won);
}
const STORM_EVENT: Record<string, string> = { spawn: N("hazard spawned"), block: N("hazard blocked"), bounce: N("bounce"), hit: N("wisp hit") };
function onTraceEvent(ev: Ev): void {
  if (ev.type === "spawn") {
    if (stepCount - lastSpawnSfx > 5) { audio.play("spawn"); lastSpawnSfx = stepCount; } // ≤ 1 per 90 ms
  } else if (ev.type === "block") {
    const hz = ev.id != null ? spawnTypeById.get(ev.id) : undefined;
    audio.play(hz && hz !== "drop" ? "block-" + hz : "block"); // ink drops use the generic block layer
  } else if (ev.type === "bounce") {
    if (stepCount - lastBounceSfx > 8) { audio.play("bounce"); lastBounceSfx = stepCount; } // ≤ 1 per 140 ms
  } else if (ev.type === "hit") {
    audio.play("hit");
    haptic();
  }
  const name = STORM_EVENT[ev.type];
  mirror(() => tr("storm: {event}", { event: name ? tr(name) : ev.type }));
}
export function skipPlayback(): void {
  if (app.phase !== "resolving" || modalOpen()) return;
  audio.play("skip");
  render.skipTrace(); // lands exactly on the terminal state via onDone
}

// ------------------------------------------------------------------ results and progression
function onResolved(won: boolean): void {
  const s = sess;
  if (!s || app.phase === "results") return;
  app.phase = "results";
  if (won) { audio.play("win"); render.celebrate(); } else audio.play("lose");
  if (s.mode === "tutorial") lessonEvent(won ? "win" : "lose");
  s.prevBest = personalBest();
  finalizeProgress(won);
  const st = s.state;
  let entries: Results["entries"] = null, boardLabel: Results["boardLabel"] = null;
  if (s.ranked && s.board) {
    storeLocalEntry(s.board, st.score.total, won);
    entries = S.sortEntries(localEntries(s.board)).slice(0, 10).map((e) => ({ name: e.name, score: e.score, won: e.won, self: e.sessionId === sessionId }));
    boardLabel = () => tr("casual (unvalidated)");
  }
  let best: number | null = null;
  const p = progress();
  if (s.mode === "journey") best = p.journeyBest[s.cfg.id] ?? null;
  else if (s.mode === "daily") best = p.dailiesDone[s.cfg.date ?? ""] ?? null;
  else if (s.mode === "challenge") best = p.challengeBest[s.cfg.id] ?? null;
  else if (s.mode === "storm") best = p.stormBest;
  const isNewBest = best != null && st.score.total > 0 && (s.prevBest == null || st.score.total > s.prevBest);
  const nextIdx = s.mode === "journey" ? (s.cfg.index ?? 0) + 1 : -1;
  const reason = st.terminal ? st.terminal.reason : "";
  const hitAt = st.sim ? (st.sim.survivedTicks / 60).toFixed(1) : "0";
  app.results = {
    headline: () => (reason === R.TERMINAL.SURVIVED ? tr("Saved!") : reason === R.TERMINAL.HIT ? tr("Hit at {s}s", { s: hitAt }) : tr("Resigned")),
    won, stars: R.starsFor(st), best, isNewBest, entries, boardLabel,
    canNext: s.mode === "journey" && won && nextIdx < C.JOURNEY.length, nextIdx,
  };
  app.overlays = ["results"];
  app.openedFrame = frame().frame;
  app.focusNext = "btn-results-retry";
  announce(tr("{headline}. Score {score}, {stars} stars.", { headline: app.results.headline(), score: st.score.total, stars: app.results.stars }), "assertive");
  postToLeaderboard(s, st.score.total);
  // Signed in, the platform's own board shows instead of the device's when it has rows.
  if (s.ranked && platform.signedIn()) {
    const r = app.results;
    void platform.fetchLeaderboard().then((b) => {
      if (app.results !== r || !b.ok || !b.entries.length) return;
      r.entries = b.entries.slice(0, 10).map((e) => ({ name: e.name, score: e.score, won: false, self: e.mine }));
      r.boardLabel = () => tr("global");
    });
  }
}
function personalBest(): number | null {
  const s = sess!, p = progress();
  if (s.mode === "journey") return p.journeyBest[s.cfg.id] ?? null;
  if (s.mode === "daily") return p.dailiesDone[s.cfg.date ?? ""] ?? null;
  if (s.mode === "challenge") return p.challengeBest[s.cfg.id] ?? null;
  if (s.mode === "storm") return p.stormBest > 0 ? p.stormBest : null;
  return null;
}
function unlock(key: string, out: Achievement[]): void {
  const p = progress();
  if (p.achievements[key]) return;
  p.achievements[key] = platform.nowMs();
  const a = C.ACHIEVEMENTS.find((x) => x.key === key);
  if (a) out.push(a);
  audio.play("achievement");
}
function finalizeProgress(won: boolean): void {
  const s = sess!, st = s.state, p = progress();
  const score = st.score.total;
  const stats = p.stats;
  stats.rounds++;
  if (won) stats.saves++;
  stats.hazardsBlocked += st.sim ? st.sim.blocked : 0;
  stats.inkSpent += st.inkUsed;
  if (won && st.sim && st.sim.minClear > stats.bestClearance) stats.bestClearance = st.sim.minClear;
  stats.playMs += elapsedMs();
  const unlocked: Achievement[] = [];
  if (won) unlock("first-save", unlocked);
  if (stats.hazardsBlocked >= 50) unlock("blocks-50", unlocked);
  if (won && s.cfg.creatures.length >= 2) unlock("twins-save", unlocked);
  if (score >= 2000) unlock("score-2000", unlocked);
  if (s.mode === "journey") {
    const stars = R.starsFor(st);
    const id = s.cfg.id;
    if (stars > (p.journeyStars[id] || 0)) {
      for (let i = p.journeyStars[id] || 0; i < stars; i++) audio.play("star");
      p.journeyStars[id] = stars;
    }
    if (score > (p.journeyBest[id] || 0)) p.journeyBest[id] = score;
    const doneCount = C.JOURNEY.filter((l) => (p.journeyStars[l.id] || 0) >= 1).length;
    if (doneCount >= 20) unlock("journey-half", unlocked);
    if (doneCount >= 40) unlock("journey-done", unlocked);
  } else if (s.mode === "daily") {
    const date = s.cfg.date ?? "";
    if (!(date in p.dailiesDone) || score > p.dailiesDone[date]!) p.dailiesDone[date] = score;
    if (Object.keys(p.dailiesDone).length >= 7) unlock("daily-7", unlocked);
  } else if (s.mode === "challenge") {
    if (score > (p.challengeBest[s.cfg.id] || 0)) p.challengeBest[s.cfg.id] = score;
  } else if (s.mode === "storm") {
    if (score > p.stormBest) p.stormBest = score;
    if (score >= 1000) unlock("storm-stand", unlocked);
  } else if (s.mode === "tutorial" && s.lesson) {
    if (won || s.lesson.goal.event === "undo") {
      p.tutorialDone[s.lesson.id] = true;
      if (lessons.every((l) => p.tutorialDone[l.id])) unlock("lessons-done", unlocked);
    }
  }
  s.newAchievements = s.newAchievements.concat(unlocked);
  platform.persist();
}
function playerName(): string {
  if (platform.signedIn()) return platform.displayName() || tr("Player {id}", { id: "" });
  let n: string | null = null;
  try { n = storage.getText(PLAYER_KEY); } catch { n = null; }
  if (!n) {
    n = "guest-" + sessionId.slice(2, 6);
    try { storage.set(PLAYER_KEY, n); } catch { /* full */ }
  }
  return n;
}
function storeLocalEntry(board: string, score: number, won: boolean): void {
  const boards = S.loadBoards();
  boards.entries.push({
    name: playerName(), score, won, invalid: sess!.invalid, durationMs: elapsedMs(), sessionId,
    board, date: new Date(platform.nowMs()).toISOString().slice(0, 10),
  });
  while (boards.entries.length > 400) boards.entries.shift();
  S.saveBoards(boards);
}
export function localEntries(board: string): BoardEntry[] { return S.loadBoards().entries.filter((e) => e.board === board); }
export function isMine(e: BoardEntry): boolean { return e.sessionId === sessionId; }
/** Signed in: every finished round except Learn lessons posts its total through score-script.js; the results show the rank. */
function postToLeaderboard(s: Session, total: number): void {
  app.lb = null;
  if (!platform.signedIn() || s.mode === "tutorial") return;
  const line = { state: "lbPosting" as const };
  app.lb = line;
  void platform.postLeaderboard(total).then((r) => {
    if (app.lb !== line) return;
    app.lb = { state: !r.posted ? "lbNotPosted" : r.rank ? "lbRank" : "lbPosted", rank: r.rank };
  });
}
export function nextLevel(): void { const r = app.results; if (r && r.canNext) startJourneyLevel(r.nextIdx); }
export function copySeed(): void {
  if (!sess) return;
  const text = "guardian-sketch " + sess.mode + " seed " + sess.cfg.seed;
  let ok = false;
  try { clipboard.writeText(text); ok = true; } catch { ok = false; }
  toast(() => (ok ? tr("Seed copied") : text));
}

// ------------------------------------------------------------------ lessons
export function startLesson(idx: number): void {
  const lesson = lessons[idx];
  if (!lesson) { toTitle(); return; }
  beginLevel(lesson.cfg, lesson, idx);
}
export function lessonCount(): number { return lessons.length; }
function lessonEvent(name: string): void {
  const s = sess;
  if (!s || !s.lesson || s.lessonDoneIn >= 0) return;
  if (s.lesson.goal.event !== name) return;
  s.lessonHits++;
  if (s.lessonHits < s.lesson.goal.count) return;
  const p = progress();
  p.tutorialDone[s.lesson.id] = true;
  if (lessons.every((l) => p.tutorialDone[l.id]) && !p.achievements["lessons-done"]) {
    p.achievements["lessons-done"] = platform.nowMs();
    const a = C.ACHIEVEMENTS.find((x) => x.key === "lessons-done");
    if (a) s.newAchievements.push(a);
  }
  platform.persist();
  const title = s.lesson.title;
  toast(() => tr("Lesson complete! {title}", { title: tr(title) }));
  audio.play("lesson");
  s.lessonDoneIn = 96; // 1.6 s, then the next lesson
}

// ------------------------------------------------------------------ pause
export function pauseGame(): void {
  if ((app.phase !== "active" && app.phase !== "resolving") || modalOpen()) return;
  if (pen.down) { pen.down = false; pen.pts = null; render.showGhost(null); }
  pointerStroke = null;
  render.showGhost(null);
  audio.play("pause");
  openOverlay("pause", "btn-resume");
  announce(tr("Paused"));
  mirror(() => tr("paused"));
}
export function resumeGame(): void {
  app.overlays = [];
  app.openedFrame = frame().frame;
  ui.setFocus(null);
}
export function quitToTitle(): void { toTitle(); }

// ------------------------------------------------------------------ settings, scores, platform
export function unlockedTheme(id: string): boolean {
  const t = C.THEMES.find((x) => x.id === id);
  return !!t && totalStars() >= (t.unlockStars || 0);
}
export function setTheme(id: string): void {
  if (!unlockedTheme(id)) return;
  platform.setSetting("theme", id);
  render.setTheme(themeFor(sess ? sess.cfg : null).palette);
}
export function resetSave(): void {
  platform.resetProgress();
  try { storage.remove("guardiansketch.lastreplay"); } catch { /* gone */ }
  toTitle();
  toast(() => tr("Save data reset"));
}
export interface ScoreBoard { id: string; label: () => string }
export function scoreBoards(): ScoreBoard[] {
  const date = today();
  return [
    { id: "storm", label: () => tr("Tempest Stand") },
    { id: "daily-" + date, label: () => tr("Daily {date}", { date }) },
    ...C.CHALLENGES.map((c) => ({ id: "challenge-" + c.id, label: () => tr(c.name) })),
  ];
}
/** The Scores dialog's rows: the platform's high-score board (Global, signed in) or this device's records. */
export function refreshScores(): void {
  app.scoresRows = null;
  app.scoresState = "idle";
  const local = (): void => {
    app.scoresRows = S.sortEntries(localEntries(app.scoresBoard)).slice(0, 20).map((e) => ({ name: e.name, score: e.score, won: e.won, self: isMine(e) }));
    app.scoresState = "done";
  };
  if (app.scoresTab === "device" || !platform.signedIn()) { local(); return; }
  app.scoresState = "loading";
  const tab = app.scoresTab, board = app.scoresBoard;
  void platform.fetchLeaderboard().then((r) => {
    if (app.scoresTab !== tab || app.scoresBoard !== board) return;
    if (r.ok && r.entries.length) {
      app.scoresRows = r.entries.map((e) => ({ name: e.name, score: e.score, won: false, self: e.mine }));
      app.scoresState = "done";
    } else local();
  });
}
export function copyInvite(): void {
  const link = platform.inviteLink();
  let ok = false;
  if (link) { try { clipboard.writeText(link); ok = true; } catch { ok = false; } }
  toast(() => (ok ? pt("inviteCopied") : pt("inviteFailed")));
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
/** The always-on board state panel's last event line. */
export function mirror(last: () => string): void { app.mirrorLast = last; }
export function nextDailyText(): string {
  const t = platform.nowMs();
  const next = Math.floor(t / 86400000) * 86400000 + 86400000;
  const s = Math.max(0, Math.floor((next - t) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return tr("Next daily in {time}", { time: h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0") });
}
export function syncLine(): string {
  if (!platform.signedIn()) return tr("Offline — progress is saved on this device");
  const st = platform.syncState();
  const status = st === "saving" ? tr("Cloud save: saving…") : st === "synced" ? tr("Cloud save: synced")
    : st === "error" ? tr("Cloud save: offline — will retry") : tr("Cloud save: offline");
  return tr("Signed in as {name}  ·  {status}", { name: platform.displayName(), status });
}

// ------------------------------------------------------------------ input: pointer drawing
interface PointerStroke { pts: Pt[]; downX: number; downY: number; downAt: number; overInk: boolean; capWarned: boolean; touchId: number | null }
let pointerStroke: PointerStroke | null = null;
/** A press waiting for the UI's hover test (it is decided after the frame's widgets are built). */
let pendingDown: { x: number; y: number; touchId: number | null } | null = null;
let lastTouch = -1e9;
function pushPoint(ps: PointerStroke, x: number, y: number): void {
  const w = render.screenToWorld(x, y);
  if (!w) return;
  const last = ps.pts[ps.pts.length - 1]!;
  const dx = w.x - last[0], dy = w.y - last[1];
  if (dx * dx + dy * dy < 4) return; // dedupe ≥ 2 world units
  if (ps.pts.length >= R.MAX_POINTS) {
    if (!ps.capWarned) { ps.capWarned = true; onInvalid("too-many-points"); } // once per stroke
    return;
  }
  if (ps.overInk) return;
  if (R.polyLength(ps.pts.concat([[w.x, w.y]])) > inkLeft()) { ps.overInk = true; onInvalid("ink-exhausted"); return; }
  ps.pts.push([Math.round(w.x), Math.round(w.y)]);
  if (ps.pts.length > 1) render.showGhost(ps.pts);
}
/** Decides a queued press once the UI is built: on the page (not a widget) it starts a stroke. */
export function decidePress(): void {
  const d = pendingDown;
  pendingDown = null;
  if (!d || pointerStroke || !canDraw() || ui.pointerOver()) return;
  const w = render.screenToWorld(d.x, d.y);
  if (!w) return;
  ui.setFocus(null);
  pointerStroke = { pts: [[Math.round(w.x), Math.round(w.y)]], downX: d.x, downY: d.y, downAt: now(), overInk: false, capWarned: false, touchId: d.touchId };
  audio.play("draw-start");
}
function pointerMove(x: number, y: number, touchId: number | null): void {
  const ps = pointerStroke;
  if (!ps || ps.touchId !== touchId) return;
  if (!canDraw()) { pointerStroke = null; render.showGhost(null); return; }
  pushPoint(ps, x, y);
}
function pointerUp(x: number, y: number, touchId: number | null, cancel: boolean): void {
  const ps = pointerStroke;
  if (!ps || ps.touchId !== touchId) return;
  pointerStroke = null;
  render.showGhost(null);
  // a quick tap (< 10 px, < 250 ms) is harmless: no accidental stroke
  const dist = Math.hypot(x - ps.downX, y - ps.downY) / Math.max(0.5, frame().scale);
  const dt = now() - ps.downAt;
  if (cancel || ps.pts.length < 2 || (dist < 10 && dt < 0.25)) {
    if (!cancel && ps.pts.length >= 2) onInvalid("stroke-too-short");
    return;
  }
  commitStroke(ps.pts);
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) pendingDown = { x: e.x, y: e.y, touchId: null };
  else pointerUp(e.x, e.y, null, false);
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) pointerMove(x, y, null); });
onTouch((e) => {
  if (e.control) return;
  lastTouch = now();
  if (e.phase === "start") { if (e.primary) pendingDown = { x: e.x, y: e.y, touchId: e.id }; }
  else if (e.phase === "move") pointerMove(e.x, e.y, e.id);
  else pointerUp(e.x, e.y, e.id, e.phase === "cancel");
});

// ------------------------------------------------------------------ input: the keyboard / gamepad pen
function penMove(dx: number, dy: number): void {
  pen.active = true;
  pen.x = Math.max(0, Math.min(1000, pen.x + dx));
  pen.y = Math.max(0, Math.min(700, pen.y + dy));
  if (!pen.down || !drawing()) return;
  if (!pen.pts) pen.pts = [[Math.round(pen.x), Math.round(pen.y)]];
  const last = pen.pts[pen.pts.length - 1]!;
  if (Math.hypot(pen.x - last[0], pen.y - last[1]) >= 2 && pen.pts.length < R.MAX_POINTS) {
    if (R.polyLength(pen.pts.concat([[pen.x, pen.y]])) <= inkLeft()) {
      pen.pts.push([Math.round(pen.x), Math.round(pen.y)]);
      pen.inkWarned = false;
      render.showGhost(pen.pts);
    } else if (!pen.inkWarned) { pen.inkWarned = true; onInvalid("ink-exhausted"); } // once per stroke
  }
}
function penToggle(): void {
  if (!drawing()) return;
  pen.active = true;
  pen.down = !pen.down;
  if (pen.down) { pen.pts = [[Math.round(pen.x), Math.round(pen.y)]]; pen.inkWarned = false; audio.play("draw-start"); return; }
  const drawn = pen.pts;
  pen.pts = null;
  render.showGhost(null);
  if (drawn && drawn.length > 1) commitStroke(drawn);
  else if (drawn) onInvalid("stroke-too-short");
}
const PEN_ACTIONS = ["pen_left", "pen_right", "pen_up", "pen_down"];
onAction((e) => {
  if (!e.pressed) return;
  const a = e.action;
  const top = topOverlay();
  // Pause / resume works while the pause dialog is open (Escape there resumes, screens.ts).
  if (a === "pause") {
    if (!top && (app.phase === "active" || app.phase === "resolving")) pauseGame();
    return;
  }
  if (top) return;
  if (PEN_ACTIONS.includes(a) && canDraw()) { ui.setFocus(null); pen.active = true; return; }
  switch (a) {
    // A focused widget (a tray button) takes Space / South itself.
    case "pen_toggle": if (canDraw() && !ui.focused()) penToggle(); break;
    case "release": doRelease(); break;
    case "undo": undoStroke(); break;
    case "hint": showHintNow(); break;
    case "skip": skipPlayback(); break;
    case "camera": render.refit(); break;
  }
});
/** Held pen movement, one step a fixed step (keys, D-pad, the left stick's tilt). */
function penTick(): void {
  if (!canDraw()) return;
  const step = isDown("pen_fast") ? PEN_STEP_FAST : PEN_STEP;
  const dx = (value("pen_right") - value("pen_left")) * step;
  const dy = (value("pen_up") - value("pen_down")) * step; // the world is y-up
  if (Math.abs(dx) > 0.25 * step || Math.abs(dy) > 0.25 * step) {
    penMove(Math.abs(dx) > 0.25 * step ? dx : 0, Math.abs(dy) > 0.25 * step ? dy : 0);
    // the pen's arrows are the game's, not the UI focus ring's
    if (ui.focused()) ui.setFocus(null);
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.onCaption((text) => { if (settings.captions) app.caption = { text, until: now() + 2.2 }; });
  hints.warm();
  const pr = preferences();
  render.setReducedMotion(pr.reducedMotion);
  render.setHighContrast(pr.highContrast);
  applyLook();
  toTitle();
});
onPreferencesChange((p) => { render.setReducedMotion(p.reducedMotion); render.setHighContrast(p.highContrast); });
platform.onSettingsChange(() => {
  // a locked theme (another device's save, a reset) falls back to the first
  if (!unlockedTheme(settings.theme) && settings.theme !== C.THEMES[0]!.id) platform.setSetting("theme", C.THEMES[0]!.id);
  render.setTheme(themeFor(sess ? sess.cfg : null).palette);
});
onLocaleChange(() => { if (topOverlay() === "scores") refreshScores(); });
onSessionEnded(() => { app.signedOut = true; toast(() => pt("signedOut")); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
// A hidden window pauses the round (the browser build's visibilitychange).
onSuspend(() => { suspended = true; platform.flush(); pauseGame(); });
onResume(() => { suspended = false; });

onFixedUpdate(() => {
  if (suspended) return;
  stepCount++;
  const s = sess;
  if (!s) return;
  const paused = modalOpen() && (app.phase === "active" || app.phase === "resolving");
  if (paused) return;
  s.steps++;
  penTick();
  if (app.phase === "resolving") render.stepTrace();
  if (s.lessonDoneIn > 0 && --s.lessonDoneIn === 0 && sess === s && s.lessonIdx != null) startLesson(s.lessonIdx + 1);
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t0 = now();
  app.toasts = app.toasts.filter((t) => t.until > t0);
  if (app.caption && t0 > app.caption.until) app.caption = null;
  // while the pen moves, arrows and the D-pad are the game's, not the focus ring's
  if (canDraw() && PEN_ACTIONS.some((a) => isDown(a)) && ui.focused()) ui.setFocus(null);
});
onRender((interp) => {
  const f = frame();
  render.resize(f.width, f.height);
  drawScreens();
  decidePress();
  render.update(frameDt, app.phase === "resolving" && !modalOpen() ? interp : 0);
});
