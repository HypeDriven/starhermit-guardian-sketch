# Guardian Sketch — running game design document

**Status:** shipped; this document describes the game as it runs today (present tense). Anything the design wants that the code does not yet do is listed in the final section only.

## 1. Overview

**Pitch:** Draw a little ink, release the storm, and keep a glowing paper creature untouched for six seconds.

| | |
|---|---|
| Genre | Drawing physics puzzle, solo, single-shot rounds |
| Players | 1 (asynchronous score comparison per board) |
| Session | 20–60 s per round; 5–15 min sittings |
| Platforms | Desktop and mobile browsers (portrait and landscape), keyboard, mouse, touch, gamepad |
| Rendering | Three.js r170 (vendored, importmap `three`) perspective scene of a raised page on a desk; all menus, HUD and results are semantic HTML over the canvas |
| Rules | Pure deterministic engine (`js/rules.js`), shared byte-for-byte between browser and the Node server script |

File map (everything that ships or matters):

| Path | Responsibility |
|---|---|
| `index.html` | Entry point; loads UMD globals (`GSRNG`, `GSRules`, `GSContent`, `GSStore`, `GSAudio`) then `js/main.js` as a module |
| `js/rng.js` | mulberry32 PRNG, FNV-1a string hash, three derived streams (rules / decor / av) |
| `js/rules.js` | State, legality, fixed-step hazard simulation, scoring, stars, hint search, replay validation, serialization |
| `js/content.js` | Hazard types, 5 themes, 40 journey stages, 6 challenges, 3 practice presets, Tempest Stand generator, daily generator, 5 lessons, 9 achievements |
| `js/store.js` | Versioned, checksummed local save (`guardiansketch.save.v1`), local leaderboards, tie-break sorter |
| `js/audio.js` | WebAudio buses, procedural fallbacks, lazy Opus sample playback from `sfx/manifest.json`, ambience and generative pad |
| `js/render.js` | Three.js scene: desk, page, wisps, obstacles, emitters, tube strokes, pooled hazards, particles, trace playback, quality tiers |
| `js/ui.js` | DOM shell: title, setup, journey grid, HUD/tray, pause, settings, results, help, learn card, scores, live regions, toasts, captions, board mirror |
| `js/main.js` | App state machine, session/commands, input (pointer, keyboard pen, gamepad), progression, replay envelope, server-time probe, boot |
| `css/main.css` | Complete stylesheet, responsive rules, safe areas, accessibility body classes |
| `server.js` | StarHermit game script: static host plus `/api/v1/*` with replay-validated score submission |
| `assets/` | `key-art.webp`, `results-saved.webp`, `results-hit.webp`, `paper-grain.webp` |
| `sfx/` | 21 Opus clips; `manifest.txt` (canonical binding), `manifest.json` (generator entries), `manifest.md` (generated listing) |
| `tests/run.js` | `npm test`: 67 rules/content/server/store checks, zero dependencies |
| `tests/e2e.mjs` | `npm run test:e2e`: Playwright playthrough on desktop and mobile viewports |
| `starhermit.txt`, `coverart.png`, `icon.png`, `favicon.svg`, `LICENSE.md` | Platform manifest, cover, icons, PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

Guardian Sketch is about the moment a pencil line becomes a wall. The player is a doodler whose sketchbook has come alive: rain, embers, pebbles and gusts fall onto the page and the only tool is a limited amount of ink.

