import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  PalmTemplate,
  REAL_PALM_WIDTH,
  canonicalPalm,
  createPalmSurface,
  fitPalmSurface,
  palmHeight,
  placeWound,
  PALM_SKIN_LIFT,
  WOUND_ALONG,
  woundToPalm,
} from './palmModel';
import { rightPalm } from './palmFixtures';

describe('canonicalPalm', () => {
  it('puts the palm in its own frame: normal out of the palm, +Z to the fingers, 8 cm wide', () => {
    const out = new Float64Array(18);
    expect(canonicalPalm(rightPalm(), true, out)).toBe(true);
    const pt = (k: number) => new THREE.Vector3(out[k * 3], out[k * 3 + 1], out[k * 3 + 2]);
    expect(pt(2).distanceTo(pt(5))).toBeCloseTo(REAL_PALM_WIDTH, 9);
    expect(pt(3).z).toBeGreaterThan(pt(0).z); // fingers are +Z
    // The same points rotated anywhere give the same canonical shape.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(1, 2, 0.5));
    const out2 = new Float64Array(18);
    canonicalPalm(rightPalm(1.3).map((p) => p.applyQuaternion(q)), true, out2);
    for (let i = 0; i < 18; i++) expect(out2[i]).toBeCloseTo(out[i], 9);
  });
});

describe('PalmTemplate', () => {
  it('fixes the shape after 10 frames, skipping an odd frame', () => {
    const t = new PalmTemplate();
    for (let i = 0; i < 5; i++) t.offer(rightPalm(), true);
    const bent = rightPalm();
    bent[1].z += 0.03; // one very different frame: skipped
    t.offer(bent, true);
    for (let i = 0; i < 4; i++) t.offer(rightPalm(), true);
    expect(t.ready).toBe(false);
    t.offer(rightPalm(), true);
    expect(t.ready).toBe(true);
    expect(t.version).toBe(1);
  });

  it('starts over when the shape really changes', () => {
    const t = new PalmTemplate();
    for (let i = 0; i < 6; i++) t.offer(rightPalm(), true);
    const bent = rightPalm();
    bent[1].z += 0.03;
    for (let i = 0; i < 9; i++) t.offer(bent, true); // the 5th in a row restarts the capture
    expect(t.ready).toBe(false);
    for (let i = 0; i < 5; i++) t.offer(bent, true);
    expect(t.ready).toBe(true);
  });
});

describe('palm surface and wound placement', () => {
  const template = new Float64Array(18);
  canonicalPalm(rightPalm(), true, template);
  const s = fitPalmSurface(template, createPalmSurface());

  it('lies PALM_SKIN_LIFT above the wrist, thumb base, index and pinky knuckles, cupped in the middle', () => {
    for (const k of [0, 1, 2, 5]) {
      expect(palmHeight({ ...s, bowDepth: 0 }, template[k * 3], template[k * 3 + 2])).toBeCloseTo(template[k * 3 + 1] + PALM_SKIN_LIFT, 9);
    }
    expect(palmHeight(s, s.bowX, s.bowZ)).toBeLessThan(palmHeight({ ...s, bowDepth: 0 }, s.bowX, s.bowZ) - 0.0029);
  });

  it('has a gradient matching its slope', () => {
    const g = new Float64Array(2);
    const x = 0.01, z = -0.005, e = 1e-6;
    palmHeight(s, x, z, g);
    expect(g[0]).toBeCloseTo((palmHeight(s, x + e, z) - palmHeight(s, x - e, z)) / (2 * e), 6);
    expect(g[1]).toBeCloseTo((palmHeight(s, x, z + e) - palmHeight(s, x, z - e)) / (2 * e), 6);
  });

  it('puts the wound in the middle of the palm, across it', () => {
    const p = placeWound(template, { x: 0, z: 0, angle: 0 });
    const index = [template[6], template[8]];
    const pinky = [template[15], template[17]];
    const wrist = [template[0], template[2]];
    const knuckles = [(index[0] + pinky[0]) / 2, (index[1] + pinky[1]) / 2];
    const c = new Float64Array(2);
    woundToPalm(p, 0, 0, c);
    expect(c[0]).toBeCloseTo(knuckles[0] + (wrist[0] - knuckles[0]) * WOUND_ALONG, 9);
    expect(c[1]).toBeCloseTo(knuckles[1] + (wrist[1] - knuckles[1]) * WOUND_ALONG, 9);
    // The wound's +Z (long axis) runs parallel to the knuckle row, towards the index.
    const tip = new Float64Array(2);
    woundToPalm(p, 0, 0.01, tip);
    const dir = [tip[0] - c[0], tip[1] - c[1]];
    const want = [index[0] - pinky[0], index[1] - pinky[1]];
    const cos = (dir[0] * want[0] + dir[1] * want[1]) / (Math.hypot(...dir) * Math.hypot(...want));
    expect(cos).toBeCloseTo(1, 9);
  });
});
