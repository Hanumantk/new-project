import type * as THREE from 'three';
import { PALM_LANDMARKS, PALM_WEIGHTS, PalmTemplate, REAL_PALM_WIDTH, canonicalPalm, type Vec3 } from './palmModel';
import { fitRotation } from './rigidFit';
import type { CameraPalm } from './webcamPalm';

/**
 * The palm as a rigid body from 3D hand joints that are already metric and
 * smooth (a headset's own hand tracking): the same template + Kabsch fit as
 * the webcam, positioned at the joints' weighted centroid.
 */
export class JointPalmFitter {
  readonly template = new PalmTemplate();
  private readonly pts: Vec3[] = PALM_LANDMARKS.map(() => ({ x: 0, y: 0, z: 0 }));
  private readonly centred = new Float64Array(18);
  private readonly frame = new Float64Array(18);

  update(joints: readonly THREE.Vector3[], isRightHand: boolean, out: CameraPalm): boolean {
    let wsum = 0, mx = 0, my = 0, mz = 0;
    for (let k = 0; k < 6; k++) {
      const j = joints[PALM_LANDMARKS[k]];
      const w = PALM_WEIGHTS[k];
      this.pts[k].x = j.x;
      this.pts[k].y = j.y;
      this.pts[k].z = j.z;
      wsum += w;
      mx += j.x * w;
      my += j.y * w;
      mz += j.z * w;
    }
    mx /= wsum; my /= wsum; mz /= wsum;
    this.template.offer(this.pts, isRightHand);
    let template: Float64Array;
    if (this.template.ready) template = this.template.points;
    else if (canonicalPalm(this.pts, isRightHand, this.frame)) template = this.frame;
    else return (out.valid = false);
    for (let k = 0; k < 6; k++) {
      this.centred[k * 3] = this.pts[k].x - mx;
      this.centred[k * 3 + 1] = this.pts[k].y - my;
      this.centred[k * 3 + 2] = this.pts[k].z - mz;
    }
    if (!fitRotation(template, this.centred, PALM_WEIGHTS, 6, out.quaternion)) return (out.valid = false);
    out.position.set(mx, my, mz);
    out.scale = joints[5].distanceTo(joints[17]) / REAL_PALM_WIDTH;
    if (out.templateVersion !== this.template.version || !this.template.ready) {
      out.template.set(template);
      out.templateVersion = this.template.ready ? this.template.version : -1;
    }
    return (out.valid = true);
  }
}