1. **One line is the whole answer.** Every round is a single decision: where the ink goes. Rules in: an ink budget that scores when unspent, a stroke cap, hints that are real solutions found through the same rules. Rules out: timers during drawing, multiple phases, upgrades, any action after Release.
2. **Ink becomes solid and stays honest.** A stroke is exactly the polyline the player drew (rounded to integers, jitter under 2 units dropped); hazards collide with that polyline and nothing else. Rules in: strokes rising off the page as tubes with shadows, hazard bounces you can predict. Rules out: auto-snapping, "magnetic" barriers, invisible hitboxes.
3. **The storm is a replay, not a gamble.** Release resolves the whole hazard timer instantly in `runSimulation` and the renderer plays back the recorded trace. Rules in: Skip always lands on the exact terminal state; pausing freezes the storm mid-tick; the server can replay your input log and get the same hash. Rules out: physics that depends on frame rate, engine, or device.
4. **The wisp is the hero, the page is the stage.** The camera frames the page to fill the viewport, the wisp glows on its own ring, and colour changes only through five cosmetic themes. Rules in: shadows, warm key light, tiny particle bursts on blocks. Rules out: camera swoops, post-processing, effects that intercept raycasts.
5. **Hazards read by shape before colour.** Drop (teardrop sphere), pebble (icosahedron), ember (glowing octahedron), gale (flat torus) each have a distinct silhouette, an emoji icon in every legend, and a high-contrast alternate colour. Rules out: colour-only distinctions, unannounced hazard kinds (the setup panel always lists what a stage throws).

## 3. Player experience

**Target player:** anyone who liked drawing in the margins; casual puzzle players on phones, with a competitive layer (par stars, daily, Tempest Stand) for people who want to optimise ink.

**First 60 seconds (as implemented):** the title screen shows the key art, one dominant **Play** button and nine secondary buttons. Play opens the setup panel for journey stage 1 "First Drops", which states the intro line ("Drops fall straight onto Wisp. Draw one line above it, then release the storm."), the hazard legend, ink budget (520, 3 strokes), storm length (6 s), par marks and assists. Start drops the player onto the page with the HUD objective "Protect Wisp — draw barriers, then Release". Dragging anywhere on the page draws an amber ghost line that solidifies into black ink on release; the ink gauge shrinks live. Release plays the storm; the results panel explains the score component by component. The **Learn** button offers five one-rule lessons (draw, hold the line, mind the ink, roofs and angles, undo/hint) each of which requires the player to perform the action.

**Session shape:** 3–8 journey stages in a row (each under a minute), or one daily plus a Tempest Stand attempt. Retry is one tap from results; the next stage is one tap when the previous one earned a star.

**Emotional beat:** the held breath between pressing Release and the last drop sliding off the barrier — then the burst of golden shards and the chime when the wisp is still standing. Losses are quick and legible ("Hit at 2.3s") so the retry is immediate.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; nothing else mutates state. The state object is `{v, cfg, seed, tick, phase, strokes, inkUsed, elapsedDrawMs, sim, trace, score, terminal, events}`.

### Board and entities (`normalizeCfg`)

- World: 1000 × 700 units, +y up, floor at y = 0, gravity 1400 u/s². Side walls and floor are solid; the top is open (hazards that leave the page by more than 90 units despawn).
- Creatures ("wisps"): circles `{x, y, r}`; authored as `wisp(x)` = radius 30 at y 60. One or two per stage.
- Obstacles ("ledges"): thick segments `{x1,y1,x2,y2,th}` (default 18) that are solid but do not count as barriers.
- Emitters: `{x, y, dx, dy, speed, r, start, every, count, grav, rest, type}`. `dx,dy` is normalised; a hazard spawns at `tick >= start` every `every` ticks until `count` have spawned. Four types with authored factories in `content.js`: `rain` (drops, speed 30 down, r 15, rest 0.1), `slinger` (pebbles aimed at a point, speed 520, low gravity 0.12), `ember` (r 13, rest 0.75 — bouncy), `gale` (horizontal wisps, speed 400, gravity 0.1).
- Ink: `{budget, maxStrokes, thickness}` (thickness always 12; barrier radius 6).
- `simTicks`: 360 (6 s) or 420 (7 s) for authored stages, 720 (12 s) for Tempest Stand; clamped to 60–1800.

### Legal actions (`legalActions`, `checkStroke`, `sanitizeStroke`)

Phase `draw` allows `stroke`, `release`, `resign`. A stroke is rejected with one of: `malformed-command`, `too-many-points` (> 160), `out-of-bounds` (any point outside the page plus a 24-unit pad), `stroke-too-short` (fewer than 2 points after dedupe, or length < 10), `stroke-limit`, `ink-exhausted` (rounded length > remaining ink). After Release the phase is `done` and every command returns `game-ended`.

### Resolution order (`applyCommand`, `runSimulation`)

