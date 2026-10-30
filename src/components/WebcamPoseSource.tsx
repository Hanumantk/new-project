import { useMemo, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { computeCover, createCoverRect } from '../lib/coverMapping';
import type { HandPose } from '../lib/handPose';
import type { TrackingState } from '../lib/tracking';
import { WEBCAM_VFOV_DEG } from '../lib/webcamPalm';

/** Typical adult wrist → middle-knuckle distance, in metres. */
const REAL_PALM_LENGTH = 0.09;

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
 * Hands the webcam tracking (already in camera space: the palm's rigid
 * pose and the 21 joints) to the scene, whose camera sits at the origin
 * with the webcam's optics as seen through the cover crop. Runs before the
 * renderers each frame (negative priority); with on-demand rendering that
 * is once per detected camera frame.
 */
export function WebcamPoseSource({ tracking, pose, surfaceOffset = 0 }: WebcamPoseSourceProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const scratch = useMemo(() => ({ cover: createCoverRect(), lastFrameId: -1 }), []);

  useFrame(() => {
    const state = tracking.current;
    const out = pose.current;
    const frame = state?.frame;
    if (!state || !out || !frame || !frame.width) return;

    // Give the virtual camera the webcam's optics as seen through the cover
    // crop, so the wound's perspective matches the real image (the tracker
    // works in the same optics: WEBCAM_VFOV_DEG over the frame's height).
    const cover = computeCover(scratch.cover, size.width, size.height, frame.width, frame.height);
    const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(WEBCAM_VFOV_DEG) / 2) * (size.height / cover.height));
    const fovDeg = THREE.MathUtils.radToDeg(halfFov * 2);
    if (Math.abs(camera.fov - fovDeg) > 0.01) {
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
    }

    const palm = state.palm;
    out.tracked = state.landmarks !== null && palm.valid;
    out.open = state.handOpen;
    out.isRightHand = state.isRightHand;
    if (out.tracked && state.frameId !== scratch.lastFrameId) {
      scratch.lastFrameId = state.frameId;
      for (let i = 0; i < 21; i++) out.joints[i].copy(state.joints[i]);
      out.palm.valid = true;
      out.palm.position.copy(palm.position);
      out.palm.quaternion.copy(palm.quaternion);
      out.palm.scale = palm.scale;
      if (out.palm.templateVersion !== palm.templateVersion || palm.templateVersion === -1) {
        out.palm.template.set(palm.template);
        out.palm.templateVersion = palm.templateVersion;
      }
      out.version++;
    }
    out.palm.valid = out.tracked;
    out.surfaceOffset = (surfaceOffset * out.joints[0].distanceTo(out.joints[9])) / REAL_PALM_LENGTH;
    out.frameId = state.frameId;
  }, -1);

  return null;
}
