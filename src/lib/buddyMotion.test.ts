import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BuddyMotion, COMFORT_ZONE_CM, MAX_SPEED, type MotionEvent, type MotionInput } from './buddyMotion';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function input(home: THREE.Vector3): MotionInput {
  return {
    eye: v(0, 1.6, 0),
    gaze: v(0, -0.5, -1).normalize(),
    right: v(1, 0, 0),
    up: v(0, 1, 0),
    home,
    wound: v(0, 1.3, -0.4),
    watchWound: false,
    facingViewer: false,
    idle: false,
  };
}

/** Runs at 72 fps; returns the events seen and the top speed. */
function run(m: BuddyMotion, inp: MotionInput, seconds: number) {
  const events: MotionEvent[] = [];
  let top = 0;
  const prev = m.position.clone();
  for (let t = 0; t < seconds; t += 1 / 72) {
    const e = m.update(1 / 72, inp);
    if (e) events.push(e);
    top = Math.max(top, m.position.distanceTo(prev) * 72);
    prev.copy(m.position);
  }
  return { events, top };
}

function settled(home: THREE.Vector3) {
  const m = new BuddyMotion();
  const inp = input(home);
  run(m, inp, 3);
  return { m, inp };
}

describe('BuddyMotion', () => {
  it('stays put while home moves within the comfort zone', () => {
    const home = v(0.12, 1.34, -0.37);
    const { m, inp } = settled(home);
    const before = m.position.clone();
    home.x += (COMFORT_ZONE_CM - 1) / 100;
    run(m, inp, 2);
    expect(m.mode).toBe('rest');
    expect(m.position.distanceTo(before)).toBeLessThan(0.03); // drift only
  });

  it('decides, reacts after a moment, then flies over and lands near home', () => {
    const home = v(0.12, 1.34, -0.37);
    const { m, inp } = settled(home);
    home.x -= 0.2;
    run(m, inp, 0.2);
    expect(m.mode).toBe('rest'); // still reacting
    const { events, top } = run(m, inp, 3);
    expect(events).toContain('arrived');
    expect(top).toBeLessThan(MAX_SPEED * 1.25);
    expect(m.position.distanceTo(home)).toBeLessThan(0.03);
  });

  it('flies back into view when the view turns away', () => {
    const home = v(0.12, 1.34, -0.37);
    const { m, inp } = settled(home);
    inp.gaze.set(1, -0.3, 0).normalize();
    home.set(0.45, 1.45, -0.05);
    const { events } = run(m, inp, 4);
    expect(events).toContain('arrived');
    const angle = THREE.MathUtils.radToDeg(m.position.clone().sub(inp.eye).angleTo(inp.gaze));
    expect(angle).toBeLessThan(30);
  });

  it('visits the wound, holds, then returns home', () => {
    const home = v(0.12, 1.34, -0.37);
    const { m, inp } = settled(home);
    m.visitWound();
    const { events } = run(m, inp, 5);
    expect(events).toEqual(['visitArrived', 'visitLeft', 'arrived']);
  });

  it('orbits the hand when the flow is done, then lands home', () => {
    const home = v(0.12, 1.34, -0.37);
    const { m, inp } = settled(home);
    m.orbitHand(inp.wound!, inp.right, inp.up);
    const { events } = run(m, inp, 5);
    expect(events).toEqual(['orbitDone', 'arrived']);
  });

  it('keeps its volume while squashing and stretching', () => {
    const home = v(0.12, 1.34, -0.37);
    const { m, inp } = settled(home);
    home.x -= 0.3;
    for (let t = 0; t < 2; t += 1 / 72) {
      m.update(1 / 72, inp);
      expect(m.stretch.x * m.stretch.y * m.stretch.z).toBeCloseTo(1, 5);
    }
  });
});