1. `stroke`: sanitise, push `{pts, len}`, `inkUsed += len`, `tick++`, record `atMs` quantised to 100 ms. Emits `{type:'stroke', len, remaining, strokes}`.
2. `release`: `phase = 'done'`, run the simulation from `cfg` + `strokes` only. Each tick at 60 Hz: (a) spawns in emitter order; (b) for each hazard in spawn order: gravity, integrate, collide against obstacles then stroke segments in stable order (push-out plus reflection with restitution and 0.5 % tangential friction), floor and walls, despawn check, then creature overlap; (c) every second tick a trace frame `[id, x, y]` is recorded. The first creature overlap ends the storm at that tick.
3. Events emitted: `spawn`, `block` (first barrier contact per hazard), `bounce` (obstacle contact), `hit`, then `win` or `lose`.
4. `resign`: terminal `resigned`, score zeroed.

Only `+ - * /` and `Math.sqrt` are used in the physics, so replays agree across JS engines.

### Scoring (`finalizeScore`) and stars (`starsFor`)

| Component | Formula |
|---|---|
| survival | 500 if every wisp survived, else 0 |
| endurance | 1 per survived tick (full `simTicks` on a win, the hit tick on a loss) |
| blocks | 40 per hazard that touched a barrier at least once |
| clearance | on a win, min(300, closest approach in units between any hazard and any wisp) |
| ink | on a win, 2 per unspent ink unit |

Worked example (journey 1, one flat 340-unit line above the wisp, all 8 drops blocked): survival 500 + endurance 360 + blocks 8 × 40 = 320 + clearance 84 + ink (520 − 180 = 198 … the HUD shows 198 left) × 2 = 396 → **1660**. Par is data-derived (`pars`): `est = 500 + simTicks + round(hazards × 34) + 40 + (budget − 280) × 2` = 1652; ★★ at 80 % (1320), ★★★ at 93 % (1540); the example earns ★★★. Stars: 1 for the save, +1 per par mark reached. Losses and resignations earn 0 stars.

### Terminal states and tie-breaks

`survived` (won), `creature-hit`, `resigned`. Leaderboard order (`GSStore.sortEntries`, mirrored by `server.js compareEntries`): won before lost, higher score, fewer invalid actions, lower `durationMs`, then session id string.

### RNG and seeding (`js/rng.js`)

One 32-bit master seed per config. `streams(seed)` derives three mulberry32 streams by XOR tag: rules (content layout), decor (wisp idle phase), av (pitch variants). Authored stages carry fixed seeds (j01 = 101 … j40 = 140, challenges 501–506). Daily seed = FNV-1a of `guardian-sketch-daily-v1-YYYY-MM-DD`; Tempest Stand seed = FNV-1a of `storm-YYYY-MM-DD`; practice seeds are random and shown to the player. The simulation itself consumes no randomness.

### Undo and hints

Undo (`main.js undoStroke`) rebuilds the state by replaying the command log minus the last stroke, so hashes stay consistent. Hint (`rules.js hint`) tries roughly 20 candidate shields (flat bars at three heights and widths, two peaked roofs, side walls beside each wisp) through the real `applyCommand`/`release` pipeline, then all ordered pairs when no single stroke wins, and returns the cheapest winning combination or the longest-surviving single stroke. Both are gated by `cfg.mechanics`.

## 5. Modes and progression

| Mode | Entry | Content | Assists | Ranked board |
|---|---|---|---|---|
| Play | Title **Play** | First journey stage without a star | per stage | `journey-<id>` |
| Journey | Title **Journey** | 40 authored stages, unlocked one at a time by earning a star on the previous one; 5 mastery stages (10, 20, 30, 33, 40) combine mechanics | undo + hint | `journey-<id>` |
| Daily | Title **Daily** | One immutable config per UTC day from `dailyConfig`; 7-day rotation of layouts (twin rain, rain + ember, rain + slinger, two wisps, rain + gale, ember pair, heavy trio); theme rotates by day | undo + hint | `daily-<date>` |
| Practice | Title **Practice** | Gentle / Steady / Tempest presets around a random centre; seed shown, "New seed" button | undo + hint | none |
| Challenges | Title **Challenges** | 6 fixed-seed constraints: One Line (1 stroke), Stingy Ink (280), Crossfire, Twins, Downpour (7 s), Gale Alley (no hints) | per challenge | `challenge-<id>` |
| Tempest Stand | Title **Tempest Stand** | 12-second escalating storm (three rain columns, ember, gale, slinger), 800 ink, 6 strokes, seed rotates daily | none | `storm` |
| Learn | Title **Learn** | 5 lessons with event goals (`stroke`, `win`, `win`, `win`, `undo`); resumes at the first unfinished lesson | per lesson | none |

