import { describe, expect, it } from 'vitest';
import { LandmarkFilter, OneEuroFilter } from './oneEuroFilter';

/** Deterministic pseudo-random noise in [-1, 1]. */
function noise(i: number): number {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

const FPS = 60;
const dt = 1 / FPS;

describe('OneEuroFilter', () => {
  it('passes the first sample through unchanged', () => {
    const f = new OneEuroFilter();
    expect(f.filter(123.4, 0)).toBe(123.4);
  });

  it('holds a constant signal exactly', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 100; i++) expect(f.filter(50, i * dt)).toBeCloseTo(50, 10);
  });

  it('removes most jitter from a still signal', () => {
    const f = new OneEuroFilter();
    let rawVar = 0;
    let outVar = 0;
    const n = 600;
    for (let i = 0; i < n; i++) {
      const raw = 400 + 2 * noise(i); // ±2 px of jitter around 400 px
      const out = f.filter(raw, i * dt);
      if (i > 60) {
        rawVar += (raw - 400) ** 2;
        outVar += (out - 400) ** 2;
      }
    }
    expect(outVar).toBeLessThan(rawVar * 0.1);
  });

  it('keeps lag small during fast motion (cutoff opens with speed)', () => {
    const speed = 1500; // px/s, a quick hand sweep
    const fast = new OneEuroFilter({ minCutoff: 1, beta: 0.02, dCutoff: 1 });
    const plainLowPass = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    let lagFast = 0;
    let lagPlain = 0;
    for (let i = 0; i <= 60; i++) {
      const x = speed * i * dt;
      lagFast = x - fast.filter(x, i * dt);
      lagPlain = x - plainLowPass.filter(x, i * dt);
    }
    // Under 1/3 of a frame's travel behind, versus far behind without beta.
    expect(lagFast).toBeLessThan((speed * dt) / 3);
    expect(lagPlain).toBeGreaterThan(lagFast * 10);
  });

  it('ignores repeated or backwards timestamps', () => {
    const f = new OneEuroFilter();
    f.filter(10, 1);
    const held = f.filter(20, 1.5);
    expect(f.filter(999, 1.5)).toBe(held);
    expect(f.filter(999, 1.2)).toBe(held);
  });

  it('starts fresh after reset', () => {
    const f = new OneEuroFilter();
    f.filter(10, 0);
    f.filter(10, dt);
    f.reset();
    expect(f.filter(500, 2 * dt)).toBe(500);
  });
});

describe('LandmarkFilter', () => {
  const hand = (offset: number) =>
    Array.from({ length: 21 }, (_, i) => ({ x: 0.3 + i * 0.01 + offset, y: 0.5, z: -0.02, visibility: 1 }));

  it('filters every coordinate and reuses its output objects', () => {
    const f = new LandmarkFilter();
    const first = f.filter(hand(0), 0, 1280, 720);
    const copy = first.map((lm) => ({ ...lm }));
    const second = f.filter(hand(0.001), dt, 1280, 720);
    expect(second).toBe(first);
    for (let i = 0; i < 21; i++) {
      // Moved, but by less than the raw 0.001 step (smoothed).
      expect(second[i].x).toBeGreaterThan(copy[i].x);
      expect(second[i].x).toBeLessThan(copy[i].x + 0.001);
      expect(second[i].y).toBeCloseTo(0.5, 10);
      expect(second[i].z).toBeCloseTo(-0.02, 10);
    }
  });

  it('jumps straight to a new hand after reset', () => {
    const f = new LandmarkFilter();
    f.filter(hand(0), 0, 1280, 720);
    f.reset();
    const out = f.filter(hand(0.2), dt, 1280, 720);
    expect(out[0].x).toBeCloseTo(0.5, 10);
  });
});
