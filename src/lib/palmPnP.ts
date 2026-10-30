import * as THREE from 'three';

/**
 * Refines a palm pose so the template, seen through the camera, lands on the
 * image landmarks: Gauss–Newton on the weighted reprojection error of the
 * six palm points (perspective), over rotation and position, with a prior
 * pulling the rotation towards the rigid fit to the world landmarks.
 *
 * MediaPipe's image landmarks are far more accurate across the image than
 * its world landmarks are in rotation; but six nearly coplanar points can't
 * tell a palm tilted one way from the other, which is what the prior is for.
 */

/** Gauss–Newton iterations per frame. */
const ITERATIONS = 4;
const EPS_ROT = 1e-4;
const EPS_POS = 1e-5;

export interface Camera {
  focal: number;
  cx: number;
  cy: number;
}

const J = new Float64Array(15 * 6);
const r = new Float64Array(15);
const rTry = new Float64Array(15);
const A = new Float64Array(36);
const b = new Float64Array(6);
const delta = new Float64Array(6);
const qTry = new THREE.Quaternion();
const qStep = new THREE.Quaternion();
const qErr = new THREE.Quaternion();
const qPriorInv = new THREE.Quaternion();
const pTry = new THREE.Vector3();
const v = new THREE.Vector3();
const axis = new THREE.Vector3();

/**
 * @param template  Canonical palm points (18 numbers, metres).
 * @param weights   Per-point weights (6).
 * @param image     Observed image points (12 numbers: u, v in video pixels).
 * @param prior     The rotation from the world landmarks.
 * @param priorPx   Prior strength: a rotation away from `prior` costs as much
 *                  as this many pixels of reprojection error per radian
 *                  (per unit weight).
 * @param q, position  Initial pose (canonical → camera), refined in place.
 */
export function refinePalmPose(
  template: ArrayLike<number>,
  weights: ArrayLike<number>,
  image: ArrayLike<number>,
  camera: Camera,
  prior: THREE.Quaternion,
  priorPx: number,
  q: THREE.Quaternion,
  position: THREE.Vector3,
) {
  qPriorInv.copy(prior).invert();
  residuals(template, weights, image, camera, q, position, priorPx, r);
  for (let it = 0; it < ITERATIONS; it++) {
    // Numeric Jacobian: small rotations (applied in camera space) and moves.
    for (let p = 0; p < 6; p++) {
      if (p < 3) {
        axis.set(p === 0 ? 1 : 0, p === 1 ? 1 : 0, p === 2 ? 1 : 0);
        qTry.setFromAxisAngle(axis, EPS_ROT).multiply(q);
        pTry.copy(position);
      } else {
        qTry.copy(q);
        pTry.copy(position).setComponent(p - 3, position.getComponent(p - 3) + EPS_POS);
      }
      residuals(template, weights, image, camera, qTry, pTry, priorPx, rTry);
      const eps = p < 3 ? EPS_ROT : EPS_POS;
      for (let k = 0; k < 15; k++) J[k * 6 + p] = (rTry[k] - r[k]) / eps;
    }
    // Normal equations (JᵀJ + μI) δ = −Jᵀr.
    A.fill(0);
    b.fill(0);
    for (let k = 0; k < 15; k++) {
      for (let i = 0; i < 6; i++) {
        const ji = J[k * 6 + i];
        b[i] -= ji * r[k];
        for (let j = i; j < 6; j++) A[i * 6 + j] += ji * J[k * 6 + j];
      }
    }
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < i; j++) A[i * 6 + j] = A[j * 6 + i];
      A[i * 7] *= 1 + 1e-6;
      A[i * 7] += 1e-9;
    }
    if (!solve6(A, b, delta)) return;
    axis.set(delta[0], delta[1], delta[2]);
    const angle = axis.length();
    if (angle > 0) q.premultiply(qStep.setFromAxisAngle(axis.divideScalar(angle), angle));
    position.x += delta[3];
    position.y += delta[4];
    position.z += delta[5];
    residuals(template, weights, image, camera, q, position, priorPx, r);
    if (angle < 1e-6 && Math.hypot(delta[3], delta[4], delta[5]) < 1e-7) break;
  }
}

/**
 * Where the template's points land in the image minus where they were seen
 * (12, scaled by √weight), then the rotation's departure from the prior (3).
 * Writes the reprojected points to `projected` if given.
 */
function residuals(
  template: ArrayLike<number>,
  weights: ArrayLike<number>,
  image: ArrayLike<number>,
  camera: Camera,
  q: THREE.Quaternion,
  position: THREE.Vector3,
  priorPx: number,
  out: Float64Array,
) {
  for (let k = 0; k < 6; k++) {
    v.set(template[k * 3], template[k * 3 + 1], template[k * 3 + 2]).applyQuaternion(q).add(position);
    const z = Math.max(-v.z, 1e-3);
    const sw = Math.sqrt(weights[k]);
    out[k * 2] = (camera.cx + (camera.focal * v.x) / z - image[k * 2]) * sw;
    out[k * 2 + 1] = (camera.cy - (camera.focal * v.y) / z - image[k * 2 + 1]) * sw;
  }
  // Rotation error as a rotation vector (q · prior⁻¹), in "pixels".
  qErr.multiplyQuaternions(q, qPriorInv);
  if (qErr.w < 0) qErr.set(-qErr.x, -qErr.y, -qErr.z, -qErr.w);
  const s = Math.hypot(qErr.x, qErr.y, qErr.z);
  const k = s > 1e-12 ? (2 * Math.atan2(s, qErr.w)) / s : 2;
  out[12] = qErr.x * k * priorPx;
  out[13] = qErr.y * k * priorPx;
  out[14] = qErr.z * k * priorPx;
}

/** Solves the 6×6 system a·x = y (a is overwritten); false if singular. */
function solve6(a: Float64Array, y: Float64Array, x: Float64Array): boolean {
  const m = a;
  for (let i = 0; i < 6; i++) x[i] = y[i];
  for (let col = 0; col < 6; col++) {
    let pivot = col;
    for (let row = col + 1; row < 6; row++) if (Math.abs(m[row * 6 + col]) > Math.abs(m[pivot * 6 + col])) pivot = row;
    if (Math.abs(m[pivot * 6 + col]) < 1e-18) return false;
    if (pivot !== col) {
      for (let k = 0; k < 6; k++) {
        const t = m[col * 6 + k];
        m[col * 6 + k] = m[pivot * 6 + k];
        m[pivot * 6 + k] = t;
      }
      const t = x[col];
      x[col] = x[pivot];
      x[pivot] = t;
    }
    for (let row = col + 1; row < 6; row++) {
      const f = m[row * 6 + col] / m[col * 6 + col];
      if (f === 0) continue;
      for (let k = col; k < 6; k++) m[row * 6 + k] -= f * m[col * 6 + k];
      x[row] -= f * x[col];
    }
  }
  for (let row = 5; row >= 0; row--) {
    let sum = x[row];
    for (let k = row + 1; k < 6; k++) sum -= m[row * 6 + k] * x[k];
    x[row] = sum / m[row * 6 + row];
  }
  return true;
}