Difficulty curve (journey): stages 1–7 rain only, introducing ledges at 7; pebbles at 8; embers at 9 (theme Ember Margin); gales at 17 (Tide Pool); two wisps at 25 (Bloom Press); tight ink at 31 and 38; everything at once from 33 (Night Ink). Each new concept appears alone, then paired with a known one, then in a mastery stage.

Themes unlock by total journey stars: Graphite Study 0, Ember Margin 12, Tide Pool 30, Bloom Press 55, Night Ink 85 (120 available). Journey and lessons always use their authored theme; other modes use the chosen theme.

Achievements (`content.js ACHIEVEMENTS`, unlocked idempotently in `finalizeProgress`): first-save, blocks-50, twins-save, score-2000, journey-half (20 stages), journey-done (40), daily-7, lessons-done, storm-stand (1000+ in Tempest Stand).

## 6. Controls and interaction

| Input | Action | Feedback |
|---|---|---|
| Drag on page (mouse/touch, pointer capture) | Draw a stroke; released on pointer up | `draw-start` tick, amber ghost tube, live ink gauge, `stroke` scratch + haptic on commit |
| Tap < 10 px and < 250 ms | Ignored (no accidental stroke) | none |
| Drag past the ink budget | Points stop being added, one `invalid` toast per stroke | "Not enough ink" |
| Arrow keys (Shift = 3×) | Move the keyboard pen (14 / 42 units per frame) | ✎ marker on the page |
| Space | Pen down / pen up (commits the stroke) | marker turns coral and grows while down |
| R | Release | `release` whoosh, tray swaps to Skip |
| U / H | Undo / Hint (where the mode allows) | `undo` swipe; dashed hint shield + `hint` glimmer |
| S | Skip storm playback | `skip` whoosh, hazards settle instantly |
| P / Escape | Pause / resume | `pause` hush, pause panel |
| C | Re-fit the camera | none |
| Enter | Native button activation | button style |
| Gamepad left stick / d-pad, A, B, Start | Move pen, pen toggle, pen up, pause | as keyboard |

Input locking: drawing input is accepted only in app state `active` with no modal open; `release` is refused during playback (`wrong-phase`) and after the round; pointer capture is released on `pointercancel` and the stroke is discarded. Double commits of an identical pointer sequence are dropped by a per-round key (`lastCommitKey`). The optional **Confirm before release** setting requires two Release presses within 2.5 s. Every rejected command increments `session.invalid`, plays `invalid`, and shows a plain-language toast (`ui.js INVALID_TEXT`).

## 7. Screens and UI flow

State machine (`main.js transition`): `boot → profile-ready → title → mode-select → preparing → active ↔ paused → resolving ↔ paused → results → (title | mode-select | preparing)`; `tutorial` wraps `preparing` for lessons. Backgrounding the tab pauses `active`/`resolving`, suspends audio and stops rendering.

Screens as implemented in `js/ui.js`:

