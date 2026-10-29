import * as THREE from 'three';

/** The joints the mat reads, in this order. */
const JOINTS: readonly XRHandJoint[] = [
  'wrist',
  'thumb-tip',
  'index-finger-tip',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'pinky-finger-phalanx-proximal',
];
const WRIST = 0;
const THUMB_TIP = 1;
const INDEX_TIP = 2;
const INDEX_PROXIMAL = 3;
const INDEX_INTERMEDIATE = 4;
const INDEX_DISTAL = 5;
const PINKY_PROXIMAL = 6;

/** Fallback fingertip radius when the runtime gives none (m). */
const DEFAULT_TIP_RADIUS = 0.008;

/** One hand's tracked state, refreshed every frame without allocating. */
export class HandState {
  tracked = false;
  readonly joints = JOINTS.map(() => new THREE.Vector3());
  readonly radii = new Float32Array(JOINTS.length);
  /** Midpoint of thumb and index tips: the drawing pen. */
  readonly pen = new THREE.Vector3();
  /** Thumb-to-index tip distance (m). */
  pinchDistance = Infinity;
  /** Unit normal out of the palm. */
  readonly palmNormal = new THREE.Vector3();
  /** Index finger roughly straight (pointing, as for a poke). */
  indexStraight = false;

  constructor(readonly handedness: 'left' | 'right') {}

  get indexTip() {
    return this.joints[INDEX_TIP];
  }

  get indexTipRadius() {
    return this.radii[INDEX_TIP] || DEFAULT_TIP_RADIUS;
  }

  /** Mean of the thumb and index tip radii: how far the pen rides above a surface. */
  get penRadius() {
    return ((this.radii[THUMB_TIP] || DEFAULT_TIP_RADIUS) + (this.radii[INDEX_TIP] || DEFAULT_TIP_RADIUS)) / 2;
  }
}

const a = new THREE.Vector3();
const b = new THREE.Vector3();

/** Reads both hands' joints from the XR frame. */
export class HandTracker {
  readonly left = new HandState('left');
  readonly right = new HandState('right');
  private readonly spaces = new WeakMap<XRHand, XRJointSpace[]>();
  private readonly transforms = new Float32Array(JOINTS.length * 16);

  update(frame: XRFrame, space: XRReferenceSpace) {
    this.left.tracked = false;
    this.right.tracked = false;
    const sources = frame.session.inputSources;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (!source.hand || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
      const hand = source.handedness === 'left' ? this.left : this.right;
      hand.tracked = this.readJoints(frame, space, source.hand, hand);
      if (hand.tracked) derive(hand);
    }
  }

  private readJoints(frame: XRFrame, space: XRReferenceSpace, xrHand: XRHand, hand: HandState): boolean {
    let spaces = this.spaces.get(xrHand);
    if (!spaces) {
      spaces = JOINTS.map((joint) => xrHand.get(joint)!);
      if (spaces.some((s) => !s)) return false;
      this.spaces.set(xrHand, spaces);
    }
    if (frame.fillPoses && frame.fillJointRadii) {
      if (!frame.fillPoses(spaces, space, this.transforms)) return false;
      if (!frame.fillJointRadii(spaces, hand.radii)) return false;
      for (let j = 0; j < JOINTS.length; j++) {
        const o = j * 16;
        hand.joints[j].set(this.transforms[o + 12], this.transforms[o + 13], this.transforms[o + 14]);
      }
      return true;
    }
    for (let j = 0; j < JOINTS.length; j++) {
      const pose = frame.getJointPose?.(spaces[j], space);
      if (!pose) return false;
      const p = pose.transform.position;
      hand.joints[j].set(p.x, p.y, p.z);
      hand.radii[j] = pose.radius ?? DEFAULT_TIP_RADIUS;
    }
    return true;
  }
}

function derive(hand: HandState) {
  const j = hand.joints;
  hand.pen.addVectors(j[THUMB_TIP], j[INDEX_TIP]).multiplyScalar(0.5);
  hand.pinchDistance = j[THUMB_TIP].distanceTo(j[INDEX_TIP]);

  // (index knuckle − wrist) × (pinky knuckle − wrist) points out of a right palm.
  a.subVectors(j[INDEX_PROXIMAL], j[WRIST]);
  b.subVectors(j[PINKY_PROXIMAL], j[WRIST]);
  hand.palmNormal.crossVectors(a, b).normalize();
  if (hand.handedness === 'left') hand.palmNormal.negate();

  a.subVectors(j[INDEX_INTERMEDIATE], j[INDEX_PROXIMAL]).normalize();
  b.subVectors(j[INDEX_TIP], j[INDEX_DISTAL]).normalize();
  hand.indexStraight = a.dot(b) > 0.75;
}
