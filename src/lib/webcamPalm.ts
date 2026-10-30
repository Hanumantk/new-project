import * as THREE from 'three';
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import {
  PALM_LANDMARKS,
  PALM_WEIGHTS,
  PalmTemplate,
  REAL_PALM_WIDTH,
  canonicalPalm,
  createPalmSurface,
  fitPalmSurface,
  palmHeight,
  placeWound,
  type Vec3,
  type WoundPlacement,
} from './palmModel';
import { PalmPoseFilter, type PalmMeasurement } from './poseFilter';
import { refinePalmPose } from './palmPnP';
import { fitRotation } from './rigidFit';

/** Vertical field of view of a typical 16:9 laptop webcam (~65° horizontal). */
export const WEBCAM_VFOV_DEG = 41;

/** Focal length in video pixels for a frame `videoHeight` tall. */
export function focalPx(videoHeight: number) {
  return videoHeight / 2 / Math.tan(((WEBCAM_VFOV_DEG * Math.PI) / 180) / 2);
}

/** The palm's rigid pose in camera space (three.js axes: x right, y up, the camera looking down −z). */
export interface CameraPalm {
  valid: boolean;
  /** The canonical palm frame's origin, metres. */
  position: THREE.Vector3;
  /** Canonical palm frame → camera. */
  quaternion: THREE.Quaternion;
  /**
   * The real palm's size relative to the template's (canonical metres → world
   * metres): 1 for the webcam, which assumes an 8 cm palm; the measured hand's
   * size in a headset.
   */
  scale: number;
  /** The template the pose was fitted to (18 numbers). */
  template: Float64Array;
  templateVersion: number;
}

export function createCameraPalm(): CameraPalm {
  return {
    valid: false,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: 1,
    template: new Float64Array(18),
    templateVersion: 0,
  };
}

const JITTER_WINDOW = 1; // s

/**
 * RMS movement over the last second, in pixels, after removing steady
 * drift (a straight-line fit per axis), so slow intentional movement
 * doesn't count as jitter. Also reports how fast the point is moving.
 */
export class JitterMeter {
  private readonly t: number[] = [];
  private readonly x: number[] = [];
  private readonly y: number[] = [];
  rms = 0;
  /** Drift speed (px/s) from the same fit. */
  speed = 0;

  add(t: number, x: number, y: number) {
    this.t.push(t);
    this.x.push(x);
    this.y.push(y);
    while (this.t.length && this.t[0] < t - JITTER_WINDOW) {
      this.t.shift();
      this.x.shift();
      this.y.shift();
    }
    const n = this.t.length;
    if (n < 5) {
      this.rms = 0;
      return;
    }
    const mt = this.t.reduce((a, b) => a + b, 0) / n;
    let stt = 0;
    for (const ti of this.t) stt += (ti - mt) ** 2;
    let sum = 0;
    let speed2 = 0;
    for (const series of [this.x, this.y]) {
      const m = series.reduce((a, b) => a + b, 0) / n;
      let sty = 0;
      for (let i = 0; i < n; i++) sty += (this.t[i] - mt) * (series[i] - m);
      const slope = stt > 0 ? sty / stt : 0;
      speed2 += slope * slope;
      for (let i = 0; i < n; i++) sum += (series[i] - (m + slope * (this.t[i] - mt))) ** 2;
    }
    this.rms = Math.sqrt(sum / n);
    this.speed = Math.sqrt(speed2);
  }

  reset() {
    this.t.length = this.x.length = this.y.length = 0;
    this.rms = this.speed = 0;
  }
}

const tmpV = new THREE.Vector3();

/**
 * Webcam palm tracking: from MediaPipe's landmarks to a rigid, filtered
 * palm pose in camera space.
 *
 *  - Rotation: a least-squares rigid fit (Kabsch) of the six palm points of
 *    MediaPipe's metric world landmarks to a template captured from the
 *    first stable frames. Six points average out most per-landmark noise,
 *    and finger joints never take part.
 *  - Position: the six image points' centroid, through the camera.
 *  - Depth: from the palm's apparent size — the template, turned by that
 *    rotation and scaled to a real 8 cm palm, fitted to the six image
 *    points (so foreshortening doesn't read as distance). MediaPipe's noisy
 *    per-landmark image z isn't used.
 *  - Then pose filtering, a deadband and a lead (PalmPoseFilter).
 */
