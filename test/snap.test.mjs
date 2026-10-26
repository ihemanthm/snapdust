// Unit tests for extension/content/snap.js with synthetic sounds and hand movements.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SoundSnapDetector, HandSnapDetector, SnapFusion } = require('../extension/content/snap.js');

const RATE = 48000;

// Deterministic noise, so the tests don't flake.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

// RBJ band-pass, to shape noise bursts.
function bandPass(signal, low, high) {
  const f0 = Math.sqrt(low * high);
  const q = f0 / (high - low);
  const w = (2 * Math.PI * f0) / RATE;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const [b0, b2, a1, a2] = [alpha / a0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return signal.map((x) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  });
}

const seconds = (s) => new Float32Array(Math.round(s * RATE));

// A quiet room: faint broadband hiss plus a little mains hum.
function room(length, seed = 1) {
  const noise = rng(seed);
  const out = seconds(length);
  for (let i = 0; i < out.length; i++) out[i] = noise() * 0.002 + Math.sin((2 * Math.PI * 50 * i) / RATE) * 0.003;
  return out;
}

// Adds a burst of band-passed noise at `at` seconds with an exponential decay.
function burst(target, { at, low, high, decayMs, amp, attackMs = 0.5, seed = 7 }) {
  const noise = rng(seed);
  const n = Math.round(((decayMs * 8) / 1000) * RATE);
  const raw = Float32Array.from({ length: n }, () => noise());
  const shaped = bandPass(raw, low, high);
  let peak = 0;
  for (const v of shaped) peak = Math.max(peak, Math.abs(v));
  const start = Math.round(at * RATE);
  for (let i = 0; i < n && start + i < target.length; i++) {
    const t = (i / RATE) * 1000;
    const env = Math.min(1, t / attackMs) * Math.exp(-t / decayMs);
    target[start + i] += (shaped[i] / peak) * amp * env;
  }
  return target;
}

function vowel(target, { at, length, pitch = 140, amp = 0.15 }) {
  const start = Math.round(at * RATE);
  const n = Math.round(length * RATE);
  for (let i = 0; i < n && start + i < target.length; i++) {
    const t = i / RATE;
    const env = Math.sin((Math.PI * i) / n) ** 0.5; // syllable swell
    let v = 0;
    for (let h = 1; h <= 20; h++) {
      const f = pitch * h;
      const formant = Math.exp(-(((f - 700) / 250) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 300) ** 2)) + 0.05;
      v += Math.sin(2 * Math.PI * f * t) * formant;
    }
    target[start + i] += v * env * amp * 0.3;
  }
  return target;
}

function detect(signal, sensitivity = 0.5) {
  const events = [];
  const d = new SoundSnapDetector(RATE, { sensitivity, onEvent: (e) => events.push(e) });
  // Feed in 10 ms chunks, like the browser does.
  const chunk = RATE / 100;
  for (let i = 0; i < signal.length; i += chunk) d.process(signal.subarray(i, i + chunk), (i / RATE) * 1000);
  return events;
}

const snaps = (events) => events.filter((e) => e.snap);

const SNAP = { low: 1800, high: 6000, decayMs: 7, amp: 0.4 };

test('a finger snap is detected, once, at the right time', () => {
  const events = detect(burst(room(1), { at: 0.5, ...SNAP }));
  assert.equal(snaps(events).length, 1, JSON.stringify(events));
  assert.ok(Math.abs(snaps(events)[0].time - 500) < 10);
});

test('a quieter snap further from the mic is still detected', () => {
  assert.equal(snaps(detect(burst(room(1), { at: 0.5, ...SNAP, amp: 0.05 }))).length, 1);
});

test('three snaps in a row are three events', () => {
  const s = room(2);
  for (const at of [0.3, 0.9, 1.5]) burst(s, { at, ...SNAP, seed: at * 100 });
  assert.equal(snaps(detect(s)).length, 3);
});

