import * as THREE from 'three';
import { LM } from './tracking';

/**
 * A tracked hand as the wound renderer consumes it, whatever produced it
 * (the webcam + MediaPipe, or a headset's own hand tracking).
 */
export interface HandPose {
  /** 21 points in world space, in MediaPipe's landmark order. */
  joints: THREE.Vector3[];
  /** The user's actual hand. */
  isRightHand: boolean;
  /** A hand is currently tracked. */
  tracked: boolean;
  /** The hand is open (a closed hand covers the palm). */
  open: boolean;
  /** How far the palm's skin sits above the plane through the joints, in metres. */
  surfaceOffset: number;
  /** Increments whenever `joints` change. */
  version: number;
  /** The camera frame the joints came from (webcam mode), for sync checks. */
  frameId: number;
}

export function createHandPose(): HandPose {
  return {
    joints: Array.from({ length: 21 }, () => new THREE.Vector3()),
    isRightHand: true,
    tracked: false,
    open: false,
    surfaceOffset: 0,
    version: 0,
    frameId: -1,
  };
}

/** Openness above which a closed hand counts as open… */
export const OPEN_HAND_SCORE = 1.3;
/** …and below which an open hand counts as closed (the gap prevents flicker). */
export const CLOSED_HAND_SCORE = 1.15;

const FINGERS = [
  [LM.INDEX_MCP, 8],
  [LM.MIDDLE_MCP, 12],
  [LM.RING_MCP, 16],
  [LM.PINKY_MCP, 20],
] as const;

/**
 * How open a hand is, from 3D joints: the mean over the four fingers of
 * |wrist→fingertip| / |wrist→knuckle|. ~2 for a flat hand, ~1 for a fist.
 */
export function opennessFromJoints(joints: THREE.Vector3[]): number {
  const wrist = joints[LM.WRIST];
  let sum = 0;
  for (const [mcp, tip] of FINGERS) {
    const knuckle = wrist.distanceTo(joints[mcp]);
    sum += knuckle > 0 ? wrist.distanceTo(joints[tip]) / knuckle : 0;
  }
  return sum / FINGERS.length;
}
