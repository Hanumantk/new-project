/**
 * The palm as a rigid body: six landmarks (wrist, thumb base, the four
 * knuckles) in a canonical palm frame, the curved surface they span, and
 * where the wound sits on it.
 *
 * Canonical palm frame (metres): origin at the six points' weighted
 * centroid, +Y out of the palm, +Z from the wrist towards the fingers,
 * +X = Y × Z. It's right-handed for both hands, so a left hand is never
 * mirrored — the wound is the same object on either hand.
 */

/** The landmarks the palm pose is fitted to (fingers moving never affect it). */
export const PALM_LANDMARKS = [0, 1, 5, 9, 13, 17] as const;
/** Fit weights: the thumb base (1) moves a little with the thumb, so it counts for less. */
export const PALM_WEIGHTS = [1, 0.5, 1, 1, 1, 1] as const;
const W = PALM_WEIGHTS;
const IDX = { wrist: 0, thumb: 1, index: 2, middle: 3, ring: 4, pinky: 5 };
/** Real distance between the index and pinky knuckles (landmarks 5 and 17), metres. */
export const REAL_PALM_WIDTH = 0.08;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Where the wound goes: the middle of the palm, this far along the line from
 * the middle of the knuckle row (between landmarks 5 and 17) to the wrist (0..1)…
 */
export const WOUND_ALONG = 0.45;
/**
 * …lying across the palm (parallel to the knuckle row, pinky → index), turned
 * this much more about the palm normal (degrees)…
 */
export const WOUND_ANGLE_DEG = 0;
/** …and moved by this much in the palm plane (metres: across towards the index side, along towards the fingers). */
export const WOUND_OFFSET: readonly [number, number] = [0, 0];

/** How far the middle of the palm sinks below the patch through the joints (metres): its cup. */
export const PALM_BOW = 0.003;
/**
 * The landmarks are joint centres inside the hand; the palm's skin lies this
 * far above the plane through them (metres, for an 8 cm palm).
 */
export const PALM_SKIN_LIFT = 0.015;

const totalWeight = W.reduce((a, b) => a + b, 0);

/**
 * Expresses six palm points (camera space, metres, in PALM_LANDMARKS order)
 * in their own canonical palm frame, scaled so the index–pinky knuckle
 * distance is REAL_PALM_WIDTH. Writes 18 numbers to `out`.
 * @returns false if the points are degenerate.
 */
export function canonicalPalm(points: readonly Vec3[], isRightHand: boolean, out: Float64Array): boolean {
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < 6; k++) {
    cx += points[k].x * W[k];
    cy += points[k].y * W[k];
    cz += points[k].z * W[k];
  }
  cx /= totalWeight;
  cy /= totalWeight;
  cz /= totalWeight;
  const p0 = points[IDX.wrist], p5 = points[IDX.index], p9 = points[IDX.middle], p17 = points[IDX.pinky];
  // Normal out of the palm: (5−0)×(17−0), flipped for left hands.
  const ax = p5.x - p0.x, ay = p5.y - p0.y, az = p5.z - p0.z;
  const bx = p17.x - p0.x, by = p17.y - p0.y, bz = p17.z - p0.z;
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  let len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-12)) return false;
  const sign = isRightHand ? 1 : -1;
  nx = (nx / len) * sign;
  ny = (ny / len) * sign;
  nz = (nz / len) * sign;
  // +Z: wrist → middle knuckle, made perpendicular to the normal.
  let zx = p9.x - p0.x, zy = p9.y - p0.y, zz = p9.z - p0.z;
  const d = zx * nx + zy * ny + zz * nz;
  zx -= d * nx;
  zy -= d * ny;
  zz -= d * nz;
  len = Math.hypot(zx, zy, zz);
  if (!(len > 1e-12)) return false;
  zx /= len;
  zy /= len;
  zz /= len;
  // +X = Y × Z.
  const xx = ny * zz - nz * zy, xy = nz * zx - nx * zz, xz = nx * zy - ny * zx;
  const width = Math.hypot(p5.x - p17.x, p5.y - p17.y, p5.z - p17.z);
  if (!(width > 1e-9)) return false;
  const s = REAL_PALM_WIDTH / width;
  for (let k = 0; k < 6; k++) {
    const px = points[k].x - cx, py = points[k].y - cy, pz = points[k].z - cz;
    out[k * 3] = (px * xx + py * xy + pz * xz) * s;
    out[k * 3 + 1] = (px * nx + py * ny + pz * nz) * s;
    out[k * 3 + 2] = (px * zx + py * zy + pz * zz) * s;
  }
  return true;
}

