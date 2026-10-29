import { useMemo, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { computeCover, createCoverRect, type CoverRect } from '../lib/coverMapping';
import type { HandPose } from '../lib/handPose';
import type { TrackingState } from '../lib/tracking';

/** Typical adult wrist → middle-knuckle distance, in metres. */
const REAL_PALM_LENGTH = 0.09;
/** Depth of the plane, in front of the camera, on which the hand is placed. */
const PLANE_DEPTH = 0.5;
/** Vertical field of view of a typical 16:9 laptop webcam (~65° horizontal). */
const WEBCAM_VFOV_DEG = 41;

/** Everything needed to turn a landmark into a world-space point. */
interface Projection {
  cover: CoverRect;
  viewW: number;
  viewH: number;
  videoW: number;
  worldPerPx: number;
}

interface WebcamPoseSourceProps {
  tracking: RefObject<TrackingState>;
  pose: RefObject<HandPose>;
  /**
   * Lift from the joints to the skin, for a 9 cm palm, in metres: 0 on the
   * camera picture (the landmarks are already on the skin), more when the
   * hand is drawn as a mesh whose palm surface sits above its bones.
   */
  surfaceOffset?: number;
}

/**
 * Turns the webcam's MediaPipe landmarks into a world-space HandPose for the
 * virtual camera at the origin, and gives that camera the webcam's optics.
 * Runs before the renderers each frame (negative priority); with on-demand
 * rendering that is once per detected camera frame.
 */
export function WebcamPoseSource({ tracking, pose, surfaceOffset = 0 }: WebcamPoseSourceProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const scratch = useMemo(
    () => ({
      projection: { cover: createCoverRect(), viewW: 0, viewH: 0, videoW: 0, worldPerPx: 0 },
      lastFrameId: -1,
    }),
    [],
  );

  useFrame(() => {
    const state = tracking.current;
    const out = pose.current;
    const frame = state?.frame;
    if (!state || !out || !frame || !frame.width) return;

    const p = scratch.projection;
    p.viewW = size.width;
    p.viewH = size.height;
    p.videoW = frame.width;
    const cover = computeCover(p.cover, p.viewW, p.viewH, frame.width, frame.height);

    // Give the virtual camera the webcam's optics as seen through the cover
    // crop, so the wound's perspective matches the real image.
    const halfFov = Math.atan(
      Math.tan(THREE.MathUtils.degToRad(WEBCAM_VFOV_DEG) / 2) * (p.viewH / cover.height),
    );
    const fovDeg = THREE.MathUtils.radToDeg(halfFov * 2);
    if (Math.abs(camera.fov - fovDeg) > 0.01) {
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
    }
    // World units per view pixel on the tracking plane.
    p.worldPerPx = (2 * PLANE_DEPTH * Math.tan(halfFov)) / p.viewH;

    const landmarks = state.landmarks;
    out.tracked = landmarks !== null;
    out.open = state.handOpen;
    out.isRightHand = state.isRightHand;
    if (landmarks && state.frameId !== scratch.lastFrameId) {
      scratch.lastFrameId = state.frameId;
      for (let i = 0; i < landmarks.length; i++) landmarkToWorld(out.joints[i], landmarks[i], p);
      out.version++;
    }
    out.surfaceOffset = (surfaceOffset * out.joints[0].distanceTo(out.joints[9])) / REAL_PALM_LENGTH;
    out.frameId = state.frameId;
  }, -1);

  return null;
}

/**
 * MediaPipe landmark → world point. x/y go through the cover crop to a view
 * pixel, whose camera ray we follow to the landmark's depth: the tracking
 * plane, shifted by MediaPipe's relative z (same scale as x, smaller = closer).
 * Following the ray keeps every point exactly over the hand on screen.
 */
function landmarkToWorld(out: THREE.Vector3, lm: NormalizedLandmark, p: Projection) {
  const { cover, viewW, viewH, videoW, worldPerPx } = p;
  const px = cover.offsetX + lm.x * cover.width;
  const py = cover.offsetY + lm.y * cover.height;
  const depth = Math.max(PLANE_DEPTH + lm.z * videoW * cover.scale * worldPerPx, PLANE_DEPTH * 0.2);
  const k = (worldPerPx / PLANE_DEPTH) * depth;
  return out.set((px - viewW / 2) * k, -(py - viewH / 2) * k, -depth);
}
