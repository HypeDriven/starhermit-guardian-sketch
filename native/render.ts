// The living sketchbook on starhermit:scene, as the browser build's
// js/render.js drew it: a raised cream page (paper grain, relief when
// detailed) on a dark desk (procedural wood grain when detailed, two loose
// sheets under the page), the wisps (squashed spheres with bead eyes, an
// amber ring on the page and an additive lamp-lit halo when detailed), the
// ledges, the emitter cones, the committed ink as round tubes that scale in,
// the amber ghost of the stroke being drawn, the dashed hint shield, the
// pooled hazards (teardrop, icosahedron pebble, glowing octahedron ember,
// flat torus gale) played back from the rules' recorded trace, the shards
// (one instanced mesh: white on blocks, red on hits, gold on a save), the
// dust drifting through the lamp light, and the small decaying camera shake.
// Lighting is the warm desk-lamp key (its shadow fitted to the page), the
// hemisphere fill in the theme's colours and the cool rim; ACES tone mapping
// and the old post chain (ambient occlusion, bloom on HDR highlights only,
// the colour grade with its vignette, FXAA/SMAA/MSAA) as renderer settings.
//
// Gaps from three.js: there is no TubeGeometry or CatmullRomCurve3, so the
// ink tube is built here from the same Catmull-Rom (tension 0.5) the browser
// build used; the grade pass is `renderer.grade`. Lights, the shadow box
// fitted to the page and the per-material envMaps are the browser build's.
//
// The storm is played by fixed steps (60 a second, `stepTrace`), not by the
// wall clock, so pausing freezes it on its exact tick and play scripts see
// the same storm every run.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry,
  DirectionalLight, Fog, Group, HemisphereLight, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OctahedronGeometry, PerspectiveCamera, PMREMGenerator, Plane,
  PlaneGeometry, Points, PointsMaterial, Quaternion, Euler, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace,
  SphereGeometry, TetrahedronGeometry, TextureLoader, TorusGeometry, Vector3, pointerToNdc, renderer, scene,
  type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { Content, RNG, type Cfg, type Ev, type HazardType, type Pt, type Theme, type Trace } from "./classic.ts";
import { DUST_MAX, type Look } from "./quality.ts";

// ---------- framing constants (authored, not magic) ----------
export const FRAMING = {
  WORLD_W: 1000, WORLD_H: 700,
  SCALE: 100,      // world units per scene unit (page = 10 x 7)
  FOV: 40,         // low-distortion perspective
  MARGIN: 1.10,    // page fill margin
  CAM_LIFT: 0.9,   // slight camera height for a tabletop feel
  PAGE_Z: 0,
  BOUNDS_PAD: 24,  // matches the rules' BOUNDS_PAD (world units)
};
const S = FRAMING.SCALE;
const PI = Math.PI;
const PAGE_CX = 0, PAGE_CY = FRAMING.WORLD_H / S / 2;
const pageW = FRAMING.WORLD_W / S, pageH = FRAMING.WORLD_H / S;
const wx = (x: number): number => (x - FRAMING.WORLD_W / 2) / S;
const wy = (y: number): number => y / S;

type Palette = Theme["palette"];
const camera = new PerspectiveCamera(FRAMING.FOV, 16 / 9, 0.1, 100);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

let look: Look | null = null;
let palette: Palette | null = null;
let highContrast = false;
let reducedMotion = false;
let time = 0;

// ---------- lights ----------
// Warm desk-lamp key (shadow caster), hemisphere fill and a faint cool rim
// from the opposite side so tubes and the wisp read as round.
const key = new DirectionalLight(0xfff2dd, 2.2);
key.target.position.set(PAGE_CX, PAGE_CY, 0);
key.position.copy(key.target.position).addScaledVector(new Vector3(4, 5.5, 7).normalize(), 14);
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.01;
fitShadow();
const hemi = new HemisphereLight(0xfff4e0, 0x2b2f3a, 0.85);
const rim = new DirectionalLight(0xbcd4ff, 0);
rim.position.set(PAGE_CX - 6, PAGE_CY + 4, 3);
rim.target.position.set(PAGE_CX, PAGE_CY, 0);
scene.add(key, key.target, hemi, rim, rim.target);

