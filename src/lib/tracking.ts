import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { createSkinSample, type SkinSample } from './skinSampler';

/**
 * Mutable state shared between the detection loop and the 3D scene.
 * It lives in a ref so per-frame updates never trigger React renders.
 */
export interface TrackingState {
  /**
   * The camera frame the latest detection ran on, copied out of the video.
   * The scene draws this same canvas as its background, so the wound pose
   * and the picture behind it always come from one frame.
   */
  frame: HTMLCanvasElement | null;
  /** Landmarks of the tracked hand in `frame` (One Euro filtered), or null if none. */
  landmarks: NormalizedLandmark[] | null;
  /** The user's actual hand (not MediaPipe's mirrored label). */
  isRightHand: boolean;
  /** True while the hand is open (a closed hand covers the palm). */
  handOpen: boolean;
  /** Increments every time a new video frame has been captured and processed. */
  frameId: number;
  /** The real skin around the wound: colour, brightness and camera noise. */
  skin: SkinSample;
  /** Which frame the background and the wound pose were last rendered from. */
  rendered: { backgroundFrameId: number; poseFrameId: number; mismatches: number };
}

export function createTrackingState(): TrackingState {
  return {
    frame: null,
    landmarks: null,
    isRightHand: true,
    handOpen: false,
    frameId: 0,
    skin: createSkinSample(),
    rendered: { backgroundFrameId: -1, poseFrameId: -1, mismatches: 0 },
  };
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

const FINGERS = [
  { mcp: 5, tip: 8 },
  { mcp: 9, tip: 12 },
  { mcp: 13, tip: 16 },
  { mcp: 17, tip: 20 },
] as const;

/**
 * How open the hand is: the mean, over the four fingers, of
 * |wrist→fingertip| / |wrist→knuckle|. Around 1.8–2 for a flat open hand,
 * close to 1 for a fist. Uses MediaPipe's z too, so turning the hand
 * sideways doesn't read as closing it.
 */
export function handOpenness(
  landmarks: NormalizedLandmark[],
  videoWidth: number,
  videoHeight: number,
): number {
  const wrist = landmarks[LM.WRIST];
  const dist = (i: number) =>
    Math.hypot(
      (landmarks[i].x - wrist.x) * videoWidth,
      (landmarks[i].y - wrist.y) * videoHeight,
      (landmarks[i].z - wrist.z) * videoWidth,
    );
  let sum = 0;
  for (const { mcp, tip } of FINGERS) {
    const knuckle = dist(mcp);
    sum += knuckle > 0 ? dist(tip) / knuckle : 0;
  }
  return sum / FINGERS.length;
}