- **Title** (`showTitle`): key art, logo, tagline, journey stars and daily status, live "Next daily in h:mm:ss", Play, and a 3-column grid (2 columns under 520 px) of Journey, Daily, Practice, Challenges, Tempest Stand, Learn, Help, Settings, Scores. WebGL-missing warning appears here.
- **Mode setup** (`showModeSetup`): name, mode label with ranked/unranked, note (e.g. "Already played today"), intro, hazard legend chips, rules summary, expected duration, Start / Cancel.
- **Journey grid** (`showJourney`): 40 numbered tiles with ★☆☆ state, locked tiles disabled, mastery tiles dashed; tooltip carries name, theme and lock reason.
- **HUD** (`showHUD`/`updateHUD`): top-left objective, ink gauge with "n ink · m strokes", top-right storm countdown during playback; bottom tray Release / Undo / Hint / Skip / Pause with context-only visibility.
- **Learn card** (`showLearn`): top sheet with "Lesson n of 5", title, instruction, Skip lesson / Quit lessons.
- **Pause** (`showPause`, non-dismissable): Resume, Settings, Help, Restart, Quit to title.
- **Results** (`showResults`, non-dismissable): headline ("Saved!", "Hit at 2.3s", "Resigned"), outcome illustration, ★ row, five-row score table plus total, par line, personal best, achievement list, top-10 board, Retry / Next level / Copy seed (daily, storm) / Back.
- **Settings**, **Help** (rule cards, hazard legend, binding table generated from `BINDINGS`), **Scores** (Global / This device tabs, board selector).

Layout: the canvas fills the viewport; during play the camera reserves the bottom 11 % for the tray (`setViewportInsets`). Panels are centred at ≥ 1024 px and become bottom sheets below; width `min(92vw, 560px)`, max height 88 dvh with internal scrolling. Portrait phones get a two-column title grid, a 130 px ink gauge and a wrapping tray; landscape phones under 480 px tall move the tray to a vertical column on the right (left when left-handed) and cap illustrations at 22 vh / 14 vh. Safe-area insets pad every fixed element. Nothing critical sits under the tray: the wisp and emitters are inside the framed page region.

## 8. Art direction

**Palette (CSS `:root` and `content.js THEMES`):** chrome `#14161c` / `#1c202a`, text `#e8eaef`, muted `#aab0bf`, paper `#f4efe3` with edge `#d9cdbb`, paper text `#2a2d38`, accent `#ffd34d`, star `#f0b429`, danger `#d05545`, ink gauge `#7fb0ff` on `#3a3f4c`, focus `#8fd0ff`. Scene theme Graphite Study: desk `#2b2f3a`, paper `#f2ecdf`, ink `#2a2e38`, wisp `#3b4d8f`, key light `#fff2dd`, accent `#e8a84b`, fog `#20242e`. Other themes shift desk, paper, ink, wisp, light and accent together (Ember Margin warm browns/orange, Tide Pool teal, Bloom Press rose, Night Ink indigo). Hazards: drop `#3a6fd8`, pebble `#8a8f9a`, ember `#e06a3a` (emissive), gale `#5db8a8`; high-contrast alternates `#2e6fe4`, `#b7791f`, `#e4572e`, `#17a398`.

**Shape language:** the page is a raised cream slab on a dark desk; ink is a round black tube with a real shadow; the wisp is a squashed sphere with two bead eyes and an amber ring on the page; emitters are small dark cones. Everything is procedural geometry so themes recolour it — which is why the wisp is not a baked model.

**Typography:** system UI stack; logo `clamp(34px, 8vh, 72px)`; body 16 px scaled ×1.25 by Large text; tabular numerals for scores and the countdown; 70 ch line cap in panels.

**Hero:** the page. `FRAMING` constants fit it with a 10 % margin at 40° FOV; the camera never moves except for a low-amplitude, fast-decaying shake on hits and wins.

**Motion:** strokes scale in over 160 ms, wisps bob ±0.035 units, hazards spin, blocks emit up to 8 white shards, hits 14 red, wins 18 gold (tier-capped at 60 / 160 / 300 live particles). Reduced motion (setting or `prefers-reduced-motion`) removes bob, spin, scale-in, shake, shortens particle life to 0.25 s, and kills CSS transitions; storm timing is unchanged.

**Visual assets the design calls for:** title key art (`assets/key-art.webp`), results illustrations for saved and hit (`assets/results-saved.webp`, `assets/results-hit.webp`), paper grain applied to the 3D page and to panel backgrounds (`assets/paper-grain.webp`), cover art (`coverart.png`). No 3D model: the wisp stays procedural.

## 9. Audio direction