export interface PalmTrackerOptions {
  /**
   * Refine the pose against the image landmarks, with this prior on the
   * world-landmark rotation (px per radian); null: rotation from the world
   * landmarks alone.
   */
  refinePx: number | null;
  /** The point whose image position is filtered and kept exact: the wound's centre or the palm's. */
  anchor: 'wound' | 'centroid';
}

export const PALM_TRACKER: PalmTrackerOptions = { refinePx: 400, anchor: 'wound' };

export class WebcamPalmTracker {
  readonly template = new PalmTemplate();
  readonly filter: PalmPoseFilter;
  readonly pose = createCameraPalm();
  /** Image position of the wound's centre (video px), filtered and raw, for the jitter meter. */
  readonly woundPx = { x: 0, y: 0, rawX: 0, rawY: 0 };
  readonly jitter = new JitterMeter();
  readonly rawJitter = new JitterMeter();

  private readonly world: Vec3[] = PALM_LANDMARKS.map(() => ({ x: 0, y: 0, z: 0 }));
  private readonly centred = new Float64Array(18);
  private readonly frameTemplate = new Float64Array(18);
  private readonly rotated = new Float64Array(18);
  private readonly measurement: PalmMeasurement = { t: 0, u: 0, v: 0, scale: 1, q: new THREE.Quaternion() };
  private readonly surface = createPalmSurface();
  private readonly placement: WoundPlacement = { x: 0, z: 0, angle: 0 };
  private readonly woundLocal = new THREE.Vector3();
  private surfaceVersion = -1;
  private focal = 1;
  private cx = 0;
  private cy = 0;
  private videoWidth = 1;
  private videoHeight = 1;
  private readonly imagePx = new Float64Array(12);
  private readonly priorQ = new THREE.Quaternion();
  private readonly fitQ = new THREE.Quaternion();
  private readonly fitPos = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly camera = { focal: 1, cx: 0, cy: 0 };

  constructor(
    private readonly options: PalmTrackerOptions = PALM_TRACKER,
    filter = new PalmPoseFilter(),
  ) {
    this.filter = filter;
  }

