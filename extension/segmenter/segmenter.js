// Runs inside an extension-owned iframe embedded in the Meet page.
// Meet's Trusted Types policy blocks MediaPipe's loader in the page itself, so the vision models
// live here: person segmentation always, hand tracking once snap detection asks for it.
//
// Protocol (over a MessagePort the page hands us in a 'connect' message):
//   page -> here: { type: 'segment', id, bitmap }   (bitmap is transferred)
//                 { type: 'hands', id, bitmap }
//   here -> page: { type: 'ready', delegate } | { type: 'error', message }
//                 { type: 'mask', id, width, height, buffer }  (RGBA, alpha = person confidence)
//                 { type: 'hands', id, hands }   (each hand: 21 [x, y] points, 0..1 image coords)
//                 { type: 'hands-error', message }
import { FilesetResolver, HandLandmarker, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

// MediaPipe prints routine startup notes ("INFO: Created TensorFlow Lite XNNPACK delegate",
// "W... OpenGL error checking is disabled") through console.error/warn, which Chrome lists as
// extension errors. Demote its info and warning lines to debug; real errors ("E....") stay.
const MEDIAPIPE_CHATTER = /^(INFO:|[IW]\d{4} )/;
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) =>
    typeof args[0] === 'string' && MEDIAPIPE_CHATTER.test(args[0]) ? console.debug(...args) : original(...args);
}

const ALLOWED_PARENTS = ['https://meet.google.com', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const WASM_BASE = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const SEGMENTER_MODEL = new URL('../vendor/mediapipe/models/selfie_segmenter.tflite', import.meta.url).href;
const HAND_MODEL = new URL('../vendor/mediapipe/models/hand_landmarker.task', import.meta.url).href;

let port = null;
let fileset = null;
let segmenter = null;
let hands = null; // HandLandmarker, or a promise while it loads
const lastTimestamp = { segment: 0, hands: 0 };

// MediaPipe requires strictly increasing timestamps per task in VIDEO mode.
function nextTimestamp(task) {
  lastTimestamp[task] = Math.max(performance.now(), lastTimestamp[task] + 1);
  return lastTimestamp[task];
}

async function createTask(create) {
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return { task: await create(delegate), delegate };
    } catch (err) {
      console.warn('[SnapDust segmenter]', delegate, 'failed', err);
    }
  }
  throw new Error('could not create the model on GPU or CPU');
}

function segment({ id, bitmap }) {
  const result = segmenter.segmentForVideo(bitmap, nextTimestamp('segment'));
  bitmap.close();
  const mask = result.confidenceMasks?.[0];
  if (!mask) {
    result.close?.();
    return;
  }

  const { width, height } = mask;
  const conf = mask.getAsFloat32Array();
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 3; i < conf.length; i++, j += 4) {
    rgba[j - 3] = 255;
    rgba[j - 2] = 255;
    rgba[j - 1] = 255;
    rgba[j] = conf[i] * 255;
  }
  result.close?.();
  port.postMessage({ type: 'mask', id, width, height, buffer: rgba.buffer }, [rgba.buffer]);
}

async function loadHands() {
  const { task } = await createTask((delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
  );
  return task;
}

function trackHands({ id, bitmap }) {
  if (!(hands instanceof HandLandmarker)) {
    bitmap.close();
    if (!hands) {
      hands = loadHands().then(
        (task) => (hands = task),
        (err) => {
          hands = null;
          port.postMessage({ type: 'hands-error', message: String(err) });
        },
      );
    }
    return;
  }
  const result = hands.detectForVideo(bitmap, nextTimestamp('hands'));
  bitmap.close();
  const found = result.landmarks.map((points) => points.map((p) => [p.x, p.y]));
  port.postMessage({ type: 'hands', id, hands: found });
}

async function onConnect(newPort) {
  port = newPort;
  port.onmessage = (event) => {
    const msg = event.data;
    if (msg?.type !== 'segment' && msg?.type !== 'hands') return;
    if (!segmenter) {
      msg.bitmap?.close();
      return;
    }
    try {
      if (msg.type === 'segment') segment(msg);
      else trackHands(msg);
    } catch (err) {
      port.postMessage({ type: msg.type === 'segment' ? 'error' : 'hands-error', message: String(err) });
    }
  };

  try {
    fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const { task, delegate } = await createTask((delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      }),
    );
    segmenter = task;
    port.postMessage({ type: 'ready', delegate });
  } catch (err) {
    port.postMessage({ type: 'error', message: String(err) });
  }
}

window.addEventListener('message', (event) => {
  if (!ALLOWED_PARENTS.includes(event.origin)) return;
  if (event.data?.type !== 'snapdust:connect' || !event.ports[0] || port) return;
  onConnect(event.ports[0]);
});
