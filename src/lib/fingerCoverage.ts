import * as THREE from 'three';
import { FINGER_BONES, FINGER_RADIUS } from './handOccluder';

/**
 * How much of the wound the fingers hide, as seen by the camera: the share
 * of sample points on the wound that fall inside a finger's outline on
 * screen, with that finger in front of the palm there.
 *
 * When fingers curl or point towards the camera, the invisible finger
 * stand-ins can't follow the real fingers' outlines closely enough, so the
 * wound would show as slivers between and over the fingers. Above a certain
 * coverage it's better to fade the whole wound out.
 */
export class FingerCoverage {
  private readonly jointX = new Float32Array(21);
  private readonly jointY = new Float32Array(21);
  private readonly jointDepth = new Float32Array(21);
  private readonly jointRadius = new Float32Array(21);
  private readonly v = new THREE.Vector3();

  /**
   * @param samples   Number of sample points, read through `sampleAt`.
   * @param sampleAt  Writes the i-th sample point (world space) into `out`.
   * @param joints    The 21 hand joints in world space.
   * @param camera    The (perspective) camera the scene is rendered with.
   * @param viewWidth, viewHeight  Size of the view in pixels.
   * @param handScale Hand size relative to a typical palm (scales finger width).
   * @returns Fraction of samples hidden behind fingers, 0..1.
   */
  measure(
    samples: number,
    sampleAt: (i: number, out: THREE.Vector3) => THREE.Vector3,
    joints: THREE.Vector3[],
    camera: THREE.PerspectiveCamera,
    viewWidth: number,
    viewHeight: number,
    handScale: number,
  ): number {
    if (samples === 0) return 0;
    // Pixels per metre at 1 m from the camera.
    const focalPx = (camera.projectionMatrix.elements[5] * viewHeight) / 2;
    const radius = FINGER_RADIUS * handScale;
    for (let j = 0; j < joints.length; j++) {
      const depth = this.toScreen(joints[j], camera, viewWidth, viewHeight);
      this.jointX[j] = this.v.x;
      this.jointY[j] = this.v.y;
      this.jointDepth[j] = depth;
      this.jointRadius[j] = depth > 0 ? (radius * focalPx) / depth : 0;
    }

    // A finger only hides the wound if it's in front of it (with a little slack).
    const slack = 0.005 * handScale;
    let covered = 0;
    for (let i = 0; i < samples; i++) {
      const depth = this.toScreen(sampleAt(i, this.v), camera, viewWidth, viewHeight);
      const x = this.v.x;
      const y = this.v.y;
      for (const [a, b] of FINGER_BONES) {
        const ax = this.jointX[a];
        const ay = this.jointY[a];
        const dx = this.jointX[b] - ax;
        const dy = this.jointY[b] - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / len2, 0), 1) : 0;
        const r = this.jointRadius[a] + (this.jointRadius[b] - this.jointRadius[a]) * t;
        const fingerDepth = this.jointDepth[a] + (this.jointDepth[b] - this.jointDepth[a]) * t;
        const ex = x - (ax + dx * t);
        const ey = y - (ay + dy * t);
        if (ex * ex + ey * ey <= r * r && fingerDepth <= depth + slack) {
          covered++;
          break;
        }
      }
    }
    return covered / samples;
  }

  /** Projects `p` into this.v as pixel coordinates; returns its depth in front of the camera. */
  private toScreen(p: THREE.Vector3, camera: THREE.PerspectiveCamera, width: number, height: number) {
    this.v.copy(p).applyMatrix4(camera.matrixWorldInverse);
    const depth = -this.v.z;
    this.v.applyMatrix4(camera.projectionMatrix);
    this.v.set(((this.v.x + 1) / 2) * width, ((1 - this.v.y) / 2) * height, 0);
    return depth;
  }
}
