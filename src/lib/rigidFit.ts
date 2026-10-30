/**
 * Least-squares rigid rotation between two weighted point sets (the
 * Kabsch / Procrustes problem), solved with Horn's quaternion method: the
 * best rotation is the eigenvector of the largest eigenvalue of a symmetric
 * 4×4 matrix built from the points' cross-covariance. No SVD, always a
 * proper rotation (never a reflection), and no allocation per call.
 */

const N = new Float64Array(16);
const V = new Float64Array(16);

/**
 * Rotation `q` (x, y, z, w) that best maps `from` onto `to`, both given as
 * flat xyz arrays of `count` points, each already centred on its own
 * weighted centroid. Minimises Σ w·|q·from_k − to_k|² (scale doesn't matter).
 * @returns false if the points don't define a rotation (all collinear, or empty).
 */
export function fitRotation(
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  weights: ArrayLike<number>,
  count: number,
  out: { x: number; y: number; z: number; w: number },
): boolean {
  // Cross-covariance S_ab = Σ w · from_a · to_b.
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
  for (let k = 0; k < count; k++) {
    const w = weights[k];
    const ax = from[k * 3], ay = from[k * 3 + 1], az = from[k * 3 + 2];
    const bx = to[k * 3], by = to[k * 3 + 1], bz = to[k * 3 + 2];
    sxx += w * ax * bx; sxy += w * ax * by; sxz += w * ax * bz;
    syx += w * ay * bx; syy += w * ay * by; syz += w * ay * bz;
    szx += w * az * bx; szy += w * az * by; szz += w * az * bz;
  }
  // Horn (1987): quaternion (w, x, y, z) order.
  N[0] = sxx + syy + szz; N[1] = syz - szy;        N[2] = szx - sxz;         N[3] = sxy - syx;
  N[4] = N[1];            N[5] = sxx - syy - szz;  N[6] = sxy + syx;         N[7] = szx + sxz;
  N[8] = N[2];            N[9] = N[6];             N[10] = -sxx + syy - szz; N[11] = syz + szy;
  N[12] = N[3];           N[13] = N[7];            N[14] = N[11];            N[15] = -sxx - syy + szz;

  let scale = 0;
  for (let i = 0; i < 16; i++) scale = Math.max(scale, Math.abs(N[i]));
  if (!(scale > 1e-18)) return false;

  jacobiEigen4(N, V);
  // Largest eigenvalue (on N's diagonal after diagonalisation).
  let best = 0;
  for (let i = 1; i < 4; i++) if (N[i * 5] > N[best * 5]) best = i;
  const w = V[best], x = V[4 + best], y = V[8 + best], z = V[12 + best];
  const len = Math.hypot(w, x, y, z);
  if (!(len > 0)) return false;
  out.w = w / len;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return true;
}

/**
 * Diagonalises the symmetric 4×4 matrix `a` (row-major, overwritten: its
 * diagonal becomes the eigenvalues) by cyclic Jacobi rotations; the
 * eigenvectors end up in the columns of `v`.
 */
export function jacobiEigen4(a: Float64Array, v: Float64Array) {
  v.fill(0);
  v[0] = v[5] = v[10] = v[15] = 1;
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p * 4 + q] ** 2;
    if (off < 1e-30) return;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p * 4 + q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = a[p * 5];
        const aqq = a[q * 5];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          // Rotate rows/columns p and q.
          const akp = a[k * 4 + p];
          const akq = a[k * 4 + q];
          a[k * 4 + p] = c * akp - s * akq;
          a[k * 4 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p * 4 + k];
          const aqk = a[q * 4 + k];
          a[p * 4 + k] = c * apk - s * aqk;
          a[q * 4 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k * 4 + p];
          const vkq = v[k * 4 + q];
          v[k * 4 + p] = c * vkp - s * vkq;
          v[k * 4 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
}
