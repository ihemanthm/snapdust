// Finger-snap detection, from sound and from hand movement, combined.
//
// Sound: a snap is a sharp, bright click. Its high-frequency energy jumps far above the room's
// noise within a few milliseconds and dies away within ~50 ms. Speech, claps and knocks are
// lower-pitched, slower to start or longer.
//
// Hand: just before a snap the thumb and middle fingertip press together; at the snap they fly
// apart within a frame or two and the middle finger lands on the palm.
//
// Loaded into the page before inject.js (window.__SnapDustSnap); also loadable in Node for tests.
(function (root) {
  // ---- Sound ------------------------------------------------------------------

  const HIGH_PASS_HZ = 2000; // snaps carry most energy above this; speech and claps below
  const SUBFRAME_MS = 2.5;
  const DECISION_MS = 60; // how long after an onset to look before deciding
  const SHORT_MS = 50; // a snap's energy falls 15 dB within this
  const BRIGHTNESS_MS = 10; // a snap's energy is almost all in its first 10 ms

  // RBJ biquad high-pass.
  function highPass(sampleRate, freq) {
    const w = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    const b0 = (1 + cos) / 2 / a0;
    const b1 = -(1 + cos) / a0;
    const b2 = b0;
    const a1 = (-2 * cos) / a0;
    const a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x) => {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      return y;
    };
  }

  const db = (ratio) => 10 * Math.log10(Math.max(ratio, 1e-12));

  class SoundSnapDetector {
    // sensitivity 0..1: how far above the room's noise a click must jump (24 dB .. 12 dB).
    constructor(sampleRate, { sensitivity = 0.5, onEvent } = {}) {
      this.sampleRate = sampleRate;
      this.subframe = Math.max(16, Math.round((sampleRate * SUBFRAME_MS) / 1000));
      this.filter = highPass(sampleRate, HIGH_PASS_HZ);
      this.onEvent = onEvent ?? (() => {});
      this.setSensitivity(sensitivity);
      this.floor = 1e-7; // running noise level of the high band
      this.history = []; // recent sub-frames: { high, all } energies
      this.acc = { high: 0, all: 0, n: 0 };
      this.candidate = null;
      this.time = 0; // ms
    }

    setSensitivity(sensitivity) {
      this.jumpDb = 24 - 12 * Math.min(1, Math.max(0, sensitivity));
    }

    // samples: mono Float32Array; startMs: time of the first sample (any clock, e.g. performance.now()).
    process(samples, startMs) {
      const msPerSample = 1000 / this.sampleRate;
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        const h = this.filter(x);
        this.acc.high += h * h;
        this.acc.all += x * x;
        if (++this.acc.n === this.subframe) {
          this.time = startMs + (i + 1) * msPerSample;
          this.subframeDone(this.acc.high / this.subframe, this.acc.all / this.subframe);
          this.acc = { high: 0, all: 0, n: 0 };
        }
      }
    }

    subframeDone(high, all) {
      const c = this.candidate;
      if (c) {
        // Only what the click adds on top of the sound just before it counts, so a snap
        // over someone talking is judged on its own.
        const extraHigh = Math.max(0, high - c.baseHigh);
        if (extraHigh >= c.peak) {
          c.peak = extraHigh;
          c.quietAt = null;
        } else if (c.quietAt == null && extraHigh < c.peak / 31.6) {
          c.quietAt = this.time; // first fell 15 dB below its peak
        }
        if (this.time - c.start < BRIGHTNESS_MS) {
          c.highSum += extraHigh;
          c.allSum += Math.max(0, all - c.baseAll);
        }
        if (this.time - c.start >= DECISION_MS) this.decide();
      } else {
        const before = Math.max(this.history.at(-2)?.high ?? 0, this.history.at(-3)?.high ?? 0);
        const jump = db(high / this.floor);
        // Sudden: well above the noise, and far above what was there 5 ms ago.
        if (jump >= this.jumpDb && high > before * 8 && high > 1e-6) {
          const recent = this.history.slice(0, -1);
          const mean = (key) => recent.reduce((sum, h) => sum + h[key], 0) / Math.max(1, recent.length);
          const baseHigh = mean('high');
          const baseAll = mean('all');
          this.candidate = {
            start: this.time,
            baseHigh,
            baseAll,
            peak: high - baseHigh,
            highSum: high - baseHigh,
            allSum: Math.max(0, all - baseAll),
            quietAt: null,
            jump,
          };
        }
      }

      // Noise floor: follows quiet quickly, loud slowly, and ignores the snap itself.
      if (!this.candidate) {
        this.floor = high < this.floor ? this.floor * 0.9 + high * 0.1 : this.floor * 0.998 + high * 0.002;
        this.floor = Math.max(this.floor, 1e-9);
      }
      this.history.push({ high, all });
      if (this.history.length > 8) this.history.shift();
    }

    decide() {
      const c = this.candidate;
      this.candidate = null;
      const brightness = c.highSum / Math.max(c.allSum, 1e-12); // share of energy above 2 kHz
      const durationMs = (c.quietAt ?? this.time) - c.start;
      let verdict = 'snap';
      if (brightness < 0.45) verdict = 'too dull'; // speech, claps, knocks
      else if (durationMs > SHORT_MS) verdict = 'too long'; // hisses, sustained noise
      this.onEvent({
        time: c.start,
        snap: verdict === 'snap',
        verdict,
        jumpDb: Math.round(c.jump),
        brightness: Math.round(brightness * 100) / 100,
        durationMs: Math.round(durationMs),
      });
    }
  }

  // ---- Hand ---------------------------------------------------------------------

  const THUMB_TIP = 4;
  const MIDDLE_TIP = 12;
  const WRIST = 0;
  const MIDDLE_KNUCKLE = 9;
  const PINCHED = 0.4; // thumb-middle tip gap, in hand sizes, when pressed together
  const RELEASED = 0.7;
  const RELEASE_WITHIN_MS = 250; // pressed -> apart this fast is a snap, slower is just letting go

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  class HandSnapDetector {
    constructor({ onEvent } = {}) {
      this.onEvent = onEvent ?? (() => {});
      this.tracks = []; // per hand slot: { lastPinch, pinchTipToWrist }
      this.lastSeen = -Infinity;
      this.lastPinch = -Infinity;
    }

    // hands: array of 21 [x, y] points per hand (image coordinates); timeMs: when the frame was taken.
    process(hands, timeMs) {
      if (hands.length) this.lastSeen = timeMs;
      hands.forEach((points, i) => {
        const track = (this.tracks[i] ??= { lastPinch: -Infinity, pinchTipToWrist: 0 });
        const size = dist(points[WRIST], points[MIDDLE_KNUCKLE]);
        if (size < 1e-3) return;
        const gap = dist(points[THUMB_TIP], points[MIDDLE_TIP]) / size;
        const tipToWrist = dist(points[MIDDLE_TIP], points[WRIST]) / size;
        if (gap < PINCHED) {
          track.lastPinch = timeMs;
          track.pinchTipToWrist = tipToWrist;
          this.lastPinch = timeMs;
        } else if (
          gap > RELEASED &&
          timeMs - track.lastPinch <= RELEASE_WITHIN_MS &&
          tipToWrist < track.pinchTipToWrist * 0.9 // the middle finger came down, not up
        ) {
          track.lastPinch = -Infinity;
          this.onEvent({ time: timeMs, snap: true, gap: Math.round(gap * 100) / 100 });
        }
      });
    }
  }

  // ---- Combined -------------------------------------------------------------------

  const MATCH_MS = 400; // sound and hand events this close together are the same snap
  const COOLDOWN_MS = 1200;

  // mode: 'both' (sound and hand must agree) | 'sound' | 'hand'.
  class SnapFusion {
    constructor({ mode = 'both', onSnap } = {}) {
      this.mode = mode;
      this.onSnap = onSnap ?? (() => {});
      this.lastSound = null;
      this.lastHand = null;
      this.lastFired = -Infinity;
      this.snaps = 0;
    }

    sound(event) {
      if (!event.snap) return;
      this.lastSound = event;
      if (this.mode === 'sound') this.fire(event.time, 'sound');
      else if (this.mode === 'both' && this.lastHand && Math.abs(this.lastHand.time - event.time) <= MATCH_MS) {
        this.fire(event.time, 'sound + hand');
      }
    }

    hand(event) {
      if (!event.snap) return;
      this.lastHand = event;
      if (this.mode === 'hand') this.fire(event.time, 'hand');
      else if (this.mode === 'both' && this.lastSound && Math.abs(this.lastSound.time - event.time) <= MATCH_MS) {
        this.fire(event.time, 'sound + hand');
      }
    }

    fire(time, by) {
      if (time - this.lastFired < COOLDOWN_MS) return;
      this.lastFired = time;
      this.lastSound = this.lastHand = null;
      this.snaps++;
      this.onSnap({ time, by });
    }
  }

  const api = { SoundSnapDetector, HandSnapDetector, SnapFusion };
  root.__SnapDustSnap = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
