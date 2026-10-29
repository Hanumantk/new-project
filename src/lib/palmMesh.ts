import * as THREE from 'three';
import { INJURY_PATCH_SIZE } from './injury/generateInjury';

/**
 * A grid of vertices laid over the palm and rebuilt from the hand landmarks
 * every frame, so the wound bends, stretches and foreshortens with the hand.
 *
 * Palm space: s runs across the palm (−1 thumb/index side → +1 pinky side),
 * t along it (−1 wrist → +1 knuckles). A vertex at (s, t) blends between
 *   - the wrist row: thumb base (1) at s=−1, wrist (0) at s=0, and the heel
 *     of the hand at s=+1 (landmark 1 mirrored across the 0→9 axis), and
 *   - the knuckle row: index (5), middle (9), ring (13), pinky (17) knuckles
 *     at s = −1, −⅓, ⅓, 1,
 * using smooth (Lagrange) curves along s, so it follows the landmarks' 3D
 * positions, including MediaPipe's depth. A slight bow pushes the middle
 * into the palm for its natural cup.
 */

/** Cells per side; the grid has (GRID + 1)² vertices. */
export const PALM_GRID = 32;
/** How far the grid reaches past the index / pinky knuckle lines (palm edges). */
export const PALM_S_EXTENT = 1.15;
/** Depth of the palm's cup at its centre, for a 9 cm palm, in metres. */
const CUP_DEPTH = 0.004;
/** Lift above the joints so the wound sits on the skin, for a 9 cm palm, in metres. */
const SKIN_LIFT = 0.0015;
/** Typical adult wrist → middle-finger knuckle distance, in metres. */
export const REAL_PALM_LENGTH = 0.09;

/**
 * Wound texture placement in palm space: a fixed mapping, so the wound
 * stretches with the hand rather than sliding over it. Millimetres per unit
 * of s and t on a typical palm (65 mm knuckle span, 90 mm wrist→knuckles).
 */
const MM_PER_S = 32.5;
const MM_PER_T = 45;
/** Wound centre: halfway between the wrist (s=0, t=−1) and middle knuckle (s=−⅓, t=1). */
const WOUND_CENTRE_S = -1 / 6;
const WOUND_CENTRE_T = 0;
/**
 * Extra rotation of the wound in the palm. The texture's cut already runs
 * diagonally, from below the index knuckle towards the heel of the hand.
 */
const WOUND_ANGLE = 0;
/** Wound size relative to the designed texture patch (a 7 cm square). */
export const INJURY_SIZE = 1.3;

const N = PALM_GRID + 1;
const WRIST = 0;
const THUMB_BASE = 1;
const INDEX = 5;
const MIDDLE = 9;
const RING = 13;
const PINKY = 17;

/** Lagrange basis weights for a quadratic through s = −1, 0, 1. */
function quadWeights(s: number, out: number[]) {
  out[0] = (s * (s - 1)) / 2;
  out[1] = (1 - s) * (1 + s);
  out[2] = (s * (s + 1)) / 2;
}

/** Lagrange basis weights for a cubic through s = −1, −⅓, ⅓, 1. */
function cubicWeights(s: number, out: number[]) {
  const a = -1;
  const b = -1 / 3;
  const c = 1 / 3;
  const d = 1;
  out[0] = ((s - b) * (s - c) * (s - d)) / ((a - b) * (a - c) * (a - d));
  out[1] = ((s - a) * (s - c) * (s - d)) / ((b - a) * (b - c) * (b - d));
  out[2] = ((s - a) * (s - b) * (s - d)) / ((c - a) * (c - b) * (c - d));
  out[3] = ((s - a) * (s - b) * (s - c)) / ((d - a) * (d - b) * (d - c));
}

