import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

/**
 * Mutable state shared between the detection loop and the 3D scene.
 * It lives in a ref so per-frame updates never trigger React renders.
 */
export interface TrackingState {
  video: HTMLVideoElement | null;
  /** Landmarks of the tracked hand in the latest frame, or null if none. */
  landmarks: NormalizedLandmark[] | null;
  /** The user's actual hand (not MediaPipe's mirrored label). */
  isRightHand: boolean;
  /** True while the palm side (not the back of the hand) faces the camera. */
  palmVisible: boolean;
  /** Increments every time a new video frame has been processed. */
  frameId: number;
}

export function createTrackingState(): TrackingState {
  return { video: null, landmarks: null, isRightHand: true, palmVisible: false, frameId: 0 };
}

/** Indices of the landmarks we use. */
export const LM = {
  WRIST: 0,
  INDEX_MCP: 5,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
  PINKY_MCP: 17,
} as const;

export const PALM_INDICES = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];

/**
 * How squarely the palm (rather than the back of the hand) faces the camera:
 * +1 palm straight at the camera, 0 edge-on, -1 back of the hand.
 *
 * It is the screen-facing component of the palm normal, built from the
 * wrist→middle-knuckle and index→pinky-knuckle directions. Only x/y are used,
 * since MediaPipe's z estimate is too noisy to decide which side faces us.
 */
export function palmFacingScore(
  landmarks: NormalizedLandmark[],
  isRightHand: boolean,
  videoWidth: number,
  videoHeight: number,
): number {
  const wrist = landmarks[LM.WRIST];
  const middle = landmarks[LM.MIDDLE_MCP];
  const index = landmarks[LM.INDEX_MCP];
  const pinky = landmarks[LM.PINKY_MCP];
  // Image y points down; flip it so the cross product follows three.js axes.
  const fx = (middle.x - wrist.x) * videoWidth;
  const fy = -(middle.y - wrist.y) * videoHeight;
  const ax = (pinky.x - index.x) * videoWidth;
  const ay = -(pinky.y - index.y) * videoHeight;
  const lengths = Math.hypot(fx, fy) * Math.hypot(ax, ay);
  if (lengths === 0) return 0;
  const cross = (fx * ay - fy * ax) / lengths;
  return isRightHand ? cross : -cross;
}
