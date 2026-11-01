import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BUDDY_MIN_PALM_DISTANCE,
  BUDDY_SCALE,
  NO_BLOCK_DEG,
  VIEW_CONE_DEG,
  WAIT_AHEAD,
  buddyTarget,
  expressionOffset,
  growthForStage,
  springStep,
} from './buddy';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const angleDeg = (eye: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) =>
  THREE.MathUtils.radToDeg(a.clone().sub(eye).angleTo(b.clone().sub(eye)));

describe('buddyTarget', () => {
  const eye = v(0, 1.6, 0);
  const palm = v(0, 1.2, -0.4);
  const gazeAtPalm = palm.clone().sub(eye).normalize();
  const thumb = v(1, 0, 0);

  it('floats beside the hand, clear of the wound, the palm and the view cone', () => {
    const p = buddyTarget(new THREE.Vector3(), eye, gazeAtPalm, palm, thumb);
    expect(p.x).toBeGreaterThan(0.05);
    expect(angleDeg(eye, p, palm)).toBeGreaterThanOrEqual(NO_BLOCK_DEG - 0.01);
    expect(p.distanceTo(palm)).toBeGreaterThanOrEqual(BUDDY_MIN_PALM_DISTANCE - 1e-6);
    expect(THREE.MathUtils.radToDeg(p.clone().sub(eye).angleTo(gazeAtPalm))).toBeLessThanOrEqual(VIEW_CONE_DEG + 0.01);
  });

  it('pushes itself out from in front of the wound', () => {
    // Thumb side pointing straight at the eyes would put Buddy in front of the wound.
    const toward = eye.clone().sub(palm).normalize();
    const p = buddyTarget(new THREE.Vector3(), eye, gazeAtPalm, palm, toward);
    expect(angleDeg(eye, p, palm)).toBeGreaterThanOrEqual(NO_BLOCK_DEG - 0.01);
  });

  it('waits at the edge of the view when the hand is out of it', () => {
    const gazeAway = v(0, 0, -1);
    const farPalm = v(0.6, 1.0, -0.2);
    const p = buddyTarget(new THREE.Vector3(), eye, gazeAway, farPalm, thumb);
    expect(THREE.MathUtils.radToDeg(p.clone().sub(eye).angleTo(gazeAway))).toBeCloseTo(VIEW_CONE_DEG, 1);
    expect(p.x).toBeGreaterThan(0); // on the hand's side
  });

  it('floats ahead of the eyes, a little low, without the hand', () => {
    const p = buddyTarget(new THREE.Vector3(), eye, v(0, 0, -1), null, thumb);
    expect(p.z).toBeCloseTo(-WAIT_AHEAD);
    expect(p.y).toBeCloseTo(1.5);
  });
});

describe('springStep', () => {
  it('settles in about 0.35 s without overshooting', () => {
    const p = v(0, 0, 0);
    const vel = v(0, 0, 0);
    const target = v(1, 0, 0);
    let max = 0;
    for (let t = 0; t < 0.35; t += 1 / 72) {
      springStep(p, vel, target, 1 / 72);
      max = Math.max(max, p.x);
    }
    expect(p.x).toBeGreaterThan(0.95);
    expect(max).toBeLessThanOrEqual(1.0001);
  });
});

describe('growth and face', () => {
  it('is the full flower before the flow and at the end; grows with the stages', () => {
    expect(growthForStage(0, false)).toBe(4);
    expect([1, 2, 3, 4, 5, 6].map((s) => growthForStage(s, true))).toEqual([0, 1, 2, 3, 4, 4]);
    expect(growthForStage(0, true)).toBe(4);
  });

  it('maps expressions to atlas cells', () => {
    expect(expressionOffset('talk', new THREE.Vector2()).toArray()).toEqual([0.25, 0.75]);
    expect(expressionOffset('determined', new THREE.Vector2()).toArray()).toEqual([0.75, 0.5]);
  });

  it('is 8 cm wide', () => {
    expect(0.239 * BUDDY_SCALE).toBeCloseTo(0.08, 3);
  });
});
