import * as THREE from 'three';
import { PinchDetector } from '../mat/lib/pinch';

/**
 * The headset's "how it's made" flow: the finished wound (stage 0), then its
 * five build stages, one per pinch of the other hand near the wound. All
 * stages are the same wound mesh with a different shape and look (see
 * xrWoundMaterial.ts), so they sit exactly where the wound is.
 */
export const STAGE_COUNT = 6;

/** A pinch only counts within this distance of the wound's centre (m), at any moment while it's held. */
export const PINCH_RANGE = 0.12;
/**
 * The stage pinch: thumb-to-index tip distance (m) that starts and ends it.
 * Looser than the mat's: the headset reports the tip joints inside the
 * fingertips, so a real pinch bottoms out around 1.5–2 cm.
 */
export const STAGE_PINCH_START = 0.02;
export const STAGE_PINCH_END = 0.03;
/** A pinch survives the hand's tracking dropping out this long (s): reaching over the palm often hides a hand briefly. */
export const STAGE_PINCH_GRACE = 1;
/** A quick pinch (under MISS_MAX_SECONDS) that came within MISS_RANGE of the wound but never within PINCH_RANGE is a near miss: Buddy asks for a closer one. Longer or further pinches (drawing the mat) are left alone. */
export const MISS_RANGE = 0.3;
export const MISS_MAX_SECONDS = 1;
/** After a step, a release is ignored this long (s), against tracking jitter. */
export const STEP_COOLDOWN = 0.25;
/** A step's shape and look blend over this long (s)… */
export const TRANSITION_SECONDS = 0.4;
/** …and the cut opening (stage 2 → 3) over this long. */
export const CUT_OPEN_SECONDS = 0.8;

export const STAGE_LABELS: readonly string[] = [
  'Pinch near the wound with your other hand to see how it’s made',
  '1/6 · Clean the skin and apply a thin line of spirit gum. Wait until tacky.',
  '2/6 · Press a marble-sized ball of scar wax on and blend the edges into the skin.',
  '3/6 · Slice the wax with a spatula and push the edges apart. Seal with latex and powder.',
  '4/6 · Match the wax to your skin, paint deep red into the cut, add bruising around it.',
  '5/6 · Fill the cut with thick blood, stipple around it and add a few drips.',
  '6/6 · Shade the lips with dark brown for depth and let the blood dry a little.',
];

/** Stage state and the pinch gesture that drives it: every pinch near the wound steps forward, round the loop. */
export class StageFlow {
  /** The stage shown (0 = finished wound, 1…STAGE_COUNT). */
  stage = 0;
  /** The stage it's blending from, and how far (0..1). */
  from = 0;
  blend = 1;
  /** The pinch under way has been near the wound. */
  armed = false;
  private duration = TRANSITION_SECONDS;
  private cooldown = 0;
  /** Counters: steps taken, and near misses (a pinch close to the wound but not close enough). */
  steps = 0;
  misses = 0;
  private near = false;
  private pinchFor = 0;
  private readonly pinch = new PinchDetector(STAGE_PINCH_START, STAGE_PINCH_END, STAGE_PINCH_GRACE);

  get pinching() {
    return this.pinch.pinching;
  }

  /**
   * @param pinchDistance the other hand's thumb-to-index tip distance (m), or null when it isn't tracked.
   * @param inRange whether its pinch point is within PINCH_RANGE of the wound.
   * @param near whether it's within MISS_RANGE.
   * @returns whether the stage changed.
   */
  update(dt: number, pinchDistance: number | null, inRange: boolean, near = false): boolean {
    this.blend = Math.min(this.blend + dt / this.duration, 1);
    this.cooldown = Math.max(this.cooldown - dt, 0);
    const event = this.pinch.update(pinchDistance, dt);
    if (event === 'start') {
      this.armed = inRange;
      this.near = near;
      this.pinchFor = 0;
    } else if (this.pinch.pinching) {
      this.armed ||= inRange;
      this.near ||= near;
      this.pinchFor += dt;
    }
    if (event !== 'end') return false;
    // Released (or the hand stayed lost past the grace): one step forward.
    const step = this.armed && this.cooldown === 0;
    if (!this.armed && this.near && pinchDistance !== null && this.pinchFor < MISS_MAX_SECONDS) this.misses++;
    this.armed = false;
    if (!step) return false;
    this.steps++;
    this.from = this.stage;
    this.stage = (this.stage + 1) % (STAGE_COUNT + 1);
    this.blend = 0;
    this.duration = this.from === 2 && this.stage === 3 ? CUT_OPEN_SECONDS : TRANSITION_SECONDS;
    this.cooldown = STEP_COOLDOWN;
    return true;
  }
}

/**
 * The wound as the headset sees it this frame, for Buddy (written by XRWound;
 * read-only elsewhere): no tracking or gestures are duplicated.
 */
export const woundLink = {
  /** The wound has been laid on the hand. */
  placed: false,
  /** The wound hand is tracked this frame. */
  tracked: false,
  /** The wound's centre on the palm, and the palm's thumb-side and outward directions (world). */
  point: new THREE.Vector3(),
  thumbSide: new THREE.Vector3(1, 0, 0),
  normal: new THREE.Vector3(0, 1, 0),
  /** The other hand's pinch point is within PINCH_RANGE. */
  otherInRange: false,
  flow: null as StageFlow | null,
};