export class PalmMesh {
  readonly geometry = new THREE.BufferGeometry();
  /** Palm centre used for the wound: midway between the wrist and middle knuckle, on the skin. */
  readonly centre = new THREE.Vector3();
  /** Unit palm normal, out of the palm: (5−0)×(17−0), flipped for left hands. */
  readonly normal = new THREE.Vector3();
  /** Palm length relative to a typical 9 cm palm. */
  handScale = 1;

  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly indexFront: THREE.BufferAttribute;
  private readonly indexBack: THREE.BufferAttribute;
  // Per-column blend weights, precomputed for the fixed grid.
  private readonly quad: Float32Array;
  private readonly cubic: Float32Array;
  // Scratch, reused every update.
  private readonly heel = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly bottom = new THREE.Vector3();
  private readonly top = new THREE.Vector3();
  private readonly du = new THREE.Vector3();
  private readonly dv = new THREE.Vector3();
  private readonly w = [0, 0, 0, 0];

  constructor() {
    const count = N * N;
    this.positions = new Float32Array(count * 3);
    this.normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const grid = new Float32Array(count * 2);
    this.quad = new Float32Array(N * 3);
    this.cubic = new Float32Array(N * 4);

    const patchMm = INJURY_PATCH_SIZE * 1000 * INJURY_SIZE;
    const cos = Math.cos(WOUND_ANGLE);
    const sin = Math.sin(WOUND_ANGLE);
    for (let j = 0; j < N; j++) {
      const t = -1 + (2 * j) / PALM_GRID;
      for (let i = 0; i < N; i++) {
        const s = PalmMesh.sAt(i);
        const k = j * N + i;
        // Texture millimetres: +X towards the pinky side, +Y towards the wrist.
        const x = (s - WOUND_CENTRE_S) * MM_PER_S;
        const y = -(t - WOUND_CENTRE_T) * MM_PER_T;
        uvs[k * 2] = (x * cos - y * sin) / patchMm + 0.5;
        uvs[k * 2 + 1] = (x * sin + y * cos) / patchMm + 0.5;
        grid[k * 2] = s / PALM_S_EXTENT;
        grid[k * 2 + 1] = t;
      }
    }
    for (let i = 0; i < N; i++) {
      quadWeights(PalmMesh.sAt(i), this.w);
      this.quad.set(this.w.slice(0, 3), i * 3);
      cubicWeights(PalmMesh.sAt(i), this.w);
      this.cubic.set(this.w, i * 4);
    }

    // Two windings, so faces can always point out of the palm whichever hand.
    const front = new Uint16Array(PALM_GRID * PALM_GRID * 6);
    const back = new Uint16Array(PALM_GRID * PALM_GRID * 6);
    let o = 0;
    for (let j = 0; j < PALM_GRID; j++) {
      for (let i = 0; i < PALM_GRID; i++) {
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        front.set([a, b, d, a, d, c], o);
        back.set([a, d, b, a, c, d], o);
        o += 6;
      }
    }
    this.indexFront = new THREE.BufferAttribute(front, 1);
    this.indexBack = new THREE.BufferAttribute(back, 1);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    /** Normalised palm coordinates (s / extent, t), for feathering the edges. */
    this.geometry.setAttribute('gridCoord', new THREE.BufferAttribute(grid, 2));
    this.geometry.setIndex(this.indexFront);
  }

  /** Palm-space s of grid column i. */
  static sAt(i: number) {
    return (-1 + (2 * i) / PALM_GRID) * PALM_S_EXTENT;
  }

