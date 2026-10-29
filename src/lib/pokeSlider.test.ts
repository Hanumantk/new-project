import { describe, expect, it } from 'vitest';
import { HEADSET_SLIDER as L, pokeSliderValue } from './pokeSlider';

describe('pokeSliderValue', () => {
  const mid = (L.trackStart + L.trackEnd) / 2;

  it('maps a touch along the track to 0..1', () => {
    expect(pokeSliderValue(L.trackStart, 0, 0, L)).toBe(0);
    expect(pokeSliderValue(L.trackEnd, 0, 0, L)).toBe(1);
    expect(pokeSliderValue(mid, 0, 0.005, L)).toBeCloseTo(0.5, 6);
  });

  it('clamps just past the ends so 0% and 100% are easy to hit', () => {
    expect(pokeSliderValue(L.trackStart - 0.01, 0, 0, L)).toBe(0);
    expect(pokeSliderValue(L.trackEnd + 0.01, 0, 0, L)).toBe(1);
  });

  it('ignores a fingertip that is not touching', () => {
    expect(pokeSliderValue(mid, 0, 0.05, L)).toBeNull(); // hovering in front
    expect(pokeSliderValue(mid, 0, -0.05, L)).toBeNull(); // pushed far through
    expect(pokeSliderValue(mid, 0.1, 0, L)).toBeNull(); // above the panel
    expect(pokeSliderValue(-0.1, 0, 0, L)).toBeNull(); // on the label, left of the track
  });
});
