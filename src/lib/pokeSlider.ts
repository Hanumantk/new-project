/**
 * A slider you press with a fingertip in a headset. Coordinates are in the
 * panel's own space (metres): x across, y up, z out of its face.
 */
export interface PokeSliderLayout {
  width: number;
  height: number;
  /** Where the track starts and ends along x. */
  trackStart: number;
  trackEnd: number;
  /** How far in front of (and behind) the face a fingertip still counts as touching. */
  touchDepth: number;
}

export const HEADSET_SLIDER: PokeSliderLayout = {
  width: 0.2,
  height: 0.055,
  trackStart: -0.035,
  trackEnd: 0.045,
  touchDepth: 0.02,
};

/** The value (0..1) a fingertip at panel-space (x, y, z) sets, or null if it isn't touching. */
export function pokeSliderValue(x: number, y: number, z: number, layout: PokeSliderLayout): number | null {
  if (Math.abs(z) > layout.touchDepth) return null;
  if (Math.abs(y) > layout.height / 2) return null;
  // A little slack past each end so 0% and 100% are easy to reach.
  const slack = 0.02;
  if (x < layout.trackStart - slack || x > layout.trackEnd + slack) return null;
  const t = (x - layout.trackStart) / (layout.trackEnd - layout.trackStart);
  return Math.min(Math.max(t, 0), 1);
}

/** A fingertip this far in front of a slider (m) hovers it: it lights up before you touch. */
export const SLIDER_HOVER_DEPTH = 0.06;
/**
 * Once held, the slider stays held (locked to sliding: only the sideways
 * position counts) while the fingertip stays within this much of it (m):
 * in front of / behind the face, above / below the track, past its ends.
 */
export const SLIDER_CAPTURE = { front: 0.06, behind: 0.05, vertical: 0.05, sideways: 0.06 };
/** Tracking dropping out for less than this (s) doesn't let go. */
export const SLIDER_LOST_GRACE = 0.25;

export type SliderGripState = 'idle' | 'hover' | 'held';

/**
 * A fingertip slider you can't lose: a touch on its band grabs it; from then
 * on only the finger's sideways position matters, until the finger is pulled
 * clearly away (SLIDER_CAPTURE) or tracking is lost for a moment.
 */
export class SliderGrip {
  state: SliderGripState = 'idle';
  value = 0;
  private lostFor = 0;

  /**
   * @param x,y,z the fingertip in the slider's space (y from its centre line, z in front of the face), or x = null when there's no finger.
   * @returns whether it's held (and `value` follows the finger).
   */
  update(x: number | null, y: number, z: number, layout: PokeSliderLayout, dt: number): boolean {
    if (x === null) {
      if (this.state === 'held') {
        this.lostFor += dt;
        if (this.lostFor < SLIDER_LOST_GRACE) return true;
      }
      this.state = 'idle';
      return false;
    }
    this.lostFor = 0;
    const along = Math.min(Math.max((x - layout.trackStart) / (layout.trackEnd - layout.trackStart), 0), 1);
    if (this.state === 'held') {
      const c = SLIDER_CAPTURE;
      const inside =
        z <= c.front &&
        z >= -c.behind &&
        Math.abs(y) <= layout.height / 2 + c.vertical &&
        x >= layout.trackStart - c.sideways &&
        x <= layout.trackEnd + c.sideways;
      if (inside) {
        this.value = along;
        return true;
      }
      this.state = 'idle';
      return false;
    }
    if (pokeSliderValue(x, y, z, layout) !== null) {
      this.state = 'held';
      this.value = along;
      return true;
    }
    const hover =
      z <= SLIDER_HOVER_DEPTH &&
      z >= -layout.touchDepth &&
      Math.abs(y) <= layout.height / 2 + 0.01 &&
      x >= layout.trackStart - 0.02 &&
      x <= layout.trackEnd + 0.02;
    this.state = hover ? 'hover' : 'idle';
    return false;
  }
}
