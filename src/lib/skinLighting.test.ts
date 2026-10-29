import { describe, expect, it } from 'vitest';
import { linearLuminance, srgbToLinear } from './skinSampler';
import {
  BASE_AMBIENT,
  BASE_DIRECTIONAL,
  createSkinLighting,
  lightingFromSkin,
  REF_SKIN_LINEAR,
} from './skinLighting';
import { createSkinSample } from './skinSampler';

const sampleOf = (srgb: [number, number, number]) => {
  const s = createSkinSample();
  s.color = srgb.map((c) => srgbToLinear(c / 255)) as [number, number, number];
  s.luminance = linearLuminance(...s.color);
  s.valid = true;
  return s;
};

describe('lightingFromSkin', () => {
  it('is neutral for the reference skin', () => {
    const l = lightingFromSkin(sampleOf([205, 150, 125]), createSkinLighting());
    expect(l.exposure).toBeCloseTo(1, 3);
    l.cast.forEach((c) => expect(c).toBeCloseTo(1, 3));
    l.skinAlbedo.forEach((c, i) => expect(c).toBeCloseTo(REF_SKIN_LINEAR[i], 3));
  });

  it('dims the lights for darker skin or a dim room', () => {
    const l = lightingFromSkin(sampleOf([100, 70, 55]), createSkinLighting());
    expect(l.exposure).toBeLessThan(0.4);
  });

  it('reproduces the sampled skin on skin-coloured wound areas', () => {
    const sample = sampleOf([170, 140, 150]); // cool, pinkish light
    const l = lightingFromSkin(sample, createSkinLighting());
    // Lit roughly face-on, the lights sum to about exposure × cast.
    const lightSum = (BASE_AMBIENT + BASE_DIRECTIONAL * 0.5) / 1.0;
    for (let c = 0; c < 3; c++) {
      const rendered = l.skinAlbedo[c] * l.cast[c] * l.exposure * lightSum;
      expect(rendered).toBeCloseTo(sample.color[c], 1);
    }
    // The cast leans the same way as the sample (bluer than the reference).
    expect(l.cast[2]).toBeGreaterThan(l.cast[0]);
  });

  it('falls back to neutral without a valid reading', () => {
    const l = lightingFromSkin(createSkinSample(), createSkinLighting());
    expect(l.exposure).toBe(1);
    expect(l.cast).toEqual([1, 1, 1]);
  });
});
