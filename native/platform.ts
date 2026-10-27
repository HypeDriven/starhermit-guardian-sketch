// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (lessons, journey stars and best scores, challenge bests,
//   dailies, achievements, lifetime stats) is the game's save
//   (starhermit:storage `saves`): { v: 1, progress } on the device and in
//   the player's cloud slot, two devices' copies merged on a conflict
//   (js/store.js mergeProgress keeps the better of both). The slot the
//   browser build wrote (the JS SDK's zipped save.json holding its
//   { v, settings, progress } document) shows as foreign and is merged in
//   and replaced once;
// - the device's local leaderboard stays on the device (js/store.js through
//   the localStorage shim, classic.ts), as the browser build kept it;
// - the game's own settings (page theme, colour palette, sound captions,
//   left-handed tray, haptics, the always-on board state panel, confirm
//   before release) are `settings` (game.<key>, synced with the account);
//   the browser build's settings (in its save and in the account's
//   per-player settings) are migrated, then removed. Volumes, mute,
//   graphics, reduced motion, high contrast and text size are the
//   runtime's Options;
// - the player's name, the invite link, the high-score board's rows and
//   posting a finished round's score through score-script.js (a practice
//   session whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did; score-script.js range-checks it and writes the board),
//   and the platform's clock for the daily's date.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, serverNow, serverTime, sessions,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { Store as S, type Doc } from "./classic.ts";
import { tr } from "./i18n.ts";

// --- the save ------------------------------------------------------------------------------
let doc: Doc = { v: 1, progress: S.defaultProgress() };
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

export function getDoc(): Doc { return doc; }
/** Writes the save (device at once, the account debounced by the runtime). */
export function persist(): void {
  try { saves.save(doc as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}

/** Takes another document's progress in (merged with this device's); whether it changed. */
function adopt(other: Doc | null): boolean {
  if (!other) return false;
  const before = JSON.stringify(doc.progress);
  const next = S.mergeProgress(other.progress, doc.progress);
  if (JSON.stringify(next) === before) return false;
  doc = { v: 1, progress: next };
  return true;
}

saves.onConflict((local, remote) => {
  const a = S.docFromSave(local?.data), b = S.docFromSave(remote.data);
  // The best of both devices' records; this device's cosmetics.
  const progress = S.mergeProgress(b ? b.progress : S.defaultProgress(), a ? a.progress : S.defaultProgress());
  return { merged: { v: 1, progress } as unknown as JsonValue };
});
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(S.docFromSave(cur.data))) { persist(); merged(); }
  }
});

/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const { doc: d, settings: s } = S.fromBrowserSave(old.text);
  const changed = adopt(d);
  if (s) for (const [k, v] of Object.entries(s)) adoptSetting(k, v);
  try { saves.save(doc as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}
export function flush(): void { void saves.flush().catch(() => undefined); }
/** Settings › Reset save data: a fresh save (device and account). */
export function resetProgress(): void {
  doc = { v: 1, progress: S.defaultProgress() };
  persist();
}
/** The cloud save's state for the title's sync line. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  try {
    const st = saves.status();
    if (st === "saved-to-account") return "synced";
    if (st === "pending") return "saving";
    return st === "session-only" ? "offline" : "error";
  } catch { return "error"; }
}

// --- the game's settings -------------------------------------------------------------------
export interface Settings {
  theme: string; colorPalette: string; captions: boolean; leftHanded: boolean; haptics: boolean;
  boardMirror: boolean; confirmRelease: boolean; [key: string]: unknown;
}
export const settings: Settings = {
  theme: "graphite", colorPalette: "standard", captions: false, leftHanded: false, haptics: true, boardMirror: false, confirmRelease: false,
};
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = S.checkSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: string, value: unknown): void {
  const v = S.checkSetting(key, value);
  if (v === undefined || store.get(key) !== undefined) return;
  try { store.set(key, v as JsonValue); settings[key] = v; settingsChanged(); } catch { /* keep the device's */ }
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: keyof Settings & string, value: boolean | string): void {
  settings[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings keys: the game's options among
// them carry over (unless this game set them since), then all are removed.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) {
    if (!S.BROWSER_SETTING_KEYS.includes(key)) continue;
    if (S.GAME_SETTING_KEYS.includes(key)) adoptSetting(key, store.legacy(key));
    store.removeLegacy(key);
  }
}

/** Reads the device's save and the game's settings (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const d = S.docFromSave(cur?.data);
  if (d) doc = d;
  else if (!cur) persist();
  for (const k of S.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!S.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player ----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  void highScoreBoard().catch(() => null);
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number { return serverNow() ?? Date.now(); }

// --- the StarHermit leaderboards -----------------------------------------------------------
const BOARD_KEY = "guardiansketch.board-id";
let boardId: string | null = null;
/** The high-score board's id: listed signed in, then kept on the device so a guest can read it. */
async function highScoreBoard(): Promise<string | null> {
  if (boardId) return boardId;
  if (player()) {
    try {
      const list = await leaderboards.list();
      const b = list.find((x) => x.key === "high-score") ?? list[0];
      if (b) { boardId = b.id; try { storage.set(BOARD_KEY, b.id); } catch { /* full */ } }
    } catch { /* offline */ }
  }
  if (!boardId) { try { boardId = storage.getText(BOARD_KEY); } catch { boardId = null; } }
  return boardId;
}
export interface BoardRow { rank: number | null; name: string; score: number; mine: boolean }
/** The high-score board's top 20 (names from the players' profiles); ok false when it cannot be read. */
export async function fetchLeaderboard(): Promise<{ ok: boolean; entries: BoardRow[] }> {
  const me = player();
  try {
    const id = await highScoreBoard();
    if (!id) return { ok: false, entries: [] };
    const page = await leaderboards.entries(id, { pageSize: 20 });
    const entries = await Promise.all(page.items.map(async (e) => {
      let name = e.username || tr("Player {id}", { id: e.userId.slice(0, 6) });
      if (me && e.userId === me.userId) name = tr("You ({name})", { name: me.displayName });
      else { try { name = (await profile(e.userId)).displayName; } catch { /* the username */ } }
      return { rank: e.rank ?? null, name, score: Math.floor(Number(e.score) || 0), mine: !!me && e.userId === me.userId };
    }));
    return { ok: true, entries };
  } catch { return { ok: false, entries: [] }; }
}

/** Signed in only: post a finished round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const id = await highScoreBoard();
    if (!id) return { posted: true, rank: null };
    const r = await leaderboards.entries(id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
