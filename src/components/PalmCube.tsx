import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { computeCover, createCoverRect, type CoverRect } from '../lib/coverMapping';
import { HandOccluder } from '../lib/handOccluder';
import { LM, PALM_INDICES, type TrackingState } from '../lib/tracking';

/** Cube edge length in metres. */
const CUBE_SIZE = 0.06;
/** Gap between the palm and the underside of the cube, in metres. */
const HOVER_GAP = 0.008;
/** Typical adult wrist → middle-finger knuckle distance, in metres. */
const REAL_PALM_LENGTH = 0.09;
/** Depth of the plane, in front of the camera, on which the hand is placed. */
const PLANE_DEPTH = 0.5;
/** Vertical field of view of a typical 16:9 laptop webcam (~65° horizontal). */
const WEBCAM_VFOV_DEG = 41;
const SMOOTHING = 0.35;
const FADE_SECONDS = 0.2;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

const CUBE_COLOR = '#8EDDB0';
const SHADOW_OPACITY = 0.38;

/** Everything needed to turn a landmark into a world-space point. */
interface Projection {
  cover: CoverRect;
  viewW: number;
  viewH: number;
  videoW: number;
  worldPerPx: number;
}

interface PalmCubeProps {
  tracking: RefObject<TrackingState>;
}

