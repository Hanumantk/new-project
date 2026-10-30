import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { PALM_LANDMARKS, canonicalPalm } from './palmModel';
import { rightPalm } from './palmFixtures';
import { WebcamPalmTracker, focalPx } from './webcamPalm';

const W = 1280;
const H = 720;
const F = focalPx(H);

let seed = 11;
/** Gaussian noise (Box–Muller) from a fixed-seed generator. */
function gauss() {
  const u = ((seed = (seed * 16807) % 2147483647) / 2147483647) || 1e-9;
  const v = (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** What MediaPipe would report for a palm at `position` turned by `q`, with noise. */
function detect(position: THREE.Vector3, q: THREE.Quaternion, pxNoise = 1, worldNoise = 0.002) {
  const palm = rightPalm();
  const image: NormalizedLandmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  const world: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  PALM_LANDMARKS.forEach((lm, k) => {
    const local = palm[k].clone().applyQuaternion(q);
    const p = local.clone().add(position);
    image[lm] = {
      x: (W / 2 + (F * p.x) / -p.z + gauss() * pxNoise) / W,
      y: (H / 2 - (F * p.y) / -p.z + gauss() * pxNoise) / H,
      z: 0,
      visibility: 1,
    };
    // MediaPipe world axes: y down, z away from the camera.
    world[lm] = { x: local.x + gauss() * worldNoise, y: -(local.y + gauss() * worldNoise), z: -(local.z + gauss() * worldNoise), visibility: 1 };
  });
  return { image, world };
}

/** Where the true canonical palm frame's origin lands in the image. */
function trueOriginPx(position: THREE.Vector3, q: THREE.Quaternion) {
  const pts = rightPalm().map((p) => p.applyQuaternion(q).add(position));
  const c = new THREE.Vector3();
  const w = [1, 0.5, 1, 1, 1, 1];
  pts.forEach((p, k) => c.addScaledVector(p, w[k]));
  c.divideScalar(5.5);
  return { x: W / 2 + (F * c.x) / -c.z, y: H / 2 - (F * c.y) / -c.z, depth: -c.z };
}

const qFacing = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, -0.2, 0.05));