/** Frames the template averages over. */
const TEMPLATE_FRAMES = 10;
/**
 * A frame further than this (RMS per point, metres) from the running
 * average is skipped as an outlier; a run of them restarts the capture
 * (the hand really is a different shape, e.g. the thumb moved).
 */
const TEMPLATE_OUTLIER_RMS = 0.008;
const TEMPLATE_RESTART_AFTER = 5;

/**
 * The palm's shape, captured once from the first few stable frames (the
 * average of their canonical points) and then fixed, so per-frame landmark
 * noise never reshapes it.
 */
export class PalmTemplate {
  /** Canonical points (18 numbers, metres); valid once `ready`. */
  readonly points = new Float64Array(18);
  ready = false;
  isRightHand = true;
  /** Bumps when `points` change. */
  version = 0;
  private readonly sum = new Float64Array(18);
  private readonly frame = new Float64Array(18);
  private count = 0;
  private outliers = 0;

  reset(isRightHand = this.isRightHand) {
    this.ready = false;
    this.isRightHand = isRightHand;
    this.count = 0;
    this.outliers = 0;
    this.sum.fill(0);
  }

  /**
   * Offers one frame's palm points (camera space, metric). Collects stable
   * frames until there are enough; ignored once ready (unless the hand changes).
   */
  offer(points: readonly Vec3[], isRightHand: boolean) {
    if (isRightHand !== this.isRightHand) this.reset(isRightHand);
    if (this.ready) return;
    if (!canonicalPalm(points, isRightHand, this.frame)) return;
    if (this.count > 0) {
      let err = 0;
      for (let i = 0; i < 18; i++) err += (this.frame[i] - this.sum[i] / this.count) ** 2;
      if (Math.sqrt(err / 6) > TEMPLATE_OUTLIER_RMS) {
        if (++this.outliers < TEMPLATE_RESTART_AFTER) return;
        // Consistently different: start over from this frame.
        this.count = 0;
        this.sum.fill(0);
      }
    }
    this.outliers = 0;
    for (let i = 0; i < 18; i++) this.sum[i] += this.frame[i];
    this.count++;
    if (this.count >= TEMPLATE_FRAMES) {
      for (let i = 0; i < 18; i++) this.points[i] = this.sum[i] / this.count;
      this.ready = true;
      this.version++;
    }
  }
}

/**
 * The palm's skin surface in the canonical frame, as a height y = H(x, z):
 * a bilinear patch through the wrist, thumb base, index and pinky knuckles,
 * minus a smooth inward bow at the centre (the palm's cup).
 */
