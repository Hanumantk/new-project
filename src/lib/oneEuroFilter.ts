import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

/**
 * One Euro Filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass filter
 * whose cutoff rises with the signal's speed. At rest it smooths hard
 * (removing jitter); during fast motion it opens up (removing lag).
 *
 *   cutoff = minCutoff + beta * |smoothed derivative|
 *
 * `beta` is in the signal's units, so it has to match their scale: the
 * landmark filter below works in video pixels, where the classic values
 * (minCutoff 1 Hz, beta ~0.01–0.05) behave as intended.
 */
export interface OneEuroParams {
  /** Cutoff at rest, in Hz. Lower = steadier but laggier when still. */
  minCutoff: number;
  /** How quickly the cutoff opens with speed (per unit/s). Higher = less lag. */
  beta: number;
  /** Cutoff for the derivative estimate, in Hz. */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.0, beta: 0.02, dCutoff: 1.0 };

/** Smoothing factor of a first-order low-pass at `cutoff` Hz over `dt` seconds. */
function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private x = 0;
  private dx = 0;
  private t = 0;
  private lastCutoff = 0;
  private initialised = false;

  constructor(private readonly params: OneEuroParams = DEFAULT_ONE_EURO) {}

  /** Filters `value` sampled at `timeSeconds`; returns the smoothed value. */
  filter(value: number, timeSeconds: number): number {
    if (!this.initialised) {
      this.x = value;
      this.dx = 0;
      this.t = timeSeconds;
      this.initialised = true;
      return value;
    }
    const dt = timeSeconds - this.t;
    // Repeated or out-of-order timestamps carry no new timing information.
    if (!(dt > 0)) return this.x;
    this.t = timeSeconds;

    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.lastCutoff = cutoff;
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  /** The smoothed rate of change (units per second). */
  get velocity() {
    return this.dx;
  }

  /**
   * How far the output trails a steadily moving input (s): the time constant
   * of the low-pass at the current cutoff.
   */
  get lag() {
    return this.lastCutoff > 0 ? 1 / (2 * Math.PI * this.lastCutoff) : 0;
  }

  reset() {
    this.initialised = false;
    this.dx = 0;
    this.lastCutoff = 0;
  }
}

/**
 * One Euro Filter on every coordinate of a hand's 21 landmarks. Filtering
 * runs in video pixels (x × width, y × height, z × width, MediaPipe's z
 * using the same scale as x) so `beta` means the same along every axis.
 * Output landmark objects are reused between calls.
 */
export class LandmarkFilter {
  private readonly filters: OneEuroFilter[];
  private readonly out: NormalizedLandmark[];

  constructor(count = 21, params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.filters = Array.from({ length: count * 3 }, () => new OneEuroFilter(params));
    this.out = Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  }

  filter(
    landmarks: NormalizedLandmark[],
    timeSeconds: number,
    videoWidth: number,
    videoHeight: number,
  ): NormalizedLandmark[] {
    for (let i = 0; i < this.out.length; i++) {
      const lm = landmarks[i];
      const o = this.out[i];
      const f = i * 3;
      o.x = this.filters[f].filter(lm.x * videoWidth, timeSeconds) / videoWidth;
      o.y = this.filters[f + 1].filter(lm.y * videoHeight, timeSeconds) / videoHeight;
      o.z = this.filters[f + 2].filter(lm.z * videoWidth, timeSeconds) / videoWidth;
      o.visibility = lm.visibility;
    }
    return this.out;
  }

  reset() {
    for (const f of this.filters) f.reset();
  }
}