  /**
   * Rebuilds the grid on the hand.
   * @param joints  21 landmarks in world space (MediaPipe order).
   * @param surfaceOffset  Extra lift from the joints to the skin, in metres.
   * @returns false if the palm is degenerate (e.g. seen exactly edge-on).
   */
  update(joints: THREE.Vector3[], isRightHand: boolean, surfaceOffset = 0): boolean {
    const wrist = joints[WRIST];
    this.normal
      .crossVectors(this.v.subVectors(joints[INDEX], wrist), this.du.subVectors(joints[PINKY], wrist));
    if (this.normal.lengthSq() < 1e-12) return false;
    this.normal.normalize();
    if (!isRightHand) this.normal.negate();

    const palmLength = wrist.distanceTo(joints[MIDDLE]);
    if (palmLength < 1e-6) return false;
    this.handScale = palmLength / REAL_PALM_LENGTH;

    // Heel of the hand: the thumb base rotated half a turn about the 0→9 axis.
    this.axis.subVectors(joints[MIDDLE], wrist).normalize();
    this.v.subVectors(joints[THUMB_BASE], wrist);
    const along = this.v.dot(this.axis);
    this.heel.copy(this.axis).multiplyScalar(2 * along).sub(this.v).add(wrist);

    const cup = CUP_DEPTH * this.handScale;
    const lift = surfaceOffset + SKIN_LIFT * this.handScale;
    const p = this.positions;
    const n = this.normal;
    for (let i = 0; i < N; i++) {
      const q = i * 3;
      const c = i * 4;
      this.bottom
        .set(0, 0, 0)
        .addScaledVector(joints[THUMB_BASE], this.quad[q])
        .addScaledVector(wrist, this.quad[q + 1])
        .addScaledVector(this.heel, this.quad[q + 2]);
      this.top
        .set(0, 0, 0)
        .addScaledVector(joints[INDEX], this.cubic[c])
        .addScaledVector(joints[MIDDLE], this.cubic[c + 1])
        .addScaledVector(joints[RING], this.cubic[c + 2])
        .addScaledVector(joints[PINKY], this.cubic[c + 3]);
      const sn = PalmMesh.sAt(i) / PALM_S_EXTENT;
      for (let j = 0; j < N; j++) {
        const t = -1 + (2 * j) / PALM_GRID;
        const k = (j * N + i) * 3;
        const blend = (t + 1) / 2;
        const bow = cup * (1 - sn * sn) * (1 - t * t);
        this.v.lerpVectors(this.bottom, this.top, blend).addScaledVector(n, lift - bow);
        p[k] = this.v.x;
        p[k + 1] = this.v.y;
        p[k + 2] = this.v.z;
      }
    }

    this.computeNormals();
    // Face winding follows the hand's handedness in world space; pick the
    // one whose faces point out of the palm so front faces stay visible.
    this.du.fromArray(p, 3).sub(this.v.fromArray(p, 0));
    this.dv.fromArray(p, N * 3).sub(this.v);
    const facesOut = this.du.cross(this.dv).dot(n) > 0;
    const wanted = facesOut ? this.indexFront : this.indexBack;
    if (this.geometry.index !== wanted) this.geometry.setIndex(wanted);

    this.centre.lerpVectors(wrist, joints[MIDDLE], 0.5).addScaledVector(n, surfaceOffset);

    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    return true;
  }

  /** World position of grid vertex (i, j), for tests and debugging. */
  vertex(i: number, j: number, out = new THREE.Vector3()) {
    return out.fromArray(this.positions, (j * N + i) * 3);
  }

  /** Vertex normals from central differences across the grid, facing out of the palm. */
  private computeNormals() {
    const p = this.positions;
    const out = this.normals;
    const n = this.normal;
    for (let j = 0; j < N; j++) {
      const j0 = Math.max(j - 1, 0);
      const j1 = Math.min(j + 1, PALM_GRID);
      for (let i = 0; i < N; i++) {
        const i0 = Math.max(i - 1, 0);
        const i1 = Math.min(i + 1, PALM_GRID);
        this.du.fromArray(p, (j * N + i1) * 3).sub(this.v.fromArray(p, (j * N + i0) * 3));
        this.dv.fromArray(p, (j1 * N + i) * 3).sub(this.v.fromArray(p, (j0 * N + i) * 3));
        this.du.cross(this.dv).normalize();
        if (this.du.dot(n) < 0) this.du.negate();
        this.du.toArray(out, (j * N + i) * 3);
      }
    }
  }
}
