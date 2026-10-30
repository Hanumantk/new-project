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
  trackStart: -0.088,
  trackEnd: 0.088,
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
