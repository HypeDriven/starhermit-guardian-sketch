/* Guardian Sketch — procedural WebAudio: original short transients per
 * logical event, ink-scratch strokes, layered impacts, quiet room tone,
 * adaptive music pad. Authored one-shot samples (sfx/*.opus, listed in
 * sfx/manifest.json) are preferred per event once lazily fetched and
 * decoded after unlock; synthesis remains the loading/failure fallback.
 * Browser global: GSAudio.
 */
(function (root) {
  'use strict';

  var ctx = null, master = null;
  var buses = {}; // music, effects, ambience, voice
  var settings = { music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false };
  var captions = false;
  var captionFn = null;
  var started = false;
  var musicTimer = null, ambienceNodes = null;
  var avRng = null; // seeded variants for replay consistency

  function ensureCtx() {
    if (ctx) return true;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    ['music', 'effects', 'ambience', 'voice'].forEach(function (name) {
      var g = ctx.createGain();
      g.gain.value = settings.muted ? 0 : (settings[name] != null ? settings[name] : 0.8);
      g.connect(master);
      buses[name] = g;
    });
    return true;
  }

  function applySettings(s) {
    Object.assign(settings, s || {});
    if (!ctx) return;
    Object.keys(buses).forEach(function (name) {
      var v = settings.muted ? 0 : (settings[name] != null ? settings[name] : 0.8);
      buses[name].gain.setTargetAtTime(v, ctx.currentTime, 0.05);
    });
  }

  function caption(text) {
    if (captions && captionFn && text) captionFn(text);
  }

  // ---------- primitive builders ----------
  function blip(freq, dur, type, gain, bus, when, sweepTo) {
    var t = (when || ctx.currentTime);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(buses[bus || 'effects']);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function noiseBurst(dur, gain, cutoff, when, type) { // filtered noise
    var t = when || ctx.currentTime;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = cutoff;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(buses.effects);
    src.start(t);
  }

  function scratch(dur, gain) { // pencil-on-paper: bandpassed noise wobble
    var t = ctx.currentTime;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 1.2;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.2);
    src.connect(f); f.connect(g); g.connect(buses.effects);
    src.start(t); src.stop(t + dur + 0.1);
  }

  function variant(base) { // seeded pitch variant (±6%) when replay consistency matters
    var r = avRng ? avRng.next() : Math.random();
    return base * (0.94 + r * 0.12);
  }

  // ---------- event map ----------
  var SFX = {
    'ui':         function () { blip(660, 0.06, 'triangle', 0.12); },
    'draw-start': function () { scratch(0.12, 0.1); },
    'stroke':     function () { scratch(0.28, 0.2); blip(variant(300), 0.1, 'sine', 0.08, 'effects', ctx.currentTime + 0.05); caption('ink stroke'); },
    'invalid':    function () { blip(160, 0.16, 'square', 0.07); blip(150, 0.14, 'square', 0.05, 'effects', ctx.currentTime + 0.05); caption('not allowed'); },
    'release':    function () {
      noiseBurst(0.35, 0.25, 700); // page flip / rumble
      blip(220, 0.4, 'sine', 0.1, 'effects', ctx.currentTime, 110);
      caption('storm released');
    },
    'spawn':      function () { blip(variant(980), 0.05, 'sine', 0.05); },
    'block':      function () { noiseBurst(0.07, 0.4, 1100); blip(variant(240), 0.07, 'sine', 0.1); caption('blocked'); },
    'bounce':     function () { noiseBurst(0.05, 0.2, 1600); },
    'hit':        function () {
      noiseBurst(0.25, 0.5, 500);
      blip(180, 0.4, 'sawtooth', 0.12, 'effects', ctx.currentTime, 70);
      caption('creature hit');
    },
    'win':        function () {
      [0, 4, 7, 12].forEach(function (st, i) {
        blip(523 * Math.pow(2, st / 12), 0.5, 'triangle', 0.13, 'effects', ctx.currentTime + i * 0.12);
      });
      caption('creature saved');
    },
    'lose':       function () { blip(300, 0.5, 'sine', 0.16, 'effects', ctx.currentTime, 180); blip(200, 0.6, 'sine', 0.1, 'effects', ctx.currentTime + 0.15, 120); caption('round lost'); },
    'undo':       function () { blip(500, 0.08, 'triangle', 0.1, 'effects', ctx.currentTime, 380); caption('undo'); },
    'hint':       function () { blip(990, 0.12, 'sine', 0.1); blip(1320, 0.14, 'sine', 0.07, 'effects', ctx.currentTime + 0.07); caption('hint'); },
    'star':       function () { blip(1568, 0.18, 'sine', 0.1); },
    'skip':       function () { noiseBurst(0.15, 0.2, 2400); }
  };

  // ---------- authored sample one-shots ----------
  // Lazy-fetch/decode/cache sfx/<name>.opus after the user-gesture unlock in
  // start(). Each event prefers its mapped sample; the synthesized fallback
  // above runs only while the sample is still loading or failed to load.
  var manifestMap = null;   // event -> sample basename (from sfx/manifest.json)
  var sampleStates = {};    // basename -> 'loading' | AudioBuffer | 'failed'

  function loadManifest() {
    if (manifestMap) return;
    manifestMap = {};
    fetch('./sfx/manifest.json')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        (Array.isArray(list) ? list : []).forEach(function (e) {
          if (e && typeof e.event === 'string' && typeof e.name === 'string' &&
              !manifestMap[e.event]) {
            manifestMap[e.event] = e.name;
          }
        });
      })
      .catch(function () { /* no manifest: synthesis stays the only path */ });
  }

  function loadSample(name) {
    if (sampleStates[name]) return;
    sampleStates[name] = 'loading';
    fetch('./sfx/' + name + '.opus')
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (bytes) { return ctx.decodeAudioData(bytes); })
      .then(function (buf) { sampleStates[name] = buf; })
      .catch(function () { sampleStates[name] = 'failed'; });
  }

  function playSample(name) {
    var src = ctx.createBufferSource();
    src.buffer = sampleStates[name];
    src.connect(buses.effects);
    src.start();
  }

  function play(name) {
    if (!started || !ctx || settings.muted) return;
    if (ctx.state === 'suspended') ctx.resume();
    loadManifest();
    var sample = manifestMap && manifestMap[name];
    if (sample) {
      var state = sampleStates[sample];
      if (state && state !== 'loading' && state !== 'failed') {
        playSample(sample);
        return;
      }
      loadSample(sample);
    }
    var fn = SFX[name];
    if (fn) fn();
  }

  // ---------- ambience: quiet studio room tone (filtered noise) ----------
  function startAmbience() {
    if (!ctx || ambienceNodes) return;
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) { // brown-ish noise
      var w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
    var g = ctx.createGain(); g.gain.value = 0.32;
    src.connect(f); f.connect(g); g.connect(buses.ambience);
    src.start();
    ambienceNodes = { src: src, gain: g };
  }

  // ---------- music: slow generative pad, seeded chord walk ----------
  var CHORDS = [
    [220.0, 261.63, 329.63], // A C E
    [174.61, 220.0, 261.63], // F A C
    [196.0, 246.94, 293.66], // G B D
    [146.83, 174.61, 220.0]  // D F A
  ];
  var chordIdx = 0;
  function schedulePad() {
    if (!ctx || settings.muted) return;
    var t = ctx.currentTime + 0.1;
    var chord = CHORDS[chordIdx % CHORDS.length];
    chordIdx++;
    chord.forEach(function (freq, i) {
      var o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = freq * 0.5;
      f.type = 'lowpass'; f.frequency.value = 650;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 1.8);
      g.gain.linearRampToValueAtTime(0.0001, t + 6.4);
      o.connect(f); f.connect(g); g.connect(buses.music);
      o.start(t); o.stop(t + 6.6);
    });
  }
  function startMusic() {
    if (musicTimer || !ctx) return;
    schedulePad();
    musicTimer = setInterval(schedulePad, 5200);
  }

  function start(opts) {
    if (!ensureCtx()) return false;
    if (ctx.state === 'suspended') ctx.resume();
    started = true;
    startAmbience();
    startMusic();
    return true;
  }

  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function resume() { if (ctx && started && ctx.state === 'suspended') ctx.resume(); }

  function setAvRng(rng) { avRng = rng; }
  function setCaptions(on, fn) { captions = !!on; captionFn = fn || captionFn; }

  root.GSAudio = {
    start: start, play: play, applySettings: applySettings,
    suspend: suspend, resume: resume, setAvRng: setAvRng, setCaptions: setCaptions,
    isStarted: function () { return started; }
  };
})(typeof self !== 'undefined' ? self : this);
