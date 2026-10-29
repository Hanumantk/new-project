import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FingerCoverage } from './fingerCoverage';

/** Camera at the origin looking down −Z, like the webcam scene. */
function webcam() {
  const camera = new THREE.PerspectiveCamera(41, 1280 / 720, 0.01, 10);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

const PALM_Z = -0.4;

/** Points over the middle of the palm, where the wound is. */
const woundSamples: THREE.Vector3[] = [];
for (let x = -0.025; x <= 0.0251; x += 0.01) {
  for (let y = -0.02; y <= 0.0201; y += 0.01) woundSamples.push(new THREE.Vector3(x, y, PALM_Z));
}

/**
 * A right hand, palm towards the camera, knuckles at y = +0.04. Each finger
 * runs from its knuckle along `dir`, at depth offset `dz` per segment.
 */
function hand(dir: [number, number], dz: number): THREE.Vector3[] {
  const j = Array.from({ length: 21 }, () => new THREE.Vector3());
  j[0].set(0, -0.05, PALM_Z);
  // Thumb, off to the side, in the palm plane.
  [1, 2, 3, 4].forEach((k, i) => j[k].set(0.035 + 0.012 * i, -0.03 + 0.012 * i, PALM_Z));
  const knuckles = [0.03, 0.01, -0.01, -0.03];
  [5, 9, 13, 17].forEach((mcp, f) => {
    for (let s = 0; s < 4; s++) {
      j[mcp + s].set(knuckles[f] + dir[0] * 0.025 * s, 0.04 + dir[1] * 0.025 * s, PALM_Z + dz * s);
    }
  });
  return j;
}

function coverage(joints: THREE.Vector3[]) {
  return new FingerCoverage().measure(
    woundSamples.length,
    (i, out) => out.copy(woundSamples[i]),
    joints,
    webcam(),
    1280,
    720,
    1,
  );
}

describe('FingerCoverage', () => {
  it('sees an open palm with fingers held up as uncovered', () => {
    expect(coverage(hand([0, 1], 0))).toBe(0);
  });

  it('sees fingers curled down in front of the palm as covering the wound', () => {
    expect(coverage(hand([0, -1], 0.012))).toBeGreaterThan(0.5);
  });

  it('ignores fingers that are behind the palm', () => {
    expect(coverage(hand([0, -1], -0.02))).toBe(0);
  });

  it('returns 0 with no samples', () => {
    expect(new FingerCoverage().measure(0, (_, o) => o, hand([0, 1], 0), webcam(), 1280, 720, 1)).toBe(0);
  });
});
