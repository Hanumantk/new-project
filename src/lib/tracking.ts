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
  /** Increments every time a new video frame has been processed. */
  frameId: number;
}

export function createTrackingState(): TrackingState {
  return { video: null, landmarks: null, isRightHand: true, frameId: 0 };
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