// ---------- textures ----------
let paperTex: Texture | null = null;
let paperAsked = false;
function loadPaper(): void {
  if (paperAsked) return;
  paperAsked = true;
  // Authored grain; if it never arrives the page simply stays plain.
  new TextureLoader().loadAsync("assets/paper-grain.webp").then((t) => {
    t.colorSpace = SRGBColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(4, 2.8);
    t.anisotropy = 4;
    paperTex = t;
    rebuild();
  }, () => undefined);
}
let woodTex: Texture | null = null;
let woodSize = 0;
/** Procedural desk wood grain (greyscale, multiplied by the theme's desk colour), authored at 512 px. */
function woodTexture(size: number): Texture {
  if (woodTex && woodSize === size) return woodTex;
  if (woodTex) woodTex.dispose();
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext("2d");
  g.scale(size / 512, size / 512);
  g.fillStyle = "#d8d8d8"; g.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 26; i++) { // planks
    const y0 = (i * 512) / 26;
    const shade = 222 + Math.floor(rnd() * 30);
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    g.fillRect(0, y0, 512, 512 / 26);
  }
  g.globalAlpha = 0.16;
  for (let i = 0; i < 420; i++) { // grain streaks
    const y = rnd() * 512, len = 60 + rnd() * 300, x = rnd() * 512;
    const v = Math.floor(120 + rnd() * 120);
    g.strokeStyle = `rgb(${v},${v},${v})`;
    g.lineWidth = 0.6 + rnd() * 1.6;
    g.beginPath(); g.moveTo(x, y);
    g.bezierCurveTo(x + len * 0.3, y + (rnd() - 0.5) * 6, x + len * 0.6, y + (rnd() - 0.5) * 6, x + len, y + (rnd() - 0.5) * 4);
    g.stroke();
  }
  g.globalAlpha = 0.35;
  g.fillStyle = "#9a9a9a";
  for (let i = 0; i < 27; i++) g.fillRect(0, Math.round((i * 512) / 26), 512, 1.5); // plank seams
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(4.5, 3);
  woodTex = tex; woodSize = size;
  return tex;
}
let discTex: Texture | null = null;
/** Soft round sprite for the dust motes and the wisp halo. */
function softDisc(): Texture {
  if (discTex) return discTex;
  const c = new OffscreenCanvas(128, 128);
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  discTex = new CanvasTexture(c);
  discTex.colorSpace = SRGBColorSpace;
  return discTex;
}
let envTex: Texture | null = null;
function environment(): Texture | null {
  if (!envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}

// ---------- materials ----------
interface LitSpec { color: number; roughness?: number; metalness?: number; emissive?: number; emissiveIntensity?: number; physical?: boolean }
const LIT: Record<string, LitSpec> = {
  desk: { color: 0x2b2f3a, roughness: 0.8 },
  page: { color: 0xf2ecdf, roughness: 0.9 },
  pageEdge: { color: 0xd8d0bc, roughness: 0.9 },
  ink: { color: 0x2a2e38, roughness: 0.55, metalness: 0.05, physical: true },
  creature: { color: 0x3b4d8f, roughness: 0.5, emissive: 0x3b4d8f, emissiveIntensity: 0.12, physical: true },
  eye: { color: 0x14161c, roughness: 0.4 },
  obstacle: { color: 0x3a3f4c, roughness: 0.85 },
  emitter: { color: 0x555c6e, roughness: 0.4, metalness: 0.6 },
};
// Image-based lighting per material (paper stays matte so ink keeps its contrast).
const ENV_INTENSITY: Record<string, number> = { desk: 0.3, page: 0.12, pageEdge: 0.2, ink: 0.35, creature: 0.35, obstacle: 0.35, emitter: 0.9 };
type LitMat = MeshLambertMaterial | MeshStandardMaterial | MeshPhysicalMaterial;
/** A lit material of the budget's class: Lambert (Low), Standard, Physical for ink/wisps/hazards on High and Ultra. */
function lit(spec: LitSpec, envK: number): LitMat {
  const kind = look ? look.budget.material : "lambert";
  const emissive = spec.emissive ?? 0x000000;
  const emissiveIntensity = spec.emissiveIntensity ?? 1;
  if (kind === "lambert") return new MeshLambertMaterial({ color: spec.color, emissive, emissiveIntensity });
  const params = {
    color: spec.color, roughness: spec.roughness ?? 1, metalness: spec.metalness ?? 0, emissive, emissiveIntensity,
    envMap: look && look.reflections ? environment() : null, envMapIntensity: envK,
  };
  return kind === "physical" && spec.physical ? new MeshPhysicalMaterial(params) : new MeshStandardMaterial(params);
}
let mats: Record<string, LitMat> = {};
let glowMat: MeshBasicMaterial | null = null;
let ghostMat: MeshBasicMaterial | null = null;
let hintMat: MeshBasicMaterial | null = null;
let haloMat: MeshBasicMaterial | null = null;
let sparkMat: MeshBasicMaterial | null = null;
let dustMat: PointsMaterial | null = null;
const hazardMats = new Map<HazardType, LitMat>();

function disposeMaterials(): void {
  for (const m of Object.values(mats)) m.dispose();
  for (const m of hazardMats.values()) m.dispose();
  for (const m of [glowMat, ghostMat, hintMat, haloMat, sparkMat, dustMat]) if (m) m.dispose();
  mats = {}; hazardMats.clear();
}
function buildMaterials(): void {
  disposeMaterials();
  const p = palette ?? Content.THEMES[0]!.palette;
  const rich = !!look && look.detailed;
  for (const [k, spec] of Object.entries(LIT)) mats[k] = lit(spec, ENV_INTENSITY[k] ?? 0.35);
  mats.desk!.color.setHex(p.desk);
  mats.page!.color.setHex(p.paper);
  mats.pageEdge!.color.setHex(p.paperEdge);
  mats.ink!.color.setHex(highContrast ? 0x10131a : p.ink);
  mats.creature!.color.setHex(p.creature);
  mats.creature!.emissive.setHex(p.creature);
  // Surface detail: wood grain, paper relief, glossy wet ink, clear-coated wisps.
  mats.desk!.map = rich ? woodTexture(look!.budget.wood) : null;
  if (paperTex) mats.page!.map = paperTex;
  mats.page!.bumpMap = rich && paperTex ? paperTex : null;
  mats.page!.bumpScale = 1.4;
  if (mats.desk instanceof MeshStandardMaterial) mats.desk.roughness = rich ? 0.72 : 0.95;
  if (mats.ink instanceof MeshStandardMaterial) mats.ink.roughness = rich ? 0.4 : 0.55;
  if (mats.creature instanceof MeshStandardMaterial) mats.creature.roughness = rich ? 0.42 : 0.5;
  if (mats.ink instanceof MeshPhysicalMaterial) { mats.ink.clearcoat = rich ? 0.35 : 0; mats.ink.clearcoatRoughness = 0.25; }
  if (mats.creature instanceof MeshPhysicalMaterial) { mats.creature.clearcoat = rich ? 0.5 : 0; mats.creature.clearcoatRoughness = 0.25; }
  glowMat = new MeshBasicMaterial({ color: p.accent, transparent: true, opacity: 0.22, depthWrite: false });
  ghostMat = new MeshBasicMaterial({ color: p.accent, transparent: true, opacity: 0.45, depthWrite: false });
  hintMat = new MeshBasicMaterial({ color: highContrast ? 0xd00000 : p.accent, transparent: true, opacity: 0.55, depthWrite: false });
  haloMat = new MeshBasicMaterial({ color: p.accent, map: softDisc(), transparent: true, opacity: 0.5, depthWrite: false, blending: AdditiveBlending });
  // Rich particles: HDR-bright shards (not tone-mapped) so bloom makes them sparkle.
  sparkMat = new MeshBasicMaterial({ color: 0xffffff });
  sparkMat.toneMapped = !(look && look.richParticles);
  dustMat = new PointsMaterial({ color: 0xfff2dd, size: 0.07, map: softDisc(), transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending });
  for (const t of Object.keys(Content.HAZARDS) as HazardType[]) {
    const hz = Content.HAZARDS[t];
    const color = highContrast ? hz.colorHC : hz.color;
    const ember = t === "ember";
    const m = lit({ color, roughness: 0.45, emissive: ember ? color : 0x000000, emissiveIntensity: ember ? 0.55 : 0, physical: true }, t === "drop" ? 0.45 : 0.4);
    if (m instanceof MeshStandardMaterial) m.roughness = t === "drop" ? (rich ? 0.25 : 0.35) : t === "pebble" ? 0.7 : t === "gale" ? 0.3 : 0.45;
    if (m instanceof MeshPhysicalMaterial) { m.clearcoat = rich ? (t === "drop" ? 0.6 : t === "pebble" ? 0 : 0.4) : 0; m.clearcoatRoughness = 0.15; }
    // Embers run HDR-bright when bloom is on so only they (and sparks) glow.
    if (ember) m.emissiveIntensity = look && look.bloom ? 1.7 : 0.55;
    hazardMats.set(t, m);
  }
}

// ---------- geometry (round LOD from the budget) ----------
let geo: {
  creature: BufferGeometry; eye: BufferGeometry; ring: BufferGeometry; emitter: BufferGeometry; obstacle: BufferGeometry;
  halo: BufferGeometry; spark: BufferGeometry; hazards: Record<HazardType, BufferGeometry>; dash: BufferGeometry;
} | null = null;
let geoSeg = 0;
function buildGeometry(seg: number): void {
  if (geo && geoSeg === seg) return;
  if (geo) {
    for (const g of [geo.creature, geo.eye, geo.ring, geo.emitter, geo.obstacle, geo.halo, geo.spark, geo.dash, ...Object.values(geo.hazards)]) g.dispose();
  }
  geoSeg = seg;
  const k = seg / 24; // 24 = the original authored detail
  const n = (base: number, min: number): number => Math.max(min, Math.round(base * k));
  geo = {
    creature: new SphereGeometry(1, seg, n(18, 8)),
    eye: new SphereGeometry(0.07, n(10, 6), n(8, 4)),
    ring: new RingGeometry(0.85, 1.12, n(40, 20)),
    emitter: new ConeGeometry(0.16, 0.34, n(10, 6)),
    obstacle: new BoxGeometry(1, 1, 0.14),
    halo: new PlaneGeometry(1, 1),
    spark: new TetrahedronGeometry(0.07),
    dash: new BoxGeometry(1, 0.075, 0.03),
    hazards: {
      drop: new SphereGeometry(1, n(12, 8), n(10, 6)),
      pebble: new IcosahedronGeometry(1, 0),
      ember: new OctahedronGeometry(1, 0),
      gale: new TorusGeometry(0.8, 0.32, n(8, 5), n(16, 10)),
    },
  };
}

// ---------- the ink tube (three.js CatmullRomCurve3 'catmullrom' + TubeGeometry) ----------
type V3 = [number, number, number];
function catmull(pts: V3[], tension: number, t: number): V3 {
  const l = pts.length;
  const p = (l - 1) * t;
  let i = Math.floor(p), w = p - i;
  if (w === 0 && i === l - 1) { i = l - 2; w = 1; }
  const at = (j: number): V3 => {
    if (j < 0) { const a = pts[0]!, b = pts[1]!; return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]]; }
    if (j > l - 1) { const a = pts[l - 1]!, b = pts[l - 2]!; return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]]; }
    return pts[j]!;
  };
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  const out: V3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const x0 = p0[c]!, x1 = p1[c]!, x2 = p2[c]!, x3 = p3[c]!;
    const t0 = tension * (x2 - x0), t1 = tension * (x3 - x1);
    const c0 = x1, c1 = t0, c2 = -3 * x1 + 3 * x2 - 2 * t0 - t1, c3 = 2 * x1 - 2 * x2 + t0 + t1;
    out[c] = c0 + c1 * w + c2 * w * w + c3 * w * w * w;
  }
  return out;
}
/** A tube along the stroke's points (world units), `segs` long and `radial` round, open at the ends. */
function tubeGeometry(ptsWorld: Pt[], radius: number, segs: number, radial: number): BufferGeometry {
  const z = FRAMING.PAGE_Z + radius + 0.02;
  const pts: V3[] = ptsWorld.map((p) => [wx(p[0]), wy(p[1]), z]);
  const tension = pts.length === 2 ? 0 : 0.5;
  // Arc-length table (three.js: 200 divisions) so segments are evenly spaced.
  const DIV = 200;
  const dense: V3[] = [];
  const lens: number[] = [0];
  for (let i = 0; i <= DIV; i++) {
    dense.push(catmull(pts, tension, i / DIV));
    if (i) { const a = dense[i - 1]!, b = dense[i]!; lens.push(lens[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  }
  const total = lens[DIV]! || 1;
  const pointAt = (u: number): V3 => {
    const target = u * total;
    let lo = 0, hi = DIV;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (lens[mid]! < target) lo = mid; else hi = mid; }
    const seg = lens[hi]! - lens[lo]!;
    const f = seg > 0 ? (target - lens[lo]!) / seg : 0;
    return catmull(pts, tension, (lo + f) / DIV);
  };
  const centers: V3[] = [];
  for (let i = 0; i <= segs; i++) centers.push(pointAt(i / segs));
  const pos = new Float32Array((segs + 1) * (radial + 1) * 3);
  const nor = new Float32Array(pos.length);
  const uv = new Float32Array((segs + 1) * (radial + 1) * 2);
  let tx = 1, ty = 0;
  for (let i = 0; i <= segs; i++) {
    const a = centers[Math.max(0, i - 1)]!, b = centers[Math.min(segs, i + 1)]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], dl = Math.hypot(dx, dy);
    if (dl > 1e-6) { tx = dx / dl; ty = dy / dl; }
    const c = centers[i]!;
    // The curve lies in the page plane: one ring direction across it, one out of the page.
    const ux = -ty, uy = tx;
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * PI * 2;
      const cs = -Math.cos(v), sn = Math.sin(v);
      const nx = cs * ux, ny = cs * uy, nz = sn;
      const o = (i * (radial + 1) + j) * 3;
      nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
      pos[o] = c[0] + radius * nx; pos[o + 1] = c[1] + radius * ny; pos[o + 2] = c[2] + radius * nz;
      const q = (i * (radial + 1) + j) * 2;
      uv[q] = i / segs; uv[q + 1] = j / radial;
    }
  }
  const idx: number[] = [];
  for (let j = 1; j <= segs; j++) {
    for (let i = 1; i <= radial; i++) {
      const a = (radial + 1) * (j - 1) + (i - 1), b = (radial + 1) * j + (i - 1), c = (radial + 1) * j + i, d = (radial + 1) * (j - 1) + i;
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("normal", new BufferAttribute(nor, 3));
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
/** Ink tube LOD from the budget: radial segments and length segments (× tubeLen). */
function strokeGeometry(pts: Pt[], thickness: number): BufferGeometry {
  const radius = Math.max(2, thickness) / S / 2;
  const b = look!.budget;
  const segs = Math.min(720, Math.max(8, Math.round(pts.length * 4 * b.tubeLen)));
  return tubeGeometry(pts, radius, segs, b.tube);
}

// ---------- the scene's objects ----------
let root: Group | null = null;
let ghostGroup: Group | null = null;
interface CreatureFx { holder: Group; halo: Mesh; haloBase: number; baseY: number; phase: number; flashUntil: number }
let creatures: CreatureFx[] = [];
interface StrokeFx { pts: Pt[]; mesh: Mesh | null; bornAt: number | null }
const strokes: StrokeFx[] = [];
let ghostPts: Pt[] | null = null;
let ghostDirty = false;
let ghostMesh: Mesh | null = null;
let hintStrokes: { points: Pt[] }[] | null = null;
let cfg: Cfg | null = null;
let sparks: InstancedMesh | null = null;
let dust: Points | null = null;
const dustPos = new Float32Array(DUST_MAX * 3);
const dustSeed = new Float32Array(DUST_MAX);
{
  let s = 4711;
  const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < DUST_MAX; i++) {
    dustSeed[i] = rnd() * 1000;
    dustPos[i * 3] = PAGE_CX + (rnd() - 0.5) * 13;
    dustPos[i * 3 + 1] = -1 + rnd() * 9.5;
    dustPos[i * 3 + 2] = 0.4 + rnd() * 2.4;
  }
}
const dustAttr = new BufferAttribute(dustPos, 3);
interface Spark { alive: boolean; x: number; y: number; z: number; rx: number; ry: number; vx: number; vy: number; vz: number; life: number; maxLife: number }
let particles: Spark[] = [];
const activeHazards = new Map<number, { mesh: Mesh; type: HazardType }>();
let shake = 0;
const thickness = (): number => (cfg && cfg.ink && cfg.ink.thickness) || 12;

function disposeTree(g: Group | null): void {
  if (!g) return;
  g.traverse((o) => { if (o instanceof Mesh && o.userData.ownGeometry) o.geometry.dispose(); });
  scene.remove(g);
}
/** Rebuilds every object for the current look, theme and level (strokes re-tessellate from their points). */
function rebuild(): void {
  if (!look) return;
  disposeTree(root);
  disposeTree(ghostGroup);
  root = null; ghostGroup = null; ghostMesh = null; creatures = []; activeHazards.clear();
  buildGeometry(look.budget.sphere);
  buildMaterials();
  const G = geo!;
  root = new Group();
  ghostGroup = new Group();
  scene.add(root, ghostGroup);
  const rich = look.detailed;

  // desk + page
  const desk = new Mesh(new PlaneGeometry(90, 64), mats.desk!);
  desk.userData.ownGeometry = true;
  desk.position.set(PAGE_CX, PAGE_CY, -0.5);
  desk.receiveShadow = true;
  const edge = new Mesh(new BoxGeometry(pageW + 0.24, pageH + 0.24, 0.05), mats.pageEdge!);
  edge.userData.ownGeometry = true;
  edge.position.set(PAGE_CX, PAGE_CY, FRAMING.PAGE_Z - 0.045);
  edge.castShadow = true;
  const page = new Mesh(new BoxGeometry(pageW, pageH, 0.04), mats.page!);
  page.userData.ownGeometry = true;
  page.position.set(PAGE_CX, PAGE_CY, FRAMING.PAGE_Z - 0.02);
  page.receiveShadow = true; page.castShadow = true;
  root.add(desk, edge, page);
  if (rich) { // a couple of loose sheets under the page so it reads as a sketchbook
    for (const o of [[0.1, -0.08, -0.012, -0.09], [-0.14, -0.05, 0.018, -0.13]] as const) {
      const sh = new Mesh(new BoxGeometry(pageW + 0.1, pageH + 0.1, 0.02), mats.pageEdge!);
      sh.userData.ownGeometry = true;
      sh.position.set(PAGE_CX + o[0], PAGE_CY + o[1], o[3]);
      sh.rotation.z = o[2];
      sh.castShadow = true; sh.receiveShadow = true;
      root.add(sh);
    }
  }
  rim.intensity = rich ? 0.55 : 0;
  hemi.intensity = look.reflections ? 0.7 : 0.85; // IBL takes over part of the fill
  const p = palette ?? Content.THEMES[0]!.palette;
  rim.color.setHex(p.creature).lerp(new Color(0xbcd4ff), 0.6);
  key.color.setHex(p.light);
  hemi.color.setHex(p.light);
  hemi.groundColor.setHex(p.desk);
  scene.fog = new Fog(p.fog, 14, 34);
  scene.background = new Color(p.fog);
  const shadows = look.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  key.castShadow = shadows;
  if (shadows) key.shadow.mapSize = look.shadows;

  if (cfg) {
    const decor = RNG.derive(cfg.seed || 0, RNG.STREAM_DECOR);
    for (const cr of cfg.creatures || []) {
      const g = new Group();
      const body = new Mesh(G.creature, mats.creature!);
      const r = cr.r / S;
      body.scale.set(r, r * 0.82, r * 0.7);
      body.castShadow = true;
      const eL = new Mesh(G.eye, mats.eye!), eR = new Mesh(G.eye, mats.eye!);
      eL.position.set(-r * 0.34, r * 0.18, r * 0.62);
      eR.position.set(r * 0.34, r * 0.18, r * 0.62);
      g.add(body, eL, eR);
      const holder = new Group();
      holder.add(g);
      holder.position.set(wx(cr.x), wy(cr.y), FRAMING.PAGE_Z + 0.12);
      const glow = new Mesh(G.ring, glowMat!); // soft ring on the page under the wisp
      glow.scale.setScalar(r);
      glow.position.set(0, wy(Math.max(4, cr.y - cr.r - 6)) - wy(cr.y), FRAMING.PAGE_Z + 0.015 - holder.position.z);
      holder.add(glow);
      const halo = new Mesh(G.halo, haloMat!); // soft lamp-lit aura (Surface detail)
      halo.scale.setScalar(r * 5);
      halo.position.set(0, 0, FRAMING.PAGE_Z + 0.02 - holder.position.z);
      halo.visible = rich;
      holder.add(halo);
      root.add(holder);
      creatures.push({ holder, halo, haloBase: r * 5, baseY: wy(cr.y), phase: decor.next() * PI * 2, flashUntil: 0 });
    }
    for (const o of cfg.obstacles || []) {
      const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1) / S;
      const mesh = new Mesh(G.obstacle, mats.obstacle!);
      mesh.scale.set(len, (o.th || 16) / S, 1);
      mesh.position.set(wx((o.x1 + o.x2) / 2), wy((o.y1 + o.y2) / 2), FRAMING.PAGE_Z + 0.07);
      mesh.rotation.z = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
      mesh.castShadow = true; mesh.receiveShadow = true;
      root.add(mesh);
    }
    for (const em of cfg.emitters || []) {
      const noz = new Mesh(G.emitter, mats.emitter!);
      noz.position.set(wx(em.x), wy(em.y), FRAMING.PAGE_Z + 0.1);
      noz.rotation.z = Math.atan2(em.dy, em.dx) - PI / 2;
      noz.castShadow = true;
      root.add(noz);
    }
  }
  for (const st of strokes) {
    st.mesh = new Mesh(strokeGeometry(st.pts, thickness()), mats.ink!);
    st.mesh.userData.ownGeometry = true;
    st.mesh.castShadow = true;
    if (st.bornAt != null) st.mesh.scale.setScalar(0.01);
    root.add(st.mesh);
  }
  ghostDirty = true;
  buildHint();
  // Sparks: one instanced mesh sized to the budget (a single draw call on every level).
  const n = Math.max(1, look.budget.sparks);
  sparks = new InstancedMesh(G.spark, sparkMat!, n);
  sparks.frustumCulled = false;
  const zero = new Matrix4().makeScale(0, 0, 0);
  const white = new Color(0xffffff);
  for (let i = 0; i < n; i++) { sparks.setMatrixAt(i, zero); sparks.setColorAt(i, white); }
  root.add(sparks);
  particles = [];
  for (let i = 0; i < n; i++) particles.push({ alive: false, x: 0, y: 0, z: 0, rx: 0, ry: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 });
  // Dust in the lamp light (Ambient motion).
  const dg = new BufferGeometry();
  dg.setAttribute("position", dustAttr);
  dg.setDrawRange(0, look.budget.dust);
  dust = new Points(dg, dustMat!);
  dust.visible = look.animated && !reducedMotion;
  root.add(dust);
  if (playback) placeHazards(playback.tick, 0);
}

function buildHint(): void {
  if (!ghostGroup || !geo) return;
  for (const c of [...ghostGroup.children]) if (c.userData.hint) ghostGroup.remove(c);
  if (!hintStrokes) return;
  // Dashed look: small dashes along the polyline.
  for (const st of hintStrokes) {
    const pts = st.points;
    if (!pts || pts.length < 2) continue;
    for (let i = 1; i < pts.length; i++) {
      const x1 = pts[i - 1]![0], y1 = pts[i - 1]![1], x2 = pts[i]![0], y2 = pts[i]![1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const dashes = Math.max(2, Math.floor(len / 40));
      for (let d = 0; d < dashes; d++) {
        const t0 = (d + 0.15) / dashes, t1 = (d + 0.7) / dashes;
        const ax = x1 + (x2 - x1) * t0, ay = y1 + (y2 - y1) * t0;
        const bx = x1 + (x2 - x1) * t1, by = y1 + (y2 - y1) * t1;
        const dash = new Mesh(geo.dash, hintMat!);
        dash.userData.hint = true;
        dash.scale.set(Math.hypot(bx - ax, by - ay) / S, 1, 1);
        dash.position.set(wx((ax + bx) / 2), wy((ay + by) / 2), FRAMING.PAGE_Z + 0.09);
        dash.rotation.z = Math.atan2(by - ay, bx - ax);
        ghostGroup.add(dash);
      }
    }
  }
}
function updateGhost(): void {
  if (!ghostDirty || !ghostGroup || !look) return;
  ghostDirty = false;
  if (ghostMesh) { ghostGroup.remove(ghostMesh); ghostMesh.geometry.dispose(); ghostMesh = null; }
  if (!ghostPts || ghostPts.length < 2) return;
  ghostMesh = new Mesh(strokeGeometry(ghostPts, thickness() * 0.8), ghostMat!);
  ghostMesh.userData.ownGeometry = true;
  ghostGroup.add(ghostMesh);
}

// ---------- public: level, strokes, ghost, hint ----------
/** The round's page (or the title's backdrop); clears strokes, the ghost, the hint and any storm. */
export function setLevel(c: Cfg | null): void {
  stopTrace();
  cfg = c;
  strokes.length = 0;
  ghostPts = null;
  hintStrokes = null;
  rebuild();
}
export function addStroke(pts: Pt[]): void {
  strokes.push({ pts, mesh: null, bornAt: reducedMotion ? null : time });
  ghostPts = null; ghostDirty = true;
  hintStrokes = null;
  if (root && look) {
    const st = strokes[strokes.length - 1]!;
    st.mesh = new Mesh(strokeGeometry(pts, thickness()), mats.ink!);
    st.mesh.userData.ownGeometry = true;
    st.mesh.castShadow = true;
    if (st.bornAt != null) st.mesh.scale.setScalar(0.01);
    root.add(st.mesh);
    buildHint();
  }
}
export function removeLastStroke(): void {
  const st = strokes.pop();
  if (st && st.mesh && root) { root.remove(st.mesh); st.mesh.geometry.dispose(); }
  showHint(null);
}
export function showGhost(pts: Pt[] | null): void { ghostPts = pts && pts.length > 1 ? pts.slice() : null; ghostDirty = true; }
export function showHint(list: { points: Pt[] }[] | null): void { hintStrokes = list; buildHint(); }

// ---------- trace playback ----------
interface Playback { trace: Trace; events: Ev[]; evIdx: number; tick: number; onEvent: (ev: Ev) => void; onDone: () => void; done: boolean; spawnById: Map<number, { hazard: HazardType; r: number }> }
let playback: Playback | null = null;
export function playTrace(trace: Trace, events: Ev[], onEvent: (ev: Ev) => void, onDone: () => void): void {
  stopTrace();
  const evs = events.filter((e) => e.tick != null).sort((a, b) => (a.tick || 0) - (b.tick || 0));
  playback = { trace, events: evs, evIdx: 0, tick: 0, onEvent, onDone, done: false, spawnById: new Map() };
  for (const sp of trace.spawns || []) playback.spawnById.set(sp.id, { hazard: sp.hazard, r: sp.r });
}
export function isPlaying(): boolean { return !!playback; }
/** 0..1 through the storm. */
export function traceProgress(): number { return playback ? Math.min(1, playback.tick / playback.trace.ticks) : 1; }
function hazardMesh(type: HazardType, r: number): Mesh {
  const mesh = new Mesh(geo!.hazards[type] ?? geo!.hazards.drop, hazardMats.get(type)!);
  mesh.castShadow = true;
  const sc = r / S;
  if (type === "drop") mesh.scale.set(sc * 0.8, sc * 1.25, sc * 0.8);
  else if (type === "gale") mesh.scale.set(sc, sc, sc * 0.55);
  else mesh.scale.set(sc, sc, sc);
  root!.add(mesh);
  return mesh;
}
/** Hazards at a (fractional) tick, interpolated between the trace's frames. */
function placeHazards(tickF: number, _alpha: number): void {
  const pb = playback;
  if (!pb || !root) return;
  const frames = pb.trace.frames;
  const pos = tickF / pb.trace.sample;
  const fi = Math.min(frames.length - 1, Math.floor(pos));
  const alpha = Math.max(0, Math.min(1, pos - fi));
  const f0 = frames[fi]!, f1 = frames[Math.min(fi + 1, frames.length - 1)]!;
  const seen = new Set<number>();
  for (const h of f1) {
    const id = h[0];
    seen.add(id);
    let x = h[1], y = h[2];
    for (const g of f0) if (g[0] === id) { x = g[1] + (h[1] - g[1]) * alpha; y = g[2] + (h[2] - g[2]) * alpha; break; }
    let rec = activeHazards.get(id);
    const sp = pb.spawnById.get(id);
    if (!rec && sp) { rec = { mesh: hazardMesh(sp.hazard, sp.r), type: sp.hazard }; activeHazards.set(id, rec); }
    if (rec) { rec.mesh.visible = true; rec.mesh.position.set(wx(x), wy(y), FRAMING.PAGE_Z + 0.16); }
  }
  for (const [id, rec] of activeHazards) if (!seen.has(id)) rec.mesh.visible = false;
}
function fireEvents(pb: Playback, tick: number): void {
  while (pb.evIdx < pb.events.length && (pb.events[pb.evIdx]!.tick || 0) <= tick) {
    const ev = pb.events[pb.evIdx++]!;
    pb.onEvent(ev);
    if (ev.type === "block" && ev.id != null) {
      const rec = activeHazards.get(ev.id);
      if (rec) burst(rec.mesh.position.x * S + 500, rec.mesh.position.y * S, 0xfff0c0, look && look.richParticles ? 8 : 3, 2.2);
    } else if (ev.type === "hit") {
      flashHit(ev.creature || 0);
      if (!reducedMotion) shake = Math.min(0.5, shake + 0.3);
    }
  }
}
function finish(pb: Playback): void {
  if (pb.done) return;
  pb.done = true;
  // settle the exact end state: last frame positions, every event fired
  pb.tick = (pb.trace.frames.length - 1) * pb.trace.sample;
  placeHazards(pb.tick, 0);
  fireEvents(pb, Infinity);
  playback = null;
  pb.onDone();
}
/** One fixed step (1/60 s) of the storm. */
export function stepTrace(): void {
  const pb = playback;
  if (!pb || pb.done) return;
  pb.tick++;
  if (pb.tick / pb.trace.sample >= pb.trace.frames.length - 1) { finish(pb); return; }
  fireEvents(pb, pb.tick);
}
/** Skip: lands exactly on the terminal state. */
export function skipTrace(): void { if (playback) finish(playback); }
export function stopTrace(): void {
  if (playback) playback.done = true;
  playback = null;
  if (root) for (const rec of activeHazards.values()) root.remove(rec.mesh);
  activeHazards.clear();
}

// ---------- fx ----------
const _m4 = new Matrix4(), _q = new Quaternion(), _e = new Euler(), _v = new Vector3(), _s = new Vector3(), _c = new Color();
function burst(x: number, y: number, colorHex: number, count: number, spread: number): void {
  if (!sparks) return;
  _c.setHex(colorHex);
  if (look && look.richParticles) _c.multiplyScalar(1.8);
  let spawned = 0;
  for (let i = 0; i < particles.length && spawned < count; i++) {
    const p = particles[i]!;
    if (p.alive) continue;
    p.alive = true;
    p.life = 0;
    p.maxLife = reducedMotion ? 0.25 : 0.55 + Math.random() * 0.35;
    p.x = wx(x); p.y = wy(y); p.z = 0.25; p.rx = 0; p.ry = 0;
    sparks.setColorAt(i, _c);
    const a = Math.random() * PI * 2;
    const sp = spread * (0.4 + Math.random() * 0.8);
    p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp * 0.9 + 1.2; p.vz = 0.6 + Math.random() * 1.4;
    spawned++;
  }
}
function flashHit(i: number): void {
  const c = creatures[i] ?? creatures[0];
  if (!c) return;
  c.flashUntil = time + 0.45;
  burst(500 + c.holder.position.x * S, c.holder.position.y * S, 0xe04a3a, look && look.richParticles ? 14 : 4, 3);
}
/** The save: gold shards from every wisp and a small shake. */
export function celebrate(): void {
  for (const c of creatures) burst(500 + c.holder.position.x * S, c.holder.position.y * S, 0xffd34d, look && look.richParticles ? 18 : 5, 3.2);
  if (!reducedMotion) shake = Math.min(0.35, shake + 0.12);
}

/** The browser build's fitShadow: the key light's ortho box tight around the page slab. */
function fitShadow(): void {
  const pos = key.position, f = new Vector3().subVectors(key.target.position, pos).normalize();
  const rt = new Vector3().crossVectors(f, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(rt, f);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const hw = pageW / 2 + 0.7, p = new Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(PAGE_CX + (i & 1 ? hw : -hw), i & 2 ? pageH + 0.7 : -0.7, i & 4 ? 0.8 : -0.55).sub(pos);
    const x = p.dot(rt), y = p.dot(up), z = -p.dot(f);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const cam = key.shadow.camera;
  Object.assign(cam, { left: x0, right: x1, bottom: y0, top: y1, near: Math.max(0.1, -z1 - 0.5), far: -z0 + 0.5 });
  cam.updateProjectionMatrix();
}

// ---------- camera, picking ----------
let insetBottom = 0;
let viewW = 1, viewH = 1;
let baseCamY = PAGE_CY + FRAMING.CAM_LIFT * 0.2;
let camDist = 20;
/** Keeps the bottom fraction of the window clear (the action tray). */
export function setInsetBottom(frac: number): void { insetBottom = Math.max(0, Math.min(0.3, frac)); fit(); }
function fit(): void {
  camera.aspect = viewW / viewH;
  const halfTan = Math.tan((FRAMING.FOV / 2) * PI / 180);
  // Fit the page into the top (1 - inset) of the window, then shift the camera
  // down so the page sits in that region (the tray stays clear).
  const vScale = 1 / (1 - insetBottom);
  const distV = ((pageH / 2) * FRAMING.MARGIN) / halfTan * vScale;
  const distH = ((pageW / 2) * FRAMING.MARGIN) / (halfTan * camera.aspect) * vScale;
  camDist = Math.max(distV, distH);
  const shift = insetBottom * camDist * halfTan;
  baseCamY = PAGE_CY + FRAMING.CAM_LIFT * 0.2 - shift;
  camera.position.set(PAGE_CX, baseCamY, camDist);
  camera.lookAt(PAGE_CX, PAGE_CY - shift, 0);
  camera.updateProjectionMatrix();
  // Decorative fog starts beyond the page (a portrait window pulls the camera far back).
  if (scene.fog instanceof Fog) { scene.fog.near = Math.max(14, camDist + 6); scene.fog.far = Math.max(34, camDist + 26); }
}
export function resize(w: number, h: number): void {
  if (w <= 0 || h <= 0) return;
  if (Math.abs(w - viewW) < 0.5 && Math.abs(h - viewH) < 0.5) return;
  viewW = w; viewH = h;
  fit();
}
/** C: re-fit the camera. */
export function refit(): void { fit(); }
const ray = new Raycaster();
const pagePlane = new Plane(new Vector3(0, 0, 1), -FRAMING.PAGE_Z);
const hitPoint = new Vector3();
/** World units (page coordinates, y up) under a window pixel, or null off the padded page. */
export function screenToWorld(x: number, y: number): { x: number; y: number } | null {
  ray.setFromCamera(pointerToNdc(x, y), camera);
  if (!ray.ray.intersectPlane(pagePlane, hitPoint)) return null;
  const px = (hitPoint.x - PAGE_CX) * S + FRAMING.WORLD_W / 2;
  const py = hitPoint.y * S;
  const pad = FRAMING.BOUNDS_PAD;
  if (px < -pad || px > FRAMING.WORLD_W + pad || py < -pad || py > FRAMING.WORLD_H + pad) return null;
  return { x: px, y: py };
}
/** The window pixel of a page point. */
export function worldToScreen(x: number, y: number): { x: number; y: number } {
  _v.set(wx(x), wy(y), FRAMING.PAGE_Z).project(camera);
  return { x: ((_v.x + 1) / 2) * viewW, y: ((1 - _v.y) / 2) * viewH };
}

// ---------- look, theme, motion ----------
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  loadPaper();
  renderer.camera = camera;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.85 : 0.7, radius: 0.35, distanceExponent: 1.4, thickness: 0.6, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only embers, sparks and glints bloom; the paper stays crisp.
  // three r170 page: the engine's r176 UnrealBloomPass model (minor 30) at the page's own strength.
  renderer.bloom = next.bloom ? { strength: 0.55, radius: 0.45, threshold: 0.9, resolution: next.budget.bloomRes, model: "r176" } : null;
  // The browser build's grade pass: a gentle S-curve (0.18), saturation 1.07,
  // cool shadows / warm highlights, the 0.2 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.18, saturation: 1.07,
    shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.97], split: [0.2, 0.8],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.9, scale: [1, 0.9] },
  } : null;
  renderer.antialias = next.antialias;
  rebuild();
}
export function setTheme(p: Palette): void {
  if (palette && JSON.stringify(palette) === JSON.stringify(p)) return;
  palette = p;
  rebuild();
}
/** High contrast: near-black ink, red hint dashes, the high-contrast hazard colours. */
export function setHighContrast(on: boolean): void {
  if (highContrast === on) return;
  highContrast = on;
  rebuild();
}
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) shake = 0;
  if (dust && look) dust.visible = look.animated && !on;
}

