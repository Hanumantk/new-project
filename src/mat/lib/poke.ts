/**
 * A button pressed with a fingertip. Coordinates are in the panel's space
 * (metres): x across, y up, z out of its face; z is the fingertip's surface
 * (tip joint minus its radius), so 0 is touching.
 */
export interface PokeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** In front of the face by more than this, the finger is "lifted" and may press again. */
export const POKE_ARM = 0.008;
/** Within this distance in front of the face, the button shows hover. */
export const POKE_HOVER = 0.05;
/** Behind the face by more than this, a finger has gone through (it no longer counts). */
export const POKE_THROUGH = 0.03;
/** Forgiveness around the button's edges. */
const EDGE_SLACK = 0.004;

export type PokeState = 'idle' | 'hover' | 'pressed';

export class PokeButton {
  state: PokeState = 'idle';
  /** How far the face is pushed in, 0..1, for the visual. */
  push = 0;
  /** A press needs the finger to have come from in front (not from behind or the side). */
  private armed = false;

  constructor(public rect: PokeRect) {}

  /**
   * Feeds the nearest fingertip (or null if none is near).
   * @returns true on the frame the button is pressed.
   */
  update(x: number | null, y: number, z: number, enabled = true): boolean {
    const inside =
      x !== null &&
      Math.abs(x - this.rect.x) <= this.rect.width / 2 + EDGE_SLACK &&
      Math.abs(y - this.rect.y) <= this.rect.height / 2 + EDGE_SLACK &&
      z > -POKE_THROUGH;
    if (!inside || !enabled) {
      this.state = 'idle';
      this.push = 0;
      this.armed = false;
      return false;
    }
    this.push = Math.min(Math.max(1 - z / POKE_ARM, 0), 1);
    if (this.state === 'pressed') {
      if (z > POKE_ARM) {
        this.state = 'hover';
        this.armed = true;
      }
      return false;
    }
    if (z > POKE_ARM) this.armed = true;
    if (this.armed && z <= 0) {
      this.state = 'pressed';
      this.armed = false;
      return true;
    }
    this.state = z < POKE_HOVER ? 'hover' : 'idle';
    return false;
  }

  reset() {
    this.state = 'idle';
    this.push = 0;
    this.armed = false;
  }
}
