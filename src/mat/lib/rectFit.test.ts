import { describe, expect, it } from 'vitest';
import { fitRectangle, isBigEnough, orientToViewer } from './rectFit';

/** Points every ~1 cm around a w × d rectangle centred at (cx, cz), turned by `angle`, with noise. */
function tracedRect(w: number, d: number, angle: number, cx = 0, cz = 0, noise = 0, seed = 1) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const corners = [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ];
  const pts: number[] = [];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k];
    const [bx, bz] = corners[(k + 1) % 4];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.01);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const lx = ax + (bx - ax) * t + rand() * noise;
      const lz = az + (bz - az) * t + rand() * noise;
      pts.push(cx + Math.cos(angle) * lx - Math.sin(angle) * lz, 0.75, cz + Math.sin(angle) * lx + Math.cos(angle) * lz);
    }
  }
  return new Float32Array(pts);
}

const sideAngle = (ux: number, uz: number) => {
  // Direction of a side, folded to [0°, 90°).
  const a = (Math.atan2(uz, ux) * 180) / Math.PI;
  return ((a % 90) + 90) % 90;
};

describe('fitRectangle', () => {
  it('recovers a turned rectangle’s centre, size and direction', () => {
    const pts = tracedRect(0.5, 0.3, 0.4, 0.1, -0.6);
    const r = fitRectangle(pts, pts.length / 3)!;
    expect(r.cx).toBeCloseTo(0.1, 2);
    expect(r.cz).toBeCloseTo(-0.6, 2);
    expect(Math.max(r.length, r.breadth)).toBeCloseTo(0.5, 2);
    expect(Math.min(r.length, r.breadth)).toBeCloseTo(0.3, 2);
    expect(sideAngle(r.ux, r.uz)).toBeCloseTo((0.4 * 180) / Math.PI, 0);
  });

  it('finds the sides of a square, where PCA alone can’t', () => {
    const pts = tracedRect(0.4, 0.4, 0.3, 0, 0, 0.004);
    const r = fitRectangle(pts, pts.length / 3)!;
    expect(sideAngle(r.ux, r.uz)).toBeGreaterThan(15.5);
    expect(sideAngle(r.ux, r.uz)).toBeLessThan(18.9);
    expect(r.length).toBeCloseTo(0.4, 1);
    expect(r.breadth).toBeCloseTo(0.4, 1);
  });

  it('copes with a wobbly hand-drawn outline', () => {
    const pts = tracedRect(0.6, 0.4, -0.2, 0, 0, 0.012);
    const r = fitRectangle(pts, pts.length / 3)!;
    expect(Math.max(r.length, r.breadth)).toBeGreaterThan(0.59);
    expect(Math.max(r.length, r.breadth)).toBeLessThan(0.64);
    expect(Math.abs(sideAngle(r.ux, r.uz) - (90 - 11.46))).toBeLessThan(3);
  });

  it('is not tilted by a loop that doesn’t close', () => {
    const full = tracedRect(0.5, 0.35, 0);
    const open = full.slice(0, full.length - 3 * 5); // the last 5 cm of the loop missing
    const r = fitRectangle(open, open.length / 3)!;
    expect(Math.min(sideAngle(r.ux, r.uz), 90 - sideAngle(r.ux, r.uz))).toBeLessThan(0.3);
    expect(Math.max(r.length, r.breadth)).toBeCloseTo(0.5, 2);
    expect(Math.min(r.length, r.breadth)).toBeCloseTo(0.35, 2);
  });

  it('ignores points the filter drops (e.g. the hand lifting off)', () => {
    const rect = tracedRect(0.4, 0.3, 0);
    const pts = new Float32Array([...rect, 0.6, 0.95, 0.6, 0.62, 0.97, 0.62]); // a tail high above
    const count = pts.length / 3;
    const r = fitRectangle(pts, count, (i) => pts[i * 3 + 1] < 0.8)!;
    expect(Math.max(r.length, r.breadth)).toBeCloseTo(0.4, 2);
  });

  it('gives up on too few points', () => {
    expect(fitRectangle(new Float32Array([0, 0, 0, 1, 0, 1]), 2)).toBeNull();
  });
});

describe('orientToViewer', () => {
  it('turns the front edge towards the viewer and reports width across, depth away', () => {
    // A 60 × 40 cm mat straight ahead (−Z) of a viewer at the origin.
    const pts = tracedRect(0.6, 0.4, 0, 0, -0.6);
    const m = orientToViewer(fitRectangle(pts, pts.length / 3)!, 0, 0);
    expect(m.width).toBeCloseTo(0.6, 2);
    expect(m.depth).toBeCloseTo(0.4, 2);
    expect(Math.cos(m.yaw)).toBeCloseTo(1, 3); // local +Z → world +Z, towards the viewer
    // The same mat seen from its side: the long edge now runs away from the viewer.
    const side = orientToViewer(fitRectangle(pts, pts.length / 3)!, 2, -0.6);
    expect(side.width).toBeCloseTo(0.4, 2);
    expect(side.depth).toBeCloseTo(0.6, 2);
    expect(Math.sin(side.yaw)).toBeCloseTo(1, 3); // local +Z → world +X
  });
});

describe('isBigEnough', () => {
  it('needs 25 × 20 cm either way round', () => {
    expect(isBigEnough(0.25, 0.2)).toBe(true);
    expect(isBigEnough(0.2, 0.25)).toBe(true);
    expect(isBigEnough(0.3, 0.19)).toBe(false);
    expect(isBigEnough(0.24, 0.24)).toBe(false);
  });
});
