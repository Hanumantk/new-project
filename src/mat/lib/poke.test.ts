import { describe, expect, it } from 'vitest';
import { PALM_UP_HOLD, PalmUpToggle } from './palmUp';
import { POKE_ARM, PokeButton } from './poke';

const button = () => new PokeButton({ x: 0, y: 0, width: 0.06, height: 0.036 });

describe('PokeButton', () => {
  it('presses once when a fingertip comes from in front and touches the face', () => {
    const b = button();
    expect(b.update(0, 0, 0.04)).toBe(false);
    expect(b.state).toBe('hover');
    expect(b.update(0, 0, 0.004)).toBe(false);
    expect(b.update(0, 0, -0.002)).toBe(true);
    expect(b.state).toBe('pressed');
    expect(b.update(0, 0, -0.01)).toBe(false); // holding in: no repeat
    expect(b.update(0, 0, 0.004)).toBe(false); // not lifted far enough yet
    expect(b.update(0, 0, -0.001)).toBe(false);
    expect(b.update(0, 0, POKE_ARM + 0.001)).toBe(false); // lifted: armed again
    expect(b.update(0, 0, 0)).toBe(true);
  });

  it('ignores a finger arriving from behind, from the side, or while disabled', () => {
    const b = button();
    expect(b.update(0, 0, -0.01)).toBe(false); // already behind the face
    expect(b.update(0, 0, 0)).toBe(false);
    const side = button();
    expect(side.update(0.1, 0, 0.02)).toBe(false);
    expect(side.update(0, 0, -0.001)).toBe(false); // slid in sideways below the face
    const off = button();
    off.update(0, 0, 0.02, false);
    expect(off.update(0, 0, -0.001, false)).toBe(false);
  });

  it('lets go when the finger leaves', () => {
    const b = button();
    b.update(0, 0, 0.02);
    b.update(0, 0, -0.001);
    expect(b.update(null, 0, 0)).toBe(false);
    expect(b.state).toBe('idle');
  });
});

describe('PalmUpToggle', () => {
  it('fires once after the palm has been up for the hold time, then needs turning down', () => {
    const t = new PalmUpToggle();
    let fired = 0;
    for (let i = 0; i < 60; i++) if (t.update(0.95, 1 / 60)) fired++;
    expect(fired).toBe(1);
    for (let i = 0; i < 60; i++) if (t.update(0.95, 1 / 60)) fired++;
    expect(fired).toBe(1); // still up: no repeat
    t.update(0.1, 1 / 60); // palm down re-arms
    for (let i = 0; i < 60; i++) if (t.update(0.95, 1 / 60)) fired++;
    expect(fired).toBe(2);
  });

  it('needs the full hold; a brief turn does nothing', () => {
    const t = new PalmUpToggle();
    expect(t.update(0.95, PALM_UP_HOLD * 0.6)).toBe(false);
    expect(t.update(null, 0.016)).toBe(false); // lost / busy
    expect(t.update(0.95, PALM_UP_HOLD * 0.6)).toBe(false);
  });
});
