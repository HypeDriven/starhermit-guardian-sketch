/* Guardian Sketch — Three.js renderer (ES module).
 * Living-sketchbook scene: desk, raised paper page, ink wisps, pooled
 * hazards, dimensional ink strokes. Rendering consumes immutable state +
 * trace data; it never touches rules truth.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectPreset, describe, resolve, SHADOW_MAP, PARTICLE_CAP } from './gfx.js';

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

// Post-processing grade: gentle S-curve contrast, a touch of saturation, warm
// highlights / cool shadows and a soft vignette (display-space in and out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: [
    'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec4 src = texture2D(tDiffuse, vUv);',
    '  vec3 c = clamp(src.rgb, 0.0, 1.0);',
    '  vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);',
    '  float l = dot(s, vec3(0.299, 0.587, 0.114));',
    '  s = mix(vec3(l), s, 1.07);',
    '  s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.97), smoothstep(0.2, 0.8, l));',
    '  c = mix(c, s, uAmount);',
    '  float d = length((vUv - 0.5) * vec2(1.0, 0.9));',
    '  c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);',
    '  gl_FragColor = vec4(c, src.a);',
    '}'
  ].join('\n')
};

// Unmasked GPU name (when the browser exposes it) for Auto quality detection.
function gpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
  } catch (e) { return ''; }
}
function touchDevice() {
  try { return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches; } catch (e) { return false; }
}

// Procedural desk wood grain (greyscale, multiplied by the theme's desk colour).
function woodTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 26; i++) { // planks
    const y0 = i * 512 / 26;
    const shade = 222 + Math.floor(rnd() * 30);
    g.fillStyle = 'rgb(' + shade + ',' + shade + ',' + shade + ')';
    g.fillRect(0, y0, 512, 512 / 26);
  }
  g.globalAlpha = 0.16;
  for (let i = 0; i < 420; i++) { // grain streaks
    const y = rnd() * 512, len = 60 + rnd() * 300, x = rnd() * 512;
    const v = Math.floor(120 + rnd() * 120);
    g.strokeStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
    g.lineWidth = 0.6 + rnd() * 1.6;
    g.beginPath(); g.moveTo(x, y);
    g.bezierCurveTo(x + len * 0.3, y + (rnd() - 0.5) * 6, x + len * 0.6, y + (rnd() - 0.5) * 6, x + len, y + (rnd() - 0.5) * 4);
    g.stroke();
  }
  g.globalAlpha = 0.35;
  g.fillStyle = '#9a9a9a';
  for (let i = 0; i < 27; i++) g.fillRect(0, Math.round(i * 512 / 26), 512, 1.5); // plank seams
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4.5, 3);
  return tex;
}

// Soft round sprite for dust motes and the wisp halo.
function softDiscTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
  // Warm desk-lamp key (shadow caster), hemisphere fill and a faint cool rim
  // from the opposite side so tubes and the wisp read as round.
  const key = new THREE.DirectionalLight(0xfff2dd, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.01;
  const hemi = new THREE.HemisphereLight(0xfff4e0, 0x2b2f3a, 0.85);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 0);
  rim.position.set(PAGE_CX - 6, PAGE_CY + 4, 3);
  rim.target.position.set(PAGE_CX, PAGE_CY, 0);
  envGroup.add(key, key.target, hemi, rim, rim.target);

  // ---------- desk + page ----------
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.8, metalness: 0, envMapIntensity: 0.35 });
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(90, 64), deskMat);
  desk.position.set(PAGE_CX, PAGE_CY, -0.5);
  desk.receiveShadow = true;
  envGroup.add(desk);

  const pageMat = new THREE.MeshStandardMaterial({ color: 0xf2ecdf, roughness: 0.9, metalness: 0, envMapIntensity: 0.2 });
  let paperTex = null;
  // Authored paper grain (assets/paper-grain.webp). The flat theme colour is
  // the fallback: if the texture never arrives the page simply stays plain.
  new THREE.TextureLoader().load('./assets/paper-grain.webp', function (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 2.8);
    tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    paperTex = tex;
    pageMat.map = tex;
    applyDetail();
  }, undefined, function () { /* keep the plain page */ });
  const pageEdgeMat = new THREE.MeshStandardMaterial({ color: 0xd8d0bc, roughness: 0.9, metalness: 0 });
  const pageW = FRAMING.WORLD_W / S, pageH = FRAMING.WORLD_H / S;
  const pageEdge = new THREE.Mesh(new THREE.BoxGeometry(pageW + 0.24, pageH + 0.24, 0.05), pageEdgeMat);
  pageEdge.position.set(PAGE_CX, PAGE_CY, FRAMING.PAGE_Z - 0.045);
  const page = new THREE.Mesh(new THREE.BoxGeometry(pageW, pageH, 0.04), pageMat);
  page.position.set(PAGE_CX, PAGE_CY, FRAMING.PAGE_Z - 0.02);
  page.receiveShadow = true;
  page.castShadow = true;
  pageEdge.castShadow = true;
  gameGroup.add(pageEdge, page);

  // Detail: a couple of loose sheets under the page so it reads as a sketchbook.
  const underSheets = new THREE.Group();
  [[0.1, -0.08, -0.012, -0.09], [-0.14, -0.05, 0.018, -0.13]].forEach(function (o) {
    const sh = new THREE.Mesh(new THREE.BoxGeometry(pageW + 0.1, pageH + 0.1, 0.02), pageEdgeMat);
    sh.position.set(PAGE_CX + o[0], PAGE_CY + o[1], o[3]);
    sh.rotation.z = o[2];
    sh.castShadow = true; sh.receiveShadow = true;
    underSheets.add(sh);
  });
  underSheets.visible = false;
  envGroup.add(underSheets);

  // Invisible pick plane (slightly padded so strokes near the edge raycast).
  const pad = FRAMING.BOUNDS_PAD / S;
  const pickPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(pageW + pad * 2, pageH + pad * 2),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  pickPlane.position.set(PAGE_CX, PAGE_CY, FRAMING.PAGE_Z);
  gameGroup.add(pickPlane);

  // ---------- shared materials / geometry ----------
  // Physical materials: clearcoat/sheen are switched on by the Surface detail
  // option (zero = the plain standard path).
  const inkMat = new THREE.MeshPhysicalMaterial({ color: 0x2a2e38, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.9 });
  const creatureMat = new THREE.MeshPhysicalMaterial({ color: 0x3b4d8f, roughness: 0.5, emissive: 0x3b4d8f, emissiveIntensity: 0.12, sheenColor: 0xc8d4ff });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.4 });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xe8a84b, transparent: true, opacity: 0.22, depthWrite: false });
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0xe8a84b, transparent: true, opacity: 0.45, depthWrite: false });
  const hintMat = new THREE.MeshBasicMaterial({ color: 0xe8a84b, transparent: true, opacity: 0.55, depthWrite: false });
  const obstacleMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4c, roughness: 0.85 });
  const emitterMat = new THREE.MeshStandardMaterial({ color: 0x555c6e, roughness: 0.4, metalness: 0.6 });
  const discTex = softDiscTexture();
  const haloMat = new THREE.MeshBasicMaterial({ color: 0xe8a84b, map: discTex, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
  const haloGeo = new THREE.PlaneGeometry(1, 1);

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
  const gpu = gpuName(renderer);
  const detected = detectPreset(gpu, touchDevice());
  let q = resolve({}, 'low');      // resolved graphics settings (see gfx.js)
  let gfxSaved = null;
  let cfg = null;
  let decorRng = null;
  let visible = true;
  let disposed = false;
  let particleCap = PARTICLE_CAP.low;
  const mqReduced = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  function motionOff() { return reducedMotion || !!(mqReduced && mqReduced.matches); }

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
  for (let i = 0; i < PARTICLE_CAP.high; i++) {
    const m = new THREE.Mesh(particleGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    m.visible = false;
    m.raycast = function () {}; // cosmetic: never intercept raycasts
    fxGroup.add(m);
    particles.push({ mesh: m, alive: false, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 });
  }

  // Ambient dust drifting through the lamp light (Ambient motion option).
  const DUST = 90;
  const dustPos = new Float32Array(DUST * 3);
  const dustSeed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    dustSeed[i] = Math.random() * 1000;
    dustPos[i * 3] = PAGE_CX + (Math.random() - 0.5) * 13;
    dustPos[i * 3 + 1] = -1 + Math.random() * 9.5;
    dustPos[i * 3 + 2] = 0.4 + Math.random() * 2.4;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ color: 0xfff2dd, size: 0.07, map: discTex, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.raycast = function () {};
  dust.visible = false;
  fxGroup.add(dust);

  // Image-based lighting (Reflections option), built on first use.
  let envTex = null;
  function environment() {
    if (!envTex) {
      const pm = new THREE.PMREMGenerator(renderer);
      envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    return envTex;
  }
  let woodTex = null;

  // Camera shake (camera only; pick plane truth unchanged).
  let shake = 0;
  const shakeSeed = { x: 0, y: 0 };

  // Trace playback state.
  let playback = null; // {trace, events, evIdx, startMs, speed, onEvent, onDone, done}
  let playbackPausedAt = null; // wall-clock ms when playback was paused

  // ---------- helpers ----------

  function hazardMaterial(type) {
    const hz = (window.GSContent && window.GSContent.HAZARDS[type]) || null;
    const color = hz ? (highContrast ? hz.colorHC : hz.color) : 0x888888;
    if (!hazardPools[type]) {
      hazardPools[type] = {
        free: [],
        mat: new THREE.MeshPhysicalMaterial({
          color: color, roughness: 0.45,
          emissive: type === 'ember' ? color : 0x000000,
          emissiveIntensity: type === 'ember' ? 0.55 : 0
        })
      };
      styleHazardMat(type, hazardPools[type].mat);
      if (q.reflections === 'on') { hazardPools[type].mat.envMap = environment(); hazardPools[type].mat.envMapIntensity = type === 'drop' ? 0.45 : 0.4; }
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
      mesh.castShadow = true;
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
      p.maxLife = motionOff() ? 0.25 : 0.55 + Math.random() * 0.35;
      p.mesh.visible = true;
      p.mesh.position.set(wx(x), wy(y), 0.25);
      p.mesh.material.color.setHex(colorHex);
      // High particles: HDR-bright shards so bloom makes them sparkle.
      p.mesh.material.toneMapped = q.particles !== 'high';
      if (q.particles === 'high') p.mesh.material.color.multiplyScalar(1.8);
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
    mesh.castShadow = true;
    return mesh;
  }

  function addStroke(pts) {
    const th = (cfg && cfg.ink && cfg.ink.thickness) || 12;
    const mesh = buildStrokeMesh(pts, th, inkMat);
    gameGroup.add(mesh);
    strokeMeshes.push(mesh);
    if (!motionOff()) { mesh.userData.bornAt = performance.now(); mesh.scale.setScalar(0.01); }
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
      body.castShadow = true;
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
      const halo = new THREE.Mesh(haloGeo, haloMat); // soft lamp-lit aura (Surface detail)
      halo.scale.setScalar(r * 5);
      halo.position.set(0, 0, FRAMING.PAGE_Z + 0.02 - holder.position.z);
      halo.raycast = function () {};
      halo.visible = q.detail === 'detailed';
      holder.add(halo);
      gameGroup.add(holder);
      creatures.push({
        group: holder, body: g, glow: glow, halo: halo, haloBase: r * 5,
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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      gameGroup.add(mesh);
      obstacles.push(mesh);
    });

    (cfg.emitters || []).forEach(function (em) {
      const noz = new THREE.Mesh(emitterGeo, emitterMat);
      noz.position.set(wx(em.x), wy(em.y), FRAMING.PAGE_Z + 0.1);
      noz.rotation.z = Math.atan2(em.dy, em.dx) - Math.PI / 2;
      noz.castShadow = true;
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
    haloMat.color.setHex(p.accent);
    rim.color.setHex(p.creature).lerp(new THREE.Color(0xbcd4ff), 0.6);
    ghostMat.color.setHex(p.accent);
    hintMat.color.setHex(highContrast ? 0xd00000 : p.accent);
    key.color.setHex(p.light);
    hemi.color.setHex(p.light);
    hemi.groundColor.setHex(p.desk);
    scene.fog = new THREE.Fog(p.fog, 14, 34);
    scene.background = new THREE.Color(p.fog);
    fitFog();
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
    playbackPausedAt = null;
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
        if (rec) spawnParticles((rec.mesh.position.x) * S + 500, rec.mesh.position.y * S, 0xfff0c0, q.particles === 'low' ? 3 : 8, 2.2);
      } else if (ev.type === 'hit') {
        flashHit(ev.creature || 0);
        if (!motionOff()) shake = Math.min(0.5, shake + 0.3);
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
    playbackPausedAt = null;
    Array.from(activeHazards.keys()).forEach(freeHazardMesh);
  }

  // Pause/resume cosmetic playback (pause menu, backgrounded tab). While
  // paused the loop skips playback advance; on resume startMs is shifted so
  // the trace continues from the exact tick it froze at.
  function pauseTrace() {
    if (playback && !playback.done && playbackPausedAt == null) {
      playbackPausedAt = performance.now();
    }
  }
  function resumeTrace() {
    if (playback && playbackPausedAt != null) {
      playback.startMs += performance.now() - playbackPausedAt;
    }
    playbackPausedAt = null;
  }

  // ---------- fx helpers ----------
  function flashHit(creatureIndex) {
    const c = creatures[creatureIndex || 0];
    if (!c) return;
    c.flashUntil = performance.now() + 450;
    spawnParticles(500 + c.group.position.x * S, c.group.position.y * S, 0xe04a3a, q.particles === 'low' ? 4 : 14, 3);
  }

  function celebrate() {
    creatures.forEach(function (c) {
      spawnParticles(500 + c.group.position.x * S, c.group.position.y * S, 0xffd34d, q.particles === 'low' ? 5 : 18, 3.2);
    });
    if (!motionOff()) shake = Math.min(0.35, shake + 0.12);
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

  // ---------- graphics settings ----------
  // Shadow frustum fitted to the page plus a small desk margin, so every
  // shadow texel lands on the play area.
  function fitShadow() {
    key.target.position.set(PAGE_CX, PAGE_CY, 0);
    _v3.set(4, 5.5, 7).normalize();
    key.position.copy(key.target.position).addScaledVector(_v3, 14);
    key.updateMatrixWorld(); key.target.updateMatrixWorld();
    const cam = key.shadow.camera;
    cam.position.copy(key.position);
    cam.lookAt(key.target.position);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorld.clone().invert();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const hw = pageW / 2 + 0.7;
    for (let i = 0; i < 8; i++) {
      _v3b.set(PAGE_CX + (i & 1 ? hw : -hw), (i & 2 ? pageH + 0.7 : -0.7), i & 4 ? 0.8 : -0.55).applyMatrix4(inv);
      x0 = Math.min(x0, _v3b.x); x1 = Math.max(x1, _v3b.x);
      y0 = Math.min(y0, _v3b.y); y1 = Math.max(y1, _v3b.y);
      z0 = Math.min(z0, _v3b.z); z1 = Math.max(z1, _v3b.z);
    }
    cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1;
    cam.near = Math.max(0.1, -z1 - 0.5); cam.far = -z0 + 0.5;
    cam.updateProjectionMatrix();
  }
  fitShadow();

  function styleHazardMat(type, m) {
    const rich = q.detail === 'detailed';
    m.roughness = type === 'drop' ? (rich ? 0.25 : 0.35) : type === 'pebble' ? 0.7 : type === 'gale' ? 0.3 : 0.45;
    m.clearcoat = rich ? (type === 'drop' ? 0.6 : type === 'pebble' ? 0 : 0.4) : 0;
    m.clearcoatRoughness = 0.15;
    // Embers run HDR-bright when bloom is on so only they (and sparks) glow.
    if (type === 'ember') m.emissiveIntensity = q.bloom === 'on' ? 1.7 : 0.55;
  }

  // Image-based lighting per material (scene.environment would force one
  // intensity on everything; paper must stay matte so ink keeps its contrast).
  const ENV_INTENSITY = [[deskMat, 0.3], [pageMat, 0.12], [pageEdgeMat, 0.2], [inkMat, 0.35], [creatureMat, 0.35],
    [obstacleMat, 0.35], [emitterMat, 0.9]];
  function applyReflections() {
    const env = q.reflections === 'on' ? environment() : null;
    const set = function (m, k) {
      if (m.envMap !== env) { m.envMap = env; m.needsUpdate = true; }
      m.envMapIntensity = k;
    };
    ENV_INTENSITY.forEach(function (e) { set(e[0], e[1]); });
    Object.keys(hazardPools).forEach(function (t) { set(hazardPools[t].mat, t === 'drop' ? 0.45 : 0.4); });
    hemi.intensity = env ? 0.7 : 0.85; // IBL takes over part of the fill
  }

  function applyDetail() {
    const rich = q.detail === 'detailed';
    if (rich && !woodTex) woodTex = woodTexture();
    deskMat.map = rich ? woodTex : null;
    deskMat.roughness = rich ? 0.72 : 0.95;
    pageMat.bumpMap = rich && paperTex ? paperTex : null;
    pageMat.bumpScale = 1.4;
    inkMat.clearcoat = rich ? 0.35 : 0;
    inkMat.clearcoatRoughness = 0.25;
    inkMat.roughness = rich ? 0.4 : 0.55;
    creatureMat.clearcoat = rich ? 0.5 : 0;
    creatureMat.sheen = rich ? 0.35 : 0;
    creatureMat.roughness = rich ? 0.42 : 0.5;
    underSheets.visible = rich;
    rim.intensity = rich ? 0.55 : 0;
    creatures.forEach(function (c) { if (c.halo) c.halo.visible = rich; });
    Object.keys(hazardPools).forEach(function (t) { styleHazardMat(t, hazardPools[t].mat); });
    [deskMat, pageMat].forEach(function (m) { m.needsUpdate = true; });
  }

  let composer = null, postFailed = false, postKey = null, gradePass = null;
  let adaptiveScale = 1, frameTimes = [], fps = 0, pixelRatio = 1, sizeW = 0, sizeH = 0;

  /** Apply saved graphics settings ({preset, render_scale, adaptive, show_fps, <category>}). */
  function setGraphics(saved) {
    const json = JSON.stringify(saved || {});
    if (json === gfxSaved) return;
    gfxSaved = json;
    const prevShadows = q.shadows;
    q = resolve(saved || {}, detected);
    const size = SHADOW_MAP[q.shadows];
    renderer.shadowMap.enabled = size > 0;
    key.castShadow = size > 0;
    if (size > 0 && key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    if ((prevShadows === 'off') !== (q.shadows === 'off')) {
      // Lit materials recompile with or without shadow sampling.
      scene.traverse(function (o) {
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.needsUpdate = true; });
      });
    }
    applyReflections();
    particleCap = PARTICLE_CAP[q.particles];
    let alive = aliveParticleCount();
    for (let i = 0; i < particles.length && alive > particleCap; i++) {
      if (particles[i].alive) { particles[i].alive = false; particles[i].mesh.visible = false; alive--; }
    }
    applyDetail();
    applyMotion();
    adaptiveScale = 1;
    frameTimes.length = 0;
    postKey = null; // rebuild the post chain on the next frame
    renderer.domElement.dataset.gfxPreset = q.preset;
    document.body.dataset.gfxPreset = q.preset;
    fpsVisible(q.showFps);
  }

  function applyMotion() {
    dust.visible = q.background === 'animated' && !motionOff();
  }

  function fpsVisible(on) {
    let el = document.getElementById('gs-fps');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'gs-fps';
      el.className = 'gs-fps';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  function graphicsInfo() {
    const px = [Math.round(sizeW * pixelRatio), Math.round(sizeH * pixelRatio)];
    return {
      gpu: gpu, detected: detected, resolved: q, pixels: px,
      summary: describe(q, px), fps: Math.round(fps),
      adaptiveScale: Math.round(adaptiveScale * 100) / 100, postFailed: postFailed
    };
  }

  function buildPost(w, h) {
    if (composer) {
      composer.passes.forEach(function (ps) { if (ps.dispose) ps.dispose(); });
      composer.dispose();
    }
    composer = null; gradePass = null;
    if (!q.post || postFailed) return;
    try {
      const pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
      const target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0 });
      const c = new EffectComposer(renderer, target);
      c.setPixelRatio(pixelRatio);
      c.setSize(w, h);
      c.addPass(new RenderPass(scene, camera));
      if (q.ao !== 'off') {
        const hi = q.ao === 'high';
        const ao = new GTAOPass(scene, camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = hi ? 0.85 : 0.7;
        ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 0.6, scale: 1.0, samples: hi ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
        c.addPass(ao);
      }
      if (q.bloom === 'on') {
        // High threshold: only embers, sparks and glints bloom; paper stays crisp.
        c.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.45, 0.9));
      }
      c.addPass(new OutputPass());
      if (q.grade === 'on') { gradePass = new ShaderPass(GradeShader); c.addPass(gradePass); }
      if (q.antialias === 'smaa') c.addPass(new SMAAPass(pw, ph));
      if (q.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        c.addPass(fxaa);
      }
      composer = c;
    } catch (e) {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      postFailed = true;
      composer = null;
    }
  }

  // Adaptive resolution: ~90-frame average; step down when slow, back up when fast.
  function adapt(dtMs) {
    frameTimes.push(dtMs);
    if (frameTimes.length < 90) return;
    let sum = 0;
    for (let i = 0; i < frameTimes.length; i++) sum += frameTimes[i];
    const avg = sum / frameTimes.length;
    frameTimes.length = 0;
    fps = 1000 / avg;
    const el = document.getElementById('gs-fps');
    if (el && !el.hidden) el.textContent = Math.round(fps) + ' fps · ' + (Math.round(pixelRatio * 100) / 100) + '×';
    if (!q.adaptive) return;
    if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
    else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
  }

  function applySize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, q.dprCap) * q.scale * adaptiveScale;
    if (w !== sizeW || h !== sizeH || ratio !== pixelRatio) {
      sizeW = w; sizeH = h; pixelRatio = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
    }
    const k = q.post && !postFailed ? [q.ao, q.bloom, q.grade, q.antialias, w, h, ratio].join('|') : 'none';
    if (k !== postKey) { postKey = k; buildPost(w, h); }
  }

  function draw() {
    applySize();
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  function setReducedMotion(b) { reducedMotion = !!b; applyMotion(); }
  if (mqReduced && mqReduced.addEventListener) mqReduced.addEventListener('change', applyMotion);
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
    applySize();
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
    fitFog();
  }

  // Decorative fog starts beyond the page: a narrow portrait viewport pulls
  // the camera far back, and fixed fog bounds would swallow the whole board.
  function fitFog() {
    if (!scene.fog) return;
    const dist = camera.position.z;
    scene.fog.near = Math.max(14, dist + 6);
    scene.fog.far = Math.max(34, dist + 26);
  }

  // ---------- context loss ----------
  function onLost(ev) {
    ev.preventDefault();
    if (opts.onContextLost) opts.onContextLost();
  }
  function onRestored() {
    // Rebuild minimal GPU state: re-apply quality + theme; geometries persist.
    const g = gfxSaved ? JSON.parse(gfxSaved) : {};
    gfxSaved = null; postKey = null; postFailed = false;
    envTex = null; // the PMREM render target died with the context
    setGraphics(g);
    if (palette) setTheme(palette, { highContrast: highContrast });
  }
  renderer.domElement.addEventListener('webglcontextlost', onLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onRestored, false);

  // ---------- render loop ----------
  let lastMs = performance.now();
  function loop(nowMs) {
    if (disposed || !visible) return;
    requestAnimationFrame(loop);
    const rawDt = (nowMs - lastMs) / 1000;
    const dt = Math.min(0.05, rawDt);
    lastMs = nowMs;

    // creature idle bob (deterministic phase), hit flash tint
    for (let i = 0; i < creatures.length; i++) {
      const c = creatures[i];
      const still = motionOff();
      const bob = still ? 0 : Math.sin(nowMs / 600 + c.phase) * 0.035;
      c.group.position.y = c.baseY + bob;
      if (c.halo && c.halo.visible) {
        const pulse = still || q.background !== 'animated' ? 1 : 1 + Math.sin(nowMs / 900 + c.phase) * 0.06;
        c.halo.scale.setScalar(c.haloBase * pulse);
      }
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
    if (playback && !playback.done && playbackPausedAt == null) {
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
      if (!motionOff()) rec.mesh.rotation.z += dt * 2.4;
    });

    // ambient dust: slow rise with a lazy sideways sway, wrapping at the top
    if (dust.visible) {
      const t = nowMs / 1000;
      for (let i = 0; i < DUST; i++) {
        let y = dustPos[i * 3 + 1] + dt * 0.12;
        if (y > 8.5) y = -1;
        dustPos[i * 3 + 1] = y;
        dustPos[i * 3] += Math.sin(t * 0.4 + dustSeed[i]) * dt * 0.08;
      }
      dustGeo.attributes.position.needsUpdate = true;
    }

    updateParticles(dt);

    // camera shake (decaying, camera only)
    if (shake > 0.001 && !motionOff()) {
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

    adapt(Math.min(250, rawDt * 1000));
    draw();
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
    if (composer) composer.dispose();
    if (envTex) envTex.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  // boot
  setGraphics({});
  resize();
  // prewarm: compile shaders and render once before first real frame
  renderer.compile(scene, camera);
  draw();
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
    pauseTrace: pauseTrace,
    resumeTrace: resumeTrace,
    isPlaying: function () { return !!playback; },
    traceProgress: function () {
      if (!playback) return 1;
      return Math.min(1, currentTick(playback) / playback.trace.ticks);
    },
    screenToWorld: screenToWorld,
    worldToScreen: worldToScreen,
    setReducedMotion: setReducedMotion,
    setGraphics: setGraphics,
    graphicsInfo: graphicsInfo,
    resize: resize,
    setViewportInsets: setViewportInsets,
    setVisible: setVisible,
    flashHit: flashHit,
    celebrate: celebrate,
    shakeSmall: function () { if (!motionOff()) shake = Math.min(0.3, shake + 0.08); },
    dispose: dispose
  };
}
