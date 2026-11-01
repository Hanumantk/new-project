import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GROWTH, expressionOffset, growthForStep, hoverPoint } from './buddy';

describe('expressionOffset', () => {
  it('points at the expression’s cell in the 4 × 4 atlas', () => {
    expect(expressionOffset('happy').toArray()).toEqual([0, 0]);
    expect(expressionOffset('sad').toArray()).toEqual([0.75, 0.25]);
    expect(expressionOffset('love').toArray()).toEqual([0.5, 0.75]);
  });
});

describe('growthForStep', () => {
  it('grows the flower with the wound’s stages, full on the finished wound', () => {
    expect([1, 2, 3, 4, 5, 0].map(growthForStep)).toEqual([0, 1, 2, 3, 4, GROWTH.length - 1]);
  });
});

describe('hoverPoint', () => {
  const eye = new THREE.Vector3(0, 1.6, 0);
  const palm = new THREE.Vector3(0, 1.3, -0.4);
  it('hovers above the palm, out to the hand’s outer side', () => {
    const left = hoverPoint(palm, eye, 'left', 0, new THREE.Vector3());
    const right = hoverPoint(palm, eye, 'right', 0, new THREE.Vector3());
    expect(left.y).toBeGreaterThan(palm.y + 0.05);
    expect(left.x).toBeLessThan(palm.x - 0.1);
    expect(right.x).toBeGreaterThan(palm.x + 0.1);
  });

  it('never strays far from the hand', () => {
    for (let t = 0; t < 30; t += 0.7) {
      expect(hoverPoint(palm, eye, 'left', t, new THREE.Vector3()).distanceTo(palm)).toBeLessThan(0.25);
    }
  });
});
