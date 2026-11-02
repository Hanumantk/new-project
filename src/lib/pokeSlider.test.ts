import { describe, expect, it } from 'vitest';
import { HEADSET_SLIDER, HEADSET_SLIDER as L, SliderGrip, pokeSliderValue } from './pokeSlider';

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

describe('SliderGrip', () => {
  const L = HEADSET_SLIDER;
  const mid = (L.trackStart + L.trackEnd) / 2;

  it('hovers before touching, then grabs on touch', () => {
    const g = new SliderGrip();
    expect(g.update(mid, 0, 0.04, L, 0.016)).toBe(false);
    expect(g.state).toBe('hover');
    expect(g.update(mid, 0, 0.005, L, 0.016)).toBe(true);
    expect(g.state).toBe('held');
    expect(g.value).toBeCloseTo(0.5);
  });

  it('stays locked to sliding when the finger drifts up, down or off the face', () => {
    const g = new SliderGrip();
    g.update(mid, 0, 0, L, 0.016);
    expect(g.update(L.trackEnd, 0.045, 0.04, L, 0.016)).toBe(true); // drifted 4.5 cm up and 4 cm out
    expect(g.value).toBeCloseTo(1);
    expect(g.update(L.trackStart, -0.05, -0.03, L, 0.016)).toBe(true);
    expect(g.value).toBeCloseTo(0);
  });

  it('lets go when the finger is pulled away', () => {
    const g = new SliderGrip();
    g.update(mid, 0, 0, L, 0.016);
    expect(g.update(mid, 0, 0.12, L, 0.016)).toBe(false);
    expect(g.state).toBe('idle');
  });

  it('survives a brief tracking drop-out', () => {
    const g = new SliderGrip();
    g.update(mid, 0, 0, L, 0.016);
    expect(g.update(null, 0, 0, L, 0.1)).toBe(true);
    expect(g.update(null, 0, 0, L, 0.3)).toBe(false);
  });
});
