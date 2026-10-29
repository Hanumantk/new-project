import { describe, expect, it } from 'vitest';
import { PINCH_END, PINCH_LOST_GRACE, PINCH_START, PinchDetector } from './pinch';

describe('PinchDetector', () => {
  it('starts below 1.5 cm and ends above 2.5 cm, holding in between', () => {
    const p = new PinchDetector();
    expect(p.update(0.03, 0.016)).toBeNull();
    expect(p.update(0.02, 0.016)).toBeNull(); // between the thresholds: not yet
    expect(p.update(PINCH_START - 0.001, 0.016)).toBe('start');
    expect(p.update(0.02, 0.016)).toBeNull(); // still pinching in the gap
    expect(p.pinching).toBe(true);
    expect(p.update(PINCH_END - 0.001, 0.016)).toBeNull();
    expect(p.update(PINCH_END + 0.001, 0.016)).toBe('end');
    expect(p.pinching).toBe(false);
  });

  it('does not flicker when the distance jitters around one threshold', () => {
    const p = new PinchDetector();
    const events = [0.014, 0.016, 0.014, 0.016, 0.0145].map((d) => p.update(d, 0.016)).filter(Boolean);
    expect(events).toEqual(['start']);
  });

  it('rides out a short tracking dropout but ends after a long one', () => {
    const p = new PinchDetector();
    p.update(0.01, 0.016);
    expect(p.update(null, PINCH_LOST_GRACE / 2)).toBeNull();
    expect(p.update(0.01, 0.016)).toBeNull(); // back in time: same pinch
    expect(p.update(null, PINCH_LOST_GRACE / 2)).toBeNull();
    expect(p.update(null, PINCH_LOST_GRACE)).toBe('end');
  });
});
