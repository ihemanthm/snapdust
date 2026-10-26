// Runs in the page's MAIN world at document_start, before Meet's own code.
// Wraps getUserMedia so Meet receives a processed camera track instead of the raw one.
(() => {
  if (window.__snapDustInstalled) return;
  window.__snapDustInstalled = true;

  const TAG = '[SnapDust]';
  const SEG_WIDTH = 256; // segmentation input width; height follows the camera's aspect ratio
  const DUST_SECONDS = 3.2; // the body's dissolve, plus up to 2.4 s for the last ash to fade
  const RETURN_SPEED = 1.5; // the return plays the dust backwards this much faster (~3.7 s)
  const FADE_MS = 400; // plain fade, used when WebGL2 is unavailable
  // How quickly the room picture follows the live room, until a clean capture replaces it.
  const PLATE_LEARN_RATE = 0.08;
  // How quickly a spot counts as "known" (~1 s of seeing it without you in front).
  const COVERAGE_RATE = 0.05;
  const MASK_THRESHOLD = 0.15 * 255; // confidence above which a pixel counts as you
  const MASK_GROW = 2; // pixels at segmentation size (~0.8% of the width) added around you
  const GAIN_WIDTH = 64; // size of the brightness comparison
  const GAIN_EVERY = 5; // frames between brightness checks
  // Average brightness (0-255) below which a frame is treated as the camera warming up or the
  // lights being off: nothing is learned from it.
  const MIN_LUMA = 20;
  const CAPTURE_DELAY_MS = 3000; // time to step out of frame
  const CAPTURE_MIN_MS = 500;
  const CAPTURE_MAX_MS = 12000;
  const CAPTURE_TARGET = 0.97; // share of the room seen at which capture stops early
  const CAPTURE_ACCEPT = 0.6; // below this, the capture is treated as not done
  const FILL_EVERY = 15; // frames between refreshes of the filled-in room picture

  // Live config, pushed from the isolated-world bridge (popup -> storage -> bridge -> here).
  const config = {
    enabled: true,
    snapEnabled: true,
    snapMode: 'both', // both | sound | hand
    snapSensitivity: 0.5,
    vanishWho: 'me', // me | everyone
    segmenterUrl: null,
  };

  // Runtime state driven by commands: popup buttons, keyboard shortcuts and snaps.
  const state = { vanished: false };

  // What the popup shows.
  const status = {
    intercepted: 0, // camera streams taken over so far
    segmenter: 'off', // off | loading | ready | error
    lastError: null,
    // The fields below describe the newest live camera stream.
    background: 'none', // none | learning | capturing | captured
    backgroundKnown: 0, // fraction of the room seen without you in front of it
    vanished: false,
    phase: 'present', // present | dusting | gone | returning
  };

  // Meet may open the camera more than once (pre-join preview, call, other resolutions).
  // Each stream gets its own compositor; the newest one feeds the popup status.
  const compositors = new Set();
  let activeCompositor = null;

  function reportStatus() {
    status.vanished = state.vanished;
    status.snap = snapStatus();
    if (activeCompositor) {
      status.background = activeCompositor.background;
      status.phase = activeCompositor.phase;
    }
    window.dispatchEvent(new CustomEvent('snapdust:status', { detail: JSON.stringify(status) }));
  }
  window.addEventListener('snapdust:get-status', reportStatus);

  window.addEventListener('snapdust:config', (event) => {
    try {
      Object.assign(config, JSON.parse(event.detail));
      if (compositors.size) ensureSegmenter();
    } catch (err) {
      console.warn(TAG, 'bad config', err);
    }
  });

  window.addEventListener('snapdust:command', (event) => {
    let command;
    try {
      ({ command } = JSON.parse(event.detail));
    } catch {
      return;
    }
    if (command === 'toggle-vanish') state.vanished = !state.vanished;
    else if (command === 'vanish') state.vanished = true;
    else if (command === 'appear') state.vanished = false;
    else if (command === 'capture-background') {
      const now = performance.now();
      for (const c of compositors) c.startCapture(now);
    }
    reportStatus();
  });

  // ---- Segmenter (extension iframe) ------------------------------------------

  // Meet enforces Trusted Types, which blocks MediaPipe's loader in this page,
  // so segmentation runs in an extension-owned iframe and talks over a MessagePort.
  const seg = {
    iframe: null,
    port: null,
    ready: false,
    busySince: 0,
    nextId: 1,
    pending: new Map(), // request id -> { compositor, generation }
  };

  function ensureSegmenter() {
    if (seg.iframe || !config.segmenterUrl) return;
    const iframe = document.createElement('iframe');
    iframe.src = config.segmenterUrl;
    iframe.tabIndex = -1;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;left:0;bottom:0;width:2px;height:2px;border:0;opacity:0;pointer-events:none;';
    iframe.addEventListener('load', () => {
      const channel = new MessageChannel();
      seg.port = channel.port1;
      seg.port.onmessage = onSegmenterMessage;
      const origin = new URL(config.segmenterUrl).origin;
      iframe.contentWindow.postMessage({ type: 'snapdust:connect' }, origin, [channel.port2]);
    });
    (document.body ?? document.documentElement).appendChild(iframe);
    seg.iframe = iframe;
    status.segmenter = 'loading';
  }

  function onSegmenterMessage(event) {
    const msg = event.data;
    if (msg.type === 'ready') {
      seg.ready = true;
      status.segmenter = 'ready';
    } else if (msg.type === 'error') {
      seg.busySince = 0;
      status.segmenter = 'error';
      status.lastError = msg.message;
    } else if (msg.type === 'hands' || msg.type === 'hands-error') {
      onHands(msg);
    } else if (msg.type === 'mask') {
      seg.busySince = 0;
      const request = seg.pending.get(msg.id);
      seg.pending.delete(msg.id);
      // Each mask goes back to the stream it was computed from, and only if that stream
      // hasn't changed size since.
      if (!request || request.generation !== request.compositor.generation) return;
      const mask = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
      request.compositor.receiveMask(mask);
    }
  }

  function requestMask(compositor) {
    if (!seg.ready) return;
    const now = performance.now();
    // One frame in flight at a time; drop it if the segmenter went quiet.
    if (seg.busySince && now - seg.busySince < 1000) return;
    if (seg.busySince) seg.pending.clear();
    const bitmap = compositor.small.transferToImageBitmap();
    const id = seg.nextId++;
    seg.busySince = now;
    seg.pending.set(id, { compositor, generation: compositor.generation });
    seg.port.postMessage({ type: 'segment', id, bitmap }, [bitmap]);
  }

  // ---- Snap detection ------------------------------------------------------------

  // Listens to a copy of the mic Meet opened and watches the hand (via the segmenter iframe).
  // A snap toggles vanish / return. Nothing is recorded or sent anywhere.
  const HAND_WIDTH = 384; // hand-tracking input width; hands need more detail than the outline
  const HAND_EVERY = 2; // video frames between hand checks (~15 per second)
  const { SoundSnapDetector, HandSnapDetector, SnapFusion } = window.__SnapDustSnap;

  const snap = {
    audioTrack: null, // our copy of Meet's mic track
    sound: null, // SoundSnapDetector, created at the mic's sample rate
    samples: null,
    hand: new HandSnapDetector({ onEvent: (e) => snap.fusion.hand(e) }),
    fusion: new SnapFusion({ mode: 'both', onSnap: onSnap }),
    handsBusySince: 0,
    handsSentAt: 0,
    handsModel: 'off', // off | loading | ready | error
    lastSnap: null,
  };

  function onSnap(event) {
    state.vanished = !state.vanished;
    snap.lastSnap = { wall: Date.now() };
    reportStatus();
  }

  // The mode actually in use: without a mic, "sound + hand" falls back to the hand alone.
  function snapMode() {
    if (!config.snapEnabled) return 'off';
    const micLive = snap.audioTrack?.readyState === 'live';
    if (config.snapMode === 'both' && !micLive) return 'hand';
    if (config.snapMode === 'sound' && !micLive) return 'off';
    return config.snapMode;
  }

  function stopAudioTap() {
    snap.audioTrack?.stop();
    snap.audioTrack = null;
  }

  function tapAudio(track) {
    if (!('MediaStreamTrackProcessor' in window)) return;
    stopAudioTap();
    // A copy, so muting in Meet (which disables Meet's track) doesn't silence snap detection.
    const copy = track.clone();
    copy.enabled = true;
    snap.audioTrack = copy;
    // When Meet lets go of the mic, so do we.
    const stopOriginal = track.stop.bind(track);
    track.stop = () => {
      stopOriginal();
      if (snap.audioTrack === copy) stopAudioTap();
    };
    track.addEventListener('ended', () => snap.audioTrack === copy && stopAudioTap());

    const reader = new MediaStreamTrackProcessor({ track: copy }).readable.getReader();
    (async () => {
      try {
        for (;;) {
          const { value: data, done } = await reader.read();
          if (done) break;
          const mode = snapMode();
          if (mode === 'both' || mode === 'sound') listen(data);
          data.close();
        }
      } catch (err) {
        console.warn(TAG, 'mic tap ended', err);
      }
    })();
  }

  function listen(data) {
    const n = data.numberOfFrames;
    if (!snap.sound || snap.sound.sampleRate !== data.sampleRate) {
      snap.sound = new SoundSnapDetector(data.sampleRate, {
        onEvent: (e) => snap.fusion.sound(e),
      });
    }
    snap.sound.setSensitivity(config.snapSensitivity);
    snap.fusion.mode = snapMode();
    if (snap.samples?.length !== n) snap.samples = new Float32Array(n);
    try {
      data.copyTo(snap.samples, { planeIndex: 0, format: 'f32-planar' });
    } catch {
      // No format conversion available: read interleaved float samples, first channel.
      if (data.format !== 'f32') return;
      const all = new Float32Array(n * data.numberOfChannels);
      data.copyTo(all, { planeIndex: 0 });
      for (let i = 0; i < n; i++) snap.samples[i] = all[i * data.numberOfChannels];
    }
    snap.sound.process(snap.samples, performance.now() - (n / data.sampleRate) * 1000);
  }

  function requestHands(compositor) {
    if (!seg.ready) return;
    const mode = snapMode();
    if (mode !== 'both' && mode !== 'hand') return;
    const now = performance.now();
    if (snap.handsBusySince && now - snap.handsBusySince < 1000) return;
    if (snap.handsModel === 'off') snap.handsModel = 'loading';
    const { handCanvas, handCtx } = compositor;
    handCtx.drawImage(compositor.frame, 0, 0, handCanvas.width, handCanvas.height);
    const bitmap = handCanvas.transferToImageBitmap();
    snap.handsBusySince = now;
    snap.handsSentAt = now;
    seg.port.postMessage({ type: 'hands', id: seg.nextId++, bitmap }, [bitmap]);
  }

  function onHands(msg) {
    snap.handsBusySince = 0;
    if (msg.type === 'hands-error') {
      snap.handsModel = 'error';
      status.lastError = `hand tracking: ${msg.message}`;
      return;
    }
    snap.handsModel = 'ready';
    if (msg.hands.length) snap.handSeenAt = performance.now();
    snap.fusion.mode = snapMode();
    snap.hand.process(msg.hands, snap.handsSentAt);
  }

  // ---- Compositor ----------------------------------------------------------------

  // `readOften`: the canvas is read back with getImageData regularly, so keep it in memory
  // rather than on the GPU (and avoid Chrome's readback warning).
  function makeCanvas(width, height, readOften = false) {
    const canvas = new OffscreenCanvas(width, height);
    return [canvas, canvas.getContext('2d', { willReadFrequently: readOften })];
  }

  // Turns a soft confidence mask into a solid one and grows it by MASK_GROW pixels.
  // Solid: half-sure areas (hair, arms in dim light) are fully replaced, not half-faded.
  // Grown: covers the movement between the mask's frame and the one shown.
  function growMask(rgba, width, height, radius = MASK_GROW, threshold = MASK_THRESHOLD) {
    const solid = new Uint8Array(width * height);
    for (let i = 0; i < solid.length; i++) solid[i] = rgba[i * 4 + 3] > threshold ? 1 : 0;

    const rows = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0, last = -Infinity; x < width; x++) {
        if (solid[row + x]) last = x;
        if (x - last <= radius) rows[row + x] = 1;
      }
      for (let x = width - 1, next = Infinity; x >= 0; x--) {
        if (solid[row + x]) next = x;
        if (next - x <= radius) rows[row + x] = 1;
      }
    }

    const grown = new Uint8Array(width * height);
    for (let x = 0; x < width; x++) {
      for (let y = 0, last = -Infinity; y < height; y++) {
        if (rows[y * width + x]) last = y;
        if (y - last <= radius) grown[y * width + x] = 1;
      }
      for (let y = height - 1, next = Infinity; y >= 0; y--) {
        if (rows[y * width + x]) next = y;
        if (next - y <= radius) grown[y * width + x] = 1;
      }
    }
    return grown;
  }

  // The room picture of the last stream that closed, for the next one to pick up.
  let roomMemory = null;

  // Effect timeline per stream: present -> dusting -> gone -> returning -> present.
  // The detector outlines everyone in frame. Keeps only you: the largest person (on a webcam,
  // whoever is nearest), sticking with the one already tracked unless someone else is clearly
  // bigger, so it doesn't flicker between two people. Blobs touching you count as you too,
  // such as a raised hand the detector sees as a separate piece. Everyone else is left alone
  // and treated as part of the room. Works in place on the mask's alpha; returns your pixels.
  const NEARBY = 8; // pixels at segmentation size: blobs this close to you count as you
  const SWITCH_RATIO = 1.3; // someone must be this much bigger to take over from the tracked person
  function keepMainPerson(mask, previous) {
    const { width, height, data } = mask;
    const count = width * height;
    const labels = new Int32Array(count); // 0 = background
    const areas = [0];
    const overlaps = [0];
    const stack = [];
    let next = 1;
    for (let start = 0; start < count; start++) {
      if (labels[start] || data[start * 4 + 3] <= MASK_THRESHOLD) continue;
      let area = 0;
      let overlap = 0;
      labels[start] = next;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        area++;
        if (previous?.[i]) overlap++;
        const x = i % width;
        for (const j of [i - width, i + width, x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1]) {
          if (j < 0 || j >= count || labels[j] || data[j * 4 + 3] <= MASK_THRESHOLD) continue;
          labels[j] = next;
          stack.push(j);
        }
      }
      areas.push(area);
      overlaps.push(overlap);
      next++;
    }
    if (next === 1) return null; // nobody in frame

    let largest = 1;
    let tracked = 0;
    for (let l = 1; l < next; l++) {
      if (areas[l] > areas[largest]) largest = l;
      if (overlaps[l] > (overlaps[tracked] ?? 0)) tracked = l;
    }
    const main = tracked && areas[tracked] * SWITCH_RATIO >= areas[largest] ? tracked : largest;

    // Blobs touching the area around you are part of you too.
    const mainRgba = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) mainRgba[i * 4 + 3] = labels[i] === main ? 255 : 0;
    const near = growMask(mainRgba, width, height, NEARBY, 127);
    const keep = new Uint8Array(next);
    keep[main] = 1;
    for (let i = 0; i < count; i++) if (labels[i] && near[i]) keep[labels[i]] = 1;

    const you = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const l = labels[i];
      if (l && !keep[l]) data[i * 4 + 3] = 0;
      else if (l) you[i] = 1;
    }
    return you;
  }

  class Compositor {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.generation = 0;
      this.frameNo = 0;
      this.lastTime = 0;
      this.capture = null; // { startAt, endAt } in performance.now() time
      this.background = 'none'; // none | learning | capturing | captured
      // A stream opened while you're vanished (camera toggled off and on) starts out gone.
      this.phase = state.vanished ? 'gone' : 'present'; // present | dusting | gone | returning
      this.phaseStart = 0;
      this.fadeAmount = state.vanished ? 1 : 0; // only eases in and out when WebGL is unavailable
      this.renderer = undefined; // created on first use; null if WebGL2 is unavailable
    }

    resize(width, height) {
      const previous = this.width ? this.roomShape : null; // Meet changed this stream's size
      this.width = width;
      this.height = height;
      this.generation++;
      const smallHeight = Math.round((SEG_WIDTH * height) / width);
      [this.frame, this.frameCtx] = makeCanvas(width, height);
      [this.out, this.outCtx] = makeCanvas(width, height);
      [this.plate, this.plateCtx] = makeCanvas(width, height);
      [this.filled, this.filledCtx] = makeCanvas(width, height);
      [this.scratch, this.scratchCtx] = makeCanvas(width, height);
      [this.maskBig, this.maskBigCtx] = makeCanvas(width, height);
      [this.small, this.smallCtx] = makeCanvas(SEG_WIDTH, smallHeight);
      [this.handCanvas, this.handCtx] = makeCanvas(HAND_WIDTH, Math.round((HAND_WIDTH * height) / width));
      [this.mask, this.maskCtx] = makeCanvas(SEG_WIDTH, smallHeight);
      [this.rawMask, this.rawMaskCtx] = makeCanvas(SEG_WIDTH, smallHeight);
      [this.inverse, this.inverseCtx] = makeCanvas(SEG_WIDTH, smallHeight);
      [this.coverage, this.coverageCtx] = makeCanvas(SEG_WIDTH, smallHeight, true);
      [this.known, this.knownCtx] = makeCanvas(SEG_WIDTH, smallHeight);
      // Half, quarter, ... size copies of the room picture, for filling never-seen spots.
      this.pyramid = [];
      for (let w = width, h = height; w > 1 || h > 1; ) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        this.pyramid.push(makeCanvas(w, h));
      }
      this.tiny = new OffscreenCanvas(GAIN_WIDTH, Math.round((GAIN_WIDTH * height) / width));
      this.tinyCtx = this.tiny.getContext('2d', { willReadFrequently: true });
      this.renderer?.resize(width, height);
      this.newMask = null;
      this.latestMask = null;
      this.mainPerson = null;
      this.prevGrown = null;
      this.gain = 1;
      this.luma = 0;
      this.maskReady = false;
      this.plateReady = false;
      this.captured = false;
      this.useFilled = false;
      this.adopted = false;
      this.background = 'none';
      this.adoptRoom(previous);
    }

    // When Meet reopens the camera (video off and on, a resolution change), the new stream
    // takes over the room picture from a stream still open or the one that just closed.
    adoptRoom(previous) {
      const aspect = this.width / this.height;
      const sameShape = (c) => c && Math.abs(c.aspect - aspect) < 0.02;
      const donor = [...compositors].find((c) => c !== this && sameShape(c.roomShape));
      const room = [previous, donor?.roomShape, roomMemory].find(sameShape) ?? null;
      if (!room) return;
      this.plateCtx.drawImage(room.plate, 0, 0, this.width, this.height);
      this.coverageCtx.drawImage(room.coverage, 0, 0, this.coverage.width, this.coverage.height);
      this.plateReady = true;
      this.adopted = true;
      this.captured = room.captured;
      this.gain = room.gain;
      this.background = room.captured ? 'captured' : 'learning';
    }

    // What another stream needs to take over this one's room picture.
    get roomShape() {
      if (!this.plateReady) return null;
      return {
        plate: this.plate,
        coverage: this.coverage,
        captured: this.captured,
        gain: this.gain,
        aspect: this.width / this.height,
      };
    }

    dispose() {
      if (this.plateReady) roomMemory = this.roomShape;
      this.renderer?.dispose();
      this.renderer = null;
    }

    startCapture(now) {
      this.capture = { startAt: now + CAPTURE_DELAY_MS, endAt: now + CAPTURE_DELAY_MS + CAPTURE_MAX_MS, fresh: true };
    }

    receiveMask(mask) {
      this.newMask = mask;
    }

    render(source, width, height) {
      if (width !== this.width || height !== this.height) this.resize(width, height);
      const now = performance.now();
      const dt = this.lastTime ? now - this.lastTime : 0;
      this.lastTime = now;
      this.frameNo++;

      this.drawInput(source);
      this.smallCtx.drawImage(this.frame, 0, 0, this.small.width, this.small.height);
      requestMask(this);
      if (this === activeCompositor && this.frameNo % HAND_EVERY === 0) requestHands(this);
      // Brightness is checked every frame until the room picture exists, so it never starts
      // from the black frames a webcam sends while warming up.
      if (!this.plateReady || this.frameNo % GAIN_EVERY === 0) this.checkBrightness();
      this.updateMask();
      this.updatePlate(now);
      if (this.plateReady && this.frameNo % FILL_EVERY === 0) this.updateFill();
      this.updatePhase(now, dt);

      this.compose(now);
      return this.out;
    }

    drawInput(source) {
      this.frameCtx.drawImage(source, 0, 0, this.width, this.height);
    }

    get roomVisible() {
      return this.luma >= MIN_LUMA;
    }

    updateMask() {
      const mask = this.newMask;
      if (!mask) return;
      this.newMask = null;
      if (config.vanishWho !== 'everyone') this.mainPerson = keepMainPerson(mask, this.mainPerson);
      this.latestMask = mask;
      const { width: mw, height: mh, data } = mask;
      if (this.mask.width !== mw || this.mask.height !== mh) {
        for (const canvas of [this.mask, this.rawMask, this.inverse, this.coverage, this.known]) {
          canvas.width = mw;
          canvas.height = mh;
        }
        this.prevGrown = null;
      }
      // The tight, soft outline: what the dust and return effects draw the body with.
      this.rawMaskCtx.putImageData(mask, 0, 0);

      // Union with the previous mask, so the spot you just moved out of stays covered too.
      const grown = growMask(data, mw, mh);
      const solid = new ImageData(mw, mh);
      for (let i = 0, j = 0; i < grown.length; i++, j += 4) {
        const on = grown[i] || (this.prevGrown && this.prevGrown[i]);
        solid.data[j] = solid.data[j + 1] = solid.data[j + 2] = 255;
        solid.data[j + 3] = on ? 255 : 0;
      }
      this.prevGrown = grown;
      this.maskCtx.putImageData(solid, 0, 0);

      // Full-size version with a slight feather. The feather stays inside the grown margin,
      // so it blends room into room rather than fading the person's edge.
      const ctx = this.maskBigCtx;
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.filter = `blur(${Math.max(1, Math.round(this.width / 320))}px)`;
      ctx.drawImage(this.mask, 0, 0, this.width, this.height);
      ctx.filter = 'none';
      // The blur fades out at the frame's edges; the unblurred copy keeps those fully covered.
      ctx.drawImage(this.mask, 0, 0, this.width, this.height);
      const firstMask = !this.maskReady;
      this.maskReady = true;
      if (firstMask && this.plateReady) this.updateFill();

      // Track which parts of the room have been seen, for a while, without you in front.
      if (!this.roomVisible) return;
      const inv = this.inverseCtx;
      inv.globalCompositeOperation = 'copy';
      inv.fillStyle = '#fff';
      inv.fillRect(0, 0, this.inverse.width, this.inverse.height);
      inv.globalCompositeOperation = 'destination-out';
      inv.drawImage(this.mask, 0, 0);
      inv.globalCompositeOperation = 'source-over';
      this.coverageCtx.globalAlpha = COVERAGE_RATE;
      this.coverageCtx.drawImage(this.inverse, 0, 0);
      this.coverageCtx.globalAlpha = 1;
    }

    // The live frame with your (grown) silhouette cut out.
    frameWithoutPerson() {
      const { scratchCtx, width, height } = this;
      scratchCtx.globalCompositeOperation = 'copy';
      scratchCtx.drawImage(this.frame, 0, 0);
      scratchCtx.globalCompositeOperation = 'destination-out';
      scratchCtx.drawImage(this.maskBig, 0, 0, width, height);
      scratchCtx.globalCompositeOperation = 'source-over';
      return this.scratch;
    }

    updatePlate(now) {
      const { plateCtx } = this;

      if (this.capture) {
        const capture = this.capture;
        if (now < capture.startAt) return;
        this.background = 'capturing';
        if (capture.fresh) {
          capture.fresh = false;
          this.coverageCtx.clearRect(0, 0, this.coverage.width, this.coverage.height);
          capture.known = 0;
        }
        // Copy the room wherever you aren't, until (nearly) all of it has been seen. If you
        // stay in frame, the spots behind you are simply never taken.
        if (this.roomVisible && this.maskReady) {
          plateCtx.drawImage(this.frameWithoutPerson(), 0, 0);
          this.coverageCtx.drawImage(this.inverse, 0, 0);
          this.plateReady = true;
        }
        if (this.frameNo % 10 === 0) capture.known = this.measureCoverage();
        const longEnough = now - capture.startAt > CAPTURE_MIN_MS;
        if ((longEnough && capture.known >= CAPTURE_TARGET) || now > capture.endAt) {
          this.capture = null;
          this.captured = capture.known >= CAPTURE_ACCEPT;
          this.background = this.captured ? 'captured' : this.plateReady ? 'learning' : 'none';
          this.gain = 1;
          this.updateFill();
        }
        return;
      }

      // A captured room is kept as-is: learning from the live video slowly picks up traces
      // of the person wherever detection is unsure. Brightness drift is handled by checkBrightness.
      if (this.captured) return;
      if (!this.roomVisible) return;

      if (!this.plateReady) {
        // Start from the first proper frame; the parts behind you get corrected as you move,
        // and updateFill covers the ones that never are.
        plateCtx.drawImage(this.frame, 0, 0);
        this.plateReady = true;
        this.background = 'learning';
        return;
      }
      if (!this.maskReady) return;

      // Blend in the live frame everywhere except where the person is.
      plateCtx.globalAlpha = PLATE_LEARN_RATE;
      plateCtx.drawImage(this.frameWithoutPerson(), 0, 0);
      plateCtx.globalAlpha = 1;
    }

    // Spots of the room never seen without you in front are painted from the colours around
    // them (a blurred "push-pull" fill), instead of showing a frozen copy of you.
    updateFill() {
      const { width: kw, height: kh } = this.known;
      const coverage = this.coverageCtx.getImageData(0, 0, kw, kh);
      // Mark the unknown spots, grown by 2 pixels, so the colours that feed the fill come only
      // from solidly known room and never from the edge of what's still you.
      let unknown = 0;
      for (let i = 3; i < coverage.data.length; i += 4) {
        const isKnown = coverage.data[i] > 200;
        if (!isKnown) unknown++;
        coverage.data[i] = isKnown ? 0 : 255;
      }
      this.useFilled = unknown > 0;
      if (!this.useFilled) return;
      const unknownGrown = growMask(coverage.data, kw, kh, 2, 127);
      const known = new ImageData(kw, kh);
      for (let i = 0, j = 0; i < unknownGrown.length; i++, j += 4) {
        known.data[j] = known.data[j + 1] = known.data[j + 2] = 255;
        known.data[j + 3] = unknownGrown[i] ? 0 : 255;
      }
      this.knownCtx.putImageData(known, 0, 0);

      // Room picture with the unknown spots cut out (hard-edged).
      const { filledCtx, width, height } = this;
      filledCtx.globalCompositeOperation = 'copy';
      filledCtx.drawImage(this.plate, 0, 0);
      filledCtx.globalCompositeOperation = 'destination-in';
      filledCtx.imageSmoothingEnabled = false;
      filledCtx.drawImage(this.known, 0, 0, width, height);
      filledCtx.imageSmoothingEnabled = true;
      filledCtx.globalCompositeOperation = 'source-over';

      // Push: shrink step by step; holes take on the average of what's around them. Drawing
      // each level over itself a few times makes partly-known cells solid, so holes close up
      // as they shrink instead of staying see-through.
      let previous = this.filled;
      for (const [canvas, ctx] of this.pyramid) {
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(previous, 0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < 4; i++) ctx.drawImage(canvas, 0, 0);
        previous = canvas;
      }
      // Pull: from the smallest up, lay each sharper level over the blurrier one below it.
      for (let i = this.pyramid.length - 2; i >= 0; i--) {
        const [canvas, ctx] = this.pyramid[i];
        ctx.globalCompositeOperation = 'destination-over';
        ctx.drawImage(this.pyramid[i + 1][0], 0, 0, canvas.width, canvas.height);
      }
      filledCtx.globalCompositeOperation = 'destination-over';
      if (this.pyramid.length) filledCtx.drawImage(this.pyramid[0][0], 0, 0, width, height);
      filledCtx.fillStyle = '#777';
      filledCtx.fillRect(0, 0, width, height);
      filledCtx.globalCompositeOperation = 'source-over';
    }

    // Measures how bright the camera image is (to skip warm-up frames), and corrects the room
    // picture for webcam auto-exposure: compared with the live room wherever you aren't.
    checkBrightness() {
      const { tiny, tinyCtx: ctx } = this;
      const read = (source) => {
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(source, 0, 0, tiny.width, tiny.height);
        return ctx.getImageData(0, 0, tiny.width, tiny.height).data;
      };
      const luma = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;

      const live = read(this.frame);
      let total = 0;
      for (let i = 0; i < live.length; i += 4) total += luma(live, i);
      this.luma = total / (live.length / 4);

      if (!this.plateReady || !this.maskReady || !this.roomVisible) return;
      const plate = read(this.plate);
      const mask = read(this.mask);
      let liveSum = 0;
      let plateSum = 0;
      let count = 0;
      for (let i = 0; i < live.length; i += 4) {
        if (mask[i + 3] > 0) continue;
        liveSum += luma(live, i);
        plateSum += luma(plate, i);
        count++;
      }
      if (count < live.length / 4 / 20 || plateSum < 1) return; // under 5% of the room visible
      const target = Math.min(2, Math.max(0.5, liveSum / plateSum));
      this.gain += (target - this.gain) * 0.3;
    }

    // ---- Effect timeline ----

    ensureRenderer() {
      if (this.renderer !== undefined) return this.renderer;
      try {
        this.renderer = new window.__SnapDustRenderer(this.width, this.height);
      } catch (err) {
        console.warn(TAG, 'dust effect unavailable, using a fade', err);
        status.lastError = `dust effect unavailable: ${err.message ?? err}`;
        this.renderer = null;
      }
      return this.renderer;
    }

    // Bounding box of the person in the latest mask, in image uv (0..1, y down).
    personBox() {
      const mask = this.latestMask;
      if (!mask) return null;
      const { width, height, data } = mask;
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] < 128) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return null;
      return { x0: x0 / width, y0: y0 / height, x1: (x1 + 1) / width, y1: (y1 + 1) / height };
    }

    // The effect clock, in "seconds into the dust": 0 = whole, DUST_SECONDS = body gone,
    // dustTotal = last ash faded. Dusting runs it forward; returning runs it backwards.
    get dustTotal() {
      return DUST_SECONDS + (window.__SnapDustRenderer?.maxLife ?? 2.4);
    }

    dustClock(now) {
      const seconds = (now - this.phaseStart) / 1000;
      if (this.phase === 'dusting') return seconds;
      if (this.phase === 'returning') return this.dustTotal - seconds * RETURN_SPEED;
      return this.phase === 'gone' ? this.dustTotal : 0;
    }

    // Sets phaseStart so the new phase's clock continues from `clock`.
    startPhase(phase, now, clock) {
      this.phase = phase;
      const seconds = phase === 'dusting' ? clock : (this.dustTotal - clock) / RETURN_SPEED;
      this.phaseStart = now - seconds * 1000;
    }

    updatePhase(now, dt) {
      const want = state.vanished;
      const clock = this.dustClock(now);

      if (want && (this.phase === 'present' || this.phase === 'returning')) {
        const renderer = this.plateReady && this.ensureRenderer();
        const bbox = this.personBox();
        if (renderer && bbox) {
          // Freeze this moment of you; it is what turns to dust. Turning back mid-return
          // continues from the same point, along the same sweep.
          renderer.setBody(this.frame);
          renderer.setMask(this.rawMask);
          if (this.phase === 'present') renderer.setField(bbox);
          this.startPhase('dusting', now, this.phase === 'present' ? 0 : clock);
        } else {
          this.phase = 'gone'; // nobody detected (or no WebGL): nothing to dissolve
          this.phaseStart = now;
        }
      } else if (!want && (this.phase === 'dusting' || this.phase === 'gone')) {
        const renderer = this.ensureRenderer();
        const bbox = this.personBox();
        if (renderer && bbox) {
          // The vanish's sweep is kept, so every flake flies back along the path it left on.
          if (!renderer.fieldSet) renderer.setField(bbox);
          this.startPhase('returning', now, clock);
        } else {
          this.phase = 'present';
          this.phaseStart = now;
        }
      }

      const after = this.dustClock(now);
      if (this.phase === 'dusting' && after >= this.dustTotal) this.phase = 'gone';
      if (this.phase === 'returning' && after <= 0) this.phase = 'present';

      // Without WebGL the old fade is used.
      const target = this.phase === 'present' ? 0 : 1;
      if (this.renderer) this.fadeAmount = target;
      else {
        const step = dt / FADE_MS;
        this.fadeAmount =
          target > this.fadeAmount
            ? Math.min(target, this.fadeAmount + step)
            : Math.max(target, this.fadeAmount - step);
      }
    }

    compose(now) {
      const { outCtx: ctx, scratchCtx, height } = this;
      ctx.drawImage(this.frame, 0, 0);

      // 1. Hide the live you behind the room picture. Until the first outline arrives, only a
      // room picture known to be empty (captured, or taken over from the previous stream) is
      // shown in full; otherwise the frame is blurred so you can't be seen in the meantime.
      if (this.fadeAmount > 0 && !this.maskReady && !(this.captured || this.adopted)) {
        ctx.filter = 'blur(24px)';
        ctx.drawImage(this.frame, 0, 0);
        ctx.filter = 'none';
      } else if (this.fadeAmount > 0 && this.plateReady) {
        const room = this.useFilled ? this.filled : this.plate;
        scratchCtx.globalCompositeOperation = 'copy';
        if (this.maskReady) {
          scratchCtx.drawImage(this.maskBig, 0, 0);
          scratchCtx.globalCompositeOperation = 'source-in';
        }
        scratchCtx.filter = `brightness(${this.gain})`;
        scratchCtx.drawImage(room, 0, 0);
        scratchCtx.filter = 'none';
        scratchCtx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = this.fadeAmount;
        ctx.drawImage(this.scratch, 0, 0);
        ctx.globalAlpha = 1;
      }

      // 2. On top: the frozen you turning to dust, or the live you reforming.
      const progress = this.dustClock(now) / DUST_SECONDS;
      if (this.phase === 'dusting' && this.renderer) {
        ctx.drawImage(this.renderer.render('dust', progress, DUST_SECONDS), 0, 0);
      } else if (this.phase === 'returning' && this.renderer) {
        this.renderer.setBody(this.frame);
        this.renderer.setMask(this.rawMask);
        ctx.drawImage(this.renderer.render('return', progress, DUST_SECONDS), 0, 0);
      }
      if (this.capture) {
        const secondsLeft = Math.ceil((this.capture.startAt - now) / 1000);
        const known = Math.round((this.capture.known ?? 0) * 100);
        drawLabel(
          ctx,
          height,
          secondsLeft > 0
            ? `Step out of frame… ${secondsLeft}`
            : `Capturing room… ${known}%${known < 60 ? ' (step aside so I can see behind you)' : ''}`,
        );
      }
    }

    // Fraction of the room seen without the person in front of it (0..1).
    measureCoverage() {
      if (!this.coverage) return 0;
      const { width, height } = this.coverage;
      const data = this.coverageCtx.getImageData(0, 0, width, height).data;
      let seen = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 200) seen++;
      return seen / (width * height);
    }
  }

  // A short message at the top of the video (seen by everyone, e.g. during room capture).
  function drawLabel(ctx, height, text) {
    const size = Math.max(14, Math.round(height / 24));
    const pad = size / 2;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    const textWidth = ctx.measureText(text).width;
    const top = pad;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(pad, top, textWidth + pad * 2, size * 2);
    ctx.fillStyle = '#ffb347';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad * 2, top + size);
  }

  setInterval(() => {
    status.backgroundKnown = activeCompositor ? activeCompositor.measureCoverage() : 0;
  }, 1000);

  function snapStatus() {
    return {
      mode: snapMode(),
      handsModel: snap.handsModel,
      handInView: performance.now() - (snap.handSeenAt ?? -Infinity) < 1000,
      lastSnapSecondsAgo: snap.lastSnap ? Math.round((Date.now() - snap.lastSnap.wall) / 1000) : null,
    };
  }

  // ---- Pipelines ---------------------------------------------------------------

  // Preferred: insertable streams. Keeps running when the tab is in the background.
  function viaInsertableStreams(inTrack, compositor) {
    const processor = new MediaStreamTrackProcessor({ track: inTrack });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });

    const transformer = new TransformStream({
      transform(frame, controller) {
        if (!config.enabled) {
          controller.enqueue(frame);
          return;
        }
        try {
          const out = compositor.render(frame, frame.displayWidth, frame.displayHeight);
          const init = { timestamp: frame.timestamp };
          if (frame.duration != null) init.duration = frame.duration;
          const outFrame = new VideoFrame(out, init);
          frame.close();
          controller.enqueue(outFrame);
        } catch (err) {
          status.lastError = String(err);
          controller.enqueue(frame);
        }
      },
    });

    processor.readable
      .pipeThrough(transformer)
      .pipeTo(generator.writable)
      .catch((err) => {
        status.lastError = String(err);
        console.warn(TAG, 'pipeline ended', err);
      });

    return generator;
  }

  // Fallback: draw a <video> into a canvas and capture it. Throttled in background tabs.
  function viaCanvas(inTrack, compositor) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([inTrack]);
    video.play().catch((err) => (status.lastError = String(err)));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const { frameRate = 30 } = inTrack.getSettings();

    const onFrame = () => {
      if (inTrack.readyState === 'ended') return;
      if (video.readyState >= 2) {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        ctx.drawImage(config.enabled ? compositor.render(video, width, height) : video, 0, 0);
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);

    return canvas.captureStream(frameRate).getVideoTracks()[0];
  }

  // ---- Stream wrapping ---------------------------------------------------------

  function wrapStream(stream) {
    const [inTrack] = stream.getVideoTracks();
    const compositor = new Compositor();
    const outTrack =
      'MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window
        ? viaInsertableStreams(inTrack, compositor)
        : viaCanvas(inTrack, compositor);
    compositors.add(compositor);
    activeCompositor = compositor;
    ensureSegmenter();

    // Meet reads these to show the camera name and settings; answer from the real track.
    Object.defineProperty(outTrack, 'label', { get: () => inTrack.label });
    outTrack.getSettings = () => ({ ...inTrack.getSettings() });
    outTrack.getCapabilities = () => inTrack.getCapabilities();
    outTrack.getConstraints = () => inTrack.getConstraints();
    outTrack.applyConstraints = (constraints) => inTrack.applyConstraints(constraints);

    const forget = () => {
      if (!compositors.has(compositor)) return;
      compositor.dispose();
      compositors.delete(compositor);
      if (activeCompositor === compositor) activeCompositor = [...compositors].pop() ?? null;
    };

    // Stopping the processed track must release the real camera (and vice versa).
    const stopOut = outTrack.stop.bind(outTrack);
    outTrack.stop = () => {
      stopOut();
      inTrack.stop();
      forget();
    };
    inTrack.addEventListener('ended', () => {
      stopOut();
      forget();
    });

    status.intercepted++;
    reportStatus();

    return new MediaStream([outTrack, ...stream.getAudioTracks()]);
  }

  const originalGetUserMedia = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (constraints) {
    const stream = await originalGetUserMedia.call(this, constraints);
    const [audio] = stream.getAudioTracks();
    if (audio) {
      try {
        tapAudio(audio);
      } catch (err) {
        console.warn(TAG, 'could not listen for snaps', err);
      }
    }
    if (!constraints?.video || stream.getVideoTracks().length === 0) return stream;
    try {
      return wrapStream(stream);
    } catch (err) {
      status.lastError = String(err);
      console.error(TAG, 'wrap failed, passing raw stream through', err);
      return stream;
    }
  };

  window.dispatchEvent(new CustomEvent('snapdust:hello'));
})();