  /**
   * Updates the pose from one detection.
   * @param image MediaPipe's normalised image landmarks (21).
   * @param world MediaPipe's world landmarks (21, metres, hand-centred).
   * @returns whether the pose is valid.
   */
  update(
    image: NormalizedLandmark[],
    world: Landmark[],
    videoWidth: number,
    videoHeight: number,
    isRightHand: boolean,
    t: number,
  ): boolean {
    this.focal = focalPx(videoHeight);
    this.cx = videoWidth / 2;
    this.cy = videoHeight / 2;
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;
    this.camera.focal = this.focal;
    this.camera.cx = this.cx;
    this.camera.cy = this.cy;

    // World landmarks → three.js axes (MediaPipe: y down, z away).
    for (let k = 0; k < 6; k++) {
      const p = world[PALM_LANDMARKS[k]];
      this.world[k].x = p.x;
      this.world[k].y = -p.y;
      this.world[k].z = -p.z;
    }
    if (this.template.isRightHand !== isRightHand) this.filter.reset();
    this.template.offer(this.world, isRightHand);
    let template: Float64Array;
    if (this.template.ready) template = this.template.points;
    else if (canonicalPalm(this.world, isRightHand, this.frameTemplate)) template = this.frameTemplate;
    else return (this.pose.valid = false);

    // Rotation: template → world points (both centred on their weighted centroids).
    let wsum = 0, mx = 0, my = 0, mz = 0;
    for (let k = 0; k < 6; k++) {
      const w = PALM_WEIGHTS[k];
      wsum += w;
      mx += this.world[k].x * w;
      my += this.world[k].y * w;
      mz += this.world[k].z * w;
    }
    mx /= wsum; my /= wsum; mz /= wsum;
    for (let k = 0; k < 6; k++) {
      this.centred[k * 3] = this.world[k].x - mx;
      this.centred[k * 3 + 1] = this.world[k].y - my;
      this.centred[k * 3 + 2] = this.world[k].z - mz;
    }
    const q = this.measurement.q;
    if (!fitRotation(template, this.centred, PALM_WEIGHTS, 6, q)) return (this.pose.valid = false);

    // Image centroid and apparent size: fit the turned template's x/y to the image points.
    let u = 0, v = 0;
    for (let k = 0; k < 6; k++) {
      const lm = image[PALM_LANDMARKS[k]];
      u += lm.x * videoWidth * PALM_WEIGHTS[k];
      v += lm.y * videoHeight * PALM_WEIGHTS[k];
    }
    u /= wsum;
    v /= wsum;
    let num = 0, den = 0;
    for (let k = 0; k < 6; k++) {
      tmpV.set(template[k * 3], template[k * 3 + 1], template[k * 3 + 2]).applyQuaternion(q);
      this.rotated[k * 3] = tmpV.x;
      this.rotated[k * 3 + 1] = tmpV.y;
      const lm = image[PALM_LANDMARKS[k]];
      const du = lm.x * videoWidth - u;
      const dv = lm.y * videoHeight - v;
      const w = PALM_WEIGHTS[k];
      num += w * (du * tmpV.x - dv * tmpV.y); // image y is down, camera y is up
      den += w * (tmpV.x * tmpV.x + tmpV.y * tmpV.y);
    }
    // Edge-on, the palm's outline gives no size; the wound is faded out by then anyway.
    if (!(den > (REAL_PALM_WIDTH * 0.15) ** 2) || !(num > 0)) return (this.pose.valid = false);

    // First guess (weak perspective), then fitted to the image landmarks.
    const fitQ = this.fitQ.copy(q);
    const fitPos = this.toCameraPosition(u, v, num / den, q, template, this.fitPos);
    if (this.options.refinePx !== null) {
      for (let k = 0; k < 6; k++) {
        const lm = image[PALM_LANDMARKS[k]];
        this.imagePx[k * 2] = lm.x * videoWidth;
        this.imagePx[k * 2 + 1] = lm.y * videoHeight;
      }
      this.priorQ.copy(q);
      refinePalmPose(template, PALM_WEIGHTS, this.imagePx, this.camera, this.priorQ, this.options.refinePx, fitQ, fitPos);
    }

    // The anchor (the wound's centre): its image position and depth are what's filtered.
    this.updateWoundCentre(template);
    if (this.options.anchor === 'wound') this.anchor.copy(this.woundLocal);
    else this.anchor.set(0, 0, 0);
    const a = tmpV.copy(this.anchor).applyQuaternion(fitQ).add(fitPos);
    const m = this.measurement;
    m.t = t;
    m.u = this.cx + (this.focal * a.x) / -a.z;
    m.v = this.cy - (this.focal * a.y) / -a.z;
    m.scale = this.focal / -a.z;
    m.q.copy(fitQ);

    const f = this.filter.update(m);
    this.fromAnchor(f.u, f.v, f.scale, f.q, this.pose.position);
    this.pose.quaternion.copy(f.q);
    this.pose.template.set(template);
    this.pose.templateVersion = this.template.ready ? this.template.version : -1;
    this.pose.valid = true;

    // Jitter meter: where the wound's centre lands in the image, filtered and raw.
    this.project(this.pose.position, this.pose.quaternion, this.woundLocal, this.woundPx, false);
    const rawPos = this.fromAnchor(m.u, m.v, m.scale, m.q, tmpV4);
    this.project(rawPos, m.q, this.woundLocal, this.woundPx, true);
    this.jitter.add(t, this.woundPx.x, this.woundPx.y);
    this.rawJitter.add(t, this.woundPx.rawX, this.woundPx.rawY);
    return true;
  }

  /** The palm frame's origin, given where the anchor appears (u, v) and its size (px per metre). */
  private fromAnchor(u: number, v: number, scale: number, q: THREE.Quaternion, out: THREE.Vector3) {
    const depth = this.focal / scale;
    out.set(((u - this.cx) * depth) / this.focal, (-(v - this.cy) * depth) / this.focal, -depth);
    return out.sub(tmpV5.copy(this.anchor).applyQuaternion(q));
  }

