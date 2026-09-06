/**
 * 3rdSpace sound design — synthesized live, no audio files.
 *
 * Everything here is generated with the Web Audio API, which keeps the whole app
 * dependency-free and makes every sound a few numbers you can tune rather than a
 * binary blob you can't.
 *
 * The design brief was "pleasing to the human ear", and the things that actually
 * deliver that are not the waveform — they are:
 *
 *  1. NO HARD EDGES. Every envelope has a 6-12ms attack. A gain that jumps from
 *     0 to 1 in one sample produces a click, and clicks are what make UI audio
 *     feel cheap.
 *  2. INHARMONIC PARTIALS, gently detuned. A pure sine is sterile; a fundamental
 *     plus a partial at ~2.76x with its own shorter decay is how a struck bell
 *     behaves, and the ear reads it as "physical".
 *  3. REVERB. A short algorithmic tail (generated as a noise burst with an
 *     exponential decay, convolved) is the single biggest difference between
 *     "beep" and "sound". ~1.1s, mostly dry.
 *  4. A GENTLE TOP END. One shared lowpass around 6.5kHz takes the glassiness
 *     off without dulling it.
 *  5. NOTHING ALARMING. The capture alert is a soft descending minor third, not
 *     a buzzer. This app tells people they may be being exploited; the sound for
 *     that should be sober, not a jump-scare.
 *
 * Pitches are drawn from a pentatonic set so that overlapping sounds — which
 * WILL happen when several events land together — stay consonant.
 */

const A = 440;
const note = (semitonesFromA4) => A * Math.pow(2, semitonesFromA4 / 12);

// D-flat major pentatonic-ish set. Anything can overlap anything.
const P = {
  db4: note(-8), eb4: note(-6), f4: note(-4), ab4: note(-1),
  bb4: note(1), db5: note(4), eb5: note(6), f5: note(8), ab5: note(11), db6: note(16),
};

let ctx = null;
let master = null;
let verb = null;
let dry = null;
let wet = null;
let ready = false;

const STORE_KEY = '3rdspace.sound.v1';

export const sound = {
  enabled: readEnabled(),
  volume: 0.75,
};

function readEnabled() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

export function setEnabled(on) {
  sound.enabled = !!on;
  try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  if (on) { ensure(); play('toggleOn'); }
}

/**
 * Build the graph. Must be called from a user gesture — browsers refuse to start
 * an AudioContext otherwise, and that rule is a good one.
 */
export function ensure() {
  if (ready) {
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = 0.0001;
  master.gain.linearRampToValueAtTime(sound.volume, ctx.currentTime + 0.3);

  // One shared tone-shaping stage, so nothing is ever harsh.
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 6500;
  tone.Q.value = 0.55;

  // Algorithmic reverb: exponentially-decaying stereo noise as an impulse.
  verb = ctx.createConvolver();
  verb.buffer = impulse(1.15, 2.6);

  dry = ctx.createGain(); dry.gain.value = 0.82;
  wet = ctx.createGain(); wet.gain.value = 0.30;

  tone.connect(dry).connect(master);
  tone.connect(verb).connect(wet).connect(master);
  master.connect(ctx.destination);

  ready = true;
  ensure.bus = tone;
}

function impulse(seconds, decay) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      // Slight early-reflection shaping so the tail is not a flat wash.
      const t = i / n;
      const early = i < ctx.sampleRate * 0.02 ? 0.4 : 1;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
    }
  }
  return buf;
}

/**
 * One struck partial. `ratio` above 1 with a shorter `decay` is what makes a
 * bell read as a bell rather than as a tone generator.
 */
function partial(freq, when, dur, gain, type = 'sine', detune = 0) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;

  const t = ctx.currentTime + when;
  const attack = 0.008;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  o.connect(g).connect(ensure.bus);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** A struck bell: fundamental plus an inharmonic partial and a soft octave. */
function bell(freq, when = 0, dur = 1.1, gain = 0.16) {
  partial(freq, when, dur, gain, 'sine');
  partial(freq * 2.76, when, dur * 0.42, gain * 0.26, 'sine', 4);
  partial(freq * 2, when, dur * 0.6, gain * 0.14, 'sine', -3);
}

