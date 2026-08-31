/* Guardian Sketch — pure deterministic rules engine.
 * No rendering, no DOM, no Date.now(): every transition derives from
 * (state, command) only. Usable from browser (window.GSRules) and Node.
 *
 * Core loop: inspect the hazard emitters, draw ink barriers within a
 * budget, then release the storm. The whole hazard simulation resolves
 * deterministically at release (fixed 60 Hz step, quantized inputs);
 * rendering later replays the recorded trace for cosmetics. The little
 * ink creature(s) must stay untouched for the full hazard timer.
 *
 * Physics notes: 2D page plane, +y up, floor at y=0. Only IEEE-754
 * primitives whose results ECMAScript pins down exactly (+ - * / and
 * the correctly-rounded Math.sqrt) are used, so replays agree across
 * engines. No Math.sin/cos/atan2 anywhere in this file.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.GSRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GSRules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var STATE_VERSION = 1;
  var DT = 1 / 60;            // fixed simulation step (seconds)
  var TRACE_SAMPLE = 2;       // record a trace frame every N ticks
  var MAX_POINTS = 160;       // per stroke
  var MIN_SEG = 2;            // min distance between consecutive stroke points
  var MIN_STROKE = 10;        // min total stroke length (units)
  var BOUNDS_PAD = 24;        // strokes may touch slightly outside the page
  var DESPAWN_MARGIN = 90;    // hazards leaving the page by this much vanish

  var SURVIVE_BASE = 500;     // win: kept every creature safe
  var ENDURANCE_PT = 1;       // per survived tick
  var BLOCK_PT = 40;          // per hazard that touched a barrier
  var INK_PT = 2;             // win: per unspent ink unit
  var CLEARANCE_CAP = 300;    // win: cap on the clearance bonus

  var TERMINAL = {
    SURVIVED: 'survived',
    HIT: 'creature-hit',
    RESIGN: 'resigned'
  };

  var INVALID = {
    ENDED: 'game-ended',
    BAD_CMD: 'unknown-command',
    BAD_SHAPE: 'malformed-command',
    PHASE: 'wrong-phase',
    BOUNDS: 'out-of-bounds',
    TOO_SHORT: 'stroke-too-short',
    TOO_MANY_POINTS: 'too-many-points',
    STROKE_LIMIT: 'stroke-limit',
    INK: 'ink-exhausted'
  };

  // ---------- helpers ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Stable stringify: object keys sorted recursively → canonical hashing.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var out = '[';
      for (var i = 0; i < v.length; i++) out += (i ? ',' : '') + stableStringify(v[i]);
      return out + ']';
    }
    var keys = Object.keys(v).sort(), s = '{';
    for (var k = 0; k < keys.length; k++) {
      s += (k ? ',' : '') + JSON.stringify(keys[k]) + ':' + stableStringify(v[keys[k]]);
    }
    return s + '}';
  }

  function hashState(state) {
    var copy = clone(state);
    delete copy.events;
    delete copy.trace;
    return RNG.hashString(stableStringify(copy));
  }

  function polyLength(pts) {
    var len = 0;
    for (var i = 1; i < pts.length; i++) {
      var dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      len += Math.sqrt(dx * dx + dy * dy);
    }
    return len;
  }

  // ---------- config normalization ----------

  // cfg: { id, version, kind, name, seed,
  //   world:{w,h,gravity}, creatures:[{x,y,r}],
  //   obstacles:[{x1,y1,x2,y2,th}], emitters:[{x,y,dx,dy,speed,r,start,
  //   every,count,grav,rest,type}], ink:{budget,maxStrokes,thickness},
  //   simTicks, par:{score2,score3}, mechanics:{undo,hint}, theme, intro }
  function normalizeCfg(cfg) {
    if (!cfg || typeof cfg !== 'object') throw new Error('bad cfg');
    var c = clone(cfg);
    c.world = Object.assign({ w: 1000, h: 700, gravity: 1400 }, c.world || {});
    if (!Array.isArray(c.creatures) || !c.creatures.length) throw new Error('cfg needs creatures');
    c.creatures.forEach(function (cr) {
      if (!isFinite(cr.x) || !isFinite(cr.y) || !(cr.r > 0)) throw new Error('bad creature');
    });
    c.obstacles = (c.obstacles || []).map(function (o) {
      return { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, th: o.th || 16 };
    });
    if (!Array.isArray(c.emitters)) c.emitters = [];
    c.emitters.forEach(function (e) {
      var len = Math.sqrt(e.dx * e.dx + e.dy * e.dy);
      if (len > 0) { e.dx = e.dx / len; e.dy = e.dy / len; }
      else { e.dx = 0; e.dy = -1; }
      e.speed = e.speed == null ? 0 : e.speed;
      e.r = e.r || 15;
      e.start = e.start || 0;
      e.every = Math.max(1, e.every || 30);
      e.count = Math.max(1, e.count || 1);
      e.grav = e.grav == null ? 1 : e.grav;
      e.rest = e.rest == null ? 0.2 : e.rest;
      e.type = e.type || 'drop';
    });
    c.ink = Object.assign({ budget: 600, maxStrokes: 4, thickness: 12 }, c.ink || {});
    c.simTicks = Math.max(60, Math.min(1800, c.simTicks || 360));
    c.mechanics = Object.assign({ undo: true, hint: true }, c.mechanics || {});
    return c;
  }

  // ---------- game creation ----------

  function createGame(cfg) {
    var c = normalizeCfg(cfg);
    return {
      v: STATE_VERSION,
      cfg: c,
      seed: (c.seed >>> 0) || 0,
      tick: 0,                 // monotonic command counter
      phase: 'draw',           // draw → done
      strokes: [],             // [{pts:[[x,y]..], len}]
      inkUsed: 0,
      elapsedDrawMs: 0,
      sim: null,               // {survivedTicks, blocked, minClear, hitCreature}
      trace: null,             // cosmetic replay data (excluded from hash)
      score: { survival: 0, endurance: 0, blocks: 0, clearance: 0, ink: 0, total: 0 },
      terminal: null,
      events: []
    };
  }

  // ---------- legality ----------

  function inkRemaining(state) {
    return Math.max(0, state.cfg.ink.budget - state.inkUsed);
  }

  // Sanitize a proposed stroke: quantize to ints, drop tiny segments.
  // Returns {pts, len} or a reason string.
  function sanitizeStroke(state, points) {
    if (!Array.isArray(points)) return INVALID.BAD_SHAPE;
    if (points.length > MAX_POINTS) return INVALID.TOO_MANY_POINTS;
    var w = state.cfg.world.w, h = state.cfg.world.h;
    var pts = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!Array.isArray(p) || p.length < 2 || !isFinite(p[0]) || !isFinite(p[1])) return INVALID.BAD_SHAPE;
      var x = Math.round(p[0]), y = Math.round(p[1]);
      if (x < -BOUNDS_PAD || x > w + BOUNDS_PAD || y < -BOUNDS_PAD || y > h + BOUNDS_PAD) return INVALID.BOUNDS;
      if (pts.length) {
        var dx = x - pts[pts.length - 1][0], dy = y - pts[pts.length - 1][1];
        if (dx * dx + dy * dy < MIN_SEG * MIN_SEG) continue; // dedupe jitter
      }
      pts.push([x, y]);
    }
    if (pts.length < 2) return INVALID.TOO_SHORT;
    var len = polyLength(pts);
    if (len < MIN_STROKE) return INVALID.TOO_SHORT;
    return { pts: pts, len: Math.round(len) };
  }

  function checkStroke(state, points) {
    if (state.terminal) return INVALID.ENDED;
    if (state.phase !== 'draw') return INVALID.PHASE;
    var s = sanitizeStroke(state, points);
    if (typeof s === 'string') return s;
    if (state.strokes.length >= state.cfg.ink.maxStrokes) return INVALID.STROKE_LIMIT;
    if (s.len > inkRemaining(state)) return INVALID.INK;
    return null;
  }

  function legalActions(state) {
    if (state.terminal || state.phase !== 'draw') return [];
    var out = [{ type: 'release' }, { type: 'resign' }];
    if (state.strokes.length < state.cfg.ink.maxStrokes && inkRemaining(state) >= MIN_STROKE) {
      out.push({ type: 'stroke', inkRemaining: inkRemaining(state), strokesRemaining: state.cfg.ink.maxStrokes - state.strokes.length });
    }
    return out;
  }

  // ---------- simulation ----------

  // Collect the static collision segments (obstacles first, then strokes,
  // in stable order). Stroke thickness comes from the ink config.
  function collectSegments(state) {
    var segs = [];
    state.cfg.obstacles.forEach(function (o) {
      segs.push({ x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, rad: o.th / 2, barrier: false });
    });
    var r = state.cfg.ink.thickness / 2;
    state.strokes.forEach(function (st) {
      for (var i = 1; i < st.pts.length; i++) {
        segs.push({
          x1: st.pts[i - 1][0], y1: st.pts[i - 1][1],
          x2: st.pts[i][0], y2: st.pts[i][1], rad: r, barrier: true
        });
      }
    });
    return segs;
  }

  // Circle (hazard h) vs segment; pushes out and reflects. Returns the
  // segment on contact, else null. Deterministic: sqrt is correctly rounded.
  function collideSeg(h, seg) {
    var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
    var len2 = dx * dx + dy * dy;
    var t = 0;
    if (len2 > 0) {
      t = ((h.x - seg.x1) * dx + (h.y - seg.y1) * dy) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    var px = seg.x1 + t * dx, py = seg.y1 + t * dy;
    var ox = h.x - px, oy = h.y - py;
    var R = h.r + seg.rad;
    var d2 = ox * ox + oy * oy;
    if (d2 >= R * R) return null;
    var d = Math.sqrt(d2);
    var nx, ny;
    if (d > 1e-9) { nx = ox / d; ny = oy / d; }
    else { nx = 0; ny = 1; }
    h.x = px + nx * R;
    h.y = py + ny * R;
    var vn = h.vx * nx + h.vy * ny;
    if (vn < 0) {
      var k = (1 + h.rest) * vn;
      h.vx -= k * nx;
      h.vy -= k * ny;
      // tangential friction
      h.vx *= 0.995;
      h.vy *= 0.995;
    }
    return seg;
  }

  // Run the whole hazard timer. Mutates nothing in `state`; returns
  // {sim, trace, events}. Fully determined by state.cfg + state.strokes.
  function runSimulation(state) {
    var cfg = state.cfg;
    var W = cfg.world.w, H = cfg.world.h, G = cfg.world.gravity;
    var segs = collectSegments(state);
    var hazards = [];
    var spawned = cfg.emitters.map(function () { return 0; });
    var nextId = 1;
    var blockedCount = 0;
    var minClear = Infinity;
    var hit = null; // {tick, creature}
    var events = [];
    var frames = [];
    var tick = 0;
    var survivedTicks = cfg.simTicks;

    for (tick = 0; tick < cfg.simTicks; tick++) {
      // 1) spawns (emitter order is stable)
      for (var e = 0; e < cfg.emitters.length; e++) {
        var em = cfg.emitters[e];
        if (spawned[e] < em.count && tick >= em.start && (tick - em.start) % em.every === 0) {
          spawned[e]++;
          var hz = {
            id: nextId++, x: em.x, y: em.y,
            vx: em.dx * em.speed, vy: em.dy * em.speed,
            r: em.r, rest: em.rest, grav: em.grav, type: em.type,
            alive: true, blocked: false
          };
          hazards.push(hz);
          events.push({ type: 'spawn', tick: tick, id: hz.id, hazard: em.type, x: em.x, y: em.y, r: em.r });
        }
      }
      // 2) integrate + collide (spawn order is stable)
      for (var i = 0; i < hazards.length; i++) {
        var z = hazards[i];
        if (!z.alive) continue;
        z.vy -= G * z.grav * DT;
        z.x += z.vx * DT;
        z.y += z.vy * DT;
        // static segments
        for (var s = 0; s < segs.length; s++) {
          var seg = collideSeg(z, segs[s]);
          if (seg) {
            if (seg.barrier && !z.blocked) {
              z.blocked = true;
              blockedCount++;
              events.push({ type: 'block', tick: tick, id: z.id });
            } else if (!seg.barrier) {
              events.push({ type: 'bounce', tick: tick, id: z.id });
            }
          }
        }
        // floor + side walls (top stays open)
        if (z.y - z.r < 0) {
          z.y = z.r;
          if (z.vy < 0) { z.vy = -z.vy * z.rest * 0.6; z.vx *= 0.98; }
        }
        if (z.x - z.r < 0) { z.x = z.r; if (z.vx < 0) z.vx = -z.vx * z.rest; }
        if (z.x + z.r > W) { z.x = W - z.r; if (z.vx > 0) z.vx = -z.vx * z.rest; }
        // despawn far outside (e.g. popped over the open top)
        if (z.y - z.r > H + DESPAWN_MARGIN) { z.alive = false; continue; }
        // creatures
        for (var c = 0; c < cfg.creatures.length; c++) {
          var cr = cfg.creatures[c];
          var cdx = z.x - cr.x, cdy = z.y - cr.y;
          var rr = z.r + cr.r;
          var cd2 = cdx * cdx + cdy * cdy;
          var clear = Math.sqrt(cd2) - rr;
          if (clear < minClear) minClear = clear;
          if (cd2 < rr * rr) {
            hit = { tick: tick, creature: c, hazard: z.id };
            events.push({ type: 'hit', tick: tick, creature: c, id: z.id });
            break;
          }
        }
        if (hit) break;
      }
      if (hit) { survivedTicks = tick; break; }
      // 3) cosmetic trace frame
      if (tick % TRACE_SAMPLE === 0) {
        var f = [];
        for (var j = 0; j < hazards.length; j++) {
          var q = hazards[j];
          if (q.alive) f.push([q.id, Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]);
        }
        frames.push(f);
      }
    }

    var sim = {
      survivedTicks: survivedTicks,
      blocked: blockedCount,
      minClear: minClear === Infinity ? cfg.world.w : Math.max(0, Math.round(minClear)),
      hitCreature: hit ? hit.creature : null
    };
    var trace = {
      sample: TRACE_SAMPLE,
      ticks: cfg.simTicks,
      frames: frames,
      spawns: events.filter(function (ev) { return ev.type === 'spawn'; }),
      hitTick: hit ? hit.tick : null
    };
    return { sim: sim, trace: trace, events: events };
  }

  // ---------- resolution ----------

  function applyCommand(state, cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
      return { ok: false, reason: INVALID.BAD_SHAPE, state: state, events: [] };
    }

    if (cmd.type === 'resign') {
      if (state.terminal) return { ok: false, reason: INVALID.ENDED, state: state, events: [] };
      var rs = clone(state);
      rs.trace = null;
      rs.events = [];
      rs.tick++;
      rs.phase = 'done';
      rs.terminal = { reason: TERMINAL.RESIGN, won: false };
      rs.events.push({ type: 'lose', reason: TERMINAL.RESIGN });
      finalizeScore(rs);
      return { ok: true, state: rs, events: rs.events };
    }

    if (cmd.type === 'stroke') {
      var reason = checkStroke(state, cmd.points);
      if (reason) return { ok: false, reason: reason, state: state, events: [] };
      var s = clone(state);
      s.trace = null;
      s.events = [];
      s.tick++;
      var clean = sanitizeStroke(s, cmd.points);
      s.strokes.push({ pts: clean.pts, len: clean.len });
      s.inkUsed += clean.len;
      if (typeof cmd.atMs === 'number' && isFinite(cmd.atMs) && cmd.atMs >= 0) {
        s.elapsedDrawMs = Math.floor(cmd.atMs / 100) * 100; // quantized, replay-safe
      }
      s.events.push({ type: 'stroke', len: clean.len, remaining: inkRemaining(s), strokes: s.strokes.length });
      return { ok: true, state: s, events: s.events };
    }

    if (cmd.type === 'release') {
      if (state.terminal) return { ok: false, reason: INVALID.ENDED, state: state, events: [] };
      if (state.phase !== 'draw') return { ok: false, reason: INVALID.PHASE, state: state, events: [] };
      var r = clone(state);
      r.events = [];
      r.tick++;
      if (typeof cmd.atMs === 'number' && isFinite(cmd.atMs) && cmd.atMs >= 0) {
        r.elapsedDrawMs = Math.floor(cmd.atMs / 100) * 100;
      }
      r.phase = 'done';
      var outcome = runSimulation(r);
      r.sim = outcome.sim;
      r.trace = outcome.trace;
      var won = outcome.sim.hitCreature == null;
      r.terminal = won
        ? { reason: TERMINAL.SURVIVED, won: true }
        : { reason: TERMINAL.HIT, won: false };
      // Fold sim events into the command events (spawn/block/hit then result).
      r.events = outcome.events.concat([won
        ? { type: 'win', reason: TERMINAL.SURVIVED }
        : { type: 'lose', reason: TERMINAL.HIT }]);
      finalizeScore(r);
      return { ok: true, state: r, events: r.events };
    }

    return { ok: false, reason: INVALID.BAD_CMD, state: state, events: [] };
  }

  function finalizeScore(s) {
    var sc = s.score;
    var won = !!(s.terminal && s.terminal.won);
    if (s.terminal && s.terminal.reason === TERMINAL.RESIGN) {
      sc.survival = sc.endurance = sc.blocks = sc.clearance = sc.ink = sc.total = 0;
      return;
    }
    var sim = s.sim || { survivedTicks: 0, blocked: 0, minClear: 0 };
    sc.endurance = sim.survivedTicks * ENDURANCE_PT;
    sc.blocks = sim.blocked * BLOCK_PT;
    sc.survival = won ? SURVIVE_BASE : 0;
    sc.clearance = won ? Math.min(CLEARANCE_CAP, sim.minClear) : 0;
    sc.ink = won ? inkRemaining(s) * INK_PT : 0;
    sc.total = sc.survival + sc.endurance + sc.blocks + sc.clearance + sc.ink;
  }

  // Stars from the finalized score: 1 for the save, +1/+1 at par marks.
  function starsFor(state) {
    if (!state.terminal || !state.terminal.won) return 0;
    var par = state.cfg.par || {};
    var stars = 1;
    if (par.score2 != null && state.score.total >= par.score2) stars++;
    if (par.score3 != null && state.score.total >= par.score3) stars++;
    return stars;
  }

  // ---------- hints (same legality surface as play) ----------

  // Candidate shields around one point cluster, all quantized ints.
  function candidateStrokes(state) {
    var cfg = state.cfg;
    var W = cfg.world.w;
    var cands = [];
    var crs = cfg.creatures;
    // Span covering every creature (also correct for a single one).
    var minX = Infinity, maxX = -Infinity, topY = 0, cxSum = 0;
    crs.forEach(function (cr) {
      if (cr.x - cr.r < minX) minX = cr.x - cr.r;
      if (cr.x + cr.r > maxX) maxX = cr.x + cr.r;
      if (cr.y + cr.r > topY) topY = cr.y + cr.r;
      cxSum += cr.x;
    });
    var cx = Math.round(cxSum / crs.length);
    function clampX(x) { return Math.max(24, Math.min(W - 24, Math.round(x))); }
    var heights = [36, 68, 104];
    var widths = [200, 280, 380];
    for (var hi = 0; hi < heights.length; hi++) {
      for (var wi = 0; wi < widths.length; wi++) {
        var y = Math.round(topY + heights[hi]);
        var half = Math.max(widths[wi] / 2, (maxX - minX) / 2 + 30);
        cands.push([[clampX(cx - half), y], [clampX(cx + half), y]]);
      }
    }
    // Roofs (deflect diagonal shots to the sides).
    var roofW = [240, 330];
    for (var ri = 0; ri < roofW.length; ri++) {
      var y0 = Math.round(topY + 36), apex = Math.round(topY + 112);
      var hw = Math.max(roofW[ri] / 2, (maxX - minX) / 2 + 30);
      cands.push([[clampX(cx - hw), y0], [clampX(cx), apex], [clampX(cx + hw), y0]]);
    }
    // Side walls for horizontal gusts.
    crs.forEach(function (cr) {
      var wy0 = Math.max(16, Math.round(cr.y - 30)), wy1 = Math.round(cr.y + cr.r + 130);
      cands.push([[clampX(cr.x - cr.r - 70), wy0], [clampX(cr.x - cr.r - 70), wy1]]);
      cands.push([[clampX(cr.x + cr.r + 70), wy0], [clampX(cr.x + cr.r + 70), wy1]]);
    });
    return cands;
  }

  function lastStroke(st) { return st.strokes[st.strokes.length - 1]; }

  // Try candidate shields through the real command pipeline. Returns
  // {strokes: [{points, len}...], len, wouldWin, why}: the cheapest winning
  // combination (one stroke, or two when the layout needs it), else the
  // single best-effort shield.
  function hint(state) {
    if (state.terminal || state.phase !== 'draw') return null;
    if (state.strokes.length >= state.cfg.ink.maxStrokes) return null;
    var cands = candidateStrokes(state);
    var bestWin = null, bestTry = null;
    var singles = [];
    for (var i = 0; i < cands.length; i++) {
      if (checkStroke(state, cands[i])) continue;
      var s1 = applyCommand(state, { type: 'stroke', points: cands[i] });
      if (!s1.ok) continue;
      var stroke = lastStroke(s1.state);
      var s2 = applyCommand(s1.state, { type: 'release' });
      var cand = { points: stroke.pts, len: stroke.len, survivedTicks: s2.state.sim ? s2.state.sim.survivedTicks : 0 };
      singles.push(cand);
      if (s2.state.terminal && s2.state.terminal.won) {
        if (!bestWin || cand.len < bestWin.len) bestWin = cand;
      } else if (!bestTry || cand.survivedTicks > bestTry.survivedTicks) {
        bestTry = cand;
      }
    }
    if (!bestWin && singles.length && state.strokes.length + 1 < state.cfg.ink.maxStrokes) {
      // Two-stroke search: every ordered pair of legal candidates.
      for (var a = 0; a < singles.length && !bestWin; a++) {
        var sa = applyCommand(state, { type: 'stroke', points: singles[a].points });
        if (!sa.ok) continue;
        for (var b = 0; b < cands.length; b++) {
          if (checkStroke(sa.state, cands[b])) continue;
          var sb = applyCommand(sa.state, { type: 'stroke', points: cands[b] });
          if (!sb.ok) continue;
          var rel = applyCommand(sb.state, { type: 'release' });
          if (rel.state.terminal && rel.state.terminal.won) {
            var total = singles[a].len + lastStroke(sb.state).len;
            if (!bestWin || total < bestWin.len) {
              bestWin = { two: [singles[a], { points: lastStroke(sb.state).pts, len: lastStroke(sb.state).len }], len: total };
            }
          }
        }
      }
    }
    if (bestWin) {
      var strokes = bestWin.two || [{ points: bestWin.points, len: bestWin.len }];
      return { strokes: strokes, len: bestWin.len, wouldWin: true, why: strokes.length > 1 ? 'combined-shield' : 'shield' };
    }
    if (bestTry) {
      return { strokes: [{ points: bestTry.points, len: bestTry.len }], len: bestTry.len, wouldWin: false, why: 'best-effort' };
    }
    return null;
  }

  // ---------- validation (network / replay boundary) ----------

  function validateCommandShape(cmd, maxLen) {
    if (!cmd || typeof cmd !== 'object') return INVALID.BAD_SHAPE;
    if (JSON.stringify(cmd).length > (maxLen || 4096)) return INVALID.BAD_SHAPE;
    if (cmd.type !== 'stroke' && cmd.type !== 'release' && cmd.type !== 'resign') return INVALID.BAD_CMD;
    if (cmd.id != null && (typeof cmd.id !== 'string' || cmd.id.length > 64)) return INVALID.BAD_SHAPE;
    if (cmd.atMs != null && (typeof cmd.atMs !== 'number' || !isFinite(cmd.atMs) || cmd.atMs < 0 || cmd.atMs > 3600000)) return INVALID.BAD_SHAPE;
    if (cmd.type === 'stroke') {
      if (!Array.isArray(cmd.points) || cmd.points.length > MAX_POINTS) return INVALID.BAD_SHAPE;
      for (var i = 0; i < cmd.points.length; i++) {
        var p = cmd.points[i];
        if (!Array.isArray(p) || p.length < 2 || !isFinite(p[0]) || !isFinite(p[1])) return INVALID.BAD_SHAPE;
        if (Math.abs(p[0]) > 4000 || Math.abs(p[1]) > 4000) return INVALID.BAD_SHAPE;
      }
    }
    return null;
  }

  // ---------- serialization ----------

  function serialize(state) {
    var copy = clone(state);
    copy.trace = null; // cosmetic; rebuilt deterministically on replay
    return JSON.stringify(copy);
  }
  function deserialize(json) {
    var s = JSON.parse(json);
    if (s.v !== STATE_VERSION) throw new Error('unsupported state version ' + s.v);
    return s;
  }

  return {
    STATE_VERSION: STATE_VERSION,
    DT: DT,
    TERMINAL: TERMINAL,
    INVALID: INVALID,
    MIN_STROKE: MIN_STROKE,
    MAX_POINTS: MAX_POINTS,
    normalizeCfg: normalizeCfg,
    createGame: createGame,
    applyCommand: applyCommand,
    checkStroke: checkStroke,
    legalActions: legalActions,
    runSimulation: runSimulation,
    hint: hint,
    candidateStrokes: candidateStrokes,
    starsFor: starsFor,
    inkRemaining: inkRemaining,
    polyLength: polyLength,
    hashState: hashState,
    stableStringify: stableStringify,
    serialize: serialize,
    deserialize: deserialize,
    clone: clone,
    validateCommandShape: validateCommandShape
  };
});
