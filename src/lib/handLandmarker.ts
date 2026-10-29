import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** Detection, presence and tracking confidence thresholds (MediaPipe defaults to 0.5). */
const MIN_CONFIDENCE = 0.6;

export type Delegate = 'GPU' | 'CPU';

export interface LoadedHandLandmarker {
  landmarker: HandLandmarker;
  delegate: Delegate;
}

/** Creates a VIDEO-mode, single-hand landmarker, preferring the GPU delegate. */
export async function createHandLandmarker(): Promise<LoadedHandLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);

  const create = (delegate: Delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: MIN_CONFIDENCE,
      minHandPresenceConfidence: MIN_CONFIDENCE,
      minTrackingConfidence: MIN_CONFIDENCE,
    });

  try {
    return { landmarker: await create('GPU'), delegate: 'GPU' };
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU.', err);
    return { landmarker: await create('CPU'), delegate: 'CPU' };
  }
}
