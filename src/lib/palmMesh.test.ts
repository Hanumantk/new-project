import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { INJURY_SIZE, PALM_GRID, PalmMesh, REAL_PALM_LENGTH } from './palmMesh';

/**
 * A flat right hand, palm towards a camera looking down −Z (so the palm
 * normal is +Z), fingers up (+Y), thumb side towards +X. Metres.
 */
function rightHand(): THREE.Vector3[] {
  const joints = Array.from({ length: 21 }, () => new THREE.Vector3());
  joints[0].set(0, 0, 0); // wrist
  joints[1].set(0.03, 0.025, 0); // thumb base
  joints[5].set(0.032, 0.09, 0); // index knuckle
  joints[9].set(0.01, 0.09, 0); // middle knuckle (palm length 0.09 → scale ≈ 1)
  joints[13].set(-0.012, 0.088, 0);
  joints[17].set(-0.032, 0.082, 0);
  return joints;
}

const mirrorX = (joints: THREE.Vector3[]) => joints.map((j) => new THREE.Vector3(-j.x, j.y, j.z));
const MID = PALM_GRID / 2;

describe('PalmMesh', () => {
  it('points the palm normal out of the palm for both hands', () => {
    const mesh = new PalmMesh();
    expect(mesh.update(rightHand(), true)).toBe(true);
    expect(mesh.normal.z).toBeGreaterThan(0.99);

    // A left hand is the mirror image; its palm still faces the camera.
    expect(mesh.update(mirrorX(rightHand()), false)).toBe(true);
    expect(mesh.normal.z).toBeGreaterThan(0.99);
  });

  it('passes through the wrist and runs up to the knuckle line', () => {
    const mesh = new PalmMesh();
    const joints = rightHand();
    mesh.update(joints, true);
    const lift = mesh.vertex(MID, 0).z; // s = 0, t = −1: the wrist, lifted onto the skin
    expect(mesh.vertex(MID, 0).x).toBeCloseTo(0, 6);
    expect(mesh.vertex(MID, 0).y).toBeCloseTo(0, 6);
    expect(lift).toBeGreaterThan(0);
    expect(lift).toBeLessThan(0.003);
    // s = 0, t = +1 lies on the knuckle row between the middle and ring knuckles.
    const top = mesh.vertex(MID, PALM_GRID);
    expect(top.y).toBeGreaterThan(0.085);
    expect(top.x).toBeLessThan(joints[9].x);
    expect(top.x).toBeGreaterThan(joints[13].x);
  });

  it('cups the middle of the palm inwards', () => {
    const mesh = new PalmMesh();
    mesh.update(rightHand(), true);
    const edgeHeight = mesh.vertex(MID, 0).z;
    const centreHeight = mesh.vertex(MID, MID).z;
    expect(centreHeight).toBeLessThan(edgeHeight - 0.002);
  });

  it('follows the hand rigidly when it moves and turns', () => {
    const mesh = new PalmMesh();
    mesh.update(rightHand(), true);
    const before = mesh.vertex(5, 7).clone();

    const motion = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(0.3, -0.5, 0.8))
      .setPosition(0.1, -0.05, -0.4);
    mesh.update(rightHand().map((j) => j.applyMatrix4(motion)), true);
    const after = mesh.vertex(5, 7);
    expect(after.distanceTo(before.applyMatrix4(motion))).toBeLessThan(1e-6);
  });

  it('scales the depth effects with hand size', () => {
    const mesh = new PalmMesh();
    const palmLength = rightHand()[9].length(); // wrist is at the origin
    mesh.update(rightHand().map((j) => j.multiplyScalar(2)), true);
    expect(mesh.handScale).toBeCloseTo((2 * palmLength) / REAL_PALM_LENGTH, 6);
  });

  it('keeps the wound fixed in palm space, centred between wrist and middle knuckle', () => {
    const mesh = new PalmMesh();
    const uv = mesh.geometry.attributes.uv;
    // Grid centre is s = 0, t = 0; the wound centre is s = −1/6, t = 0.
    const k = MID * (PALM_GRID + 1) + MID;
    const patchMm = 70 * INJURY_SIZE;
    expect(uv.getX(k)).toBeCloseTo(0.5 + ((1 / 6) * 32.5) / patchMm, 6);
    expect(uv.getY(k)).toBeCloseTo(0.5, 6);
    // UVs are never rewritten by updates.
    mesh.update(rightHand(), true);
    expect(uv.getY(k)).toBeCloseTo(0.5, 6);
  });

  it('winds faces out of the palm for either hand', () => {
    for (const [joints, isRight] of [
      [rightHand(), true],
      [mirrorX(rightHand()), false],
    ] as const) {
      const mesh = new PalmMesh();
      mesh.update(joints, isRight);
      const index = mesh.geometry.index!;
      const a = mesh.vertex(0, 0);
      const p = (v: number) =>
        new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position as THREE.BufferAttribute, v);
      const face = new THREE.Vector3()
        .subVectors(p(index.getX(1)), a)
        .cross(new THREE.Vector3().subVectors(p(index.getX(2)), a));
      expect(face.dot(mesh.normal)).toBeGreaterThan(0);
    }
  });

  it('updates its buffers in place', () => {
    const mesh = new PalmMesh();
    const positions = mesh.geometry.attributes.position.array;
    const normals = mesh.geometry.attributes.normal.array;
    mesh.update(rightHand(), true);
    mesh.update(mirrorX(rightHand()), false);
    expect(mesh.geometry.attributes.position.array).toBe(positions);
    expect(mesh.geometry.attributes.normal.array).toBe(normals);
  });

  it('rejects a degenerate palm', () => {
    const mesh = new PalmMesh();
    const flat = rightHand().map(() => new THREE.Vector3(0, 0, 0));
    expect(mesh.update(flat, true)).toBe(false);
  });
});