test('a hand clap is rejected', () => {
  const events = detect(burst(room(1), { at: 0.5, low: 500, high: 1800, decayMs: 25, amp: 0.6 }));
  assert.equal(snaps(events).length, 0, JSON.stringify(events));
});

test('a knock on the desk is rejected', () => {
  const s = room(1);
  const start = Math.round(0.5 * RATE);
  for (let i = 0; i < RATE * 0.2; i++) {
    const t = i / RATE;
    s[start + i] += Math.sin(2 * Math.PI * 150 * t) * Math.exp(-t / 0.04) * 0.7;
  }
  assert.equal(snaps(detect(s)).length, 0);
});

test('talking, including an "s" sound, is rejected', () => {
  const s = room(2.5);
  vowel(s, { at: 0.2, length: 0.25 });
  vowel(s, { at: 0.5, length: 0.2, pitch: 160 });
  burst(s, { at: 0.75, low: 4000, high: 9000, decayMs: 60, amp: 0.05, attackMs: 30 }); // "s"
  vowel(s, { at: 1.0, length: 0.3 });
  vowel(s, { at: 1.5, length: 0.25, pitch: 120, amp: 0.3 });
  const events = detect(s);
  assert.equal(snaps(events).length, 0, JSON.stringify(events));
});

test('the room getting louder does not trigger anything', () => {
  const s = room(2);
  const noise = rng(3);
  for (let i = RATE; i < s.length; i++) s[i] += noise() * 0.02 * Math.min(1, (i - RATE) / (RATE * 0.3));
  assert.equal(snaps(detect(s)).length, 0);
});

test('a snap over ongoing speech is still detected', () => {
  const s = room(1.2);
  vowel(s, { at: 0.2, length: 0.8, amp: 0.15 });
  burst(s, { at: 0.6, ...SNAP });
  const events = detect(s);
  assert.equal(snaps(events).length, 1, JSON.stringify(events));
});

test('a keyboard click sounds like a snap (why "sound + hand" is the default)', () => {
  const events = detect(burst(room(1), { at: 0.5, low: 2500, high: 8000, decayMs: 3, amp: 0.15 }));
  assert.equal(snaps(events).length, 1);
});

// ---- Hand -------------------------------------------------------------------------

// A right hand: wrist at the bottom, middle knuckle above it (hand size 0.2).
function hand({ thumbTip, middleTip }) {
  const points = Array.from({ length: 21 }, () => [0.5, 0.65]);
  points[0] = [0.5, 0.8];
  points[9] = [0.5, 0.6];
  points[4] = thumbTip;
  points[12] = middleTip;
  return points;
}
const READY = hand({ thumbTip: [0.47, 0.5], middleTip: [0.48, 0.48] }); // tips pressed together
const SNAPPED = hand({ thumbTip: [0.4, 0.46], middleTip: [0.5, 0.68] }); // middle finger on the palm
const OPEN = hand({ thumbTip: [0.4, 0.55], middleTip: [0.5, 0.42] }); // relaxed, fingers up

// The snap releases detected (ready-pose frames are reported too, but aren't snaps).
function handEvents(frames, fps = 15) {
  const events = [];
  const d = new HandSnapDetector({ onEvent: (e) => events.push(e) });
  frames.forEach((f, i) => d.process(f ? [f] : [], (i * 1000) / fps));
  return events.filter((e) => e.type === 'release');
}

function poseFrames(frames, fps = 15) {
  const events = [];
  const d = new HandSnapDetector({ onEvent: (e) => events.push(e) });
  frames.forEach((f, i) => d.process(f ? [f] : [], (i * 1000) / fps));
  return events.filter((e) => e.type === 'pose').length;
}

test('hand: thumb and middle finger together, then snapped apart', () => {
  assert.equal(handEvents([OPEN, READY, READY, READY, SNAPPED, SNAPPED]).length, 1);
});