**Philosophy:** a quiet studio. Ink and paper sounds are dry and close; hazards are small material transients layered by type; music is a slow generative pad that never competes with cues. Every cue is tied to a logical event so captions can mirror it.

**Buses (`js/audio.js`):** music (0.6), effects (0.9), ambience (0.5), voice (0.8, reserved — nothing plays on it), master mute. Ambience: looped brown noise low-passed at 300 Hz. Music: four-chord walk (Am, F, G, Dm) of filtered triangle/sine pads every 5.2 s. Audio starts on the first pointer or key event; the tab suspends it when hidden. Seeded pitch variants (±6 %) come from the av stream so a replay sounds the same.

**Samples:** `sfx/manifest.json` maps events to Opus clips that are fetched lazily after unlock; the procedural version of every event plays until the sample is decoded or if it fails, so the game is never silent.

SFX event table (the source for `sfx/manifest.txt`):

| Event id | File | Sound | Usage |
|---|---|---|---|
| ui | ui-tap.opus | soft plastic tap | every menu/tray button |
| draw-start | pencil-touch.opus | pencil tip touching paper | pointer down / Space pen down |
| stroke | ink-stroke.opus | confident graphite line | stroke committed |
| invalid | invalid-buzz.opus | two dull desk knocks | any rejected command |
| release | storm-release.opus | page-flip whoosh into rumble | Release accepted |
| spawn | creature-spawn.opus | airy pop with chirp | hazard leaves emitter (≤ 1 per 90 ms) |
| block | shield-block.opus | wooden knock | ink drop meets a barrier; generic fallback |
| block-ember | ember-sizzle.opus | sizzle hiss with crackle | ember meets a barrier |
| block-gale | gale-deflect.opus | gust deflected sideways | gale meets a barrier |
| block-pebble | pebble-clack.opus | crisp stone clack | pebble meets a barrier |
| bounce | pebble-bounce.opus | light pebble tap | hazard bounces off a ledge (≤ 1 per 140 ms) |
| hit | creature-hit.opus | heavy thud with crunch | wisp touched; loss |
| win | victory-chime.opus | four rising bell notes | storm survived |
| lose | defeat-tone.opus | two descending sad notes | hit or resign |
| undo | undo-swipe.opus | paper pulled back | last stroke undone |
| hint | hint-glimmer.opus | two high shimmer notes | hint shield shown |
| star | star-twinkle.opus | tiny bell ping | each newly earned journey star |
| achievement | badge-unlock.opus | brass-and-bell flourish | achievement unlocked |
| lesson | lesson-flourish.opus | three rising xylophone notes | lesson goal met |
| skip | turn-skip.opus | fast page skip | Skip playback |
| pause | pause-hush.opus | muffled hush | pause panel opens |

## 10. Localization

Shipping language: **English only** (en-US strings; the same text serves en-GB). All player-facing strings are literals in `js/ui.js` (labels, panels, invalid reasons), `js/main.js` (objective, headlines, toasts, bindings) and `js/content.js` (stage names, intros, lessons, achievements). There is no locale file, no language selector, and `<html lang="en">` is fixed. Layout already tolerates ~30 % longer strings: buttons wrap in a grid, panels scroll, the tray wraps on narrow screens, and the HUD objective is a single flexible line. The required set (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) is listed as unimplemented intent in section 17.

## 11. Accessibility

- **Keyboard-only path:** the whole game is playable without a pointer: Tab through buttons (visible 3 px `#8fd0ff` focus ring), arrows + Space draw, R/U/H/S/P act, Enter confirms. Modals move focus to their first control and restore focus on close; Escape closes dismissable panels (pause and results are deliberately not dismissable).
- **Screen reader:** two live regions (polite: title, lessons, hints; assertive: toasts, results headline with score and stars), `role="dialog"` with `aria-labelledby` on every panel, decorative art `aria-hidden`. The optional **Always-on board state panel** mirrors phase, strokes, ink, wisp positions, emitter count and last event as a DOM list.
- **Captions:** the Captions toggle prints a short text line for every meaningful cue ("storm released", "blocked", "creature hit", "creature saved", …) at the bottom of the screen for 2.2 s.
- **Contrast and colour:** High contrast switches the chrome to pure black/white, paper to white with black text, the ink to `#10131a`, hint dashes to `#d00000`, and hazards to the high-contrast set; `prefers-contrast: more` is honoured on first run. Hazards always carry shape and icon as well as colour.
- **Motion:** Reduced motion setting plus `prefers-reduced-motion` (see section 8).
- **Targets:** every button is at least 44 × 44 CSS px with 8 px gaps; checkboxes 24 px; range inputs 30 px tall.
- **Other:** Large text (×1.25), Left-handed controls (tray and mirror flip), Haptics toggle, Confirm before release (timing assistance), tutorial replay from Learn.

