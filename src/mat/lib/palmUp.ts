/** The palm's normal must point this close to straight up (its y component)… */
export const PALM_UP_Y = 0.8;
/** …for this long (s) to toggle. */
export const PALM_UP_HOLD = 0.5;
/** It re-arms once the palm turns well away from up. */
export const PALM_DOWN_Y = 0.4;

/** Turning the left palm up (and holding it) toggles something once. */
export class PalmUpToggle {
  /** Progress of the current hold, 0..1. */
  progress = 0;
  private held = 0;
  private armed = true;

  /**
   * @param normalY the palm normal's y, or null when the hand isn't tracked or is busy (pinching).
   * @returns true on the frame the toggle fires.
   */
  update(normalY: number | null, dt: number): boolean {
    if (normalY === null || normalY < PALM_DOWN_Y) {
      this.armed = true;
      this.held = 0;
      this.progress = 0;
      return false;
    }
    if (!this.armed || normalY < PALM_UP_Y) {
      this.held = 0;
      this.progress = 0;
      return false;
    }
    this.held += dt;
    this.progress = Math.min(this.held / PALM_UP_HOLD, 1);
    if (this.held < PALM_UP_HOLD) return false;
    this.armed = false;
    this.held = 0;
    this.progress = 0;
    return true;
  }
}