// ---------- the frame ----------
/** Cosmetic animation, `dt` seconds; `interp` the fraction of a fixed step since the last (smooth hazard motion). */
export function update(dtIn: number, interp: number): void {
  const dt = Math.min(0.05, Math.max(0, dtIn));
  time += dt;
  updateGhost();
  const still = reducedMotion;
  for (const c of creatures) {
    c.holder.position.y = c.baseY + (still ? 0 : Math.sin(time / 0.6 + c.phase) * 0.035);
    if (c.halo.visible) {
      const pulse = still || !look || !look.animated ? 1 : 1 + Math.sin(time / 0.9 + c.phase) * 0.06;
      c.halo.scale.setScalar(c.haloBase * pulse);
    }
  }
  const flashing = creatures.some((c) => time < c.flashUntil);
  if (mats.creature) mats.creature.emissiveIntensity = flashing ? 0.8 : 0.12;
  // stroke scale-in (160 ms, ease-out cubic)
  for (const st of strokes) {
    if (st.bornAt == null || !st.mesh) continue;
    const t = (time - st.bornAt) / 0.16;
    if (t >= 1) { st.mesh.scale.setScalar(1); st.bornAt = null; }
    else st.mesh.scale.setScalar(0.01 + 0.99 * (1 - Math.pow(1 - t, 3)));
  }
  // storm playback between fixed steps
  if (playback && !playback.done) placeHazards(playback.tick + Math.max(0, Math.min(1, interp)), 0);
  if (!still) for (const rec of activeHazards.values()) rec.mesh.rotation.z += dt * 2.4;
  // dust: slow rise with a lazy sideways sway, wrapping at the top
  if (dust && dust.visible && look) {
    for (let i = 0, n = look.budget.dust; i < n; i++) {
      let y = dustPos[i * 3 + 1]! + dt * 0.12;
      if (y > 8.5) y = -1;
      dustPos[i * 3 + 1] = y;
      dustPos[i * 3] = dustPos[i * 3]! + Math.sin(time * 0.4 + dustSeed[i]!) * dt * 0.08;
    }
    dustAttr.needsUpdate = true;
  }
  // shards: fall, tumble, shrink away as they fade
  if (sparks) {
    let any = false;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.alive = false; sparks.setMatrixAt(i, _m4.makeScale(0, 0, 0)); any = true; continue; }
      any = true;
      p.vy -= 6 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.z < 0.05) { p.z = 0.05; p.vz *= -0.4; }
      p.rx += dt * 5; p.ry += dt * 4;
      const k = Math.max(0.001, 1 - p.life / p.maxLife);
      _q.setFromEuler(_e.set(p.rx, p.ry, 0));
      sparks.setMatrixAt(i, _m4.compose(_v.set(p.x, p.y, p.z), _q, _s.set(k, k, k)));
    }
    if (any) sparks.instanceMatrix.needsUpdate = true;
  }
  // camera shake (decaying, camera only)
  if (shake > 0.001 && !still) {
    camera.position.x = PAGE_CX + (Math.random() - 0.5) * shake * 0.12;
    camera.position.y = baseCamY + (Math.random() - 0.5) * shake * 0.12;
    shake *= Math.pow(0.02, dt);
  } else if (shake !== 0) {
    shake = 0;
    camera.position.x = PAGE_CX;
    camera.position.y = baseCamY;
  }
}