## 12. StarHermit integration

Manifest `starhermit.txt`: `name=Guardian Sketch`, `launch=index.html`, `owner=…`, `server=server.js`, `version=1.0.0`, `contentVersion=1`, `cover=coverart.png`.

Used:
- **Server time:** the client probes `GET /api/v1/time` once at boot (`fetchServerTime`) and uses the round-trip-adjusted offset for the daily boundary and countdown; offline it falls back to local time.
- **Game script (`server.js`):** serves the distribution (refuses `data/` and unknown extensions), answers `/api/v1/time`, `/api/v1/daily`, `/api/v1/leaderboard?board=`, and `POST /api/v1/score` which replays the envelope (`schema 1`, content version, seed, config id, initial hash, ordered commands with ids, per-command state hashes, result) through the same `GSRules`, rejects tampered scores, stale content versions, seed/config mismatches and more than 8 invalid commands, applies a 20/min rate limit and idempotent session ids, and stores boards in `data/leaderboards.json`. `presence`, `activity` and `telemetry` routes accept and discard.
- **Launch token:** read from the URL in memory only; never persisted.

Not used (by design, per https://wiki.starhermit.com/ conventions for solo titles): realtime rooms, relay, matchmaking, chat, voice, invitations, cloud save. The client currently never calls the score or leaderboard routes; ranked rounds write a replay envelope to `localStorage` (`guardiansketch.lastreplay`) and boards shown in the UI are on-device, labelled "casual (unvalidated)". Identity is a generated guest name (`guest-xxxx`); achievements and progress are local.

## 13. Technical architecture

- **Modules:** `rules` (pure, no Date/DOM), `content` (data + generators), `store` (save v1 with FNV checksum, memory fallback when storage is blocked, future versions never clobbered), `audio`, `render`, `ui`, `main` (owner of every transition, session log, progression). `render` and `ui` only read state; `main` mutates it through `applyValidated` (shape check → `applyCommand` → hash append).
- **Determinism and replay:** fixed 60 Hz step, integer stroke points, `atMs` quantised to 100 ms, stable iteration orders, canonical JSON hashing (`stableStringify` → FNV-1a) with `trace`/`events` excluded. The session keeps `commands[]` and `stateHashes[]`; undo replays them; the envelope is what the server validates.
- **Persistence:** `guardiansketch.save.v1` (settings + progress + stats + achievements), `guardiansketch.leaderboards.v1` (≤ 400 local entries), `guardiansketch.lastreplay`, `guardiansketch.playername`, `guardiansketch.telemetry` (≤ 60 local funnel events, never sent).
- **Rendering budget:** auto tier from DPR/cores/screen; tiers set pixel ratio cap 1 / 1.5 / 2, shadow map 0 / 1024 / 2048, particle cap 60 / 160 / 300. Geometry is pooled per hazard type; particles are a fixed pool with `raycast` disabled; no per-frame allocations in the loop; shaders are pre-compiled at boot; the loop stops while hidden. WebGL context loss re-applies tier and theme; no-WebGL devices get menus and a warning.
- **Trace playback:** frames every 2 ticks, linear interpolation by wall clock, events fired by tick, `skip` and natural completion both call `finishPlayback` which places every hazard at the last frame and flushes events before `onDone`.
- **E2E drive:** `tests/e2e.mjs` starts its own static server on an ephemeral port, launches Chrome with SwiftShader, and only uses what a player sees: clicks Play/Start, moves the keyboard pen by counting rAF frames, presses Space/R/P/Escape/S, reads the HUD and results text.

## 14. Testing and acceptance criteria

`npm test` (`tests/run.js`, 67 checks): initial state and legal actions; every invalid reason; stroke and ink limits; tick monotonicity; win/loss/resign scoring and star rules; commands after terminal; 30 randomised replays hash-identical; 500 fuzzed commands with no NaN; serialization round trip and save migration; hint legality and success on stage 1; 40 stages, 6 challenges, 3 practice presets, Tempest Stand and 366 dailies all structurally valid with a reachable win; daily immutability; 5 completable lessons; golden easy/medium/hard sessions; interrupted-and-resumed equality; server envelope acceptance and rejection cases; leaderboard tie order.

`npm run test:e2e` (desktop 1280×800 and mobile 390×844 touch): title visible → Play → stage 1 setup → HUD shows "520 ink · 3 strokes" → keyboard-pen stroke → Release → pause freezes playback for 12 s → Escape resumes → Skip → "Saved!" with stars → save document has j01 stars and stats → Next level → pause blocks Space → resume → quit → Settings toggles and persists Reduced motion → Help opens and closes; fails on any console error.

QA bar (checkable): every feature reachable by clicks/taps; no console errors or warnings on either viewport; no text clipped in title, setup, HUD, results, settings at 1280×800, 390×844 and 844×390; first-time players get the stage intro and Learn lessons; all buttons ≥ 44 px; audio never required to play.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1200×672, 36 KB) | Title screen key art; source of the cover | FLUX.2 klein, seed 4101 | generated in this pass, wired |
| `assets/results-saved.webp` (640×400, 10 KB) | Results illustration on a win | FLUX.2 klein, seed 4102 | generated in this pass, wired |
| `assets/results-hit.webp` (640×400, 8 KB) | Results illustration on hit/resign | FLUX.2 klein, seed 4103 | generated in this pass, wired |
| `assets/paper-grain.webp` (512×512, 21 KB) | Page texture in the 3D scene; panel and learn-card background | FLUX.2 klein, seed 4104 | generated in this pass, wired |
| `coverart.png` (1200×675, 256-colour) | StarHermit cover | key art, resampled | replaced placeholder in this pass |
| `icon.png`, `favicon.svg` | Platform icon, tab icon | authored | shipped |
| `sfx/*.opus` × 15 (ui-tap … turn-skip) | Original event cues | MOSS-SFX v2, 100 steps | shipped |
| `sfx/ember-sizzle.opus`, `gale-deflect.opus`, `pebble-clack.opus` | Material-specific block cues | MOSS-SFX v2, 100 steps | generated in this pass, wired |
| `sfx/badge-unlock.opus`, `lesson-flourish.opus`, `pause-hush.opus` | Achievement, lesson, pause cues | MOSS-SFX v2, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical binding / generator entries / generated listing | hand-written / tool | shipped |
| `vendor/three.module.min.js` | Three.js r170 | upstream | shipped |
| 3D models, character animation | none needed (no humanoid; wisp is procedural) | — | not applicable |

## 16. Known limitations

- Ranked boards are on-device only; the validated server boards exist but the client does not submit to or read from them.
- The **Color palette: High visibility** setting is stored and shown but has no effect on rendering (High contrast is the working option).
- The **Voice** bus slider controls a bus nothing plays on.
- Hint search runs synchronously on the main thread; on dense stages the two-stroke pass can stall input for a moment.
- Gamepad B while the pen is down commits the stroke rather than cancelling it (it mirrors Space).
- Achievements, guest name and progress are per browser; clearing site data resets them.
- The page under SwiftShader (headless CI) renders more beige than on GPU browsers because of ACES tone mapping; not a defect on real hardware.
- The `C` key only re-fits the camera; there is no free camera to reset.

## 17. Design intent not yet implemented

- Localization to en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT with a string table and language selection from the host locale.
- Client submission of the replay envelope to `POST /api/v1/score` with global and friends-filtered boards, and StarHermit identity for display names.
- Idempotent achievement delivery through the platform.
- A high-visibility hazard palette bound to the existing setting.
- Cancel-without-commit for gamepad B and pointer cancel parity.
