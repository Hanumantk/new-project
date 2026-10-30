import * as THREE from 'three';
import { OneEuroFilter, type OneEuroParams } from './oneEuroFilter';
import { REAL_PALM_WIDTH } from './palmModel';

/**
 * Smoothing of the palm's pose (not of individual landmarks): its image
 * position, its apparent size (= depth) and its rotation each get their own
 * filter, then a deadband holds it perfectly still while the hand is.
 */

/** Image position of the palm, in video pixels. */
export const POSITION_FILTER: OneEuroParams = { minCutoff: 1.2, beta: 0.03, dCutoff: 1 };
/**
 * Apparent size (log of pixels per metre): real hands never change size, so
 * this is smoothed hard; it still follows the hand moving nearer or further.
 */
export const SCALE_FILTER: OneEuroParams = { minCutoff: 0.3, beta: 4, dCutoff: 1 };
/** Rotation: cutoff in Hz, beta per rad/s of turning. */
export const ROTATION_FILTER: OneEuroParams = { minCutoff: 0.5, beta: 3, dCutoff: 1 };
/** Changes smaller than this (video pixels, as seen on the wound) are ignored while still. */
export const DEADBAND_PX = 0.3;
/** Longest the pose is extrapolated to cancel the smoothing's lag (s). */
export const MAX_LEAD = 0.02;
/** Distance from the palm centre at which a rotation is measured for the deadband (m). */
const ROTATION_ARM = 0.03;

export interface PalmMeasurement {
  /** Seconds. */
  t: number;
  /** Image position of the palm's centroid, video pixels. */
  u: number;
  v: number;
  /** Apparent size: video pixels per metre at the palm. */
  scale: number;
  /** Palm rotation (canonical → camera). */
  q: THREE.Quaternion;
}

export interface PoseFilterParams {
  position: OneEuroParams;
  scale: OneEuroParams;
  rotation: OneEuroParams;
  deadbandPx: number;
  maxLead: number;
}

export const POSE_FILTER: PoseFilterParams = {
  position: POSITION_FILTER,
  scale: SCALE_FILTER,
  rotation: ROTATION_FILTER,
  deadbandPx: DEADBAND_PX,
  maxLead: MAX_LEAD,
};

export interface FilteredPalm {
  u: number;
  v: number;
  scale: number;
  q: THREE.Quaternion;
}

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * One Euro filter for a rotation: the cutoff rises with the angular speed.
 * The angular velocity is smoothed as a vector (axis × rate), so frame-to-
 * frame noise, which points every which way, averages out instead of
 * reading as steady turning.
 */
export class QuaternionOneEuro {
  readonly value = new THREE.Quaternion();
  private readonly omega = new THREE.Vector3();
  private t = 0;
  private initialised = false;
  private readonly target = new THREE.Quaternion();
  private readonly delta = new THREE.Quaternion();

  constructor(private readonly params: OneEuroParams = ROTATION_FILTER) {}

  filter(q: THREE.Quaternion, t: number): THREE.Quaternion {
    if (!this.initialised) {
      this.value.copy(q);
      this.t = t;
      this.omega.set(0, 0, 0);
      this.initialised = true;
      return this.value;
    }
    const dt = t - this.t;
    if (!(dt > 0)) return this.value;
    this.t = t;
    // Same hemisphere, so slerp takes the short way.
    this.target.copy(q);
    if (this.value.dot(this.target) < 0) this.target.set(-q.x, -q.y, -q.z, -q.w);
    // Rotation from the current estimate to the new reading, as axis × angle / dt.
    this.delta.copy(this.value).invert().premultiply(this.target);
    if (this.delta.w < 0) this.delta.set(-this.delta.x, -this.delta.y, -this.delta.z, -this.delta.w);
    const s = Math.hypot(this.delta.x, this.delta.y, this.delta.z);
    const rate = s > 1e-12 ? (2 * Math.atan2(s, this.delta.w)) / (s * dt) : 0;
    const a = alpha(this.params.dCutoff, dt);
    this.omega.x += a * (this.delta.x * rate - this.omega.x);
    this.omega.y += a * (this.delta.y * rate - this.omega.y);
    this.omega.z += a * (this.delta.z * rate - this.omega.z);
    const cutoff = this.params.minCutoff + this.params.beta * this.omega.length();
    this.value.slerp(this.target, alpha(cutoff, dt));
    return this.value;
  }

  reset() {
    this.initialised = false;
  }
}

/**
 * The palm pose filter: One Euro on position (with a short lead that cancels
 * its lag), a heavier one on size, an adaptive slerp on rotation, then a
 * deadband in pixels so the output doesn't move at all while the hand is still.
 */
export class PalmPoseFilter {
  readonly out: FilteredPalm = { u: 0, v: 0, scale: 1, q: new THREE.Quaternion() };
  private readonly u: OneEuroFilter;
  private readonly v: OneEuroFilter;
  private readonly logScale: OneEuroFilter;
  private readonly rotation: QuaternionOneEuro;
  private started = false;

  constructor(private readonly params: PoseFilterParams = POSE_FILTER) {
    this.u = new OneEuroFilter(params.position);
    this.v = new OneEuroFilter(params.position);
    this.logScale = new OneEuroFilter(params.scale);
    this.rotation = new QuaternionOneEuro(params.rotation);
  }

  update(m: PalmMeasurement): FilteredPalm {
    const fu = this.u.filter(m.u, m.t);
    const fv = this.v.filter(m.v, m.t);
    const fs = Math.exp(this.logScale.filter(Math.log(m.scale), m.t));
    const fq = this.rotation.filter(m.q, m.t);

    // Lead: the smoothed position trails a moving hand by about its filter's
    // time constant; step each axis forward along its velocity by that much (≤ 20 ms).
    const { deadbandPx, maxLead } = this.params;
    const pu = fu + this.u.velocity * Math.min(this.u.lag, maxLead);
    const pv = fv + this.v.velocity * Math.min(this.v.lag, maxLead);

    const o = this.out;
    if (!this.started) {
      o.u = pu;
      o.v = pv;
      o.scale = fs;
      o.q.copy(fq);
      this.started = true;
      return o;
    }
    // Deadband: ignore sub-0.3 px changes of each part of the pose.
    if (Math.hypot(pu - o.u, pv - o.v) >= deadbandPx) {
      o.u = pu;
      o.v = pv;
    }
    if (Math.abs(fs - o.scale) * (REAL_PALM_WIDTH / 2) >= deadbandPx) o.scale = fs;
    const angle = 2 * Math.acos(Math.min(1, Math.abs(o.q.dot(fq))));
    if (angle * ROTATION_ARM * fs >= deadbandPx) o.q.copy(fq);
    return o;
  }

  reset() {
    this.u.reset();
    this.v.reset();
    this.logScale.reset();
    this.rotation.reset();
    this.started = false;
  }
}
