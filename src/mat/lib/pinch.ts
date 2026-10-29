/** Thumb-tip to index-tip distance (m) that starts a pinch… */
export const PINCH_START = 0.015;
/** …and the distance that ends it. The gap between them stops flicker. */
export const PINCH_END = 0.025;
/** A pinch survives tracking dropping out for this long (s). */
export const PINCH_LOST_GRACE = 0.3;

export type PinchEvent = 'start' | 'end';

/** Pinch state for one hand, with hysteresis. */
export class PinchDetector {
  pinching = false;
  private lostFor = 0;

  /**
   * @param distance thumb-to-index tip distance in metres, or null when the hand isn't tracked.
   * @param dt seconds since the last update.
   */
  update(distance: number | null, dt: number): PinchEvent | null {
    if (distance === null) {
      if (!this.pinching) return null;
      this.lostFor += dt;
      if (this.lostFor < PINCH_LOST_GRACE) return null;
      return this.release();
    }
    this.lostFor = 0;
    if (!this.pinching && distance < PINCH_START) {
      this.pinching = true;
      return 'start';
    }
    if (this.pinching && distance > PINCH_END) return this.release();
    return null;
  }

  reset() {
    this.pinching = false;
    this.lostFor = 0;
  }

  private release(): PinchEvent {
    this.pinching = false;
    this.lostFor = 0;
    return 'end';
  }
}
