import { useEffect, useMemo, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import { JointPalmFitter } from '../lib/jointPalm';
import { PALM_SKIN_LIFT } from '../lib/palmModel';
import {
  CLOSED_HAND_SCORE,
  OPEN_HAND_SCORE,
  opennessFromJoints,
  type HandPose,
} from '../lib/handPose';

/** WebXR hand joints in MediaPipe's landmark order (MCP = base of the proximal phalanx). */
const XR_JOINTS: readonly XRHandJoint[] = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
];
/** Extra lift above the palm's joint radius, in metres: just clear of the real skin… */
const SKIN_CLEARANCE = 0.002;
/** …or clear of the virtual hand model's palm, which is thicker than the joint radius. */
const MODEL_CLEARANCE = 0.009;
/** Skin tone for the virtual hands (the stock model is grey). */
const HAND_SKIN = new THREE.Color('#d6a48c');
/** Fallback palm half-thickness when the runtime gives no joint radius. */
const DEFAULT_PALM_RADIUS = 0.011;

type HandSpace = THREE.XRHandSpace;

interface XRPoseSourceProps {
  pose: RefObject<HandPose>;
  /** Draw virtual hands (in VR; in mixed reality the real hands are visible). */
  showHands: boolean;
}

/**
 * Feeds the headset's own hand tracking into a HandPose. The wound goes on
 * the right hand when it's tracked, otherwise on the left.
 */
export function XRPoseSource({ pose, showHands }: XRPoseSourceProps) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  const state = useMemo(
    () => ({
      hands: [] as HandSpace[],
      models: [] as THREE.Object3D[],
      handedness: new Map<HandSpace, XRHandedness>(),
      skinned: new WeakSet<THREE.Material>(),
      palmFitter: new JointPalmFitter(),
    }),
    [],
  );

  // Hand spaces (and their models) must exist before a session connects hands.
  useEffect(() => {
    const factory = new XRHandModelFactory();
    const hands = [gl.xr.getHand(0), gl.xr.getHand(1)];
    const listeners = hands.map((hand) => {
      const onConnected = (event: { data: XRInputSource }) => {
        if (event.data.hand) state.handedness.set(hand, event.data.handedness);
      };
      const onDisconnected = () => state.handedness.delete(hand);
      hand.addEventListener('connected', onConnected);
      hand.addEventListener('disconnected', onDisconnected);
      return { onConnected, onDisconnected };
    });
    const models = hands.map((hand) => {
      const model = factory.createHandModel(hand, 'mesh');
      hand.add(model);
      scene.add(hand);
      return model;
    });
    state.hands = hands;
    state.models = models;
    return () => {
      hands.forEach((hand, i) => {
        hand.removeEventListener('connected', listeners[i].onConnected);
        hand.removeEventListener('disconnected', listeners[i].onDisconnected);
        hand.remove(models[i]);
        scene.remove(hand);
      });
      state.handedness.clear();
      state.hands = [];
      state.models = [];
    };
  }, [gl, scene, state]);

  useEffect(() => {
    state.models.forEach((model) => (model.visible = showHands));
  }, [showHands, state]);

  useFrame(() => {
    const out = pose.current;
    if (!out) return;

    // The hand meshes load asynchronously; tint each one once it appears.
    if (showHands) {
      for (const model of state.models) {
        model.traverse((child) => {
          const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (!material || !('color' in material) || state.skinned.has(material)) return;
          material.color.copy(HAND_SKIN);
          material.roughness = 0.75;
          state.skinned.add(material);
        });
      }
    }

    const hand = pickHand(state.hands, state.handedness);
    if (!hand) {
      out.tracked = false;
      out.palm.valid = false;
      return;
    }
    for (let i = 0; i < XR_JOINTS.length; i++) {
      const joint = hand.joints[XR_JOINTS[i]];
      if (!joint || !joint.visible) {
        out.tracked = false;
        out.palm.valid = false;
        return;
      }
      out.joints[i].copy(joint.position);
    }

    const palm = hand.joints['middle-finger-metacarpal'];
    // The palm surface already sits PALM_SKIN_LIFT above the joints; make up the rest of the joint's radius.
    out.surfaceOffset =
      (palm?.jointRadius ?? DEFAULT_PALM_RADIUS) -
      PALM_SKIN_LIFT * out.palm.scale +
      (showHands ? MODEL_CLEARANCE : SKIN_CLEARANCE);
    out.isRightHand = state.handedness.get(hand) === 'right';
    out.open = opennessFromJoints(out.joints) > (out.open ? CLOSED_HAND_SCORE : OPEN_HAND_SCORE);
    out.tracked = state.palmFitter.update(out.joints, out.isRightHand, out.palm);
    out.version++;
  }, -1);

  return null;
}

/** The tracked right hand if there is one, else the tracked left hand. */
function pickHand(hands: HandSpace[], handedness: Map<HandSpace, XRHandedness>) {
  let fallback: HandSpace | null = null;
  for (const hand of hands) {
    if (!handedness.has(hand) || !hand.joints.wrist?.visible) continue;
    if (handedness.get(hand) === 'right') return hand;
    fallback = hand;
  }
  return fallback;
}
