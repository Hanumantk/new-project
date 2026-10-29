/** A detected horizontal plane: its height and outline (x, z pairs) in world space. */
export interface HorizontalPlane {
  y: number;
  polygon: number[];
}

/** A plane counts as the table under the pen if it's this far below the pen at most… */
export const SURFACE_BELOW = 0.1;
/** …and at most this far above it (tracking noise). */
export const SURFACE_ABOVE = 0.03;

/** Median of the y values of x, y, z triples. */
export function medianY(points: Float32Array, count: number): number {
  if (count === 0) return 0;
  const ys = new Float32Array(count);
  for (let i = 0; i < count; i++) ys[i] = points[i * 3 + 1];
  ys.sort();
  const mid = count >> 1;
  return count % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
}

/**
 * The table height with no detected plane: the pen (between the fingertip
 * joints) rides one fingertip radius above the surface it traces on.
 */
export function surfaceFromPen(penMedianY: number, tipRadius: number): number {
  return penMedianY - tipRadius;
}

export function pointInPolygon(x: number, z: number, polygon: number[]): boolean {
  let inside = false;
  const n = polygon.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2];
    const zi = polygon[i * 2 + 1];
    const xj = polygon[j * 2];
    const zj = polygon[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The horizontal plane the stroke was drawn on: one whose outline contains
 * the stroke's centre, at a plausible height below the pen, the closest to
 * where the surface should be.
 */
export function pickSurfacePlane(
  planes: HorizontalPlane[],
  centreX: number,
  centreZ: number,
  penY: number,
  tipRadius: number,
): HorizontalPlane | null {
  const expected = surfaceFromPen(penY, tipRadius);
  let best: HorizontalPlane | null = null;
  let bestError = Infinity;
  for (const plane of planes) {
    if (plane.y < penY - SURFACE_BELOW || plane.y > penY + SURFACE_ABOVE) continue;
    if (!pointInPolygon(centreX, centreZ, plane.polygon)) continue;
    const error = Math.abs(plane.y - expected);
    if (error < bestError) {
      best = plane;
      bestError = error;
    }
  }
  return best;
}
