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
// buffer, are rendered once into clips (OfflineAudioContext); the synthesized
// stand-ins it played while a sample loaded are not ported (the engine's web
// runtime drops clip loads while a synthesis graph changes). The clips all
// load at once in onStart (every loaded clip reaches the mixer, natively and
// on the web); the room tone and the pad start once the mixer runs (in a
// browser after the first press).
import { files } from "starhermit:engine";
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.6, effects: 0.9, ambience: 0.5 };
/** Caption text per logical event (js/audio.js CAPTIONS). */
const CAPTIONS: Record<string, string> = {
  stroke: "ink stroke", invalid: "not allowed", release: "storm released", block: "blocked",
  hit: "creature hit", win: "creature saved", lose: "round lost", undo: "undo", hint: "hint",
  "block-ember": "ember blocked", "block-gale": "gust deflected", "block-pebble": "pebble blocked",
  achievement: "achievement unlocked", lesson: "lesson complete", pause: "paused",
};
/** Events whose pitch varies with the round's av stream (js/audio.js variant()). */
const VARIED = new Set(["stroke", "spawn", "block", "block-ember", "block-gale", "block-pebble"]);
let avRng: { next(): number } | null = null;
/** The round's seeded av stream (replays sound the same). */
export function setAvRng(rng: { next(): number } | null): void { avRng = rng; }

const eventFile = new Map<string, string>();
const clips = new Map<string, AudioClip>();
/** Reads the manifest and loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  renderVoices();
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name?: string; event?: string }[];
    for (const e of Array.isArray(list) ? list : []) {
      if (e && typeof e.name === "string" && typeof e.event === "string" && !eventFile.has(e.event)) eventFile.set(e.event, e.name);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  for (const name of new Set(eventFile.values())) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
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
    catch { /* the mixer is full this frame: skip it */ }
  }
  const cap = CAPTIONS[event];
  if (cap && captionFn) captionFn(cap);
}

// -- rendered voices (one offline context a stem) -----------------------------------------
const RATE = 11025;
/** One pad chord an octave down: a triangle root and two sines through a 650 Hz lowpass, up to 0.05 over 1.8 s, gone by 6.4 s. */
async function renderChord(freqs: number[]): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(6.6 * RATE), RATE);
  const lp = off.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 650; lp.Q.value = -3.01; // linear Q 0.707, in the node's decibels
  const env = off.createGain();
  env.gain.setValueAtTime(0, 0);
  env.gain.linearRampToValueAtTime(0.05, 1.8);
  env.gain.linearRampToValueAtTime(0, 6.4);
  freqs.forEach((f0, vi) => {
    const o = off.createOscillator();
    o.type = vi === 0 ? "triangle" : "sine"; o.frequency.value = f0 * 0.5;
    o.connect(env); o.start();
  });
  env.connect(lp).connect(off.destination);
  return createClip(await off.startRendering());
}
/** The studio room tone: brown noise lowpassed at 300 Hz, a seamless 4 s loop (filtered periodic noise is periodic once settled). */
async function renderHum(): Promise<AudioClip> {
  const n = 4 * RATE, settle = RATE;
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed: 4242, seconds: 4 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 300; lp.Q.value = -3.01;
  const g = off.createGain();
  g.gain.value = HUM_GAIN;
  noise.connect(lp).connect(g).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
const HUM_GAIN = 0.32;
const CHORDS = [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66], [146.83, 174.61, 220.0]];
const chords: (AudioClip | null)[] = CHORDS.map(() => null);
let hum: AudioClip | null = null;
function renderVoices(): void {
  const failed = (e: unknown): void => console.warn(`audio: ${String(e)}`);
  CHORDS.forEach((c, i) => { renderChord(c).then((clip) => { chords[i] = clip; }, failed); });
  renderHum().then((clip) => { hum = clip; }, failed);
}

// -- music and ambience ---------------------------------------------------------------------
let ambSound: Sound | null = null;
let ambStarted = false;
let nextChord = 0;
let step = 0;

/** Each frame once the mixer runs and the voices are rendered: the
 * ambience loop and the pad's chords by mixer time. */
export function update(): void {
  if (context.state !== "running") return; // starting the room tone and the pad still waits for the mixer
  if (!hum || chords.includes(null)) return;
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