/** A soft wooden//rounded blip — for taps and small confirmations. */
function blip(freq, when = 0, dur = 0.16, gain = 0.10) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = freq * 3.2;
  o.type = 'triangle';
  o.frequency.setValueAtTime(freq * 1.06, ctx.currentTime + when);
  o.frequency.exponentialRampToValueAtTime(freq, ctx.currentTime + when + dur * 0.7);

  const t = ctx.currentTime + when;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  o.connect(f).connect(g).connect(ensure.bus);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** A filtered noise swell — water, bubbles, the aqua in Frutiger Aero. */
function swell(when = 0, dur = 0.5, gain = 0.05, centre = 900) {
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.6;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.4;
  const t = ctx.currentTime + when;
  f.frequency.setValueAtTime(centre * 0.6, t);
  f.frequency.exponentialRampToValueAtTime(centre * 1.9, t + dur);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(f).connect(g).connect(ensure.bus);
  src.start(t);
}

// --------------------------------------------------------------- the palette

const VOICES = {
  /** Tiny, low, almost subliminal. Used for taps — must never become tiring. */
  tap: () => blip(P.db5, 0, 0.09, 0.045),

  /** Switching the browse scope. Two quick rising notes. */
  toggle: () => { blip(P.ab4, 0, 0.10, 0.055); blip(P.db5, 0.055, 0.12, 0.05); },
  toggleOn: () => { bell(P.db5, 0, 0.7, 0.10); bell(P.f5, 0.07, 0.8, 0.07); },

  /** Opening a space. A warm major-ish spread — the MSN sign-in feeling. */
  open: () => { bell(P.db4, 0, 1.3, 0.11); bell(P.ab4, 0.06, 1.2, 0.09); bell(P.db5, 0.12, 1.4, 0.07); swell(0, 0.5, 0.03, 700); },

  /** Sending. Light, upward, gone quickly. */
  send: () => { blip(P.db5, 0, 0.11, 0.06); blip(P.ab5, 0.05, 0.14, 0.045); },

  /** Receiving. The classic two-tone, but soft and reverberant. */
  receive: () => { bell(P.f5, 0, 0.85, 0.11); bell(P.db5, 0.10, 1.0, 0.09); },

  /** Admitted to a space. A small ascending arpeggio, unmistakably positive. */
  admit: () => { bell(P.db5, 0, 0.9, 0.10); bell(P.f5, 0.08, 0.9, 0.09); bell(P.ab5, 0.16, 1.2, 0.08); swell(0.02, 0.45, 0.025, 1100); },

  /** Turned away. Descending, gentle — disappointment, not failure. */
  reject: () => { bell(P.f4, 0, 1.0, 0.09); bell(P.eb4, 0.11, 1.1, 0.075); },

  /**
   * A space is flagged. Deliberately NOT an alarm: a low descending minor third
   * with a slow tail. It should make you look, not make you flinch.
   */
  alert: () => { bell(P.f4, 0, 1.5, 0.10); bell(P.db4, 0.16, 1.8, 0.085); swell(0.1, 0.7, 0.02, 380); },

  /** A cryptographic proof. Lower and more final than an alert — this one is certain. */
  proof: () => { bell(P.db4 / 2, 0, 2.0, 0.10); bell(P.ab4 / 2, 0.13, 1.9, 0.08); bell(P.db4, 0.26, 1.6, 0.05); },

  /** Saving the profile file. A soft click-and-settle. */
  save: () => { blip(P.bb4, 0, 0.12, 0.055); bell(P.eb5, 0.09, 0.7, 0.07); },

  /** Something went wrong, but recoverably. */
  nope: () => { blip(P.f4, 0, 0.13, 0.06); blip(P.eb4, 0.08, 0.18, 0.05); },
};

export function play(name) {
  if (!sound.enabled) return;
  ensure();
  if (!ready) return;
  const v = VOICES[name];
  if (!v) return;
  try { v(); } catch { /* audio is a nicety; never let it break the UI */ }
}

/** Preview every sound, for the settings panel. */
export function previewAll(delayMs = 700) {
  const names = ['open', 'admit', 'receive', 'send', 'alert', 'proof'];
  names.forEach((n, i) => setTimeout(() => play(n), i * delayMs));
}

export const SOUND_NAMES = Object.keys(VOICES);