export interface PalmSurface {
  /** Bilinear: c0 + c1·x + c2·z + c3·x·z. */
  c0: number;
  c1: number;
  c2: number;
  c3: number;
  /** Bow centre and radii in x/z, and depth (subtracted). */
  bowX: number;
  bowZ: number;
  bowRx: number;
  bowRz: number;
  bowDepth: number;
  /** Extent of the palm in x/z (min, max), for the palm stand-in mesh. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function createPalmSurface(): PalmSurface {
  return { c0: 0, c1: 0, c2: 0, c3: 0, bowX: 0, bowZ: 0, bowRx: 0.04, bowRz: 0.04, bowDepth: 0, minX: -0.05, maxX: 0.05, minZ: -0.05, maxZ: 0.05 };
}

/** Fits the surface to a template's canonical points, raised by `lift` onto the skin. */
export function fitPalmSurface(template: ArrayLike<number>, out: PalmSurface, lift = PALM_SKIN_LIFT): PalmSurface {
  const corner = [IDX.wrist, IDX.thumb, IDX.index, IDX.pinky];
  // Solve [1 x z xz]·c = y exactly through the four corners.
  const m: number[][] = corner.map((k) => {
    const x = template[k * 3], y = template[k * 3 + 1], z = template[k * 3 + 2];
    return [1, x, z, x * z, y];
  });
  const c = solve4(m);
  if (c) [out.c0, out.c1, out.c2, out.c3] = c;
  else {
    // Degenerate quad: a flat plane through the centroid.
    out.c0 = out.c1 = out.c2 = out.c3 = 0;
  }
  out.c0 += lift;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sx = 0, sz = 0;
  for (let k = 0; k < 6; k++) {
    const x = template[k * 3], z = template[k * 3 + 2];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    sx += x;
    sz += z;
  }
  out.minX = minX;
  out.maxX = maxX;
  out.minZ = minZ;
  out.maxZ = maxZ;
  out.bowX = sx / 6;
  out.bowZ = sz / 6;
  out.bowRx = Math.max((maxX - minX) / 2, 0.01);
  out.bowRz = Math.max((maxZ - minZ) / 2, 0.01);
  out.bowDepth = PALM_BOW;
  return out;
}

/**
 * Surface height at (x, z), and its gradient (written to grad[0..1]).
 * Mirrors `palmHeight` in the conform shader (woundShaders.ts).
 */
export function palmHeight(s: PalmSurface, x: number, z: number, grad?: Float64Array): number {
  let h = s.c0 + s.c1 * x + s.c2 * z + s.c3 * x * z;
  let gx = s.c1 + s.c3 * z;
  let gz = s.c2 + s.c3 * x;
  const dx = (x - s.bowX) / s.bowRx;
  const dz = (z - s.bowZ) / s.bowRz;
  const r2 = dx * dx + dz * dz;
  if (r2 < 1) {
    const k = 1 - r2;
    h -= s.bowDepth * k * k;
    gx += (4 * s.bowDepth * k * dx) / s.bowRx;
    gz += (4 * s.bowDepth * k * dz) / s.bowRz;
  }
  if (grad) {
    grad[0] = gx;
    grad[1] = gz;
  }
  return h;
}

/** The wound's place on the palm: centre (x, z) and the angle its long axis is turned by. */
export interface WoundPlacement {
  x: number;
  z: number;
  /** Rotation about +Y taking the wound's +Z (long axis) to its direction on the palm. */
  angle: number;
}

/**
 * The wound's centre and direction from a template: in the middle of the
 * palm, its long axis across it, parallel to the knuckle row.
 */
export function placeWound(template: ArrayLike<number>, out: WoundPlacement): WoundPlacement {
  const ix = template[IDX.index * 3], iz = template[IDX.index * 3 + 2];
  const px = template[IDX.pinky * 3], pz = template[IDX.pinky * 3 + 2];
  const kx = (ix + px) / 2, kz = (iz + pz) / 2;
  const wx = template[IDX.wrist * 3], wz = template[IDX.wrist * 3 + 2];
  out.x = kx + (wx - kx) * WOUND_ALONG + WOUND_OFFSET[0];
  out.z = kz + (wz - kz) * WOUND_ALONG + WOUND_OFFSET[1];
  out.angle = Math.atan2(ix - px, iz - pz) + (WOUND_ANGLE_DEG * Math.PI) / 180;
  return out;
}

/** Wound-local (x, z) → canonical palm (x, z). Mirrors `woundToPalm` in the shader. */
export function woundToPalm(p: WoundPlacement, x: number, z: number, out: Float64Array) {
  const c = Math.cos(p.angle);
  const s = Math.sin(p.angle);
  out[0] = p.x + x * c + z * s;
  out[1] = p.z - x * s + z * c;
}

const conformGrad = new Float64Array(2);
const conformXZ = new Float64Array(2);

/**
 * A wound-local point (x, height y, z) laid onto the palm surface, in the
 * canonical palm frame: the surface point under it, raised along the
 * surface normal by y + lift. Mirrors `conformPoint` in woundShaders.ts.
 */
export function conformPoint(
  s: PalmSurface,
  p: WoundPlacement,
  x: number,
  y: number,
  z: number,
  lift: number,
  out: Vec3,
): Vec3 {
  woundToPalm(p, x, z, conformXZ);
  const h = palmHeight(s, conformXZ[0], conformXZ[1], conformGrad);
  const nx = -conformGrad[0], nz = -conformGrad[1];
  const nl = Math.hypot(nx, 1, nz);
  const up = y + lift;
  out.x = conformXZ[0] + (nx / nl) * up;
  out.y = h + up / nl;
  out.z = conformXZ[1] + (nz / nl) * up;
  return out;
}

/** Solves a 4×4 system given as augmented rows [a b c d | e]; null if singular. */
function solve4(m: number[][]): number[] | null {
  const a = m.map((r) => r.slice());
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let k = col; k < 5; k++) a[r][k] -= f * a[col][k];
    }
  }
  return a.map((r, i) => r[4] / a[i][i]);
}
