// Copies MediaPipe's runtime and the selfie segmentation model into extension/vendor.
// MV3 forbids loading code from the network, so everything ships inside the extension.
// Run with: npm run vendor
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'node_modules/@mediapipe/tasks-vision');
const out = join(root, 'extension/vendor/mediapipe');

const MODELS = {
  'selfie_segmenter.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  // For spotting the finger snap (thumb + middle finger together, then apart).
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
};

const files = [
  ['vision_bundle.mjs', 'vision_bundle.mjs'],
  // Chrome always supports wasm SIMD, so only the SIMD build is shipped.
  ['wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.js'],
  ['wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_internal.wasm'],
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(join(out, 'wasm'), { recursive: true });
await mkdir(join(out, 'models'), { recursive: true });

for (const [from, to] of files) {
  await copyFile(join(pkg, from), join(out, to));
  console.log('copied', to);
}

for (const [name, url] of Object.entries(MODELS)) {
  const modelPath = join(out, 'models', name);
  if (await exists(modelPath)) {
    console.log(`${name} already present`);
    continue;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} download failed: ${res.status}`);
  await writeFile(modelPath, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded models/${name}`);
}
