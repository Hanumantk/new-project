import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitRotation } from './rigidFit';

function centred(points: THREE.Vector3[]) {
  const c = points.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(points.length);
  return points.flatMap((p) => [p.x - c.x, p.y - c.y, p.z - c.z]);
}

describe('fitRotation (Horn / Kabsch)', () => {
  const pts = [
    new THREE.Vector3(0, 0, -0.04),
    new THREE.Vector3(0.03, -0.01, -0.02),
    new THREE.Vector3(0.035, 0, 0.04),
    new THREE.Vector3(0.01, 0.003, 0.045),
    new THREE.Vector3(-0.015, 0.002, 0.04),
    new THREE.Vector3(-0.04, -0.002, 0.03),
  ];
  const ones = [1, 1, 1, 1, 1, 1];

  it('recovers a known rotation exactly', () => {
    const truth = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.7));
    const moved = pts.map((p) => p.clone().applyQuaternion(truth).multiplyScalar(1.7)); // scale is ignored
    const q = new THREE.Quaternion();
    expect(fitRotation(centred(pts), centred(moved), ones, 6, q)).toBe(true);
    expect(Math.abs(q.dot(truth))).toBeCloseTo(1, 9);
  });

  it('handles turns past 90° and the identity', () => {
    for (const e of [new THREE.Euler(0, 0, 0), new THREE.Euler(Math.PI * 0.9, 0.2, -2.5)]) {
      const truth = new THREE.Quaternion().setFromEuler(e);
      const q = new THREE.Quaternion();
      fitRotation(centred(pts), centred(pts.map((p) => p.clone().applyQuaternion(truth))), ones, 6, q);
      expect(Math.abs(q.dot(truth))).toBeCloseTo(1, 9);
    }
  });

  it('averages noise over the points', () => {
    const truth = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.3, 0.5, 0.2));
    let seed = 3;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const noisy = pts.map((p) => p.clone().applyQuaternion(truth).add(new THREE.Vector3(rand(), rand(), rand()).multiplyScalar(0.002)));
    const q = new THREE.Quaternion();
    fitRotation(centred(pts), centred(noisy), ones, 6, q);
    expect(q.angleTo(truth)).toBeLessThan(0.06); // < 3.5° from 2 mm noise on a 8 cm palm
  });
});