  /**
   * Where a point of the wound (wound-local x across, z along, metres, on
   * the palm surface) appears in the image (video px), with the filtered pose.
   */
  woundPointPx(x: number, z: number, out = { x: 0, y: 0 }) {
    const c = Math.cos(this.placement.angle);
    const s = Math.sin(this.placement.angle);
    const px = this.placement.x + x * c + z * s;
    const pz = this.placement.z - x * s + z * c;
    tmpV2.set(px, palmHeight(this.surface, px, pz), pz).applyQuaternion(this.pose.quaternion).add(this.pose.position);
    out.x = this.cx + (this.focal * tmpV2.x) / -tmpV2.z;
    out.y = this.cy - (this.focal * tmpV2.y) / -tmpV2.z;
    return out;
  }

  /** Forget the hand (it's gone): filters and the meters restart; the template is kept per hand. */
  lose() {
    this.filter.reset();
    this.pose.valid = false;
    this.jitter.reset();
    this.rawJitter.reset();
  }

  /**
   * All 21 joints in camera space (for occlusion, finger coverage and the
   * mesh view): each at its image point, at the palm's depth plus its metric
   * depth offset from the palm in the world landmarks. Call after `update`.
   */
  joints(image: NormalizedLandmark[], world: Landmark[], out: THREE.Vector3[]) {
    let zc = 0, wsum = 0;
    for (let k = 0; k < 6; k++) {
      zc += -world[PALM_LANDMARKS[k]].z * PALM_WEIGHTS[k];
      wsum += PALM_WEIGHTS[k];
    }
    zc /= wsum;
    const a = world[5], b = world[17];
    const width = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const scale = width > 1e-6 ? REAL_PALM_WIDTH / width : 1;
    const palmDepth = -this.pose.position.z;
    for (let i = 0; i < out.length; i++) {
      const d = Math.max(palmDepth - (-world[i].z - zc) * scale, 0.05);
      out[i].set(
        ((image[i].x * this.videoWidth - this.cx) * d) / this.focal,
        (-(image[i].y * this.videoHeight - this.cy) * d) / this.focal,
        -d,
      );
    }
  }

  /**
   * The palm frame's origin in camera space, from its image centroid (u, v)
   * and apparent size. Under perspective the centroid of the projected
   * points isn't quite the projection of the 3D centroid (nearer points
   * spread further), so the origin is nudged until the template's projected
   * centroid lands exactly on (u, v).
   */
  private toCameraPosition(
    u: number,
    v: number,
    scale: number,
    q: THREE.Quaternion,
    template: Float64Array,
    out: THREE.Vector3,
  ) {
    const depth = this.focal / scale;
    out.set(((u - this.cx) * depth) / this.focal, (-(v - this.cy) * depth) / this.focal, -depth);
    for (let iteration = 0; iteration < 2; iteration++) {
      let pu = 0, pv = 0, wsum = 0;
      for (let k = 0; k < 6; k++) {
        tmpV3.set(template[k * 3], template[k * 3 + 1], template[k * 3 + 2]).applyQuaternion(q).add(out);
        const w = PALM_WEIGHTS[k];
        pu += w * (this.cx + (this.focal * tmpV3.x) / -tmpV3.z);
        pv += w * (this.cy - (this.focal * tmpV3.y) / -tmpV3.z);
        wsum += w;
      }
      out.x += ((u - pu / wsum) * -out.z) / this.focal;
      out.y -= ((v - pv / wsum) * -out.z) / this.focal;
    }
    return out;
  }

  /** The wound's centre on the palm surface, canonical coordinates. */
  private updateWoundCentre(template: Float64Array) {
    const version = this.template.ready ? this.template.version : -1;
    if (version !== this.surfaceVersion || version === -1) {
      fitPalmSurface(template, this.surface);
      placeWound(template, this.placement);
      this.surfaceVersion = version;
    }
    const { x, z } = this.placement;
    this.woundLocal.set(x, palmHeight(this.surface, x, z), z);
  }

  private project(
    position: THREE.Vector3,
    q: THREE.Quaternion,
    local: THREE.Vector3,
    out: { x: number; y: number; rawX: number; rawY: number },
    raw: boolean,
  ) {
    const p = tmpV2.copy(local).applyQuaternion(q).add(position);
    const x = this.cx + (this.focal * p.x) / -p.z;
    const y = this.cy - (this.focal * p.y) / -p.z;
    if (raw) {
      out.rawX = x;
      out.rawY = y;
    } else {
      out.x = x;
      out.y = y;
    }
  }
}

const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpV4 = new THREE.Vector3();
const tmpV5 = new THREE.Vector3();
