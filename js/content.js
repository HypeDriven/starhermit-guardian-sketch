/* Guardian Sketch — versioned content: hazard types, themes, 40 authored
 * journey stages, challenges, practice presets, daily ruleset generator,
 * tutorial lessons, achievements. Shared browser (window.GSContent) / Node.
 * Content is data-only; all randomness enters through the config seed.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.GSRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GSContent = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var CONTENT_VERSION = 1;

  // ---------- hazard types (visual + physics flavor; icon reinforces color) ----------
  var HAZARDS = {
    drop:   { label: 'Ink drop',  icon: '💧', color: 0x3a6fd8, colorHC: 0x2e6fe4 },
    pebble: { label: 'Pebble',    icon: '🪨', color: 0x8a8f9a, colorHC: 0xb7791f },
    ember:  { label: 'Ember',     icon: '🔥', color: 0xe06a3a, colorHC: 0xe4572e },
    gale:   { label: 'Gale wisp', icon: '🌀', color: 0x5db8a8, colorHC: 0x17a398 }
  };

  // ---------- themes (cosmetic only: paper, desk, light, hazard tint) ----------
  var THEMES = [
    { id: 'graphite', name: 'Graphite Study', unlockStars: 0,
      palette: { desk: 0x2b2f3a, paper: 0xf2ecdf, paperEdge: 0xd8d0bc, ink: 0x2a2e38,
                 creature: 0x3b4d8f, light: 0xfff2dd, accent: 0xe8a84b, fog: 0x20242e } },
    { id: 'ember',    name: 'Ember Margin', unlockStars: 12,
      palette: { desk: 0x3a2620, paper: 0xf5e8d8, paperEdge: 0xddc9ae, ink: 0x38241c,
                 creature: 0xa04a30, light: 0xffc98a, accent: 0xff8a3d, fog: 0x2a1a14 } },
    { id: 'tide',     name: 'Tide Pool', unlockStars: 30,
      palette: { desk: 0x1f3038, paper: 0xe8f0ea, paperEdge: 0xc4d4c8, ink: 0x1e3038,
                 creature: 0x2a6a70, light: 0xd8fff0, accent: 0x5db8a8, fog: 0x16242a } },
    { id: 'bloom',    name: 'Bloom Press', unlockStars: 55,
      palette: { desk: 0x352432, paper: 0xf6ecec, paperEdge: 0xddc8cc, ink: 0x352430,
                 creature: 0x8f4a70, light: 0xffd8e8, accent: 0xd87aa0, fog: 0x241a22 } },
    { id: 'night',    name: 'Night Ink', unlockStars: 85,
      palette: { desk: 0x1c2030, paper: 0xe8e8f2, paperEdge: 0xc0c0d4, ink: 0x1c2030,
                 creature: 0x4a5ab0, light: 0xbfd0ff, accent: 0x8fa0ff, fog: 0x12162a } }
  ];

  // ---------- emitter factories (compact authored hazards) ----------
  function rain(x, over) {
    return Object.assign({ x: x, y: 660, dx: 0, dy: -1, speed: 30, r: 15,
      start: 0, every: 36, count: 9, grav: 1, rest: 0.1, type: 'drop' }, over || {});
  }
  function slinger(fx, fy, tx, ty, over) { // aims at (tx,ty); normalization in rules
    return Object.assign({ x: fx, y: fy, dx: tx - fx, dy: ty - fy, speed: 520, r: 14,
      start: 0, every: 64, count: 5, grav: 0.12, rest: 0.25, type: 'pebble' }, over || {});
  }
  function ember(x, over) {
    return Object.assign({ x: x, y: 660, dx: 0, dy: -1, speed: 60, r: 13,
      start: 0, every: 46, count: 7, grav: 1, rest: 0.75, type: 'ember' }, over || {});
  }
  function gale(x, y, dir, over) { // dir: +1 blows right, -1 blows left
    return Object.assign({ x: x, y: y, dx: dir, dy: 0.04, speed: 400, r: 16,
      start: 0, every: 72, count: 5, grav: 0.1, rest: 0.2, type: 'gale' }, over || {});
  }

  function wisp(x, over) { return Object.assign({ x: x, y: 60, r: 30 }, over || {}); }
  function ledge(x1, y1, x2, y2, th) { return { x1: x1, y1: y1, x2: x2, y2: y2, th: th || 18 }; }

  // Par score estimate from config numbers (data-derived, deterministic).
  function pars(emitters, simTicks, budget) {
    var hazards = 0;
    emitters.forEach(function (e) { hazards += e.count; });
    var est = 500 + simTicks + Math.round(hazards * 40 * 0.85) + 40 + (budget - 280) * 2;
    return { score2: Math.round(est * 0.8 / 10) * 10, score3: Math.round(est * 0.93 / 10) * 10 };
  }

  // ---------- journey ----------
  // Row: [id, name, seed, creatures, emitters, obstacles, ink, maxStrokes,
  //       simTicks, themeIdx, intro]
  var J = [
    ['j01','First Drops',     101,[wisp(500)],[rain(500,{count:8,every:40})],[],520,3,360,0,
      'Drops fall straight onto Wisp. Draw one line above it, then release the storm.'],
    ['j02','Twin Clouds',     102,[wisp(500)],[rain(430),rain(570)],[],540,3,360,0,''],
    ['j03','Light Shower',    103,[wisp(500)],[rain(500,{every:30,count:11})],[],480,3,360,0,
      'A steadier shower. Spend only the ink you need — unspent ink scores.'],
    ['j04','Off Center',      104,[wisp(350)],[rain(350),rain(560,{every:52,count:6})],[],520,3,360,0,''],
    ['j05','Steady Rain',     105,[wisp(520)],[rain(520,{every:26,count:13})],[],500,3,360,0,''],
    ['j06','Wide Front',      106,[wisp(500)],[rain(370,{every:44}),rain(500,{every:40}),rain(630,{every:48})],[],580,4,360,0,
      'A wide front. One long line, or several short ones.'],
    ['j07','The Ledge',       107,[wisp(560)],[rain(560),rain(390,{every:48,count:6})],[ledge(300,250,470,250)],440,4,360,0,
      'Sketchy ledges are solid — drops bounce off them. Let the page help you.'],
    ['j08','First Pebble',    108,[wisp(480)],[slinger(930,620,480,260,{count:4})],[],480,3,360,0,
      'A pebble arcs in from the side. A flat roof will not always help — think angles.'],
    ['j09','Ember Glow',      109,[wisp(500)],[ember(500,{count:6})],[],520,3,360,1,
      'Embers bounce — off the floor, off your ink. Expect ricochets.'],
    ['j10','Charcoal Test',   110,[wisp(500)],[rain(430,{every:38}),rain(570,{every:42}),slinger(80,620,500,280,{count:3,start:80})],[],600,4,360,1,
      'MASTERY: rain from above, pebbles from the side. Combine what you know.'],
    ['j11','Ember Shower',    111,[wisp(500)],[ember(430),ember(570)],[],560,4,360,1,''],
    ['j12','Hot Rain',        112,[wisp(500)],[ember(500,{every:40,count:8}),rain(380,{every:50,count:6}),rain(620,{every:54,count:6})],[],600,4,360,1,''],
    ['j13','Bounce House',    113,[wisp(620)],[ember(620,{every:40}),ember(420,{every:56,count:5})],[ledge(300,230,470,230),ledge(700,300,860,300)],520,4,360,1,
      'Two ledges, two ember vents. Trap the bounce or roof it over.'],
    ['j14','Slinger Duo',     114,[wisp(500)],[slinger(60,640,500,300,{count:4}),slinger(940,640,500,300,{count:4,start:32})],[],540,4,360,1,
      'Pebbles from both flanks. A peaked roof sheds both ways.'],
    ['j15','Ember Cross',     115,[wisp(500)],[ember(500,{every:44}),slinger(920,600,500,240,{count:4,start:60})],[],580,4,360,1,''],
    ['j16','Kindling',        116,[wisp(460)],[ember(460,{every:34,count:10}),rain(600,{every:44,count:7})],[],560,4,360,1,''],
    ['j17','First Gust',      117,[wisp(500)],[gale(40,96,1,{every:80,count:4}),rain(500,{every:48,count:6})],[],560,4,360,2,
      'Gale wisps blow in sideways, low and fast. Walls stop them.'],
    ['j18','Sea Breeze',      118,[wisp(480)],[gale(960,110,-1,{every:64,count:5}),rain(480,{every:44,count:7})],[],560,4,360,2,''],
    ['j19','Spray',           119,[wisp(500)],[gale(40,120,1,{every:70,count:5}),rain(430,{every:40}),rain(570,{every:46})],[],600,4,360,2,''],
    ['j20','High Tide',       120,[wisp(500)],[gale(40,100,1,{every:76,count:4}),rain(500,{every:40,count:8}),ember(620,{every:60,count:4,start:40})],[],640,4,360,2,
      'MASTERY: wind, rain, and embers in one tide. Layer your defenses.'],
    ['j21','Gust Corridor',   121,[wisp(520)],[gale(40,70,1,{every:60,count:4}),gale(40,150,1,{every:60,count:4,start:30})],[],520,4,360,2,
      'Two gust lanes at different heights.'],
    ['j22','Driftwood',       122,[wisp(600)],[gale(40,104,1,{every:68,count:5}),rain(600,{every:44,count:7})],[ledge(360,220,520,220)],540,4,360,2,''],
    ['j23','Squall Line',     123,[wisp(500)],[gale(960,90,-1,{every:56,count:6}),rain(400,{every:42}),rain(560,{every:38})],[],600,4,360,2,''],
    ['j24','Undertow',        124,[wisp(460)],[gale(40,108,1,{every:66,count:5}),slinger(930,630,460,270,{count:4,start:50})],[],580,4,360,2,''],
    ['j25','Two Wisps',       125,[wisp(360),wisp(640)],[rain(360,{every:40}),rain(640,{every:40})],[],680,4,360,3,
      'Two wisps now — every one of them must survive.'],
    ['j26','Twin Shower',     126,[wisp(340),wisp(660)],[rain(340,{every:34,count:10}),rain(660,{every:34,count:10})],[],640,4,360,3,''],
    ['j27','Petal Pebbles',   127,[wisp(360),wisp(640)],[slinger(500,690,360,300,{count:4}),slinger(500,690,640,300,{count:4,start:32})],[],660,4,360,3,''],
    ['j28','Overgrown',       128,[wisp(320),wisp(680)],[rain(320,{every:40}),rain(680,{every:40})],[ledge(430,200,570,200)],600,4,360,3,
      'A ledge between the wisps. It blocks your ink as much as the rain.'],
    ['j29','Bloom Burst',     129,[wisp(370),wisp(630)],[ember(370,{every:44}),ember(630,{every:44,start:22})],[],660,4,360,3,''],
    ['j30','Full Bloom',      130,[wisp(350),wisp(650)],[rain(350,{every:40}),rain(650,{every:40}),gale(40,100,1,{every:84,count:4})],[],720,5,360,3,
      'MASTERY: twins, rain, and a side wind.'],
    ['j31','Narrow Margin',   131,[wisp(500)],[rain(470,{every:32,count:11}),rain(560,{every:36,count:10})],[],400,3,360,3,
      'Very little ink. Short, precise strokes only.'],
    ['j32','Thicket',         132,[wisp(480)],[rain(380,{every:38}),rain(480,{every:34}),rain(600,{every:42}),slinger(70,640,480,300,{count:3,start:70})],[],620,4,360,3,''],
    ['j33','Nightfall',       133,[wisp(500)],[rain(500,{every:38,count:9}),ember(600,{every:52,count:5}),gale(40,104,1,{every:88,count:3})],[],680,5,360,4,
      'Night ink: every hazard you have met, one page.'],
    ['j34','Ink Storm',       134,[wisp(500)],[rain(400,{every:30,count:12}),rain(500,{every:28,count:12}),rain(600,{every:32,count:11})],[],640,5,420,4,''],
    ['j35','Moonlit Pebbles', 135,[wisp(500)],[slinger(50,650,500,320,{count:5}),slinger(950,650,500,320,{count:5,start:32}),rain(500,{every:48,count:6})],[],620,4,360,4,''],
    ['j36','Star Twins',      136,[wisp(340),wisp(660)],[rain(340,{every:36}),rain(660,{every:36}),ember(500,{every:56,count:5})],[],720,5,360,4,''],
    ['j37','Ember Gale',      137,[wisp(520)],[ember(520,{every:40,count:8}),gale(960,100,-1,{every:64,count:5})],[],620,4,360,4,''],
    ['j38','Blackout',        138,[wisp(480)],[rain(440,{every:36,count:9}),rain(560,{every:40,count:8})],[],360,3,360,4,
      'The inkwell is nearly dry. 360 units — make every one count.'],
    ['j39','Last Page',       139,[wisp(500)],[rain(420,{every:34}),rain(580,{every:38}),ember(500,{every:52,count:5}),slinger(920,640,500,300,{count:3,start:60})],[],680,5,420,4,''],
    ['j40','Guardian Sketch', 140,[wisp(350),wisp(650)],[rain(350,{every:34,count:10}),rain(650,{every:34,count:10}),ember(500,{every:48,count:6}),gale(40,100,1,{every:80,count:4}),gale(960,150,-1,{every:80,count:4,start:40})],[],820,6,420,4,
      'MASTERY: the definitive page. Two wisps, four hazard kinds. Good luck.']
  ];

  function expandLevel(row, idx) {
    var emitters = row[4];
    return {
      id: row[0], version: CONTENT_VERSION, kind: 'journey', index: idx,
      name: row[1], seed: row[2],
      world: { w: 1000, h: 700, gravity: 1400 },
      creatures: row[3], emitters: emitters, obstacles: row[5],
      ink: { budget: row[6], maxStrokes: row[7], thickness: 12 },
      simTicks: row[8],
      par: pars(emitters, row[8], row[6]),
      mechanics: { undo: true, hint: true },
      theme: THEMES[row[9]].id,
      intro: row[10] || '',
      mastery: /MASTERY/.test(row[10] || '')
    };
  }

  var JOURNEY = J.map(expandLevel);

  // ---------- challenges (fixed seeds, constrained goals, ranked) ----------
  function ch(obj) {
    obj.version = CONTENT_VERSION;
    obj.kind = 'challenge';
    obj.world = { w: 1000, h: 700, gravity: 1400 };
    obj.par = pars(obj.emitters, obj.simTicks, obj.ink.budget);
    obj.mechanics = Object.assign({ undo: true, hint: true }, obj.mechanics || {});
    return obj;
  }
  var CHALLENGES = [
    ch({ id: 'c1', name: 'One Line', seed: 501, theme: 'graphite',
      creatures: [wisp(500)],
      emitters: [rain(430, { every: 36 }), rain(570, { every: 36, start: 18 })],
      obstacles: [], ink: { budget: 520, maxStrokes: 1, thickness: 12 }, simTicks: 360,
      intro: 'A single stroke is all you get. Make it span both clouds.' }),
    ch({ id: 'c2', name: 'Stingy Ink', seed: 502, theme: 'ember',
      creatures: [wisp(500)],
      emitters: [rain(500, { every: 30, count: 11 })],
      obstacles: [], ink: { budget: 280, maxStrokes: 3, thickness: 12 }, simTicks: 360,
      intro: 'Only 280 ink units. A short, well-placed line.' }),
    ch({ id: 'c3', name: 'Crossfire', seed: 503, theme: 'bloom',
      creatures: [wisp(500)],
      emitters: [slinger(50, 650, 500, 310, { count: 5 }), slinger(950, 650, 500, 310, { count: 5, start: 32 })],
      obstacles: [], ink: { budget: 560, maxStrokes: 3, thickness: 12 }, simTicks: 360,
      intro: 'Pebbles from both flanks. One peaked roof sheds both.' }),
    ch({ id: 'c4', name: 'Twins', seed: 504, theme: 'tide',
      creatures: [wisp(300), wisp(700)],
      emitters: [rain(300, { every: 36 }), rain(700, { every: 36 }), rain(500, { every: 48, count: 6 })],
      obstacles: [], ink: { budget: 640, maxStrokes: 4, thickness: 12 }, simTicks: 360,
      intro: 'Two wisps, far apart. Both must survive.' }),
    ch({ id: 'c5', name: 'Downpour', seed: 505, theme: 'night',
      creatures: [wisp(500)],
      emitters: [rain(400, { every: 24, count: 15 }), rain(500, { every: 26, count: 14 }), rain(600, { every: 24, count: 15, start: 12 })],
      obstacles: [], ink: { budget: 580, maxStrokes: 4, thickness: 12 }, simTicks: 420,
      intro: 'A long, heavy downpour. Endure the full timer.' }),
    ch({ id: 'c6', name: 'Gale Alley', seed: 506, theme: 'tide', mechanics: { undo: true, hint: false },
      creatures: [wisp(520)],
      emitters: [gale(40, 64, 1, { every: 58, count: 4 }), gale(40, 120, 1, { every: 62, count: 4, start: 24 }),
                 gale(40, 176, 1, { every: 66, count: 3, start: 48 }), rain(520, { every: 44, count: 7 })],
      obstacles: [], ink: { budget: 560, maxStrokes: 4, thickness: 12 }, simTicks: 360,
      intro: 'Three gust lanes plus rain. No hints in the alley.' })
  ];

  // ---------- practice presets (unranked; seed chosen at setup) ----------
  function makePractice(id, seed) {
    var rng = RNG.derive((seed >>> 0) ^ 0x51ab, RNG.STREAM_RULES);
    var cx = 380 + rng.int(241); // 380..619
    var base = PRACTICE.find(function (p) { return p.id === id; }) || PRACTICE[0];
    var emitters = [];
    if (id === 'gentle') {
      emitters = [rain(cx, { every: 40, count: 8 })];
    } else if (id === 'steady') {
      emitters = [rain(cx - 70, { every: 38 }), rain(cx + 70, { every: 42 }),
                  slinger(rng.int(2) ? 70 : 930, 640, cx, 300, { count: 3, start: 80 })];
    } else { // tempest
      emitters = [rain(cx - 90, { every: 34 }), rain(cx, { every: 30 }), rain(cx + 90, { every: 36 }),
                  ember(cx + (rng.int(2) ? 160 : -160), { every: 52, count: 5 })];
    }
    var budget = id === 'gentle' ? 560 : id === 'steady' ? 600 : 660;
    return {
      id: 'practice-' + id, version: CONTENT_VERSION, kind: 'practice',
      name: base.name + ' practice', seed: seed >>> 0,
      world: { w: 1000, h: 700, gravity: 1400 },
      creatures: [wisp(cx)], emitters: emitters, obstacles: [],
      ink: { budget: budget, maxStrokes: 4, thickness: 12 },
      simTicks: 360, par: pars(emitters, 360, budget),
      mechanics: { undo: true, hint: true },
      intro: base.blurb
    };
  }
  var PRACTICE = [
    { id: 'gentle', name: 'Gentle', blurb: 'One slow rain cloud. Learn the ropes.' },
    { id: 'steady', name: 'Steady', blurb: 'Rain with an occasional pebble.' },
    { id: 'tempest', name: 'Tempest', blurb: 'Heavy rain and embers. A real test.' }
  ];

  // ---------- score chase ruleset (ranked; seed shareable) ----------
  function makeStorm(seed) {
    var rng = RNG.derive((seed >>> 0) ^ 0x7073, RNG.STREAM_RULES);
    var cx = 420 + rng.int(161);
    var x1 = cx - 60 - rng.int(60), x2 = cx + 60 + rng.int(60);
    var gx = rng.int(2) ? 40 : 960, gdir = gx < 500 ? 1 : -1;
    var emitters = [
      rain(x1, { every: 32, count: 14 }),
      rain(cx, { every: 28, count: 16, start: 30 }),
      rain(x2, { every: 32, count: 14, start: 60 }),
      ember(cx + (rng.int(2) ? 170 : -170), { every: 46, count: 8, start: 120 }),
      gale(gx, 96, gdir, { every: 60, count: 6, start: 200 }),
      slinger(gx < 500 ? 950 : 50, 650, cx, 300, { count: 4, start: 300, every: 70 })
    ];
    return {
      id: 'storm', version: CONTENT_VERSION, kind: 'score', name: 'Tempest Stand',
      seed: seed >>> 0,
      world: { w: 1000, h: 700, gravity: 1400 },
      creatures: [wisp(cx)], emitters: emitters, obstacles: [],
      ink: { budget: 800, maxStrokes: 6, thickness: 12 },
      simTicks: 720, par: pars(emitters, 720, 800),
      mechanics: { undo: false, hint: false },
      theme: 'night',
      intro: 'A twelve-second escalating tempest. Survive whole — or score on endurance and blocks. Ranked.'
    };
  }

  // ---------- daily ----------
  // One immutable ruleset per UTC day, derived purely from the date string.
  function dailyConfig(dateStr) {
    var seed = RNG.hashString('guardian-sketch-daily-v' + CONTENT_VERSION + '-' + dateStr);
    var rng = RNG.derive(seed, RNG.STREAM_RULES);
    var day = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
    var rot = ((day % 7) + 7) % 7;
    var theme = THEMES[((day % THEMES.length) + THEMES.length) % THEMES.length].id;
    var cx = 400 + rng.int(201); // 400..600
    var creatures = [wisp(cx)];
    var emitters;
    if (rot === 0) {
      emitters = [rain(cx - 70, { every: 38 }), rain(cx + 70, { every: 40 })];
    } else if (rot === 1) {
      emitters = [rain(cx, { every: 34, count: 10 }), ember(cx + (rng.int(2) ? 130 : -130), { every: 50, count: 5 })];
    } else if (rot === 2) {
      emitters = [rain(cx, { every: 38 }), slinger(rng.int(2) ? 60 : 940, 640, cx, 290, { count: 4, start: 60 })];
    } else if (rot === 3) {
      creatures = [wisp(cx - 130), wisp(cx + 130)];
      emitters = [rain(cx - 130, { every: 38 }), rain(cx + 130, { every: 38 })];
    } else if (rot === 4) {
      var gx = rng.int(2) ? 40 : 960;
      emitters = [rain(cx, { every: 40 }), gale(gx, 100, gx < 500 ? 1 : -1, { every: 68, count: 5 })];
    } else if (rot === 5) {
      emitters = [ember(cx - 70, { every: 44 }), ember(cx + 70, { every: 44, start: 22 }), rain(cx, { every: 52, count: 6 })];
    } else {
      emitters = [rain(cx - 80, { every: 32, count: 10 }), rain(cx + 80, { every: 34, count: 10 }),
                  ember(cx, { every: 52, count: 5, start: 40 })];
    }
    var budget = rot === 3 ? 680 : 560;
    var simTicks = rot === 6 ? 420 : 360;
    return {
      id: 'daily-' + dateStr, version: CONTENT_VERSION, kind: 'daily',
      name: 'Daily ' + dateStr, seed: seed, date: dateStr,
      world: { w: 1000, h: 700, gravity: 1400 },
      creatures: creatures, emitters: emitters, obstacles: [],
      ink: { budget: budget, maxStrokes: 4, thickness: 12 },
      simTicks: simTicks, par: pars(emitters, simTicks, budget),
      mechanics: { undo: true, hint: true },
      theme: theme,
      intro: 'One shared seed for everyone, today only.'
    };
  }

  function utcDateString(nowMs) {
    var d = new Date(nowMs == null ? Date.now() : nowMs);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  // ---------- tutorial (Learn) ----------
  function tutorialLessons() {
    var W = { w: 1000, h: 700, gravity: 1400 };
    return [
      { id: 't1', title: 'Draw ink',
        text: 'Drag on the page (or hold Space and move the pen) to draw one line above Wisp. Any line will do — this is your barrier.',
        goal: { event: 'stroke', count: 1 },
        cfg: { id: 't1', version: CONTENT_VERSION, kind: 'tutorial', seed: 9001,
          world: W, creatures: [wisp(500)],
          emitters: [rain(500, { every: 40, count: 6, start: 200 })],
          obstacles: [], ink: { budget: 600, maxStrokes: 3, thickness: 12 },
          simTicks: 360, par: null, mechanics: { undo: false, hint: false } } },
      { id: 't2', title: 'Hold the line',
        text: 'Draw a line above Wisp, then press Release (R). If your barrier holds for the whole storm, Wisp is saved.',
        goal: { event: 'win', count: 1 },
        cfg: { id: 't2', version: CONTENT_VERSION, kind: 'tutorial', seed: 9002,
          world: W, creatures: [wisp(500)],
          emitters: [rain(500, { every: 44, count: 7 })],
          obstacles: [], ink: { budget: 520, maxStrokes: 3, thickness: 12 },
          simTicks: 360, par: null, mechanics: { undo: false, hint: true } } },
      { id: 't3', title: 'Mind the ink',
        text: 'Ink is limited and unspent ink scores points. Save Wisp using a short line — 260 units is all you have.',
        goal: { event: 'win', count: 1 },
        cfg: { id: 't3', version: CONTENT_VERSION, kind: 'tutorial', seed: 9003,
          world: W, creatures: [wisp(500)],
          emitters: [rain(500, { every: 42, count: 8 })],
          obstacles: [], ink: { budget: 260, maxStrokes: 3, thickness: 12 },
          simTicks: 360, par: null, mechanics: { undo: true, hint: true } } },
      { id: 't4', title: 'Roofs and angles',
        text: 'Pebbles arc in from the side. A peaked roof (two angled strokes) sheds them to either side. Save Wisp.',
        goal: { event: 'win', count: 1 },
        cfg: { id: 't4', version: CONTENT_VERSION, kind: 'tutorial', seed: 9004,
          world: W, creatures: [wisp(500)],
          emitters: [slinger(80, 640, 500, 300, { count: 4 }), slinger(920, 640, 500, 300, { count: 4, start: 40 })],
          obstacles: [], ink: { budget: 560, maxStrokes: 3, thickness: 12 },
          simTicks: 360, par: null, mechanics: { undo: true, hint: true } } },
      { id: 't5', title: 'Second chances',
        text: 'In relaxed modes you can undo a stroke (U) or ask for a hint (H). Draw any stroke, then undo it to finish the lesson.',
        goal: { event: 'undo', count: 1 },
        cfg: { id: 't5', version: CONTENT_VERSION, kind: 'tutorial', seed: 9005,
          world: W, creatures: [wisp(500)],
          emitters: [rain(500, { every: 44, count: 6 })],
          obstacles: [], ink: { budget: 600, maxStrokes: 3, thickness: 12 },
          simTicks: 360, par: null, mechanics: { undo: true, hint: true } } }
    ];
  }

  // ---------- achievements (stable lowercase keys, idempotent) ----------
  var ACHIEVEMENTS = [
    { key: 'first-save',    name: 'Guardian',          desc: 'Save a wisp for the first time.' },
    { key: 'blocks-50',     name: 'Ink Wall',          desc: 'Block 50 hazards across all play.' },
    { key: 'twins-save',    name: 'Double Duty',       desc: 'Win a round protecting two wisps.' },
    { key: 'score-2000',    name: 'Big Ink',           desc: 'Score 2000+ in a single round.' },
    { key: 'journey-half',  name: 'Half the Sketchbook', desc: 'Finish 20 journey stages.' },
    { key: 'journey-done',  name: 'Master Guardian',   desc: 'Finish all 40 journey stages.' },
    { key: 'daily-7',       name: 'Daily Doodler',     desc: 'Finish 7 daily challenges.' },
    { key: 'lessons-done',  name: 'Studious',          desc: 'Finish every Learn lesson.' },
    { key: 'storm-stand',   name: 'Stormwatcher',      desc: 'Score 1000+ in Tempest Stand.' }
  ];

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    HAZARDS: HAZARDS,
    THEMES: THEMES,
    JOURNEY: JOURNEY,
    CHALLENGES: CHALLENGES,
    PRACTICE: PRACTICE,
    makePractice: makePractice,
    makeStorm: makeStorm,
    ACHIEVEMENTS: ACHIEVEMENTS,
    dailyConfig: dailyConfig,
    utcDateString: utcDateString,
    tutorialLessons: tutorialLessons,
    emitterFactories: { rain: rain, slinger: slinger, ember: ember, gale: gale },
    wisp: wisp
  };
});
