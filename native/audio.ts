// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, mapped to the game's logical events by
// sfx/manifest.json; ink and stroke cues pitch-varied ±6 % from the round's
// seeded av stream, so a replay sounds the same), the captions it showed for
// meaningful sounds when Captions is on, the quiet studio room tone (brown-ish
// noise lowpassed at 300 Hz) and the slow generative pad (Am, F, G, Dm an
// octave down through a 650 Hz lowpass: three voices a chord, rising over
// 1.8 s and gone by 6.4 s, a chord every 5.2 s).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu tap → "interface"; the old default bus
// levels (music 60 %, effects 90 %, ambience 50 %) are folded into each
// sound's gain. The voice bus carried nothing and is gone. The pad and the
// ambience, which the browser build made with oscillators and a noise
// buffer, are rendered once into clips (createClip); the synthesized
// stand-ins it played while a sample loaded are not ported (the engine's web
// runtime drops clip loads while a synthesis graph changes). Clips load once
// the mixer runs (natively at once, in a browser after the first press), one
// at a time.
import { files } from "starhermit:engine";
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.6, effects: 0.9, ambience: 0.5 };
/** Caption text per logical event (js/audio.js CAPTIONS). */
const CAPTIONS: Record<string, string> = {
  stroke: "ink stroke", invalid: "not allowed", release: "storm released", block: "blocked",
  hit: "creature hit", win: "creature saved", lose: "round lost", undo: "undo", hint: "hint",
  "block-ember": "ember blocked", "block-gale": "gust deflected", "block-pebble": "pebble blocked",
  achievement: "achievement unlocked", lesson: "lesson complete", pause: "paused",
};
// The game's first sounds load first.
const FIRST = ["ui", "draw-start", "stroke", "invalid", "release", "spawn", "block", "hit", "win", "lose"];
/** Events whose pitch varies with the round's av stream (js/audio.js variant()). */
const VARIED = new Set(["stroke", "spawn", "block", "block-ember", "block-gale", "block-pebble"]);
let avRng: { next(): number } | null = null;
/** The round's seeded av stream (replays sound the same). */
export function setAvRng(rng: { next(): number } | null): void { avRng = rng; }

const eventFile = new Map<string, string>();
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Reads the manifest and asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name?: string; event?: string }[];
    for (const e of Array.isArray(list) ? list : []) {
      if (e && typeof e.name === "string" && typeof e.event === "string" && !eventFile.has(e.event)) eventFile.set(e.event, e.name);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  wantClips = true;
}

let captionFn: ((text: string) => void) | null = null;
/** fn(caption key) for each meaningful sound (the browser build's caption strip). */
export function onCaption(fn: (text: string) => void): void { captionFn = fn; }

/** Plays a logical event's sample (js/audio.js play); unknown or still-loading samples are silent. */
export function play(event: string): void {
  const file = eventFile.get(event);
  const clip = file ? clips.get(file) : undefined;
  if (clip) {
    const bus: Bus = event === "ui" ? "interface" : "effects";
    const pitch = VARIED.has(event) ? 0.94 + (avRng ? avRng.next() : Math.random()) * 0.12 : 1;
    try { playClip(clip, { bus, gain: LEVEL.effects, pitch }); }
    catch { clips.delete(file!); load(file!); } // a clip the mixer lost: load it again
  }
  const cap = CAPTIONS[event];
  if (cap && captionFn) captionFn(cap);
}

// -- rendered voices ------------------------------------------------------------------------
const RATE = 11025;
/** One pad chord an octave down: a triangle root and two sines through a 650 Hz lowpass, up to 0.05 over 1.8 s, gone by 6.4 s. */
function chordClip(freqs: number[]): AudioClip {
  const n = Math.round(6.6 * RATE);
  const out = new Float32Array(n);
  freqs.forEach((f0, vi) => {
    const f = f0 * 0.5;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const e = t < 1.8 ? 0.05 * (t / 1.8) : t < 6.4 ? 0.05 * (1 - (t - 1.8) / 4.6) : 0;
      const ph = (f * t) % 1;
      const w = vi === 0 ? 1 - 4 * Math.abs(ph - 0.5) : Math.sin(2 * Math.PI * ph);
      out[i]! += w * e;
    }
  });
  // RBJ biquad lowpass at 650 Hz, Q 0.707 (the browser build's BiquadFilter)
  const w0 = (2 * Math.PI * 650) / RATE, alpha = Math.sin(w0) / (2 * 0.707), c = Math.cos(w0), a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const x0 = out[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return createClip([out], RATE);
}
/** The studio room tone: brown-ish noise lowpassed at 300 Hz, at 0.32, as a 4 s loop whose ends cross-fade. */
function ambienceClip(): AudioClip {
  const n = 4 * RATE, fade = RATE;
  const raw = new Float32Array(n + fade);
  let seed = 4242, last = 0;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 48271) % 2147483647;
    const w = (seed / 2147483647) * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    raw[i] = last * 3.5;
  }
  // RBJ biquad lowpass at 300 Hz, Q 0.707
  const w0 = (2 * Math.PI * 300) / RATE, alpha = Math.sin(w0) / (2 * 0.707), c = Math.cos(w0), a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < raw.length; i++) {
    const x0 = raw[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    raw[i] = y0;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = raw[i]!;
    if (i < fade) { const k = i / fade; v = v * k + raw[n + i]! * (1 - k); }
    out[i] = Math.max(-1, Math.min(1, v * 0.32));
  }
  return createClip([out], RATE);
}
const CHORDS = [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66], [146.83, 174.61, 220.0]];
const chords: AudioClip[] = [];
let hum: AudioClip | null = null;
/** One rendered voice a frame, once the samples are in; false when all are made. */
function renderNext(): boolean {
  if (chords.length < CHORDS.length) { chords.push(chordClip(CHORDS[chords.length]!)); return true; }
  if (!hum) { hum = ambienceClip(); return true; }
  return false;
}

// -- music and ambience ---------------------------------------------------------------------
let ambSound: Sound | null = null;
let ambStarted = false;
let nextChord = 0;
let step = 0;

/** Each frame: the samples once the mixer runs, one rendered voice a frame,
 * then the ambience loop and the pad's chords by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    const firstFiles = FIRST.map((e) => eventFile.get(e)).filter((f): f is string => !!f);
    for (const name of firstFiles) load(name);
    for (const name of eventFile.values()) load(name);
  }
  pump();
  if (loading || queue.length) return;
  try { if (renderNext()) return; } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  const now = context.currentTime;
  if (!ambStarted && hum) {
    ambStarted = true;
    try { ambSound = playClip(hum, { bus: "effects", gain: 0.0001, loop: true }); ambSound.fade(LEVEL.ambience, 1.5); }
    catch { ambSound = null; }
    return; // the pad starts on a frame of its own
  }
  if (now >= nextChord) {
    if (nextChord === 0 || now - nextChord > 1) nextChord = now;
    const clip = chords[step % chords.length];
    if (clip) { try { playClip(clip, { bus: "music", gain: LEVEL.music }); } catch { /* the mixer is full */ } }
    step++;
    nextChord += 5.2;
  }
}
