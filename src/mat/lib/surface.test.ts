import { describe, expect, it } from 'vitest';
import { medianY, pickSurfacePlane, pointInPolygon, surfaceFromPen } from './surface';

const square = (half: number, cx = 0, cz = 0) => [cx - half, cz - half, cx + half, cz - half, cx + half, cz + half, cx - half, cz + half];

describe('surface', () => {
  it('takes the median pen height', () => {
    expect(medianY(new Float32Array([0, 0.8, 0, 0, 0.76, 0, 0, 0.75, 0]), 3)).toBeCloseTo(0.76, 6);
    expect(medianY(new Float32Array([0, 1, 0, 0, 2, 0]), 2)).toBe(1.5);
  });

  it('puts the surface one fingertip radius below the pen', () => {
    expect(surfaceFromPen(0.76, 0.009)).toBeCloseTo(0.751, 6);
  });

  it('tests points against a polygon', () => {
    expect(pointInPolygon(0, 0, square(0.5))).toBe(true);
    expect(pointInPolygon(0.6, 0, square(0.5))).toBe(false);
  });

  it('picks the table under the stroke, not the floor or a shelf above', () => {
    const floor = { y: 0, polygon: square(3) };
    const table = { y: 0.74, polygon: square(0.6, 0, -0.5) };
    const shelf = { y: 0.9, polygon: square(0.6, 0, -0.5) };
    const elsewhere = { y: 0.745, polygon: square(0.3, 2, 2) };
    const picked = pickSurfacePlane([floor, shelf, elsewhere, table], 0, -0.5, 0.752, 0.009);
    expect(picked).toBe(table);
    expect(pickSurfacePlane([floor, shelf], 0, -0.5, 0.752, 0.009)).toBeNull();
  });
});