test('hand: slowly letting go of a pinch is not a snap', () => {
  const frames = [READY, READY];
  for (let i = 1; i <= 8; i++) {
    const k = i / 8;
    const lerp = (a, b) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    frames.push(hand({ thumbTip: lerp(READY[4], OPEN[4]), middleTip: lerp(READY[12], OPEN[12]) }));
  }
  assert.equal(handEvents(frames).length, 0);
});

test('hand: opening the fingers upward is not a snap', () => {
  assert.equal(handEvents([READY, READY, OPEN, OPEN]).length, 0);
});

test('hand: no hand in view, nothing happens', () => {
  assert.equal(handEvents([null, null, null]).length, 0);
});

test('hand: the snap frame lost to motion blur is still caught a frame later', () => {
  assert.equal(handEvents([READY, READY, null, SNAPPED]).length, 1);
});

test('hand: the ready pose is reported while held, not when relaxed', () => {
  assert.equal(poseFrames([OPEN, READY, READY, READY, OPEN]), 3);
});

// ---- Combined -----------------------------------------------------------------------

function fusion(mode) {
  const fired = [];
  return { f: new SnapFusion({ mode, onSnap: (s) => fired.push(s) }), fired };
}
const soundAt = (time) => ({ time, snap: true });
const handAt = (time) => ({ type: 'release', time, snap: true });
const poseAt = (time) => ({ type: 'pose', time });

test('both: sound and hand together fire once', () => {
  const { f, fired } = fusion('both');
  f.sound(soundAt(1000));
  f.hand(handAt(1090));
  assert.deepEqual(fired.map((s) => s.by), ['sound + hand']);
});

test('both: hand seen first, sound a moment later, fires', () => {
  const { f, fired } = fusion('both');
  f.hand(handAt(1000));
  f.sound(soundAt(1150));
  assert.equal(fired.length, 1);
});

test('both: snap sound right after holding the ready pose fires, even with the snap frame missed', () => {
  const { f, fired } = fusion('both');
  f.hand(poseAt(800));
  f.hand(poseAt(870));
  f.sound(soundAt(1000));
  assert.deepEqual(fired.map((s) => s.by), ['sound + ready pose']);
});

test('both: a ready pose from seconds ago does not count', () => {
  const { f, fired } = fusion('both');
  f.hand(poseAt(1000));
  f.sound(soundAt(3500));
  assert.equal(fired.length, 0);
});

test('both: a click with the hand in view but not in snap pose does nothing, and says why', () => {
  const decisions = [];
  const f = new SnapFusion({ mode: 'both', onDecision: (d) => decisions.push(d.result) });
  f.sound(soundAt(1000));
  assert.equal(f.snaps, 0);
  assert.match(decisions[0], /not seen in snap pose/);
});

test('both: a sound alone (keyboard click) does nothing', () => {
  const { f, fired } = fusion('both');
  f.sound(soundAt(1000));
  assert.equal(fired.length, 0);
});

test('both: a hand alone does nothing', () => {
  const { f, fired } = fusion('both');
  f.hand(handAt(1000));
  assert.equal(fired.length, 0);
});

test('both: sound and hand far apart do nothing', () => {
  const { f, fired } = fusion('both');
  f.sound(soundAt(1000));
  f.hand(handAt(2500));
  assert.equal(fired.length, 0);
});

test('sound only and hand only modes fire on their own', () => {
  const s = fusion('sound');
  s.f.sound(soundAt(1000));
  const h = fusion('hand');
  h.f.hand(handAt(1000));
  assert.equal(s.fired.length + h.fired.length, 2);
});

test('a second snap within the cooldown is ignored, a later one fires', () => {
  const { f, fired } = fusion('sound');
  f.sound(soundAt(1000));
  f.sound(soundAt(1500));
  f.sound(soundAt(3000));
  assert.equal(fired.length, 2);
});
