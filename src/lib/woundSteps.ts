import { PinchDetector } from '../mat/lib/pinch';

/**
 * The headset's "how it's made" flow: the finished wound (stage 0), then its
 * five build stages, one per pinch of the other hand near the wound. All
 * stages are the same wound mesh with a different shape and look (see
 * xrWoundMaterial.ts), so they sit exactly where the wound is.
 */
export const STAGE_COUNT = 6;

/** A pinch only counts within this distance of the wound's centre (m). */
export const PINCH_RANGE = 0.12;
/** Pinch and hold this long (s) to go back one stage. */
export const HOLD_BACK_SECONDS = 0.8;
/** After a step, pinches are ignored this long (s): one pinch = one step. */
export const STEP_COOLDOWN = 0.6;
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

/** Stage state and the pinch gesture that drives it. */
export class StageFlow {
  /** The stage shown (0 = finished wound, 1…STAGE_COUNT). */
  stage = 0;
  /** The stage it's blending from, and how far (0..1). */
  from = 0;
  blend = 1;
  /** A pinch that began in range is under way. */
  armed = false;
  private duration = TRANSITION_SECONDS;
  private cooldown = 0;
  private holdFor = 0;
  private heldBack = false;
  private readonly pinch = new PinchDetector();

  /**
   * @param pinchDistance the other hand's thumb-to-index tip distance (m), or null when it isn't tracked.
   * @param inRange whether its pinch point is within PINCH_RANGE of the shown wound.
   * @returns whether the stage changed.
   */
  update(dt: number, pinchDistance: number | null, inRange: boolean): boolean {
    this.blend = Math.min(this.blend + dt / this.duration, 1);
    this.cooldown = Math.max(this.cooldown - dt, 0);
    const event = this.pinch.update(pinchDistance, dt);
    let changed = false;
    if (event === 'start') {
      this.armed = inRange && this.cooldown === 0;
      this.holdFor = 0;
      this.heldBack = false;
    } else if (event === 'end') {
      // A tap advances; not after a hold, nor when the release is the hand being lost.
      if (this.armed && !this.heldBack && pinchDistance !== null && this.cooldown === 0) {
        changed = this.go((this.stage + 1) % (STAGE_COUNT + 1));
      }
      this.armed = false;
    } else if (this.pinch.pinching && this.armed && !this.heldBack) {
      this.holdFor += Math.min(dt, 0.1); // a hitch in the frames is not a hold
      if (this.holdFor >= HOLD_BACK_SECONDS) {
        this.heldBack = true;
        if (this.stage > 0) changed = this.go(this.stage - 1);
      }
    }
    return changed;
  }

  private go(stage: number): boolean {
    this.from = this.stage;
    this.stage = stage;
    this.blend = 0;
    this.duration = this.from === 2 && stage === 3 ? CUT_OPEN_SECONDS : TRANSITION_SECONDS;
    this.cooldown = STEP_COOLDOWN;
    return true;
  }
}
