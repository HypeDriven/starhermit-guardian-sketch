// The hint on a worker (native/hint-worker.js) so a long search never stalls
// a frame; without a worker (it failed to start) the search runs on the
// game's thread as the browser build's did.
import { worker, type Worker } from "starhermit:script";
import { Rules, type Hint, type State } from "./classic.ts";

let w: Worker | null = null;
let failed = false;
let nextId = 1;
const waiting = new Map<number, (h: Hint | null) => void>();

function ensure(): Worker | null {
  if (w || failed) return w;
  try {
    w = worker("native/hint-worker.js", { type: "module" });
    w.on("message", (m) => {
      const r = m as unknown as { id: number; hint: Hint | null };
      const job = waiting.get(r.id);
      if (!job) return;
      waiting.delete(r.id);
      job(r.hint);
    });
    // A long search reports "not responding" but goes on: the answer still comes.
    w.on("error", (msg) => { if (!/not responding/i.test(msg)) console.warn(`hint worker: ${msg}`); });
    w.on("stopped", () => {
      failed = true; w = null;
      for (const [id, job] of waiting) { waiting.delete(id); job(undefined as unknown as null); }
    });
  } catch (e) { console.warn(`hint worker: ${String(e)}`); failed = true; w = null; }
  return w;
}
/** Starts the worker ahead of the first request (its module loads meanwhile). */
export function warm(): void { ensure(); }

/** Asks for a hint for `state`; `done` hears it (null: none). Returns a cancel. */
export function request(state: State, done: (h: Hint | null) => void): () => void {
  const sync = (): void => { let h: Hint | null = null; try { h = Rules.hint(state); } catch { h = null; } done(h); };
  const wk = ensure();
  if (!wk) { sync(); return () => undefined; }
  const id = nextId++;
  let cancelled = false;
  // undefined: the worker stopped before answering, so search here instead.
  waiting.set(id, (h) => { if (cancelled) return; if (h === undefined) sync(); else done(h); });
  try {
    const plain = JSON.parse(JSON.stringify({ ...state, trace: null, events: [] }));
    wk.post({ id, state: plain });
  } catch (e) { waiting.delete(id); console.warn(`hint worker: ${String(e)}`); sync(); }
  return () => { cancelled = true; waiting.delete(id); };
}
