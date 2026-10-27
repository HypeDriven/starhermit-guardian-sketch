// The browser build's DOM shell (index.html + js/ui.js + css/main.css) as
// starhermit:ui, built every frame over the page: the title (key art, logo,
// tagline, journey stars and daily status, the next-daily countdown, the
// sync line, Play and the menu grid, sign-in / invite), the HUD (the
// objective, the ink gauge with "n ink · m strokes", the storm countdown,
// the action tray with Release / Undo / Hint / Skip / Pause in context, the
// keyboard pen's marker, the lesson card, the always-on board state panel),
// the dialogs (setup, journey grid, practice, challenges, pause, settings,
// results, help, scores, the reset confirmation), the toasts and the
// caption strip. The browser's media queries are layouts picked by the
// window's logical size: phone portrait (≤ 520 px wide: a smaller one-line
// logo, the tray wrapping), short landscape (≤ 480 px tall: the title in
// two columns, the tray a column on the right, left when left-handed), and
// the rest.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { TextureLoader, type Texture } from "starhermit:scene";
import { Content as C, type Cfg, type HazardType } from "./classic.ts";
import { tr, pt } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, canHint, canUndo, cfgName, closeOverlay, copyInvite, copySeed, doRelease, firstUncompletedJourney, hazardName, inkLeft,
  lessonCount, modalOpen, modeMeta, newPracticeSeed, nextDailyText, nextLevel, openDaily, openLearn, openOverlay, openSetup, openStorm,
  pauseGame, pen, progress, quitToTitle, refreshScores, resetSave, restartLevel, resumeGame, scoreBoards, sess, setTheme, settings,
  showHintNow, signIn, skipPlayback, startFromSetup, startJourneyLevel, startLesson, startPractice, syncLine, today, toTitle, topOverlay,
  totalStars, undoStroke, unlockedTheme, objectiveText,
} from "./main.ts";
import { COLORS } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; phone: boolean; shortLand: boolean; wide: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 480;
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, phone: !shortLand && lw <= 520, shortLand, wide: lw >= 1024 };
}
const lastHeight = new Map<string, number>();
type Cls = string | ui.Style;
const textWidth = (text: string, style: Cls | readonly Cls[], kind?: "button" | "heading"): number =>
  ui.measureText(text, { ...(kind ? { kind } : {}), style }).width / ui.preferences().scale;

interface Btn { id: string; text: string; style?: Cls[]; disabled?: boolean; selected?: boolean; act: () => void; width?: number; tooltip?: string }
const PLAIN: Cls[] = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.tooltip) opts.tooltip = b.tooltip;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && textWidth(b.text, style, "button") + 2 > width) {
    const inner = Math.max(20, width - 20);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
    s.padding = { start: 8, end: 8, top: 8, bottom: 8 };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) { b.act(); }
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 12, reverse = false): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, b.width ?? textWidth(b.text, b.style ?? PLAIN, "button") + 2);
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of reverse ? [...row].reverse() : row) button(b, b.width ?? (textWidth(b.text, b.style ?? PLAIN, "button") + 2 > width ? width : null));
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align: "center", width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string, center = false): void {
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  if (ui.measureText(text, { kind: "heading", style: styles }).width / ui.preferences().scale <= width) (id ? ui.id(id) : ui).style(...styles).heading(text);
  else (id ? ui.id(id) : ui).style(...styles).paragraph(text, width);
}
const stars = (n: number): string => "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n));

