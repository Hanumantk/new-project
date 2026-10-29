import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HandOccluder } from '../lib/handOccluder';
import type { HandPose } from '../lib/handPose';
import {
  INJURY_HEIGHT_MAX,
  INJURY_HEIGHT_MIN,
  INJURY_PATCH_SIZE,
  loadInjuryTextures,
  type InjuryTextures,
} from '../lib/injury/injuryTextures';
import { LM, PALM_INDICES } from '../lib/tracking';

/** Size of the wound relative to the designed patch (a 7 cm square of palm). */
const INJURY_SIZE = 1.3;
/** The landmark palm centre sits near the knuckles; move the wound towards the wrist. */
const INJURY_OFFSET_TOWARDS_WRIST = 0.022;
/** Heights above the palm plane, in metres, for the skin tint and the wound's base. */
const TINT_LIFT = 0.0008;
const WOUND_LIFT = 0.0014;
/** Vertex grid of the displaced wound mesh. */
const WOUND_SEGMENTS = 192;
/** Typical adult wrist → middle-finger knuckle distance, in metres. */
const REAL_PALM_LENGTH = 0.09;
const FADE_SECONDS = 0.2;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

interface PalmInjuryProps {
  /** The tracked hand, filled each frame by a pose source (webcam or headset). */
  pose: RefObject<HandPose>;
  /**
   * Hide the wound behind an invisible stand-in for the real hand. Needed when
   * the real hand is seen (webcam video, passthrough); off when a visible
   * virtual hand is drawn, which hides the wound by itself.
   */
  occlude?: boolean;
}

