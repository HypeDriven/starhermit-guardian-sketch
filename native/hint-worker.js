// The hint search (js/rules.js hint: ~20 candidate shields run through the
// real rules, then every ordered pair) off the game's thread
// (starhermit:script worker, a module): natively it can take longer than a
// frame may run, so the page keeps drawing meanwhile. The rules are the
// browser build's js/rng.js and js/rules.js unchanged.
// Message in:  { id, state }   Message out: { id, hint } (null: none).
import "../js/rng.js";
import "../js/rules.js";

globalThis.onmessage = (e) => {
  const d = e.data;
  let hint = null;
  try { hint = globalThis.GSRules.hint(d.state); } catch (err) { hint = null; }
  postMessage({ id: d.id, hint: hint ? JSON.parse(JSON.stringify(hint)) : null });
};
