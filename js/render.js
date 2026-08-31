/* Guardian Sketch — Three.js renderer (ES module).
 * Living-sketchbook scene: desk, raised paper page, ink wisps, pooled
 * hazards, dimensional ink strokes. Rendering consumes immutable state +
 * trace data; it never touches rules truth.
 */
import * as THREE from 'three';

// ---------- framing constants (authored, not magic) ----------
export const FRAMING = {
  WORLD_W: 1000,          // world units (page)
  WORLD_H: 700,
  SCALE: 100,             // world units per scene unit (page = 10 x 7)
  FOV: 40,                // low-distortion perspective
  MARGIN: 1.10,           // page fill margin
  CAM_LIFT: 0.9,          // slight camera height for a tabletop feel
  PAGE_Z: 0,              // page plane
  PAGE_RISE: 0.06,        // page raised above desk
  BOUNDS_PAD: 24          // matches rules BOUNDS_PAD (world units)
};

const S = FRAMING.SCALE;
const PAGE_CX = 0, PAGE_CY = FRAMING.WORLD_H / S / 2; // scene center of page (0, 3.5)

function wx(x) { return (x - FRAMING.WORLD_W / 2) / S; }
function wy(y) { return y / S; }

// Shared temporaries — no per-frame allocation in the hot loop.
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _planeHits = [];

const TIER_DPR = { low: 1, medium: 1.5, high: 2 };
const TIER_SHADOW = { low: 0, medium: 1024, high: 2048 };
const TIER_PARTICLES = { low: 60, medium: 160, high: 300 };

function pickAutoTier() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cores = navigator.hardwareConcurrency || 4;
  const small = Math.min(window.screen.width, window.screen.height) < 760;
  if (dpr > 1.5 && cores >= 8 && !small) return 'high';
  if (cores <= 4 || small || dpr <= 1) return 'medium';
  return 'medium';
}

