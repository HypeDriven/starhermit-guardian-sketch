# Guardian Sketch — running game design document

**Status:** shipped on the StarHermit engine 1.23.0 (host API 1.21); this document describes the game as it runs today (present tense). Anything the design wants that the code does not yet do is listed in the final section only.

## 1. Overview

**Pitch:** Draw a little ink, release the storm, and keep a glowing paper creature untouched for six seconds.

| | |
|---|---|
| Genre | Drawing physics puzzle, solo, single-shot rounds |
| Players | 1 (asynchronous score comparison per board) |
| Session | 20–60 s per round; 5–15 min sittings |
| Platforms | A StarHermit engine script game: natively in the StarHermit client, and in browsers (desktop and mobile, portrait and landscape) through the engine's web runtime; keyboard, mouse, touch, gamepad |
| Rendering | `starhermit:scene` perspective scene of a raised page on a desk; menus, HUD and results are `starhermit:ui` widgets drawn over it |
| Rules | Pure deterministic engine (`js/rules.js`), shared byte-for-byte between the client and the Node server script |

File map (everything that ships or matters):

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.23.0`, `engine.minor=19`, capabilities `platform,storage,clipboard`, `server=score-script.js`, the actions (`control.*`, `engine.gamepad.*`, `engine.group.*`) |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (`starhermit package --web .`); never edited by hand |
| `native/main.ts` | Entry: app state (title → setup → drawing ⇄ paused → storm ⇄ paused → results), the command log and state hashes, undo by replay, pointer / touch / keyboard-pen / gamepad input, storm cues, progression, stars, bests, achievements, local board, posting scores, lessons, toasts, captions, the board state panel; time by fixed steps (60 a second) |
| `native/screens.ts` | Every screen and dialog in `starhermit:ui`, layouts by window size |
| `native/render.ts` | The scene: desk, page, wisps, ledges, emitters, the ink tube (Catmull-Rom tube built by hand), ghost and hint, pooled hazards played back from the trace, instanced shards, dust, lights, shake, picking, the post effects per look |
| `native/quality.ts` | The browser build's four presets and budgets keyed by the runtime's quality tier and level |
| `native/audio.ts` | Clips from `sfx/manifest.json`, captions, the rendered pad and room tone |
| `native/platform.ts` | The save (`starhermit:storage` saves), the game's settings, foreign-save and legacy-settings migration, player, invite link, the `high-score` board, posting through `score-script.js`, the platform clock |
| `native/hint.ts`, `native/hint-worker.js` | The hint search on a script worker |
| `native/classic.ts`, `native/i18n.ts`, `native/style.ts` | Classic-script loading (with a `localStorage` shim over the device storage) and types; the locale from the runtime's language; the UI theme and styles |
| `js/rng.js`, `js/rules.js`, `js/content.js`, `js/store.js` | Classic UMD scripts shared with the Node tests and `server.js`: streams, rules, content, save document helpers and local leaderboards |
| `js/strings.js`, `js/i18n.js`, `js/platform-strings.js` | Translation tables (English keys) and the `T` lookup; the account strings in the nine locales |
| `tools/ui-style.css` → `assets/ui-style.json` | The style sheet, class-based, converted by `npm run css` |
| `tools/package-web.mjs`, `tools/css.mjs`, `tools/browser-play.mjs` | Packaging, style conversion, the GPU browser check |
| `score-script.js` | StarHermit platform script (`server=score-script.js`): range-checks a finished round's total and posts it to the `high-score` leaderboard |
| `server.js` | Local Node host with legacy replay-validating `/api/v1/*` routes (not part of the package; the client never calls it) |
| `assets/` | key art, results illustrations, paper grain, the converted UI styles |
| `sfx/` | 21 Opus clips; `manifest.txt` (canonical binding), `manifest.json` (generator entries), `manifest.md` (generated listing) |
| `tests/` | `run.js` (rules/content/server/store), `save.test.mjs`, `i18n.test.mjs`, `native.mjs` with `tests/native/*.play` |
| `coverart.png`, `cover.jpg`, `icon.png`, `LICENSE.md` | Cover, icon, PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

Guardian Sketch is about the moment a pencil line becomes a wall. The player is a doodler whose sketchbook has come alive: rain, embers, pebbles and gusts fall onto the page and the only tool is a limited amount of ink.

1. **One line is the whole answer.** Every round is a single decision: where the ink goes. Rules in: an ink budget that scores when unspent, a stroke cap, hints that are real solutions found through the same rules. Rules out: timers during drawing, multiple phases, upgrades, any action after Release.
2. **Ink becomes solid and stays honest.** A stroke is exactly the polyline the player drew (rounded to integers, jitter under 2 units dropped); hazards collide with that polyline and nothing else. Rules in: strokes rising off the page as tubes with shadows, hazard bounces you can predict. Rules out: auto-snapping, "magnetic" barriers, invisible hitboxes.
3. **The storm is a replay, not a gamble.** Release resolves the whole hazard timer instantly in `runSimulation` and the renderer plays back the recorded trace. Rules in: Skip always lands on the exact terminal state; pausing freezes the storm mid-tick; the server can replay your input log and get the same hash. Rules out: physics that depends on frame rate, engine, or device.
4. **The wisp is the hero, the page is the stage.** The camera frames the page to fill the viewport, the wisp glows on its own ring, and colour changes only through five cosmetic themes. Rules in: shadows, warm key light, tiny particle bursts on blocks. Rules out: camera swoops, post-processing that dims the paper or the pieces, effects that intercept raycasts.
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

Undo (`native/main.ts undoStroke`) rebuilds the state by replaying the command log minus the last stroke, so hashes stay consistent. Hint (`rules.js hint`) tries roughly 20 candidate shields (flat bars at three heights and widths, two peaked roofs, side walls beside each wisp) through the real `applyCommand`/`release` pipeline, then all ordered pairs when no single stroke wins, and returns the cheapest winning combination or the longest-surviving single stroke. The search runs on a script worker (`native/hint-worker.js`) so it never stalls a frame; the game's thread runs it only if the worker cannot start. Both are gated by `cfg.mechanics`.

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

Actions are declared in `starhermit.txt` (lower-case names; players rebind keys and pads in the runtime's Options › Controls, opened from Settings › Change keys and buttons). The browser build's per-player key bindings (`penLeft`, …) are not carried over: the action names changed.

| Input | Action | Feedback |
|---|---|---|
| Drag on the page (mouse, or a finger) | Draw a stroke; committed when the button or finger lifts | `draw-start` tick, amber ghost tube, live ink gauge, `stroke` scratch + haptic on commit |
| Tap < 10 px and < 250 ms | Ignored (no accidental stroke) | none |
| Drag past the ink budget | Points stop being added, one `invalid` toast per stroke | "Not enough ink" |
| `pen_left/right/up/down` (arrows; D-pad or left stick, analog) | Move the keyboard pen (14 units a step, 42 with `pen_fast`: Shift / left shoulder) | ✎ marker on the page |
| `pen_toggle` (Space; A/South) | Pen down / pen up (commits the stroke) | marker turns coral and grows while down |
| `release` (R; Y/North) | Release | `release` whoosh, tray swaps to Skip |
| `undo` (U; X/West) / `hint` (H; Select) | Undo / Hint (where the mode allows) | `undo` swipe; dashed hint shield + `hint` glimmer |
| `skip` (S; right shoulder) | Skip storm playback | `skip` whoosh, hazards settle instantly |
| `pause` (P, Escape; Start) | Pause / resume | `pause` hush, pause sheet |
| `camera` (C) | Re-fit the camera | none |
| Tab / arrows / Enter, D-pad / South / East | UI navigation, activation, back | focus ring |

Input locking: drawing is accepted only while drawing is open and no dialog is up; a press over a widget never starts a stroke (presses are decided after the frame's UI is built); while the pen moves, the arrows and D-pad belong to the pen, not the UI focus ring, and Space/South activate a tray button only when one has keyboard focus. Double commits of an identical point sequence are dropped by a per-round key. The optional **Confirm before release** setting requires two Release presses within 2.5 s. Every rejected command increments the round's invalid count, plays `invalid`, and shows a plain-language toast.

## 7. Screens and UI flow

App phases (`native/main.ts`): `title → (setup dialog) → active ⇄ paused → resolving ⇄ paused → results → (title | setup | active)`; lessons start rounds directly. A hidden or suspended window pauses the round.

Screens (`native/screens.ts`):

- **Title**: a dark veil over the 3D page; key art, logo, tagline, journey stars and daily status, "Next daily in h:mm:ss" (platform clock), the sync line, **▶ Play** and a 3 × 3 grid of Journey, Daily, Practice, Challenges, Tempest Stand, Learn, Help, Settings, Scores; signed out **Sign in with StarHermit**, signed in **Invite a friend** (copies the invite link).
- **Setup dialog**: name, mode with ranked/unranked, note ("Already played today"), intro, hazard legend chips (emoji icon + name, bordered in the hazard colour), rules summary, expected duration; Start / Cancel pinned under the scrolling body.
- **Journey dialog**: 40 stage tiles (number and ★☆☆), locked tiles disabled, mastery tiles with a thicker amber border; the tooltip carries name, theme and lock reason.
- **Practice dialog**: difficulty select, seed and New seed, Start / Cancel. **Challenges dialog**: the six challenges with intro and best.
- **HUD**: top-left objective pill, ink gauge with "n ink · m strokes", top-right "⏱ n.ns" during playback; the tray (Release / Undo / Hint / Skip ⏩ / ❚❚ Pause in context) at the bottom, reversed when left-handed; the keyboard pen's ✎ marker; the lesson card below the gauge; the board state panel (top right on wide windows, above the tray otherwise, left when left-handed).
- **Pause** (Escape or P resumes): Resume, Settings, Help, Restart, Quit to title.
- **Results** (not dismissable): headline ("Saved!", "Hit at 2.3s", "Resigned"), illustration, stars, score table and total, par, personal best, new achievements, the board (this device's casual records, or signed in the platform's `high-score` board), the posting status; Retry / Next level / Copy seed (daily, storm) / Back pinned under the scrolling body.
- **Settings**: Audio (volumes and mute live in the runtime's Options: Open Options; Captions), Graphics (theme with locks; quality in the runtime's Options), Accessibility (colour palette, left-handed, haptics, board state panel, confirm before release; reduced motion, high contrast and text size in the runtime's Options), Controls (Change keys and buttons), Done and **Reset save data** (asks first).
- **Help**: rule cards, hazard legend, the effective key and pad bindings (`bindingLabel`). **Scores**: Global / This device and a board select.

Layouts by the window's logical size: phone portrait (≤ 520 px wide: 34 px logo, wrapping tray, smaller journey tiles), short landscape (≤ 480 px tall: the title in two columns, the tray a column on the right — left when left-handed — and the lesson card on the left), and the rest. Dialogs open at their top and scroll when taller than 88 % of the window, their buttons pinned in view. While a dialog is open the toasts sit at the top edge; in play they and the caption strip sit above the tray. During play the camera keeps the bottom 11 % of the window for the tray.

## 8. Art direction

**Palette (`tools/ui-style.css` `:root` and `content.js THEMES`):** chrome `#14161c` / `#1c202a`, text `#e8eaef`, muted `#aab0bf`, paper `#f4efe3` with edge `#d9cdbb`, paper text `#2a2d38`, accent `#ffd34d`, star `#f0b429`, danger `#d05545`, ink gauge `#7fb0ff` on `#3a3f4c`, focus `#8fd0ff`. Scene theme Graphite Study: desk `#2b2f3a`, paper `#f2ecdf`, ink `#2a2e38`, wisp `#3b4d8f`, key light `#fff2dd`, accent `#e8a84b`, fog `#20242e`. Other themes shift desk, paper, ink, wisp, light and accent together (Ember Margin warm browns/orange, Tide Pool teal, Bloom Press rose, Night Ink indigo). Hazards: drop `#3a6fd8`, pebble `#8a8f9a`, ember `#e06a3a` (emissive), gale `#5db8a8`; high-contrast alternates `#2e6fe4`, `#b7791f`, `#e4572e`, `#17a398`.

**Shape language:** the page is a raised cream slab on a dark desk; ink is a round black tube with a real shadow; the wisp is a squashed sphere with two bead eyes and an amber ring on the page; emitters are small dark cones. Everything is procedural geometry so themes recolour it — which is why the wisp is not a baked model.

**Typography:** the runtime's system UI face; logo 54 px (34 px on phones); body 16 px, scaled by the runtime's text size; tabular numerals for scores and the countdown; 70 ch line cap in panels.

**Hero:** the page. `FRAMING` constants fit it with a 10 % margin at 40° FOV; the camera never moves except for a low-amplitude, fast-decaying shake on hits and wins.

**Motion:** strokes scale in over 160 ms, wisps bob ±0.035 units, hazards spin, blocks emit up to 8 white shards, hits 14 red, wins 18 gold (3 / 4 / 5 on Low; the live cap is the level's spark budget; from Balanced up the shards are HDR-bright so bloom makes them sparkle). Shards shrink away as they fade. Reduced motion (the runtime's Options) removes bob, spin, scale-in and shake and shortens particle life to 0.25 s; storm timing is unchanged; it also stills the dust motes and the halo pulse.

**Graphics.** A warm desk-lamp key light (soft shadows over the page's reach), a hemisphere fill in the theme's light/desk colours and (detailed) a faint cool rim; ACES tone mapping. The look follows the runtime's graphics level (Options › Graphics: Auto or a level; render scale, frame-rate limit and adaptive resolution are the runtime's): `native/quality.ts` maps its tier to the browser build's presets — Low (no shadows or post effects, MSAA, Lambert shading, plain surfaces, low particles, still), Balanced (1024² shadows, bloom, colour grade, FXAA, room reflections, detailed surfaces, rich particles, dust), High (2048², ambient occlusion, SMAA, physical clear-coat ink, wisps and drops) and Ultra (4096², high AO, MSAA, full-resolution bloom/AO) — with the per-tier budgets of the browser build (desk wood-grain texture 128–1024², ink tube 5–12 radial segments and ×0.5–×1.5 length, wisp sphere 12–32 segments, sparks 40–200 and dust 24–160, both growing with the level within the tier, at most 4×). Bloom keeps a 0.9 threshold so only embers, sparks and glints glow; the grade is a gentle S-curve, slight saturation, warm highlights / cool shadows and a soft vignette. Reflections use a `RoomEnvironment` per material (matte paper 0.12, glossy drops and metal emitters higher). Detailed surfaces add the procedural desk wood grain, the paper-grain relief, two loose sheets under the page, clear-coat ink and the additive lamp-lit halo behind each wisp. The browser build's own Graphics panel (per-category overrides, render scale, FPS readout, GPU summary) is replaced by the runtime's Options.

**Visual assets:** title key art (`assets/key-art.webp`), results illustrations (`assets/results-saved.webp`, `assets/results-hit.webp`), paper grain on the page and the panels (`assets/paper-grain.webp`), cover art. No 3D model: the wisp stays procedural.

## 9. Audio direction

**Philosophy:** a quiet studio. Ink and paper sounds are dry and close; hazards are small material transients layered by type; music is a slow generative pad that never competes with cues. Every cue is tied to a logical event so captions can mirror it.

**Buses (`native/audio.ts`):** the runtime's buses and Options (volumes, mute, voice limit): music (pad, gain 0.6), effects (cues 0.9, room tone 0.5), interface (the menu tap). The room tone (brown noise low-passed at 300 Hz, a 4 s cross-faded loop) and the pad (Am, F, G, Dm an octave down, triangle and sines through a 650 Hz low-pass, a chord every 5.2 s) are rendered once into clips. Clips load one at a time once the mixer runs (natively at once, in a browser after the first press). Seeded pitch variants (±6 %) for stroke, spawn and block cues come from the round's av stream so a replay sounds the same.

**Samples:** `sfx/manifest.json` maps events to Opus clips. The browser build's synthesized stand-ins (played while a clip loaded) are not ported: a cue is silent until its clip has loaded.

SFX event table (the source for `sfx/manifest.txt`):

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

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**. Every player-facing string — title, dialogs, HUD and tray, results, help, lessons, scores, board state panel, toasts, captions, and the content names and texts in `js/content.js` — is an English key in `js/strings.js` with es-419, de-DE, fr-FR, pt-BR and it-IT translations; en-GB, es-ES and fr-CA carry only their differences. The StarHermit account lines are `js/platform-strings.js`. "Guardian Sketch", "StarHermit" and "Wisp" are not translated; numbers stay plain digits.

The language is the runtime's interface language (Options › Language: the player's choice, else the account's preferred language, else the device's), mapped to the nearest shipped locale (`es-MX → es-419`, `en-AU → en-GB`, `fr → fr-FR`); the game's own Language setting and `?lang=` are gone. Every string is looked up each frame, so a change shows at once without touching the round.

## 11. Accessibility

- **Keyboard and gamepad:** the whole game is playable without a pointer (UI focus with Tab/arrows/Enter or the D-pad/South/East; the pen and round actions as in section 6). Dialogs focus their first control and open at their top; Escape closes dismissable dialogs and resumes from pause (results are not dismissable).
- **Screen reader:** `starhermit:ui` widgets form the accessibility tree; round starts, lessons, hints, toasts and the results headline with score and stars are announced (`ui.announce`). The optional **Always-on board state panel** shows phase, strokes, ink, wisp positions, emitter count and the last event.
- **Captions:** the Captions setting shows a short line for every meaningful cue ("storm released", "blocked", "creature hit", "creature saved", …) for 2.2 s.
- **Contrast, text size, motion:** the runtime's High contrast recolours the UI and switches the scene to near-black ink, red hint dashes and the high-contrast hazard set; its text size scales all UI text; its Reduced motion is honoured as in section 8. Hazards always carry shape and icon as well as colour.
- **Targets:** buttons at least 44 × 44 logical px; **Left-handed controls**, **Haptics**, **Confirm before release** (timing assistance), lessons replayable from Learn.

## 12. StarHermit integration

Manifest `starhermit.txt` as in section 1. All platform traffic is the runtime's (`starhermit:platform`, `starhermit:storage`); the game never sees tokens.

- **Save:** `{ v: 1, progress }` through `saves` (on the device, and signed in in the account's cloud slot with conflict handling: the merge keeps highest stars and best scores per stage, best challenge/daily/Tempest Stand scores, largest stats, the union of lessons and achievements with the earliest unlock time, this device's cosmetics). The browser build's slot (the JS SDK's `save.json` holding `{ v, settings, progress }`) shows as foreign: it is merged into this device's progress and replaced once (`replaceForeign`), its game settings adopted unless set since. Guests' old browser `localStorage` progress does not migrate.
- **Settings:** the game's own (theme, colour palette, captions, left-handed, haptics, board state panel, confirm before release) are `settings` keys synced with the account; the browser build's per-player settings keys are adopted, then removed. Volumes, mute, graphics, reduced motion, high contrast, text size, language and bindings are the runtime's Options.
- **Identity, sign-in, invites:** the player's display name in the sync line; signed out the title offers Sign in with StarHermit (`requestSignIn`), signed in Invite a friend copies the invite link. A session that ends shows a toast; play continues on the device.
- **Leaderboards:** signed in, every finished round except Learn lessons posts its total through `score-script.js` (a practice session's `{ type: 'result', scores: { 'high-score': n } }`; the script range-checks 0–10,000 and writes the board — the client never writes a board); the results show "Leaderboard rank: #N" (or posted / not posted). The Scores dialog and the results read the `high-score` board (guests read it too once its id is known on the device); otherwise, and on This device, the device's casual records. No multiplayer or hosted results exist in this game.
- **Daily:** the platform's clock (`serverNow`) gives the UTC date; offline the device's.

## 13. Technical architecture

- **Modules:** `rules` (pure), `content`, `store`, `rng` (classic scripts, unchanged in what they decide), and the engine client `native/*` (section 1). `render` and `screens` only read state; `main` mutates it through `applyValidated` (shape check → `applyCommand` → hash append).
- **Determinism and replay:** fixed 60 Hz step, integer stroke points, `atMs` from fixed steps quantised to 100 ms, canonical hashing with `trace`/`events` excluded. The session keeps `commands[]` and `stateHashes[]`; undo replays them.
- **Trace playback:** one trace tick per fixed step, hazards interpolated between trace frames by the render interpolation, events fired by tick; Skip and natural completion both land on the last frame and flush the events before the results.
- **Persistence:** the engine save (progress); `guardiansketch.leaderboards.v1` (≤ 400 local entries), `guardiansketch.playername` and `guardiansketch.board-id` in the device storage.
- **Rendering:** materials and objects are rebuilt when the look, theme or contrast changes (strokes re-tessellate from their points); sparks are one instanced mesh; the ghost tube is rebuilt at most once a frame.

## 14. Testing and acceptance criteria

`npm test`: `tests/run.js` (67 rules/content/server/store checks: legality, every invalid reason, scoring and stars, 30 randomised replays hash-identical, 500 fuzzed commands, serialization, hints, all content structurally valid with a reachable win, 366 dailies, lessons, golden sessions, server envelopes, leaderboard ties), `tests/save.test.mjs` (browser-save conversion, corrupt/newer saves, defaults, two-device merge, settings checks), `tests/i18n.test.mjs` (every used key translated in every locale, nothing unused, placeholders, locale switching, account strings), then `tests/native.mjs`: the web index is up to date, `tsc` passes, `starhermit check .` with no warnings, and the play scripts as signed-out render checks:

- `tests/native/journey.play`: stages 1 and 2 with the keyboard pen, the storm played out in full (Saved!, 1576) and skipped (2038), Next level, back to the title with 6 stars.
- `tests/native/screens.play`: every title dialog, settings toggles, Scores tabs, Learn lesson 1 met → lesson 2, pause → Help → Quit to title.
- `tests/native/practice-storm.play`: practice with Nothing to undo, a hint, undo of a stroke, a bare release (Hit at…), Retry, pause → Quit, Tempest Stand skipped to its results, Copy seed.

`npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in Chrome on the GPU at desktop 1366×768 (keyboard pen and a mouse drag), phone 390×844 and landscape 844×390 at DPR 3 (finger drags), pause, hint, release, skip, results; fails on console errors or warnings or the runtime's error screen.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1200×672, 36 KB) | Title screen key art; source of the cover | FLUX.2 klein, seed 4101 | generated in this pass, wired |
| `assets/results-saved.webp` (640×400, 10 KB) | Results illustration on a win | FLUX.2 klein, seed 4102 | generated in this pass, wired |
| `assets/results-hit.webp` (640×400, 8 KB) | Results illustration on hit/resign | FLUX.2 klein, seed 4103 | generated in this pass, wired |
| `assets/paper-grain.webp` (512×512, 21 KB) | Page texture in the 3D scene; panel and learn-card background | FLUX.2 klein, seed 4104 | generated in this pass, wired |
| `coverart.png` (1200×675, 256-colour) | StarHermit cover | key art, resampled | replaced placeholder in this pass |
| `icon.png` | Platform icon | authored | shipped |
| `assets/ui-style.json` | The UI's styles, converted from `tools/ui-style.css` by `starhermit css` | `npm run css` | shipped |
| `sfx/*.opus` × 15 (ui-tap … turn-skip) | Original event cues | MOSS-SFX v2, 100 steps | shipped |
| `sfx/ember-sizzle.opus`, `gale-deflect.opus`, `pebble-clack.opus` | Material-specific block cues | MOSS-SFX v2, 100 steps | generated in this pass, wired |
| `sfx/badge-unlock.opus`, `lesson-flourish.opus`, `pause-hush.opus` | Achievement, lesson, pause cues | MOSS-SFX v2, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical binding / generator entries / generated listing | hand-written / tool | shipped |
| 3D models, character animation | none needed (no humanoid; wisp is procedural) | — | not applicable |

## 16. Known limitations

- Scores are server-written only through `score-script.js`, which range-checks the client's total (no server-side replay verification; the replay-validating routes in `server.js` are a dev host the client never calls).
- The **Color palette: High visibility** setting is stored and shown but has no effect on rendering (the runtime's High contrast is the working option).
- Sound cues are silent until their clip has loaded (no synthesized stand-ins).
- The browser build's key bindings do not carry over (actions were renamed to the engine's lower-case names); its Graphics, Sound, Language and frame-rate panels are the runtime's Options now.
- Gamepad has no separate "lift without committing": A toggles the pen (as Space).
- Signed-out play keeps progress on the device only; guests' old browser progress does not migrate.
- The `C` key only re-fits the camera; there is no free camera to reset.
- Sign-in, cloud-save migration and score posting cannot be exercised headlessly; their logic is covered by `tests/save.test.mjs`.

## 17. Design intent not yet implemented

- Friends-filtered platform leaderboards and per-stage platform boards (one `high-score` board today).
- Platform achievements (achievements are part of the save; `score-script.js` has no unlock path).
- A high-visibility hazard palette bound to the existing setting.
- Cancel-without-commit for the gamepad pen.
