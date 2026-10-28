import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { computeCover, createCoverRect } from '../lib/coverMapping';
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

  useEffect(
    () => () => {
      geometry.dispose();
      cubeMaterial.dispose();
      shadowMaterial.dispose();
      shadowTexture.dispose();
    },
    [geometry, cubeMaterial, shadowMaterial, shadowTexture],
  );

  // Everything below is allocated once and reused every frame.
  const scratch = useMemo(
    () => ({
      cover: createCoverRect(),
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
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
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
    const viewW = size.width;
    const viewH = size.height;
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    const cover = computeCover(s.cover, viewW, viewH, videoW, videoH);

    // Give the virtual camera the webcam's optics as seen through the cover
    // crop, so the cube's perspective matches the real image.
    const halfFov = Math.atan(
      Math.tan(THREE.MathUtils.degToRad(WEBCAM_VFOV_DEG) / 2) * (viewH / cover.height),
    );
    const fovDeg = THREE.MathUtils.radToDeg(halfFov * 2);
    if (Math.abs(camera.fov - fovDeg) > 0.01) {
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
    }
    // World units per view pixel on the tracking plane.
    const worldPerPx = (2 * PLANE_DEPTH * Math.tan(halfFov)) / viewH;

    const landmarks = state.landmarks;
    // The cube only shows while the palm itself faces the camera.
    const hasHand = landmarks !== null && state.palmVisible;

    if (landmarks && state.frameId !== s.lastFrameId) {
      s.lastFrameId = state.frameId;
      updateTargets(landmarks, state.isRightHand, videoW, videoH, viewW, viewH, worldPerPx);
    }

    // Snap rather than glide when the cube is (re)appearing from invisible.
    if (hasHand && s.hasTarget && s.opacity === 0) {
      group.position.copy(s.targetPosition);
      group.quaternion.copy(s.targetQuaternion);
      group.scale.setScalar(s.targetScale);
    } else if (s.hasTarget) {
      group.position.lerp(s.targetPosition, SMOOTHING);
      group.quaternion.slerp(s.targetQuaternion, SMOOTHING);
      group.scale.setScalar(THREE.MathUtils.lerp(group.scale.x, s.targetScale, SMOOTHING));
    }

    const fadeStep = delta / FADE_SECONDS;
    s.opacity = THREE.MathUtils.clamp(s.opacity + (hasHand ? fadeStep : -fadeStep), 0, 1);
    cubeMaterial.opacity = s.opacity;
    shadowMaterial.opacity = SHADOW_OPACITY * s.opacity;
    group.visible = s.opacity > 0;
  });

  function updateTargets(
    landmarks: NormalizedLandmark[],
    isRightHand: boolean,
    videoW: number,
    videoH: number,
    viewW: number,
    viewH: number,
    worldPerPx: number,
  ) {
    const s = scratch;
    const cover = s.cover;

    // Palm centre: average of the wrist and the four knuckles, mapped through
    // the cover crop into view pixels, then onto the tracking plane.
    let nx = 0;
    let ny = 0;
    for (const i of PALM_INDICES) {
      nx += landmarks[i].x;
      ny += landmarks[i].y;
    }
    nx /= PALM_INDICES.length;
    ny /= PALM_INDICES.length;
    const px = cover.offsetX + nx * cover.width;
    const py = cover.offsetY + ny * cover.height;
    s.targetPosition.set((px - viewW / 2) * worldPerPx, -(py - viewH / 2) * worldPerPx, -PLANE_DEPTH);

    // Hand vectors in video pixels, converted to three.js axes (y up, z towards camera).
    toThree(s.a, landmarks[LM.WRIST], videoW, videoH);
    toThree(s.fingers, landmarks[LM.MIDDLE_MCP], videoW, videoH).sub(s.a);
    toThree(s.a, landmarks[LM.INDEX_MCP], videoW, videoH);
    toThree(s.across, landmarks[LM.PINKY_MCP], videoW, videoH).sub(s.a);

    // Scale: palm length on the tracking plane relative to a real palm.
    const palmWorld = s.fingers.length() * cover.scale * worldPerPx;
    s.targetScale = THREE.MathUtils.clamp(palmWorld / REAL_PALM_LENGTH, MIN_SCALE, MAX_SCALE);

    // Rotation: y = palm normal (out of the palm), z = towards the fingers.
    // fingers × across points out of the palm for a right hand and out of the
    // back of a left hand, so flip it for left hands.
    s.yAxis.crossVectors(s.fingers, s.across);
    if (!isRightHand) s.yAxis.negate();
    if (s.yAxis.lengthSq() < 1e-6) {
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
  );
}

/**
 * MediaPipe landmark → three.js-oriented vector in video pixels.
 * MediaPipe's z uses roughly the same scale as x and is smaller when closer
 * to the camera, so it is scaled by the video width and negated.
 */
function toThree(out: THREE.Vector3, lm: NormalizedLandmark, videoW: number, videoH: number) {
  return out.set(lm.x * videoW, -lm.y * videoH, -lm.z * videoW);
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