describe('WebcamPalmTracker', () => {
  it('holds still to well under half a pixel while the raw pose jitters', () => {
    const tracker = new WebcamPalmTracker();
    const pos = new THREE.Vector3(0.02, -0.01, -0.45);
    for (let i = 0; i < 120; i++) {
      const { image, world } = detect(pos, qFacing);
      tracker.update(image, world, W, H, true, i / 30);
    }
    expect(tracker.template.ready).toBe(true);
    expect(tracker.rawJitter.rms).toBeGreaterThan(1);
    expect(tracker.jitter.rms).toBeLessThan(0.5);
  });

  it('finds the palm where it is: depth from its size, not from image z', () => {
    const tracker = new WebcamPalmTracker();
    const pos = new THREE.Vector3(-0.03, 0.02, -0.6);
    for (let i = 0; i < 60; i++) {
      const { image, world } = detect(pos, qFacing, 0.3, 0.0005);
      tracker.update(image, world, W, H, true, i / 30);
    }
    const truth = trueOriginPx(pos, qFacing);
    const p = tracker.pose.position;
    // rightPalm() is a 7 cm palm; the tracker assumes 8 cm, so depth reads 8/7 too far.
    const width = rightPalm()[2].distanceTo(rightPalm()[5]);
    expect(-p.z).toBeCloseTo((truth.depth * 0.08) / width, 2);
    expect(W / 2 + (F * p.x) / -p.z).toBeCloseTo(truth.x, 0);
    expect(H / 2 - (F * p.y) / -p.z).toBeCloseTo(truth.y, 0);
    // Orientation: the canonical frame of the true points, in the camera.
    const truePts = rightPalm().map((pt) => pt.applyQuaternion(qFacing));
    const canon = new Float64Array(18);
    canonicalPalm(truePts, true, canon);
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(tracker.pose.quaternion);
    const trueNormal = new THREE.Vector3()
      .crossVectors(truePts[2].clone().sub(truePts[0]), truePts[5].clone().sub(truePts[0]))
      .normalize();
    expect(normal.angleTo(trueNormal)).toBeLessThan(0.03);
  });

  it('keeps up with a fast-moving hand (no trailing)', () => {
    const tracker = new WebcamPalmTracker();
    let worst = 0;
    for (let i = 0; i < 150; i++) {
      const t = i / 30;
      // Still for 2 s, then sweeping sideways at ~0.4 m/s (~700 px/s).
      const x = t < 2 ? 0 : (t - 2) * 0.4 - 0.2 * Math.max(0, t - 3.5);
      const pos = new THREE.Vector3(x - 0.15, 0, -0.45);
      const { image, world } = detect(pos, qFacing, 0.5, 0.001);
      tracker.update(image, world, W, H, true, t);
      if (t > 2.3 && t < 3.4) {
        const truth = trueOriginPx(pos, qFacing);
        const p = tracker.pose.position;
        worst = Math.max(worst, Math.abs(W / 2 + (F * p.x) / -p.z - truth.x));
      }
    }
    // One frame of motion at this speed is ~23 px; the lead keeps the error to a few px.
    expect(worst).toBeLessThan(6);
  });

  it('stays on the palm while the hand turns', () => {
    const tracker = new WebcamPalmTracker();
    const pos = new THREE.Vector3(0, 0, -0.45);
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      const t = i / 30;
      // Still for 2 s, then turning about the palm's normal at ~1.5 rad/s.
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), t < 2 ? 0 : (t - 2) * 1.5).multiply(qFacing);
      const { image, world } = detect(pos, q, 0.5, 0.001);
      tracker.update(image, world, W, H, true, t);
      if (t > 2.4) {
        // A point 3 cm from the palm centre, as the tracker places it vs. where it truly is.
        const arm = new THREE.Vector3(0.03, 0, 0);
        const truePts = rightPalm().map((p) => p.applyQuaternion(q));
        const canon = new Float64Array(18);
        canonicalPalm(truePts, true, canon);
        const got = arm.clone().applyQuaternion(tracker.pose.quaternion).add(tracker.pose.position);
        // True: same canonical point through the true frame (template ≈ truth at this noise).
        const trueQ = new THREE.Quaternion();
        const trueFrame = new THREE.Matrix4();
        const n = new THREE.Vector3().crossVectors(truePts[2].clone().sub(truePts[0]), truePts[5].clone().sub(truePts[0])).normalize();
        const zAxis = truePts[3].clone().sub(truePts[0]);
        zAxis.addScaledVector(n, -zAxis.dot(n)).normalize();
        trueFrame.makeBasis(new THREE.Vector3().crossVectors(n, zAxis), n, zAxis);
        trueQ.setFromRotationMatrix(trueFrame);
        const width = truePts[2].distanceTo(truePts[5]);
        const truth = arm.clone().multiplyScalar(width / 0.08).applyQuaternion(trueQ);
        const origin = trueOriginPx(pos, q);
        const px = (p: THREE.Vector3) => W / 2 + (F * p.x) / -p.z;
        const gotPx = px(got);
        const truePx = origin.x + (px(truth.clone().add(new THREE.Vector3(0, 0, -origin.depth))) - W / 2);
        worst = Math.max(worst, Math.abs(gotPx - truePx));
      }
    }
    expect(worst).toBeLessThan(6);
  });

  it('ignores the fingers entirely', () => {
    const a = new WebcamPalmTracker();
    const b = new WebcamPalmTracker();
    for (let i = 0; i < 40; i++) {
      seed = 100 + i;
      const d1 = detect(new THREE.Vector3(0, 0, -0.45), qFacing);
      seed = 100 + i;
      const d2 = detect(new THREE.Vector3(0, 0, -0.45), qFacing);
      // Wiggle every finger joint in b's input.
      for (let lm = 0; lm < 21; lm++) {
        if ((PALM_LANDMARKS as readonly number[]).includes(lm)) continue;
        d2.image[lm] = { x: Math.random(), y: Math.random(), z: Math.random(), visibility: 1 };
        d2.world[lm] = { x: Math.random(), y: Math.random(), z: Math.random(), visibility: 1 };
      }
      a.update(d1.image, d1.world, W, H, true, i / 30);
      b.update(d2.image, d2.world, W, H, true, i / 30);
    }
    expect(b.pose.position.distanceTo(a.pose.position)).toBe(0);
    expect(b.pose.quaternion.equals(a.pose.quaternion)).toBe(true);
  });
});