export function createRenderer(container, opts) {
  opts = opts || {};
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    if (opts.onUnsupported) opts.onUnsupported(e);
    return null;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'gs-gl';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FRAMING.FOV, 1, 0.1, 100);

  // Render groups (layered responsibilities).
  const envGroup = new THREE.Group();    // desk, lights target, backdrop
  const gameGroup = new THREE.Group();   // page, creatures, obstacles, strokes, hazards
  const ghostGroup = new THREE.Group();  // in-progress stroke + hint preview
  const fxGroup = new THREE.Group();     // particles (never raycast)
  scene.add(envGroup, gameGroup, ghostGroup, fxGroup);

  // ---------- lights ----------
  const key = new THREE.DirectionalLight(0xfff2dd, 2.2);
  key.position.set(4, 9, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -7; key.shadow.camera.right = 7;
  key.shadow.camera.top = 6; key.shadow.camera.bottom = -2;
  key.shadow.camera.near = 1; key.shadow.camera.far = 30;
  key.shadow.bias = -0.0008;
  const hemi = new THREE.HemisphereLight(0xfff4e0, 0x2b2f3a, 0.85);
  envGroup.add(key, hemi);

  // ---------- desk + page ----------
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.95, metalness: 0 });
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(40, 26), deskMat);
  desk.position.set(PAGE_CX, PAGE_CY, -0.5);
  desk.receiveShadow = true;
  envGroup.add(desk);

  const pageMat = new THREE.MeshStandardMaterial({ color: 0xf2ecdf, roughness: 0.9, metalness: 0 });
  const pageEdgeMat = new THREE.MeshStandardMaterial({ color: 0xd8d0bc, roughness: 0.9, metalness: 0 });
  const pageW = FRAMING.WORLD_W / S, pageH = FRAMING.WORLD_H / S;
  const pageEdge = new THREE.Mesh(new THREE.BoxGeometry(pageW + 0.24, pageH + 0.24, 0.05), pageEdgeMat);
  pageEdge.position.set(PAGE_CX, PAGE_CY, FRAMING.PAGE_Z - 0.045);
  const page = new THREE.Mesh(new THREE.BoxGeometry(pageW, pageH, 0.04), pageMat);
  page.position.set(PAGE_CX, PAGE_CY, FRAMING.PAGE_Z - 0.02);
  page.receiveShadow = true;
  gameGroup.add(pageEdge, page);

  // Invisible pick plane (slightly padded so strokes near the edge raycast).
  const pad = FRAMING.BOUNDS_PAD / S;
  const pickPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(pageW + pad * 2, pageH + pad * 2),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  pickPlane.position.set(PAGE_CX, PAGE_CY, FRAMING.PAGE_Z);
  gameGroup.add(pickPlane);

  // ---------- shared materials / geometry ----------
  const inkMat = new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.55, metalness: 0.05 });
  const creatureMat = new THREE.MeshStandardMaterial({ color: 0x3b4d8f, roughness: 0.5, emissive: 0x3b4d8f, emissiveIntensity: 0.12 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.4 });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xe8a84b, transparent: true, opacity: 0.22, depthWrite: false });
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0xe8a84b, transparent: true, opacity: 0.45, depthWrite: false });
  const hintMat = new THREE.MeshBasicMaterial({ color: 0xe8a84b, transparent: true, opacity: 0.55, depthWrite: false });
  const obstacleMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4c, roughness: 0.85 });
  const emitterMat = new THREE.MeshStandardMaterial({ color: 0x555c6e, roughness: 0.6, metalness: 0.2 });

  const creatureGeo = new THREE.SphereGeometry(1, 24, 18);
  const eyeGeo = new THREE.SphereGeometry(0.07, 10, 8);
  const ringGeo = new THREE.RingGeometry(0.85, 1.12, 40);
  const obstacleGeo = new THREE.BoxGeometry(1, 1, 0.14);
  const emitterGeo = new THREE.ConeGeometry(0.16, 0.34, 10);

  // Hazard geometries per type.
  const HAZARD_GEO = {
    drop: new THREE.SphereGeometry(1, 12, 10),
    pebble: new THREE.IcosahedronGeometry(1, 0),
    ember: new THREE.OctahedronGeometry(1, 0),
    gale: new THREE.TorusGeometry(0.8, 0.32, 8, 16)
  };

  // ---------- module state ----------
  let palette = null;
  let highContrast = false;
  let reducedMotion = false;
  let tier = 'medium';
  let cfg = null;
  let decorRng = null;
  let visible = true;
  let disposed = false;
  let particleCap = TIER_PARTICLES.medium;

  const creatures = [];      // {group, body, glow, baseY, phase}
  const obstacles = [];
  const emittersFx = [];
  const strokeMeshes = [];   // committed ink strokes
  let ghostMesh = null;
  let hintGroup = null;

  // Hazard pool: type -> {free:[], mat}
  const hazardPools = {};
  const activeHazards = new Map(); // id -> {mesh, type}

  // Particle pool (small tetra shards, bounded).
  const particles = [];
  const particleGeo = new THREE.TetrahedronGeometry(0.07);
  for (let i = 0; i < TIER_PARTICLES.high; i++) {
    const m = new THREE.Mesh(particleGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    m.visible = false;
    m.raycast = function () {}; // cosmetic: never intercept raycasts
    fxGroup.add(m);
    particles.push({ mesh: m, alive: false, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 });
  }

  // Camera shake (camera only; pick plane truth unchanged).
  let shake = 0;
  const shakeSeed = { x: 0, y: 0 };

  // Trace playback state.
  let playback = null; // {trace, events, evIdx, startMs, speed, onEvent, onDone, done}

  // ---------- helpers ----------

  function hazardMaterial(type) {
    const hz = (window.GSContent && window.GSContent.HAZARDS[type]) || null;
    const color = hz ? (highContrast ? hz.colorHC : hz.color) : 0x888888;
    if (!hazardPools[type]) {
      hazardPools[type] = {
        free: [],
        mat: new THREE.MeshStandardMaterial({
          color: color, roughness: 0.45,
          emissive: type === 'ember' ? color : 0x000000,
          emissiveIntensity: type === 'ember' ? 0.55 : 0
        })
      };
    } else {
      hazardPools[type].mat.color.setHex(color);
      if (type === 'ember') hazardPools[type].mat.emissive.setHex(color);
    }
    return hazardPools[type];
  }

  function getHazardMesh(type, r) {
    const pool = hazardMaterial(type);
    let mesh = pool.free.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(HAZARD_GEO[type] || HAZARD_GEO.drop, pool.mat);
      mesh.castShadow = tier !== 'low';
      if (type === 'drop') mesh.scale.set(0.8, 1.25, 0.8);
      if (type === 'gale') mesh.scale.set(1, 1, 0.55);
    }
    mesh.visible = true;
    const sc = r / S;
    mesh.userData.baseScale = sc;
    if (type === 'drop') mesh.scale.set(sc * 0.8, sc * 1.25, sc * 0.8);
    else if (type === 'gale') mesh.scale.set(sc, sc, sc * 0.55);
    else mesh.scale.set(sc, sc, sc);
    gameGroup.add(mesh);
    return mesh;
  }

  function freeHazardMesh(id) {
    const rec = activeHazards.get(id);
    if (!rec) return;
    activeHazards.delete(id);
    rec.mesh.visible = false;
    gameGroup.remove(rec.mesh);
    hazardPools[rec.type].free.push(rec.mesh);
  }

  function spawnParticles(x, y, colorHex, count, spread) {
    let spawned = 0;
    for (let i = 0; i < particles.length && spawned < count; i++) {
      const p = particles[i];
      if (p.alive) continue;
      p.alive = true;
      p.life = 0;
      p.maxLife = reducedMotion ? 0.25 : 0.55 + Math.random() * 0.35;
      p.mesh.visible = true;
      p.mesh.position.set(wx(x), wy(y), 0.25);
      p.mesh.material.color.setHex(colorHex);
      p.mesh.material.opacity = 0.95;
      const a = Math.random() * Math.PI * 2;
      const sp = (spread || 2.4) * (0.4 + Math.random() * 0.8);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp * 0.9 + 1.2; p.vz = 0.6 + Math.random() * 1.4;
      spawned++;
    }
  }

  function updateParticles(dt) {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.alive = false; p.mesh.visible = false; continue; }
      p.vy -= 6 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      if (p.mesh.position.z < 0.05) { p.mesh.position.z = 0.05; p.vz *= -0.4; }
      p.mesh.material.opacity = 0.95 * (1 - p.life / p.maxLife);
      p.mesh.rotation.x += dt * 5; p.mesh.rotation.y += dt * 4;
    }
  }

  function aliveParticleCount() {
    let n = 0;
    for (let i = 0; i < particles.length; i++) if (particles[i].alive) n++;
    return n;
  }

  // ---------- strokes ----------
  function strokeCurve(pts, radius) {
    const v = [];
    for (let i = 0; i < pts.length; i++) v.push(new THREE.Vector3(wx(pts[i][0]), wy(pts[i][1]), FRAMING.PAGE_Z + radius + 0.02));
    if (v.length === 2) return new THREE.CatmullRomCurve3(v, false, 'catmullrom', 0);
    return new THREE.CatmullRomCurve3(v, false, 'catmullrom', 0.5);
  }

  function buildStrokeMesh(pts, thickness, material) {
    const radius = Math.max(2, thickness) / S / 2;
    const curve = strokeCurve(pts, radius);
    const segs = Math.min(480, Math.max(8, pts.length * 4));
    const geo = new THREE.TubeGeometry(curve, segs, radius, 8, false);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = tier !== 'low';
    return mesh;
  }

  function addStroke(pts) {
    const th = (cfg && cfg.ink && cfg.ink.thickness) || 12;
    const mesh = buildStrokeMesh(pts, th, inkMat);
    gameGroup.add(mesh);
    strokeMeshes.push(mesh);
    if (!reducedMotion) { mesh.userData.bornAt = performance.now(); mesh.scale.setScalar(0.01); }
    showGhost(null);
    showHint(null);
    return mesh;
  }

  function removeLastStroke() {
    const mesh = strokeMeshes.pop();
    if (mesh) { gameGroup.remove(mesh); mesh.geometry.dispose(); }
  }

  function clearStrokes() {
    while (strokeMeshes.length) removeLastStroke();
    showGhost(null);
    showHint(null);
  }

  function showGhost(pts) {
    if (ghostMesh) { ghostGroup.remove(ghostMesh); ghostMesh.geometry.dispose(); ghostMesh = null; }
    if (!pts || pts.length < 2) return;
    const th = (cfg && cfg.ink && cfg.ink.thickness) || 12;
    ghostMesh = buildStrokeMesh(pts, th * 0.8, ghostMat);
    ghostMesh.castShadow = false;
    ghostGroup.add(ghostMesh);
  }

  function showHint(strokes) {
    if (hintGroup) {
      hintGroup.children.forEach(function (c) { c.geometry.dispose(); });
      ghostGroup.remove(hintGroup);
      hintGroup = null;
    }
    if (!strokes || !strokes.length) return;
    hintGroup = new THREE.Group();
    strokes.forEach(function (st) {
      const pts = st.points || st.pts;
      if (!pts || pts.length < 2) return;
      // Dashed look: small dashes along the polyline.
      for (let i = 1; i < pts.length; i++) {
        const x1 = pts[i - 1][0], y1 = pts[i - 1][1], x2 = pts[i][0], y2 = pts[i][1];
        const len = Math.hypot(x2 - x1, y2 - y1);
        const dashes = Math.max(2, Math.floor(len / 40));
        for (let d = 0; d < dashes; d++) {
          const t0 = (d + 0.15) / dashes, t1 = (d + 0.7) / dashes;
          const ax = x1 + (x2 - x1) * t0, ay = y1 + (y2 - y1) * t0;
          const bx = x1 + (x2 - x1) * t1, by = y1 + (y2 - y1) * t1;
          const dl = Math.hypot(bx - ax, by - ay) / S;
          const dash = new THREE.Mesh(new THREE.BoxGeometry(dl, 0.075, 0.03), hintMat);
          dash.position.set(wx((ax + bx) / 2), wy((ay + by) / 2), FRAMING.PAGE_Z + 0.09);
          dash.rotation.z = Math.atan2(by - ay, bx - ax);
          hintGroup.add(dash);
        }
      }
    });
    ghostGroup.add(hintGroup);
  }

  // ---------- level build ----------
  function clearLevelEntities() {
    creatures.forEach(function (c) { gameGroup.remove(c.group); });
    creatures.length = 0;
    obstacles.forEach(function (o) { gameGroup.remove(o); o.geometry.dispose(); });
    obstacles.length = 0;
    emittersFx.forEach(function (e) { gameGroup.remove(e); });
    emittersFx.length = 0;
    clearStrokes();
    Array.from(activeHazards.keys()).forEach(freeHazardMesh);
  }

  function setLevel(newCfg) {
    stopTrace();
    clearLevelEntities();
    cfg = newCfg;
    decorRng = window.GSRNG ? window.GSRNG.derive(newCfg.seed || 0, window.GSRNG.STREAM_DECOR) : null;

    (cfg.creatures || []).forEach(function (cr) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(creatureGeo, creatureMat);
      const r = cr.r / S;
      body.scale.set(r, r * 0.82, r * 0.7);
      body.castShadow = tier !== 'low';
      const eL = new THREE.Mesh(eyeGeo, eyeMat);
      const eR = new THREE.Mesh(eyeGeo, eyeMat);
      eL.position.set(-r * 0.34, r * 0.18, r * 0.62);
      eR.position.set(r * 0.34, r * 0.18, r * 0.62);
      const glow = new THREE.Mesh(ringGeo, glowMat); // soft ring on the page under the wisp
      glow.scale.setScalar(r);
      g.add(body, eL, eR);
      const holder = new THREE.Group();
      holder.add(g);
      holder.position.set(wx(cr.x), wy(cr.y), FRAMING.PAGE_Z + 0.12);
      // glow sits on the page plane, relative to the holder
      glow.position.set(0, wy(Math.max(4, cr.y - cr.r - 6)) - wy(cr.y), FRAMING.PAGE_Z + 0.015 - holder.position.z);
      holder.add(glow);
      gameGroup.add(holder);
      creatures.push({
        group: holder, body: g, glow: glow,
        baseY: wy(cr.y),
        phase: decorRng ? decorRng.next() * Math.PI * 2 : Math.random() * 6.28,
        flashUntil: 0
      });
    });

    (cfg.obstacles || []).forEach(function (o) {
      const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1) / S;
      const mesh = new THREE.Mesh(obstacleGeo, obstacleMat);
      mesh.scale.set(len, (o.th || 16) / S, 1);
      mesh.position.set(wx((o.x1 + o.x2) / 2), wy((o.y1 + o.y2) / 2), FRAMING.PAGE_Z + 0.07);
      mesh.rotation.z = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
      mesh.castShadow = tier !== 'low';
      mesh.receiveShadow = true;
      gameGroup.add(mesh);
      obstacles.push(mesh);
    });

    (cfg.emitters || []).forEach(function (em) {
      const noz = new THREE.Mesh(emitterGeo, emitterMat);
      noz.position.set(wx(em.x), wy(em.y), FRAMING.PAGE_Z + 0.1);
      noz.rotation.z = Math.atan2(em.dy, em.dx) - Math.PI / 2;
      gameGroup.add(noz);
      emittersFx.push(noz);
    });
  }

  // ---------- theme ----------
  function setTheme(p, o) {
    if (!p) return;
    palette = p;
    highContrast = !!(o && o.highContrast);
    deskMat.color.setHex(p.desk);
    pageMat.color.setHex(p.paper);
    pageEdgeMat.color.setHex(p.paperEdge);
    inkMat.color.setHex(highContrast ? 0x10131a : p.ink);
    creatureMat.color.setHex(p.creature);
    creatureMat.emissive.setHex(p.creature);
    glowMat.color.setHex(p.accent);
    ghostMat.color.setHex(p.accent);
    hintMat.color.setHex(highContrast ? 0xd00000 : p.accent);
    key.color.setHex(p.light);
    hemi.color.setHex(p.light);
    hemi.groundColor.setHex(p.desk);
    scene.fog = new THREE.Fog(p.fog, 14, 34);
    scene.background = new THREE.Color(p.fog);
    // refresh pooled hazard colors
    Object.keys(hazardPools).forEach(function (t) { hazardMaterial(t); });
  }

  // ---------- trace playback ----------
  // opts: {speed, reducedMotion, events, onEvent(ev), onDone()}
  function playTrace(trace, traceCfg, o) {
    stopTrace();
    o = o || {};
    cfg = traceCfg || cfg;
    const events = (o.events || []).slice().sort(function (a, b) { return (a.tick || 0) - (b.tick || 0); });
    playback = {
      trace: trace,
      events: events,
      evIdx: 0,
      startMs: performance.now(),
      speed: o.speed || 1,
      onEvent: o.onEvent || null,
      onDone: o.onDone || null,
      done: false,
      spawnById: {}
    };
    (trace.spawns || []).forEach(function (sp) { playback.spawnById[sp.id] = sp; });
  }

  function traceDurationMs(trace) {
    return (trace.frames.length - 1) * trace.sample * (1000 / 60);
  }

  function currentTick(pb) {
    return ((performance.now() - pb.startMs) / 1000) * pb.speed * 60;
  }

  function setHazardsAtFrame(pb, fi, alpha) {
    const frames = pb.trace.frames;
    const f0 = frames[Math.min(fi, frames.length - 1)];
    const f1 = frames[Math.min(fi + 1, frames.length - 1)];
    const seen = {};
    for (let i = 0; i < f1.length; i++) {
      const id = f1[i][0];
      seen[id] = true;
      let x = f1[i][1], y = f1[i][2];
      // find id in f0 for interpolation (frames are short; linear scan ok)
      for (let j = 0; j < f0.length; j++) {
        if (f0[j][0] === id) {
          x = f0[j][1] + (f1[i][1] - f0[j][1]) * alpha;
          y = f0[j][2] + (f1[i][2] - f0[j][2]) * alpha;
          break;
        }
      }
      let rec = activeHazards.get(id);
      const sp = pb.spawnById[id];
      if (!rec && sp) {
        rec = { mesh: getHazardMesh(sp.hazard, sp.r), type: sp.hazard };
        activeHazards.set(id, rec);
      }
      if (rec) rec.mesh.position.set(wx(x), wy(y), FRAMING.PAGE_Z + 0.16);
    }
    // hide hazards not present in this frame
    activeHazards.forEach(function (rec, id) {
      if (!seen[id]) rec.mesh.visible = false;
    });
  }

  function fireTraceEvents(pb, tick) {
    while (pb.evIdx < pb.events.length && (pb.events[pb.evIdx].tick || 0) <= tick) {
      const ev = pb.events[pb.evIdx++];
      if (pb.onEvent) pb.onEvent(ev);
      if (ev.type === 'block' && ev.id != null) {
        const rec = activeHazards.get(ev.id);
        if (rec) spawnParticles((rec.mesh.position.x) * S + 500, rec.mesh.position.y * S, 0xfff0c0, tier === 'low' ? 3 : 8, 2.2);
      } else if (ev.type === 'hit') {
        flashHit(ev.creature || 0);
        if (!reducedMotion) shake = Math.min(0.5, shake + 0.3);
      }
    }
  }

  function finishPlayback(pb) {
    if (pb.done) return;
    pb.done = true;
    // settle exact end state: last frame positions, all events fired
    setHazardsAtFrame(pb, pb.trace.frames.length - 1, 1);
    fireTraceEvents(pb, Infinity);
    const cb = pb.onDone;
    playback = null;
    if (cb) cb();
  }

  function skip() {
    if (playback) finishPlayback(playback);
  }

  function stopTrace() {
    if (playback) { playback.done = true; playback = null; }
    Array.from(activeHazards.keys()).forEach(freeHazardMesh);
  }

  // ---------- fx helpers ----------
  function flashHit(creatureIndex) {
    const c = creatures[creatureIndex || 0];
    if (!c) return;
    c.flashUntil = performance.now() + 450;
    spawnParticles(500 + c.group.position.x * S, c.group.position.y * S, 0xe04a3a, tier === 'low' ? 4 : 14, 3);
  }

  function celebrate() {
    creatures.forEach(function (c) {
      spawnParticles(500 + c.group.position.x * S, c.group.position.y * S, 0xffd34d, tier === 'low' ? 5 : 18, 3.2);
    });
    if (!reducedMotion) shake = Math.min(0.35, shake + 0.12);
  }

  // ---------- coordinate mapping ----------
  function screenToWorld(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    _ray.setFromCamera(_ndc, camera);
    _planeHits.length = 0;
    _ray.intersectObject(pickPlane, false, _planeHits);
    if (!_planeHits.length) return null;
    const p = _planeHits[0].point;
    const x = (p.x - PAGE_CX) * S + FRAMING.WORLD_W / 2;
    const y = (p.y - 0) * S;
    if (x < -FRAMING.BOUNDS_PAD || x > FRAMING.WORLD_W + FRAMING.BOUNDS_PAD ||
        y < -FRAMING.BOUNDS_PAD || y > FRAMING.WORLD_H + FRAMING.BOUNDS_PAD) return null;
    return { x: x, y: y };
  }

  function worldToScreen(x, y) {
    const rect = renderer.domElement.getBoundingClientRect();
    _v3.set(wx(x), wy(y), FRAMING.PAGE_Z).project(camera);
    return { x: rect.left + (_v3.x + 1) / 2 * rect.width, y: rect.top + (1 - _v3.y) / 2 * rect.height };
  }

  // ---------- quality / motion / visibility ----------
  function applyTier(t) {
    tier = TIER_DPR[t] ? t : 'medium';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIER_DPR[tier]));
    const sh = TIER_SHADOW[tier];
    renderer.shadowMap.enabled = sh > 0;
    key.castShadow = sh > 0;
    if (sh > 0) {
      key.shadow.mapSize.set(sh, sh);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    particleCap = TIER_PARTICLES[tier];
    // trim alive particles over cap
    let alive = aliveParticleCount();
    for (let i = 0; i < particles.length && alive > particleCap; i++) {
      if (particles[i].alive) { particles[i].alive = false; particles[i].mesh.visible = false; alive--; }
    }
    resize();
  }

  function setQuality(t) { applyTier(t === 'auto' ? pickAutoTier() : t); }
  function setReducedMotion(b) { reducedMotion = !!b; }
  function setVisible(v) {
    visible = !!v;
    if (visible && !disposed) renderer.domElement && requestAnimationFrame(loop);
  }

  let insetBottomFrac = 0; // reserved bottom strip (action tray / safe area)
  let baseCamY = PAGE_CY + FRAMING.CAM_LIFT * 0.2;
  function setViewportInsets(insets) {
    insetBottomFrac = Math.max(0, Math.min(0.3, (insets && insets.bottom) || 0));
    resize();
  }

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const halfTan = Math.tan(THREE.MathUtils.degToRad(FRAMING.FOV / 2));
    // Fit the page into the top (1 - insetBottomFrac) of the viewport, then
    // shift the camera down so the page sits in that region (tray stays clear).
    const vScale = 1 / (1 - insetBottomFrac);
    const distV = (pageH / 2 * FRAMING.MARGIN) / halfTan * vScale;
    const distH = (pageW / 2 * FRAMING.MARGIN) / (halfTan * camera.aspect) * vScale;
    const dist = Math.max(distV, distH);
    const worldShift = insetBottomFrac * dist * halfTan;
    baseCamY = PAGE_CY + FRAMING.CAM_LIFT * 0.2 - worldShift;
    camera.position.set(PAGE_CX, baseCamY, dist + FRAMING.CAM_LIFT * 0);
    camera.lookAt(PAGE_CX, PAGE_CY - worldShift, 0);
    camera.updateProjectionMatrix();
  }

  // ---------- context loss ----------
  function onLost(ev) {
    ev.preventDefault();
    if (opts.onContextLost) opts.onContextLost();
  }
  function onRestored() {
    // Rebuild minimal GPU state: re-apply quality + theme; geometries persist.
    applyTier(tier);
    if (palette) setTheme(palette, { highContrast: highContrast });
  }
  renderer.domElement.addEventListener('webglcontextlost', onLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onRestored, false);

  // ---------- render loop ----------
  let lastMs = performance.now();
  function loop(nowMs) {
    if (disposed || !visible) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (nowMs - lastMs) / 1000);
    lastMs = nowMs;

    // creature idle bob (deterministic phase), hit flash tint
    for (let i = 0; i < creatures.length; i++) {
      const c = creatures[i];
      const bob = reducedMotion ? 0 : Math.sin(nowMs / 600 + c.phase) * 0.035;
      c.group.position.y = c.baseY + bob;
      const flashing = nowMs < c.flashUntil;
      c.body.children.forEach(function (m) {
        if (m.material === creatureMat) m.material.emissiveIntensity = flashing ? 0.8 : 0.12;
      });
    }

    // stroke scale-in animation
    for (let i = 0; i < strokeMeshes.length; i++) {
      const m = strokeMeshes[i];
      if (m.userData.bornAt != null) {
        const t = (nowMs - m.userData.bornAt) / 160;
        if (t >= 1) { m.scale.setScalar(1); delete m.userData.bornAt; }
        else m.scale.setScalar(0.01 + 0.99 * (1 - Math.pow(1 - t, 3)));
      }
    }

    // trace playback
    if (playback && !playback.done) {
      const tick = currentTick(playback);
      const fi = Math.floor(tick / playback.trace.sample);
      const alpha = (tick / playback.trace.sample) - fi;
      if (fi >= playback.trace.frames.length - 1) {
        finishPlayback(playback);
      } else {
        setHazardsAtFrame(playback, fi, Math.max(0, Math.min(1, alpha)));
        fireTraceEvents(playback, tick);
      }
    }

    // hazard spin (cosmetic)
    activeHazards.forEach(function (rec) {
      if (!reducedMotion) rec.mesh.rotation.z += dt * 2.4;
    });

    updateParticles(dt);

    // camera shake (decaying, camera only)
    if (shake > 0.001 && !reducedMotion) {
      shakeSeed.x = (Math.random() - 0.5) * shake * 0.12;
      shakeSeed.y = (Math.random() - 0.5) * shake * 0.12;
      shake *= Math.pow(0.02, dt); // fast decay
      camera.position.x = PAGE_CX + shakeSeed.x;
      camera.position.y = baseCamY + shakeSeed.y;
    } else if (shake !== 0) {
      shake = 0;
      camera.position.x = PAGE_CX;
      camera.position.y = baseCamY;
    }

    renderer.render(scene, camera);
  }

  // ---------- dispose ----------
  function dispose() {
    disposed = true;
    renderer.domElement.removeEventListener('webglcontextlost', onLost);
    renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
    scene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
      }
    });
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  // boot
  setQuality('medium');
  resize();
  // prewarm: compile shaders and render once before first real frame
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);

  return {
    canvas: renderer.domElement,
    setLevel: setLevel,
    setTheme: setTheme,
    addStroke: addStroke,
    removeLastStroke: removeLastStroke,
    clearStrokes: clearStrokes,
    showGhost: showGhost,
    showHint: showHint,
    playTrace: playTrace,
    skipTrace: skip,
    stopTrace: stopTrace,
    isPlaying: function () { return !!playback; },
    traceProgress: function () {
      if (!playback) return 1;
      return Math.min(1, currentTick(playback) / playback.trace.ticks);
    },
    screenToWorld: screenToWorld,
    worldToScreen: worldToScreen,
    setReducedMotion: setReducedMotion,
    setQuality: setQuality,
    resize: resize,
    setViewportInsets: setViewportInsets,
    setVisible: setVisible,
    flashHit: flashHit,
    celebrate: celebrate,
    shakeSmall: function () { if (!reducedMotion) shake = Math.min(0.3, shake + 0.08); },
    dispose: dispose
  };
}