// ------------------------------------------------------------------ art
let keyArt: Texture | null = null;
const resultArt: { saved: Texture | null; hit: Texture | null } = { saved: null, hit: null };
let artAsked = false;
function loadArt(): void {
  if (artAsked) return;
  artAsked = true;
  // Decorative: a missing file just leaves the art out.
  const loader = new TextureLoader();
  loader.loadAsync("assets/key-art.webp").then((t) => { keyArt = t; }, () => undefined);
  loader.loadAsync("assets/results-saved.webp").then((t) => { resultArt.saved = t; }, () => undefined);
  loader.loadAsync("assets/results-hit.webp").then((t) => { resultArt.hit = t; }, () => undefined);
}
/** Art cover-fitted into w × h (CSS object-fit: cover). */
function art(id: string, tex: Texture | null, w: number, h: number, cls: string): void {
  if (!tex || h < 24) return;
  const tw = tex.width || 1200, th = tex.height || 672;
  const k = Math.max(w / tw, h / th);
  const sw = w / k / tw, sh = h / k / th;
  const u0 = (1 - sw) / 2, v0 = (1 - sh) / 2;
  ui.column(`${id}-frame`, () => {
    ui.image("", tex, { width: w, height: h }, { min: [u0, v0], max: [u0 + sw, v0 + sh] });
  }, { style: cls, clip: true, padding: 0 });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  loadArt();
  const L = layoutNow();
  const f = frame();
  if (app.phase === "title") titleScreen(L);
  else if (sess) hud(L);
  dialogs(L);
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ title
function titleScreen(L: Layout): void {
  const f = frame();
  draw.box(0, 0, f.width, f.height, "title-veil");
  const p = progress();
  const done = p.dailiesDone[today()];
  const statsText = tr("Journey stars: {n} / 120", { n: totalStars() }) + "  ·  " +
    (done != null ? tr("Today’s daily: done ({score})", { score: done }) : tr("Today’s daily: open"));
  const nav: [string, string, () => void][] = [
    ["btn-journey", tr("Journey"), () => openOverlay("journey")],
    ["btn-daily", tr("Daily"), openDaily],
    ["btn-practice", tr("Practice"), () => openOverlay("practice", "btn-practice-start")],
    ["btn-challenges", tr("Challenges"), () => openOverlay("challenges")],
    ["btn-storm", tr("Tempest Stand"), openStorm],
    ["btn-learn", tr("Learn"), openLearn],
    ["btn-help", tr("Help"), () => openOverlay("help", "btn-help-close")],
    ["btn-settings", tr("Settings"), () => openOverlay("settings", "btn-settings-done")],
    ["btn-scores", tr("Scores"), () => openOverlay("scores", "btn-scores-close")],
  ];
  const head = (w: number, artH: number): void => {
    art("title-art", keyArt, w, artH, "art-frame");
    heading(L.phone ? "logo-small" : "logo", "Guardian Sketch", w, "title-logo", true);
    para(tr("Draw ink. Shield the wisps. Weather the storm."), w, "tagline", "title-tagline", true);
    para(statsText, w, "title-stats", "title-stats", true);
    para(nextDailyText(), w, "countdown", "title-countdown", true);
    para(syncLine(), w, "sync", "title-sync", true);
    if (app.signedOut && !platform.signedIn()) para(pt("signedOut"), w, "sync", "title-signed-out", true);
  };
  const menu = (w: number): void => {
    const gap = L.phone || L.shortLand ? 8 : 11;
    button({ id: "btn-play", text: "▶ " + tr("Play"), style: ["btn", "btn-primary", "btn-big"], act: () => startJourneyLevel(firstUncompletedJourney()) }, w);
    const cw = (w - 2 * gap) / 3;
    for (let r = 0; r < 3; r++) {
      ui.row(`title-grid-r${r}`, () => {
        for (const [id, text, act] of nav.slice(r * 3, r * 3 + 3)) button({ id, text, act, style: ["btn", { padding: { start: 6, end: 6, top: 10, bottom: 10 } }] }, cw);
      }, { spacing: gap });
    }
    const acct: Btn[] = [];
    if (!platform.signedIn()) acct.push({ id: "btn-signin", text: pt("signIn"), act: signIn });
    else if (platform.inviteLink()) acct.push({ id: "btn-invite", text: pt("invite"), act: copyInvite });
    if (acct.length) flow("title-account", acct, w);
  };
  const avail = L.lh - 16;
  if (L.shortLand) {
    // short landscape: art, logo and status on the left; Play and the menu on the right
    const total = Math.min(L.lw - 24, 860);
    const lw = (total - 20) * 0.43, rw = total - 20 - lw;
    ui.place("title", { anchor: "top-start", x: L.ox + (L.lw - total) / 2, y: L.oy + 8 }, () => {
      ui.row("title-cols", () => {
        ui.column("title-head", () => head(lw, Math.min(L.lh * 0.34, lw * 0.56)), { width: lw, spacing: 4, align: "center" });
        ui.column("title-menu", () => menu(rw), { width: rw, spacing: 8, align: "center" });
      }, { spacing: 20, align: "center", height: avail });
    }, { width: total, height: avail });
    return;
  }
  const w = Math.min(L.lw * 0.92, 560);
  const prev = lastHeight.get("title") ?? 0;
  const body = (): void => {
    const r = ui.column("title-card", () => {
      head(w, Math.min(L.lh * 0.3, w * 0.56));
      ui.column("title-menu", () => menu(w), { width: w, spacing: L.phone ? 8 : 11, padding: { top: 6 } });
    }, { width: w, spacing: 6, align: "center" });
    lastHeight.set("title", r.height / L.sc);
  };
  ui.place("title", { anchor: "top-start", x: L.ox, y: L.oy }, () => {
    if (prev > avail) ui.scrollArea("title-scroll", { width: L.lw, height: L.lh }, () => ui.column("title-scroll-col", body, { width: L.lw - 12, align: "center", padding: { top: 8, bottom: 8 } }));
    else ui.column("title-center", body, { width: L.lw, height: L.lh, justify: "center", align: "center" });
  }, { width: L.lw, height: L.lh });
}

// ------------------------------------------------------------------ HUD
function trayButtons(): Btn[] {
  const s = sess!;
  const list: Btn[] = [];
  const st = s.state;
  if (app.phase === "active" && st.phase === "draw") {
    list.push({ id: "btn-release", text: tr("Release"), style: ["btn", "btn-primary", "btn-tray"], act: doRelease });
    if (canUndo()) list.push({ id: "btn-undo", text: tr("Undo"), style: ["btn", "btn-tray"], act: undoStroke });
    if (canHint()) list.push({ id: "btn-hint", text: tr("Hint"), style: ["btn", "btn-tray"], disabled: app.hintPending, act: showHintNow });
  }
  if (app.phase === "resolving") list.push({ id: "btn-skip", text: tr("Skip ⏩"), style: ["btn", "btn-tray"], act: skipPlayback });
  if (app.phase === "active" || app.phase === "resolving") list.push({ id: "btn-pause", text: tr("❚❚ Pause"), style: ["btn", "btn-ghost", "btn-tray"], act: pauseGame });
  return list;
}
function hud(L: Layout): void {
  const s = sess!;
  const st = s.state;
  const pad = L.phone ? 10 : 16;
  const results = app.phase === "results";
  if (!results) {
    // top-left: the objective pill and the ink gauge
    const gw = L.shortLand ? 110 : L.phone ? 130 : Math.max(140, Math.min(240, L.lw * 0.22));
    ui.place("hud-left", { anchor: "top-start", x: pad, y: pad * 0.6 }, () => {
      const ow = Math.min(L.lw - 2 * pad - (app.phase === "resolving" ? 90 : 0), 640);
      ui.column("hud-objective-pill", () => para(objectiveText(), ow - 20, "hud-objective", "hud-objective"), { style: "hud-pill" });
      ui.progress(st.cfg.ink.budget ? Math.max(0, Math.min(1, inkLeft() / st.cfg.ink.budget)) : 0, gw);
      ui.style("ink-label").id("hud-ink").label(tr("{ink} ink · {strokes} strokes", { ink: Math.round(inkLeft()), strokes: st.cfg.ink.maxStrokes - st.strokes.length }));
    }, { spacing: 6 });
    if (app.phase === "resolving" && render.isPlaying()) {
      const left = (st.cfg.simTicks / 60) * (1 - render.traceProgress());
      ui.place("hud-right", { anchor: "top-end", x: pad, y: pad * 0.6 }, () => {
        ui.column("hud-countdown-pill", () => ui.style("hud-countdown").id("hud-countdown").label("⏱ " + left.toFixed(1) + "s"), { style: "hud-pill" });
      });
    }
  }
  // the lesson card, below the gauge (left column in short landscape)
  if (s.lesson && !results) {
    const lw = L.shortLand ? Math.min(L.lw * 0.6, 420) : Math.min(L.lw * 0.94, 480);
    const at = L.shortLand ? { anchor: "top-start" as const, x: 8, y: 74 } : { anchor: "top" as const, y: (L.phone ? 72 : 88) };
    const lesson = s.lesson;
    ui.place("learn", at, () => {
      ui.column("learn-card", () => {
        ui.style("learn-progress").id("learn-progress").label(tr("Lesson {n} of {total}", { n: (s.lessonIdx ?? 0) + 1, total: lessonCount() }).toUpperCase());
        heading("h3", tr(lesson.title), lw - 40, "learn-title");
        para(tr(lesson.text), lw - 40, "learn-text", "learn-text");
        flow("learn-buttons", [
          { id: "btn-skip-lesson", text: tr("Skip lesson"), act: () => startLesson((s.lessonIdx ?? 0) + 1) },
          { id: "btn-quit-lessons", text: tr("Quit lessons"), act: toTitle },
        ], lw - 40, 10);
      }, { style: "learn-card", width: lw, spacing: 6 });
    });
  }
  // the board state panel
  if (settings.boardMirror) mirrorPanel(L);
  // the tray
  if (!results) {
    const list = trayButtons();
    if (L.shortLand) {
      const tw = Math.min(L.lw * 0.3, 190);
      const at = settings.leftHanded ? { anchor: "start" as const, x: 6 } : { anchor: "end" as const, x: 6 };
      ui.place("tray", at, () => { for (const b of list) button(b, tw); }, { spacing: 8, width: tw });
    } else {
      const tw = Math.min(L.lw * 0.96, 760);
      const r = ui.place("tray", { anchor: "bottom", y: Math.max(8, L.lh * 0.02) }, () => flow("tray-flow", list, tw, 8, settings.leftHanded), { width: tw });
      lastHeight.set("tray", r.height / L.sc + Math.max(8, L.lh * 0.02));
    }
  }
  // the keyboard / gamepad pen
  if (pen.active && app.phase === "active" && !modalOpen()) {
    const p = render.worldToScreen(pen.x, pen.y);
    const cls = pen.down ? "pen-marker-down" : "pen-marker";
    const m = ui.measureText("✎", { style: cls });
    ui.area({ x: p.x - m.width / 2, y: p.y - m.height / 2, width: m.width + 2, height: m.height + 2 }, () => {
      ui.style(cls).id("pen-marker").label("✎");
    });
  }
}
const PHASE_NAME: Record<string, string> = { draw: "drawing", done: "finished", storm: "storm" };
function mirrorPanel(L: Layout): void {
  const s = sess!;
  const st = s.state;
  const w = Math.min(240, L.lw * 0.44);
  const phase = app.phase === "resolving" ? "storm" : st.phase;
  const lines = [
    tr("Phase: {phase}", { phase: tr(PHASE_NAME[phase] ?? phase) }),
    tr("Strokes: {n} / {max}", { n: st.strokes.length, max: st.cfg.ink.maxStrokes }),
    tr("Ink left: {n}", { n: Math.round(inkLeft()) }),
    tr("Creatures: {list}", { list: st.cfg.creatures.map((c, i) => tr("wisp {n} at {x},{y}", { n: i + 1, x: c.x, y: c.y })).join("; ") }),
    tr("Emitters: {n}", { n: st.cfg.emitters.length }),
    tr("Last: {event}", { event: app.mirrorLast ? app.mirrorLast() : "—" }),
  ];
  const compact = !L.wide;
  const at = compact
    ? { anchor: (settings.leftHanded ? "bottom-start" : "bottom-end") as ui.Anchor, x: 10, y: (lastHeight.get("tray") ?? 70) + 12 }
    : { anchor: (settings.leftHanded ? "top-start" : "top-end") as ui.Anchor, x: 10, y: 90 };
  ui.place("mirror", at, () => {
    ui.style("mirror-h").label(tr("Board"));
    for (let i = 0; i < lines.length; i++) para(lines[i]!, w - 24, "mirror-line", `mirror-${i}`);
  }, { style: "mirror", width: w, spacing: 2 });
}

// ------------------------------------------------------------------ dialogs
function dialogFrame(label: string, L: Layout, maxW: number, build: (w: number) => void, onClose: (() => void) | null = () => closeOverlay(), footer?: (w: number) => void): void {
  const w = Math.min(maxW, L.lw * 0.94) - 50;
  const footH = footer ? (lastHeight.get(`dlg-${label}-foot`) ?? 56) + 10 : 0;
  const avail = L.lh * 0.88 - 50 - footH;
  const h = lastHeight.get(`dlg-${label}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${label}-body`, () => build(w), { spacing: 10, width: w });
    lastHeight.set(`dlg-${label}`, r.height / L.sc);
  };
  // A dialog opens at its top (heading visible), whatever it focuses.
  const fresh = frame().frame - app.openedFrame <= 4;
  const open = ui.dialog(label, "", true, () => {
    if (h > avail) ui.scrollArea(`${label}-scroll`, { width: w + 14, height: Math.max(80, avail) }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
    // the action buttons stay in view under a scrolling body
    if (footer) {
      const r = ui.column(`${label}-foot`, () => footer(w), { width: w, padding: { top: 10 } });
      lastHeight.set(`dlg-${label}-foot`, r.height / L.sc);
    }
  });
  // The Escape (or East) that opened it must not close it the same frame.
  if (!open && frame().frame !== app.openedFrame && onClose) onClose();
}
function dialogs(L: Layout): void {
  const o = topOverlay();
  if (!o) return;
  switch (o) {
    case "setup": setupDialog(L); break;
    case "journey": journeyDialog(L); break;
    case "practice": practiceDialog(L); break;
    case "challenges": challengesDialog(L); break;
    case "pause": pauseDialog(L); break;
    case "settings": settingsDialog(L); break;
    case "help": helpDialog(L); break;
    case "scores": scoresDialog(L); break;
    case "results": resultsDialog(L); break;
    case "reset": resetDialog(L); break;
  }
}
function legend(id: string, types: HazardType[], w: number): void {
  const list = types.map((t) => ({ t, text: hazardName(t) }));
  const rows: (typeof list)[] = [[]];
  let used = 0;
  for (const it of list) {
    const iw = textWidth(it.text, "chip-" + it.t) + 26;
    if (rows[rows.length - 1]!.length && used + 8 + iw > w) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? 8 : 0) + iw;
    rows[rows.length - 1]!.push(it);
  }
  ui.column(id, () => {
    rows.forEach((row, ri) => ui.row(`${id}-r${ri}`, () => {
      for (const it of row) ui.column(`${id}-${it.t}`, () => ui.style({ text: { color: COLORS.paperFg, size: 13.6 } }).label(it.text), { style: "chip-" + it.t });
    }, { spacing: 8 }));
  }, { spacing: 8 });
}
function setupDialog(L: Layout): void {
  const st = app.setup;
  if (!st) { closeOverlay(); return; }
  const cfg: Cfg = st.cfg;
  const meta = modeMeta(cfg);
  dialogFrame("overlay-setup", L, 560, (w) => {
    heading("h2", cfgName(cfg), w, "setup-title");
    para(tr(meta.ranked ? "{mode} · ranked" : "{mode} · unranked", { mode: meta.label() }).toUpperCase(), w, "mode-label", "setup-mode");
    if (st.note) para(st.note(), w, "note", "setup-note");
    if (cfg.intro) para(tr(cfg.intro), w, "intro", "setup-intro");
    const seen: HazardType[] = [];
    for (const e of cfg.emitters) if (!seen.includes(e.type)) seen.push(e.type);
    legend("setup-legend", seen, w);
    const items = [
      tr("Ink budget: {budget} units · up to {strokes} strokes", { budget: cfg.ink.budget, strokes: cfg.ink.maxStrokes }),
      tr("Storm length: {s} seconds", { s: (cfg.simTicks / 60).toFixed(0) }),
      tr("Creatures to protect: {n}", { n: cfg.creatures.length }),
    ];
    if (cfg.par) items.push(tr("Par: ★★ at {two} · ★★★ at {three}", { two: cfg.par.score2, three: cfg.par.score3 }));
    items.push(tr("Assists: undo {undo} · hint {hint}", { undo: cfg.mechanics.undo ? tr("on") : tr("off"), hint: cfg.mechanics.hint ? tr("on") : tr("off") }));
    ui.column("setup-rules", () => items.forEach((t, i) => para("• " + t, w - 10, "bullet", `setup-rule-${i}`)), { spacing: 3, padding: { start: 6 } });
    para(tr("Expected duration: under a minute."), w, "note");
  }, () => closeOverlay(), (w) => flow("setup-buttons", [
    { id: "btn-setup-start", text: tr("Start"), style: ["btn", "btn-primary"], act: startFromSetup },
    { id: "btn-setup-cancel", text: tr("Cancel"), act: () => closeOverlay("setup") },
  ], w));
}
function journeyDialog(L: Layout): void {
  const p = progress();
  dialogFrame("overlay-journey", L, 560, (w) => {
    heading("h2", tr("Journey"), w, "journey-title");
    const gap = L.phone ? 6 : 8;
    const min = L.phone ? 52 : 64;
    const cols = Math.max(4, Math.floor((w + gap) / (min + gap)));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.grid("journey-grid", () => {
      C.JOURNEY.forEach((cfg, i) => {
        const prevOk = i === 0 || (p.journeyStars[C.JOURNEY[i - 1]!.id] || 0) >= 1;
        const n = p.journeyStars[cfg.id] || 0;
        const theme = C.THEMES.find((t) => t.id === cfg.theme);
        let tip = tr(cfg.name);
        if (cfg.mastery) tip = tr("{name} (Mastery)", { name: tip });
        tip = tr("{name} — {theme}", { name: tip, theme: theme ? tr(theme.name) : "" });
        if (!prevOk) tip = tr("{label} — locked: earn a star on the previous stage", { label: tip });
        const label = String(i + 1);
        if (ui.style(cfg.mastery ? "level-mastery" : "level", { width: cw, minHeight: min }).id(`journey-${i}`).button(tr("Stage {n}", { n: i + 1 }), {
          disabled: !prevOk, tooltip: tip,
          content: () => { ui.style("level-num").label(label); ui.style("stars").label(stars(n)); },
        })) { closeOverlay("journey"); openSetup(cfg); }
      });
    }, { columns: cols, gap });
  }, () => closeOverlay(), (w) => flow("journey-buttons", [{ id: "btn-journey-back", text: tr("Back"), act: () => closeOverlay("journey") }], w));
}
function practiceDialog(L: Layout): void {
  dialogFrame("overlay-practice", L, 560, (w) => {
    heading("h2", tr("Practice"), w, "practice-title");
    para(tr("Unranked. Undo and hints are on. Restarting with the same seed gives the same layout."), w, "note");
    const opts = C.PRACTICE.map((pr) => tr("{name} — {blurb}", { name: tr(pr.name), blurb: tr(pr.blurb) }));
    const next = ui.style({ width: w }).id("practice-preset").select(tr("Difficulty"), app.practiceIdx, opts);
    if (next !== app.practiceIdx) app.practiceIdx = next;
    ui.row("practice-seed", () => {
      ui.style("body").id("practice-seed-label").label(tr("Seed: {seed}", { seed: app.practiceSeed }));
      button({ id: "btn-new-seed", text: tr("New seed"), act: newPracticeSeed });
    }, { spacing: 12, align: "center" });
  }, () => closeOverlay(), (w) => flow("practice-buttons", [
    { id: "btn-practice-start", text: tr("Start"), style: ["btn", "btn-primary"], act: () => { closeOverlay("practice"); startPractice(); } },
    { id: "btn-practice-cancel", text: tr("Cancel"), act: () => closeOverlay("practice") },
  ], w));
}
function challengesDialog(L: Layout): void {
  const p = progress();
  dialogFrame("overlay-challenges", L, 560, (w) => {
    heading("h2", tr("Challenges"), w, "challenges-title");
    C.CHALLENGES.forEach((cfg, i) => {
      const best = p.challengeBest[cfg.id];
      const name = tr(cfg.name);
      if (ui.style("challenge", { width: w }).id(`challenge-${i}`).button(name, {
        content: () => {
          ui.style("ch-name").label(name);
          if (cfg.intro) ui.style("ch-text").paragraph(tr(cfg.intro), w - 34);
          ui.style("ch-text").label(best != null ? tr("Best: {score}", { score: best }) : tr("Not attempted"));
        },
      })) { closeOverlay("challenges"); openSetup(cfg); }
    });
  }, () => closeOverlay(), (w) => flow("challenges-buttons", [{ id: "btn-challenges-back", text: tr("Back"), act: () => closeOverlay("challenges") }], w));
}
function pauseDialog(L: Layout): void {
  dialogFrame("overlay-pause", L, 380, (w) => {
    heading("h2", tr("Paused"), w, "pause-title");
    button({ id: "btn-resume", text: tr("Resume"), style: ["btn", "btn-primary"], act: resumeGame }, w);
    button({ id: "btn-pause-settings", text: tr("Settings"), act: () => openOverlay("settings", "btn-settings-done") }, w);
    button({ id: "btn-pause-help", text: tr("Help"), act: () => openOverlay("help", "btn-help-close") }, w);
    button({ id: "btn-restart", text: tr("Restart"), act: restartLevel }, w);
    button({ id: "btn-quit", text: tr("Quit to title"), act: quitToTitle }, w);
  }, resumeGame);
}
function check(key: "captions" | "leftHanded" | "haptics" | "boardMirror" | "confirmRelease", label: string): void {
  const cur = !!settings[key];
  const next = ui.id(`set-${key}`).checkbox(label, cur);
  if (next !== cur) platform.setSetting(key, next);
}
function section(id: string, title: string, w: number, build: () => void): void {
  ui.column(id, () => { heading("h3", title, w); build(); }, { style: "setsec", width: w, spacing: 6 });
}
function selectRow(id: string, label: string, w: number, index: number, options: (string | ui.SelectOption)[], set: (i: number) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, Math.max(80, w * 0.4), "body");
    ui.spacer();
    const next = ui.id(id).select(label, index, options);
    if (next !== index) set(next);
  }, { width: w, align: "center", spacing: 10 });
}
function settingsDialog(L: Layout): void {
  dialogFrame("overlay-settings", L, 560, (w) => {
    heading("h2", tr("Settings"), w, "settings-title");
    section("set-audio", tr("Audio"), w, () => {
      para(tr("Music, effects and voice volumes and mute are set in the StarHermit Options (F1)."), w, "note");
      button({ id: "btn-options-audio", text: tr("Open Options"), act: () => openMenu() });
      check("captions", tr("Captions"));
    });
    section("set-graphics", tr("Graphics"), w, () => {
      const ids = C.THEMES.map((t) => t.id);
      const opts = C.THEMES.map((t) => {
        const locked = !unlockedTheme(t.id);
        return { text: locked ? tr("{name} 🔒", { name: tr(t.name) }) : tr(t.name), disabled: locked };
      });
      selectRow("set-theme", tr("Theme"), w, Math.max(0, ids.indexOf(settings.theme)), opts, (i) => setTheme(ids[i]!));
      para(tr("Graphics quality, render scale and the frame rate are set in the StarHermit Options (F1)."), w, "note");
    });
    section("set-a11y", tr("Accessibility"), w, () => {
      const pal = ["standard", "high-visibility"];
      selectRow("set-palette", tr("Color palette"), w, Math.max(0, pal.indexOf(settings.colorPalette)), [tr("Standard"), tr("High visibility")], (i) => platform.setSetting("colorPalette", pal[i]!));
      check("leftHanded", tr("Left-handed controls"));
      check("haptics", tr("Haptics"));
      check("boardMirror", tr("Always-on board state panel"));
      check("confirmRelease", tr("Confirm before release"));
      para(tr("Reduced motion, high contrast and text size are set in the StarHermit Options (F1)."), w, "note");
    });
    section("set-controls", tr("Controls"), w, () => {
      para(tr("Drag to draw. Keyboard: arrows move the pen, Space draws, R release, U undo, H hint, S skip, P pause."), w, "note");
      button({ id: "btn-rebind", text: tr("Change keys and buttons"), act: () => requestRebind() });
    });
  }, () => closeOverlay(), (w) => flow("settings-buttons", [
    { id: "btn-settings-done", text: tr("Done"), style: ["btn", "btn-primary"], act: () => closeOverlay("settings") },
    { id: "btn-reset", text: tr("Reset save data"), style: ["btn", "btn-danger"], act: () => openOverlay("reset", "btn-reset-cancel") },
  ], w));
}
function resetDialog(L: Layout): void {
  dialogFrame("overlay-reset", L, 420, (w) => {
    heading("h2", tr("Reset save data"), w, "reset-title");
    para(tr("Erase all local progress and settings?"), w, "body", "reset-text");
    flow("reset-buttons", [
      { id: "btn-reset-yes", text: tr("Reset save data"), style: ["btn", "btn-danger"], act: () => { app.overlays = []; resetSave(); } },
      { id: "btn-reset-cancel", text: tr("Cancel"), act: () => closeOverlay("reset") },
    ], w);
  });
}
function resultsDialog(L: Layout): void {
  const r = app.results;
  const s = sess;
  if (!r || !s) { closeOverlay(); return; }
  const st = s.state;
  dialogFrame("overlay-results", L, 560, (w) => {
    heading("h2", r.headline(), w, "results-headline");
    const artH = Math.min(L.lh * (L.shortLand ? 0.14 : 0.22), w * 0.36);
    art("results-art", r.won ? resultArt.saved : resultArt.hit, w, artH, "result-art");
    ui.column("results-stars-row", () => ui.style("big-stars").id("results-stars").label(stars(r.stars), { tooltip: tr("{n} stars", { n: r.stars }) }), { width: w, align: "center" });
    const rows: [string, number][] = [
      [tr("Survival"), st.score.survival], [tr("Endurance"), st.score.endurance], [tr("Blocks"), st.score.blocks],
      [tr("Clearance"), st.score.clearance], [tr("Ink bonus"), st.score.ink],
    ];
    ui.column("results-table", () => {
      rows.forEach(([k, v], i) => ui.row(`score-${i}`, () => { ui.style("score-cell").label(k); ui.spacer(); ui.style("score-cell").label(String(v)); }, { style: "score-row", width: w, align: "center" }));
      ui.row("score-total", () => { ui.style("score-strong").label(tr("Total")); ui.spacer(); ui.style("score-strong").id("results-total").label(String(st.score.total)); }, { style: "score-total", width: w, align: "center" });
    }, { width: w, spacing: 0 });
    if (s.cfg.par) para(tr("Par ★★ {two} · ★★★ {three}", { two: s.cfg.par.score2, three: s.cfg.par.score3 }), w, "note");
    if (r.best != null) para(tr(r.isNewBest ? "New personal best! {best}" : "Personal best: {best}", { best: r.best }), w, "note", "results-best");
    for (const a of s.newAchievements) para("• " + tr("🏅 {name} — {desc}", { name: tr(a.name), desc: tr(a.desc) }), w, "body", `ach-${a.key}`);
    if (r.entries && r.entries.length) {
      heading("h3", r.boardLabel ? tr("Leaderboard ({board})", { board: r.boardLabel() }) : tr("Leaderboard"), w);
      r.entries.slice(0, 10).forEach((e, i) => para(`${i + 1}. ${e.name} — ${e.score}${e.won ? " ✓" : ""}`, w, e.self ? "board-self" : "body", `board-${i}`));
    } else if (s.ranked) para(tr("Board: {board}", { board: r.boardLabel ? r.boardLabel() : tr("casual (unvalidated)") }), w, "note");
    if (app.lb) para(app.lb.state === "lbRank" ? pt("lbRank", { rank: app.lb.rank ?? "" }) : pt(app.lb.state), w, "note", "results-lb");
  }, null, (w) => {
    const btns: Btn[] = [{ id: "btn-results-retry", text: tr("Retry"), act: restartLevel }];
    if (r.canNext) btns.push({ id: "btn-results-next", text: tr("Next level"), style: ["btn", "btn-primary"], act: nextLevel });
    if (s.mode === "storm" || s.mode === "daily") btns.push({ id: "btn-copy-seed", text: tr("Copy seed"), act: copySeed });
    btns.push({ id: "btn-results-back", text: tr("Back"), act: toTitle });
    flow("results-buttons", btns, w);
  });
}
function helpDialog(L: Layout): void {
  dialogFrame("overlay-help", L, 640, (w) => {
    heading("h2", tr("How to play"), w, "help-title");
    const cols = w >= 420 ? 2 : 1;
    const cw = (w - 10 * (cols - 1)) / cols;
    const cards: [string, string][] = [
      [tr("Draw"), tr("Drag on the page to sketch ink barriers. Ink is limited — the gauge shows what is left.")],
      [tr("Release"), tr("When your defenses are ready, press Release. The storm plays out and the wisps must stay untouched.")],
      [tr("Ink"), tr("Shorter barriers leave unspent ink, which becomes bonus points when you win.")],
      [tr("Scoring"), tr("Score = survival + endurance + blocks + clearance + ink bonus. Beat par marks for ★★ and ★★★.")],
    ];
    for (let i = 0; i < cards.length; i += cols) {
      ui.row(`help-r${i}`, () => {
        cards.slice(i, i + cols).forEach(([t, x], j) => ui.column(`help-card-${i + j}`, () => { heading("h4", t, cw - 26); para(x, cw - 26, "help-text"); }, { style: "help-card", width: cw, spacing: 4 }));
      }, { spacing: 10, align: "stretch" });
    }
    heading("h3", tr("Hazards"), w);
    legend("help-legend", Object.keys(C.HAZARDS) as HazardType[], w);
    heading("h3", tr("Keyboard & gamepad"), w);
    const k = (a: string): string => bindingLabel(a, "keyboard");
    const g = (a: string): string => bindingLabel(a, "gamepad");
    const or = (list: string[]): string => list.filter(Boolean).reduce((acc, n) => (acc ? tr("{a} or {b}", { a: acc, b: n }) : n), "");
    const rows: [string, string][] = [
      [[k("pen_left"), k("pen_right"), k("pen_up"), k("pen_down")].join(" "), tr("Move the pen")],
      [tr("{keys} + move", { keys: k("pen_fast") }), tr("Move the pen faster")],
      [k("pen_toggle"), tr("Pen down / pen up (draw)")],
      [k("release"), tr("Release the storm")],
      [k("undo"), tr("Undo last stroke")],
      [k("hint"), tr("Hint")],
      [k("skip"), tr("Skip storm playback")],
      [or([k("pause"), bindingLabel("pause", "keyboard") === "Escape" ? "" : tr("Escape")]), tr("Pause / resume")],
      [tr("Enter"), tr("Confirm default button")],
      [k("camera"), tr("Reset camera framing")],
      [tr("Gamepad dpad/stick"), tr("Move the pen")],
      [[g("pen_toggle"), g("release"), g("pause")].join(" / "), tr("Draw or confirm / cancel / pause")],
    ];
    const kw = Math.min(200, w * 0.42);
    rows.forEach(([a, b], i) => ui.row(`bind-${i}`, () => { para(a, kw, "bind-key"); para(b, w - kw - 12, "bind-act"); }, { spacing: 12, width: w }));
  }, () => closeOverlay(), (w) => flow("help-buttons", [{ id: "btn-help-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("help") }], w));
}
function scoresDialog(L: Layout): void {
  dialogFrame("overlay-scores", L, 560, (w) => {
    heading("h2", tr("Scores"), w, "scores-title");
    ui.row("scores-tabs", () => {
      for (const t of ["global", "device"] as const) {
        const text = t === "global" ? tr("Global") : tr("This device");
        if (ui.style("btn", app.scoresTab === t && "btn-sel").id(`tab-${t}`).button(text, { selected: app.scoresTab === t }) && app.scoresTab !== t) {
          app.scoresTab = t;
          refreshScores();
        }
      }
    }, { spacing: 10, role: "radiogroup" });
    const boards = scoreBoards();
    const idx = Math.max(0, boards.findIndex((b) => b.id === app.scoresBoard));
    selectRow("scores-board", tr("Board"), w, idx, boards.map((b) => b.label()), (i) => { app.scoresBoard = boards[i]!.id; refreshScores(); });
    const rows = app.scoresRows;
    if (rows && rows.length) rows.slice(0, 20).forEach((e, i) => para(`${i + 1}. ${e.name} — ${e.score}${e.won ? " ✓" : ""}`, w, e.self ? "board-self" : "body", `scores-${i}`));
    else if (app.scoresState === "done") para(app.scoresTab === "device" ? tr("No local entries for this board yet.") : tr("No scores on this device for this board yet."), w, "note", "scores-empty");
  }, () => closeOverlay(), (w) => flow("scores-buttons", [{ id: "btn-scores-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("scores") }], w));
}

// ------------------------------------------------------------------ toasts and captions
function toasts(L: Layout): void {
  const modal = modalOpen();
  const playing = !!sess && app.phase !== "title" && !modal;
  const w = Math.min(L.lw * 0.8, 520);
  // in play the caption strip and the toasts sit above the tray, never over its buttons
  const base = playing && !L.shortLand ? (lastHeight.get("tray") ?? 70) + 14 : 8;
  let capH = 0;
  if (app.caption) {
    const text = tr(app.caption.text);
    const r = ui.place("captions", { anchor: "bottom", y: base }, () => ui.style("captions").id("caption-text").label(text));
    capH = r.height / L.sc + 8;
  }
  if (!app.toasts.length) return;
  const body = (): void => {
    app.toasts.forEach((t, i) => {
      const text = t.text();
      if (textWidth(text, "toast") + 34 <= w) ui.style("toast").id(`toast-${i}`).label(text);
      else ui.style("toast").id(`toast-${i}`).paragraph(text, w - 34);
    });
  };
  // While a dialog is open the toasts sit at the top edge so they never cover its buttons.
  if (modal) ui.place("toasts", { anchor: "top", y: 8 }, body, { spacing: 6, align: "center", width: w });
  else ui.place("toasts", { anchor: "bottom", y: base + capH + (playing ? 6 : 16) }, body, { spacing: 6, align: "center", width: w });
}
