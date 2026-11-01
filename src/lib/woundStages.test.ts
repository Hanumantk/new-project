import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { STAGE_COUNT, isPinchAtWound, nextStep } from './woundStages';

const target = (x: number, y: number, z: number, visible = true) => ({ visible, point: new THREE.Vector3(x, y, z) });
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('nextStep', () => {
  it('goes finished wound → stage 1 … stage 5 → finished wound', () => {
    const seen = [0];
    for (let i = 0; i < STAGE_COUNT + 1; i++) seen.push(nextStep(seen[seen.length - 1]));
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 0]);
  });
});

describe('isPinchAtWound', () => {
  it('accepts a pinch close to the wound', () => {
    expect(isPinchAtWound(v(0.06, 0.03, 0), target(0, 0, 0))).toBe(true);
  });

  it('ignores a pinch further away, wherever it points', () => {
    expect(isPinchAtWound(v(0.2, 0, 0), target(0, 0, 0))).toBe(false);
  });

  it('ignores every pinch while the wound is hidden', () => {
    expect(isPinchAtWound(v(0.01, 0, 0), target(0, 0, 0, false))).toBe(false);
  });
});