export function PalmInjury({ pose, occlude = true }: PalmInjuryProps) {
  const gl = useThree((s) => s.gl);

  const groupRef = useRef<THREE.Group>(null);
  const [textures, setTextures] = useState<InjuryTextures | null>(null);

  const tintGeometry = useMemo(
    () => new THREE.PlaneGeometry(INJURY_PATCH_SIZE, INJURY_PATCH_SIZE),
    [],
  );
  const woundGeometry = useMemo(
    () =>
      new THREE.PlaneGeometry(INJURY_PATCH_SIZE, INJURY_PATCH_SIZE, WOUND_SEGMENTS, WOUND_SEGMENTS),
    [],
  );
  // Bruising and redness are unlit so they read as a change in skin colour.
  const tintMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
    [],
  );
  // The wound is lit: displaced, normal-mapped, and glossy where it's wet.
  const woundMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        transparent: true,
        depthWrite: false,
        roughness: 1, // scaled per pixel by the roughness map
        metalness: 0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.12,
        displacementScale: INJURY_HEIGHT_MAX - INJURY_HEIGHT_MIN,
        displacementBias: INJURY_HEIGHT_MIN,
        envMapIntensity: 0.3,
        // Keep the authored wound colours; tone mapping washes reds out to pink.
        toneMapped: false,
      }),
    [],
  );
  const occluder = useMemo(() => new HandOccluder(), []);

  // Soft studio reflections for the wet surfaces.
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, 0.04).texture;
    woundMaterial.envMap = envMap;
    woundMaterial.needsUpdate = true;
    room.dispose();
    pmrem.dispose();
    return () => envMap.dispose();
  }, [gl, woundMaterial]);

  useEffect(() => {
    let cancelled = false;
    let loaded: InjuryTextures | null = null;
    loadInjuryTextures().then((t) => {
      if (cancelled) {
        t.dispose();
        return;
      }
      loaded = t;
      tintMaterial.map = t.tint;
      woundMaterial.map = t.wound;
      woundMaterial.normalMap = t.normal;
      woundMaterial.roughnessMap = t.surface;
      woundMaterial.displacementMap = t.surface;
      tintMaterial.needsUpdate = true;
      woundMaterial.needsUpdate = true;
      setTextures(t);
    });
    return () => {
      cancelled = true;
      loaded?.dispose();
    };
  }, [tintMaterial, woundMaterial]);

  useEffect(
    () => () => {
      tintGeometry.dispose();
      woundGeometry.dispose();
      tintMaterial.dispose();
      woundMaterial.dispose();
      occluder.dispose();
    },
    [tintGeometry, woundGeometry, tintMaterial, woundMaterial, occluder],
  );

  // Everything below is allocated once and reused every frame.
  const scratch = useMemo(
    () => ({
      targetJoints: Array.from({ length: 21 }, () => new THREE.Vector3()),
      joints: Array.from({ length: 21 }, () => new THREE.Vector3()),
      targetPosition: new THREE.Vector3(),
      targetQuaternion: new THREE.Quaternion(),
      targetScale: 1,
      hasTarget: false,
      lastVersion: -1,
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
    const hand = pose.current;
    if (!group || !hand) return;
    const s = scratch;

    // A closed hand covers the palm, so the wound only shows while it's open.
    const visible = hand.tracked && hand.open && textures !== null;

    if (hand.tracked && hand.version !== s.lastVersion) {
      s.lastVersion = hand.version;
      updateTargets(hand);
    }

    // No smoothing here: the pose is used as tracked (webcam landmarks are
    // already One Euro filtered), so the wound never trails the hand.
    if (s.hasTarget) {
      group.position.copy(s.targetPosition);
      group.quaternion.copy(s.targetQuaternion);
      group.scale.setScalar(s.targetScale);
      s.joints.forEach((joint, i) => joint.copy(s.targetJoints[i]));
    }

    const fadeStep = delta / FADE_SECONDS;
    s.opacity = THREE.MathUtils.clamp(s.opacity + (visible ? fadeStep : -fadeStep), 0, 1);
    tintMaterial.opacity = s.opacity;
    woundMaterial.opacity = s.opacity;
    group.visible = s.opacity > 0;

    // Keep the invisible hand in step with the wound so the real
    // hand hides it whenever the palm is turned away.
    occluder.root.visible = occlude && group.visible;
    if (occluder.root.visible) {
      s.normal.set(0, 1, 0).applyQuaternion(group.quaternion);
      occluder.update(s.joints, s.normal, group.position, group.scale.x);
    }
  });

  function updateTargets(hand: HandPose) {
    const s = scratch;
    s.targetJoints.forEach((joint, i) => joint.copy(hand.joints[i]));

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
    if (!hand.isRightHand) s.yAxis.negate();
    if (s.yAxis.lengthSq() < 1e-12) {
      s.hasTarget = true;
      return; // Degenerate (hand edge-on): keep the previous orientation.
    }
    s.yAxis.normalize();
    // Sit on the skin rather than on the plane through the joints.
    s.targetPosition.addScaledVector(s.yAxis, hand.surfaceOffset);
    s.zAxis.copy(s.fingers).addScaledVector(s.yAxis, -s.fingers.dot(s.yAxis)).normalize();
    s.xAxis.crossVectors(s.yAxis, s.zAxis);
    s.basis.makeBasis(s.xAxis, s.yAxis, s.zAxis);
    s.targetQuaternion.setFromRotationMatrix(s.basis);
    s.hasTarget = true;
  }

  // The planes lie flat on the palm (local XZ), texture "down" towards the wrist.
  return (
    <>
      <primitive object={occluder.root} />
      <group ref={groupRef} visible={false}>
        <mesh
          geometry={tintGeometry}
          material={tintMaterial}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, TINT_LIFT, -INJURY_OFFSET_TOWARDS_WRIST]}
          scale={INJURY_SIZE}
          renderOrder={1}
        />
        <mesh
          geometry={woundGeometry}
          material={woundMaterial}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, WOUND_LIFT, -INJURY_OFFSET_TOWARDS_WRIST]}
          scale={[INJURY_SIZE, INJURY_SIZE, 1]}
          renderOrder={2}
        />
      </group>
    </>
  );
}