export function PalmCube({ tracking }: PalmCubeProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);

  const groupRef = useRef<THREE.Group>(null);

  const geometry = useMemo(
    () => new RoundedBoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, 4, CUBE_SIZE * 0.14),
    [],
  );
  const cubeMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: CUBE_COLOR,
        roughness: 0.32,
        metalness: 0,
        clearcoat: 0.8,
        clearcoatRoughness: 0.18,
        transparent: true,
      }),
    [],
  );
  const shadowTexture = useMemo(() => createShadowTexture(), []);
  const shadowMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: SHADOW_OPACITY,
      }),
    [shadowTexture],
  );
  const occluder = useMemo(() => new HandOccluder(), []);

  useEffect(
    () => () => {
      geometry.dispose();
      cubeMaterial.dispose();
      shadowMaterial.dispose();
      shadowTexture.dispose();
      occluder.dispose();
    },
    [geometry, cubeMaterial, shadowMaterial, shadowTexture, occluder],
  );

  // Everything below is allocated once and reused every frame.
  const scratch = useMemo(
    () => ({
      projection: { cover: createCoverRect(), viewW: 0, viewH: 0, videoW: 0, worldPerPx: 0 },
      targetJoints: Array.from({ length: 21 }, () => new THREE.Vector3()),
      joints: Array.from({ length: 21 }, () => new THREE.Vector3()),
      targetPosition: new THREE.Vector3(),
      targetQuaternion: new THREE.Quaternion(),
      targetScale: 1,
      hasTarget: false,
      lastFrameId: -1,
      opacity: 0,
      fingers: new THREE.Vector3(),
      across: new THREE.Vector3(),
      xAxis: new THREE.Vector3(),
      yAxis: new THREE.Vector3(),
      zAxis: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      basis: new THREE.Matrix4(),
    }),
    [],
  );

  useFrame((_, delta) => {
    const group = groupRef.current;
    const state = tracking.current;
    const video = state?.video;
    if (!group || !state || !video || !video.videoWidth) return;

    const s = scratch;
    const p = s.projection;
    p.viewW = size.width;
    p.viewH = size.height;
    p.videoW = video.videoWidth;
    const cover = computeCover(p.cover, p.viewW, p.viewH, video.videoWidth, video.videoHeight);

    // Give the virtual camera the webcam's optics as seen through the cover
    // crop, so the cube's perspective matches the real image.
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
    // A closed hand has no palm to rest on, so the cube only shows while it's open.
    const hasHand = landmarks !== null && state.handOpen;

    if (landmarks && state.frameId !== s.lastFrameId) {
      s.lastFrameId = state.frameId;
      updateTargets(landmarks, state.isRightHand, p);
    }

    // Snap rather than glide when the cube is (re)appearing from invisible.
    if (hasHand && s.hasTarget && s.opacity === 0) {
      group.position.copy(s.targetPosition);
      group.quaternion.copy(s.targetQuaternion);
      group.scale.setScalar(s.targetScale);
      s.joints.forEach((joint, i) => joint.copy(s.targetJoints[i]));
    } else if (s.hasTarget) {
      group.position.lerp(s.targetPosition, SMOOTHING);
      group.quaternion.slerp(s.targetQuaternion, SMOOTHING);
      group.scale.setScalar(THREE.MathUtils.lerp(group.scale.x, s.targetScale, SMOOTHING));
      s.joints.forEach((joint, i) => joint.lerp(s.targetJoints[i], SMOOTHING));
    }

    const fadeStep = delta / FADE_SECONDS;
    s.opacity = THREE.MathUtils.clamp(s.opacity + (hasHand ? fadeStep : -fadeStep), 0, 1);
    cubeMaterial.opacity = s.opacity;
    shadowMaterial.opacity = SHADOW_OPACITY * s.opacity;
    group.visible = s.opacity > 0;

    // Keep the invisible hand in step with the (smoothed) cube so the real
    // hand hides whatever part of the cube is behind it.
    occluder.root.visible = group.visible;
    if (group.visible) {
      s.normal.set(0, 1, 0).applyQuaternion(group.quaternion);
      occluder.update(s.joints, s.normal, group.position, group.scale.x);
    }
  });

  function updateTargets(landmarks: NormalizedLandmark[], isRightHand: boolean, p: Projection) {
    const s = scratch;

    // All 21 landmarks as 3D points in front of the camera.
    for (let i = 0; i < landmarks.length; i++) landmarkToWorld(s.targetJoints[i], landmarks[i], p);

    // Palm centre: average of the wrist and the four knuckles.
    s.targetPosition.set(0, 0, 0);
    for (const i of PALM_INDICES) s.targetPosition.add(s.targetJoints[i]);
    s.targetPosition.divideScalar(PALM_INDICES.length);

    s.fingers.subVectors(s.targetJoints[LM.MIDDLE_MCP], s.targetJoints[LM.WRIST]);
    s.across.subVectors(s.targetJoints[LM.PINKY_MCP], s.targetJoints[LM.INDEX_MCP]);

    // Scale: palm length relative to a real palm.
    s.targetScale = THREE.MathUtils.clamp(
      s.fingers.length() / REAL_PALM_LENGTH,
      MIN_SCALE,
      MAX_SCALE,
    );

    // Rotation: y = palm normal (out of the palm), z = towards the fingers.
    // fingers × across points out of the palm for a right hand and out of the
    // back of a left hand, so flip it for left hands.
    s.yAxis.crossVectors(s.fingers, s.across);
    if (!isRightHand) s.yAxis.negate();
    if (s.yAxis.lengthSq() < 1e-12) {
      s.hasTarget = true;
      return; // Degenerate (hand edge-on): keep the previous orientation.
    }
    s.yAxis.normalize();
    s.zAxis.copy(s.fingers).addScaledVector(s.yAxis, -s.fingers.dot(s.yAxis)).normalize();
    s.xAxis.crossVectors(s.yAxis, s.zAxis);
    s.basis.makeBasis(s.xAxis, s.yAxis, s.zAxis);
    s.targetQuaternion.setFromRotationMatrix(s.basis);
    s.hasTarget = true;
  }

  return (
    <>
      <primitive object={occluder.root} />
      <group ref={groupRef} visible={false}>
        <mesh
          geometry={geometry}
          material={cubeMaterial}
          position={[0, CUBE_SIZE / 2 + HOVER_GAP, 0]}
        />
        <mesh material={shadowMaterial} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
          <planeGeometry args={[CUBE_SIZE * 1.7, CUBE_SIZE * 1.7]} />
        </mesh>
      </group>
    </>
  );
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

function createShadowTexture(): THREE.CanvasTexture {
  const res = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = res;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(res / 2, res / 2, 0, res / 2, res / 2, res / 2);
  gradient.addColorStop(0, 'rgba(18, 48, 32, 0.9)');
  gradient.addColorStop(0.45, 'rgba(18, 48, 32, 0.45)');
  gradient.addColorStop(1, 'rgba(18, 48, 32, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, res, res);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
