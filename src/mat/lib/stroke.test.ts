import { describe, expect, it } from 'vitest';
import { STROKE_CAPACITY, STROKE_SPACING, StrokeBuffer } from './stroke';

describe('StrokeBuffer', () => {
  it('records a point only every STROKE_SPACING of movement', () => {
    const s = new StrokeBuffer();
    expect(s.add(0, 0, 0)).toBe(true);
    expect(s.add(STROKE_SPACING * 0.5, 0, 0)).toBe(false);
    expect(s.add(STROKE_SPACING * 1.01, 0, 0)).toBe(true);
    expect(s.count).toBe(2);
  });

  it('stops at capacity and resets', () => {
    const s = new StrokeBuffer();
    for (let i = 0; i < STROKE_CAPACITY + 10; i++) s.add(i * 0.02, 0, 0);
    expect(s.count).toBe(STROKE_CAPACITY);
    s.reset();
    expect(s.count).toBe(0);
  });
});
