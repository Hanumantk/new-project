/** Smallest mat accepted: long side × short side (m). */
export const MIN_MAT_LONG = 0.25;
export const MIN_MAT_SHORT = 0.2;
/**
 * When the stroke's two principal spreads are this close (a squarish shape),
 * PCA can't tell the sides' directions apart, so the whole ±45° range is
 * searched for the tightest box; otherwise only ±10° around the PCA axis
 * (an uneven or unclosed loop tilts the PCA axes by a few degrees).
 */
const SQUARE_RATIO = 0.8;
const REFINE_RANGE = 10;

/** An oriented rectangle on the floor plane (world XZ). */
export interface FittedRect {
  cx: number;
  cz: number;
  /** Unit direction of the `length` side. */
  ux: number;
  uz: number;
  length: number;
  /** Extent across, along (−uz, ux). */
  breadth: number;
}

/** A fitted rectangle turned so its local +Z (front) faces the viewer. */
export interface MatPlacement {
  cx: number;
  cz: number;
  /** Rotation about +Y: local +X → (cos, 0, −sin), local +Z → (sin, 0, cos). */
  yaw: number;
  /** Size along local X (left to right for the viewer) and Z (back to front). */
  width: number;
  depth: number;
}

/**
 * Fits an oriented rectangle to the XZ positions of stroke points: the
 * principal axes of the points (PCA), refined to the tightest box near
 * them, then the points' extent along each axis.
 *
 * @param points x, y, z triples.
 * @param keep optional filter (by index); ignored if it would leave too few points.
 */
export function fitRectangle(points: Float32Array, count: number, keep?: (i: number) => boolean): FittedRect | null {
  let indices = Array.from({ length: count }, (_, i) => i);
  if (keep) {
    const kept = indices.filter(keep);
    if (kept.length >= Math.max(4, count * 0.6)) indices = kept;
  }
  if (indices.length < 4) return null;

  let mx = 0;
  let mz = 0;
  for (const i of indices) {
    mx += points[i * 3];
    mz += points[i * 3 + 2];
  }
  mx /= indices.length;
  mz /= indices.length;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (const i of indices) {
    const dx = points[i * 3] - mx;
    const dz = points[i * 3 + 2] - mz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  }

  let angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const half = (sxx + szz) / 2;
  const spread = Math.sqrt(((sxx - szz) / 2) ** 2 + sxz ** 2);
  const major = half + spread;
  const minor = half - spread;
  if (major <= 0) return null;
  angle = tightestAngle(points, indices, angle, minor / major > SQUARE_RATIO ? 45 : REFINE_RANGE);

  const box = extent(points, indices, angle);
  const ux = Math.cos(angle);
  const uz = Math.sin(angle);
  const midU = (box.minU + box.maxU) / 2;
  const midV = (box.minV + box.maxV) / 2;
  return {
    cx: ux * midU - uz * midV,
    cz: uz * midU + ux * midV,
    ux,
    uz,
    length: box.maxU - box.minU,
    breadth: box.maxV - box.minV,
  };
}

/** Turns the rectangle so its front edge (local +Z) is the side facing the viewer. */
export function orientToViewer(rect: FittedRect, viewerX: number, viewerZ: number): MatPlacement {
  let dx = viewerX - rect.cx;
  let dz = viewerZ - rect.cz;
  const d = Math.hypot(dx, dz) || 1;
  dx /= d;
  dz /= d;
  const alongU = rect.ux * dx + rect.uz * dz;
  const alongV = -rect.uz * dx + rect.ux * dz;
  let zx: number;
  let zz: number;
  let width: number;
  let depth: number;
  if (Math.abs(alongU) >= Math.abs(alongV)) {
    const s = Math.sign(alongU) || 1;
    zx = rect.ux * s;
    zz = rect.uz * s;
    depth = rect.length;
    width = rect.breadth;
  } else {
    const s = Math.sign(alongV) || 1;
    zx = -rect.uz * s;
    zz = rect.ux * s;
    depth = rect.breadth;
    width = rect.length;
  }
  return { cx: rect.cx, cz: rect.cz, yaw: Math.atan2(zx, zz), width, depth };
}

/** Whether a mat is at least MIN_MAT_LONG × MIN_MAT_SHORT, either way round. */
export function isBigEnough(width: number, depth: number): boolean {
  const eps = 1e-9;
  return Math.max(width, depth) >= MIN_MAT_LONG - eps && Math.min(width, depth) >= MIN_MAT_SHORT - eps;
}

function extent(points: Float32Array, indices: number[], angle: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const i of indices) {
    const x = points[i * 3];
    const z = points[i * 3 + 2];
    const u = c * x + s * z;
    const v = -s * x + c * z;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { minU, maxU, minV, maxV };
}

/** The angle within ±`range` degrees of `start` whose bounding box has the least area. */
function tightestAngle(points: Float32Array, indices: number[], start: number, range: number): number {
  const area = (a: number) => {
    const b = extent(points, indices, a);
    return (b.maxU - b.minU) * (b.maxV - b.minV);
  };
  const deg = Math.PI / 180;
  let best = start;
  let bestArea = area(start);
  for (let k = -range; k < range; k++) {
    const a = start + k * deg;
    const value = area(a);
    if (value < bestArea) {
      best = a;
      bestArea = value;
    }
  }
  const coarse = best;
  for (let k = -10; k <= 10; k++) {
    const a = coarse + k * 0.1 * deg;
    const value = area(a);
    if (value < bestArea) {
      best = a;
      bestArea = value;
    }
  }
  return best;
}
