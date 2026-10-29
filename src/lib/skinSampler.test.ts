import { describe, expect, it } from 'vitest';
import { estimateNoise, insidePolygon, ringStats } from './skinSampler';

function image(width: number, height: number, fill: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return data;
}

/** Deterministic noise in [-1, 1]. */
const noise = (i: number) => {
  const s = Math.sin(i * 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
};

describe('insidePolygon', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  it('tells inside from outside', () => {
    expect(insidePolygon(5, 5, square)).toBe(true);
    expect(insidePolygon(15, 5, square)).toBe(false);
    expect(insidePolygon(-1, -1, square)).toBe(false);
  });
});

describe('ringStats', () => {
  it('averages only the ring of skin inside the palm', () => {
    // Skin colour inside a palm-shaped square, background elsewhere, and a
    // "wound" blob in the middle that must not be counted.
    const data = image(64, 64, (x, y) => {
      const inPalm = x >= 16 && x < 48 && y >= 16 && y < 48;
      const inWound = (x - 32) ** 2 + (y - 32) ** 2 < 25;
      if (inWound) return [120, 10, 10];
      return inPalm ? [200, 150, 120] : [30, 60, 200];
    });
    const palm = [16, 16, 48, 16, 48, 48, 16, 48];
    const stats = ringStats(data, 64, 64, { cx: 32, cy: 32, inner: 8, outer: 20 }, palm);
    expect(stats.count).toBeGreaterThan(100);
    expect(stats.r).toBeCloseTo(200, 6);
    expect(stats.g).toBeCloseTo(150, 6);
    expect(stats.b).toBeCloseTo(120, 6);
  });

  it('returns no pixels when the ring misses the palm', () => {
    const data = image(32, 32, () => [100, 100, 100]);
    const stats = ringStats(data, 32, 32, { cx: 16, cy: 16, inner: 2, outer: 4 }, [0, 0, 3, 0, 3, 3, 0, 3]);
    expect(stats.count).toBe(0);
  });
});

describe('estimateNoise', () => {
  it('is ~0 for a flat patch and tracks the noise level', () => {
    const flat = image(24, 24, () => [150, 150, 150]);
    expect(estimateNoise(flat, 24, 24)).toBeLessThan(0.01);

    let i = 0;
    const levels = [3, 8];
    const estimates = levels.map((amp) => {
      // Uniform noise of half-width `amp` has σ = amp/√3.
      const noisy = image(24, 24, () => {
        const v = 128 + amp * noise(i++);
        return [v, v, v];
      });
      return estimateNoise(noisy, 24, 24) / (amp / Math.sqrt(3));
    });
    for (const ratio of estimates) {
      expect(ratio).toBeGreaterThan(0.75);
      expect(ratio).toBeLessThan(1.25);
    }
  });
});
