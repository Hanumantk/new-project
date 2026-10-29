import * as THREE from 'three';
import { LM } from './tracking';

/** Real finger half-thickness, in metres (scaled with the hand). */
const FINGER_RADIUS = 0.0095;
/** The palm occluder sits this far behind the palm surface, in metres. */
const PALM_BACKOFF = 0.006;
/** Grows the palm outline a little so it covers the fleshy edge of the hand. */
const PALM_OUTLINE_GROWTH = 1.25;

/** Finger bones, as landmark index pairs (thumb first). */
const FINGER_BONES: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];
/** Joints that get a sphere so bones join smoothly (everything but the wrist). */
const FINGER_JOINTS = Array.from({ length: 20 }, (_, i) => i + 1);
/** Palm outline, in order around the hand. */
const PALM_OUTLINE = [LM.WRIST, 1, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];

/**
 * An invisible stand-in for the user's hand. It writes depth but no colour,
 * so anything behind the real hand (like the wound when the back of the hand
 * faces the camera) is hidden, while the video stays visible.
 *
 * Fingers are capsules (cylinders + joint spheres); the palm is a flat fan
 * laid just behind the palm plane, so it never clips what sits on the palm from the
 * palm side. All meshes and scratch objects are created once and reused.
 */
export class HandOccluder {
  readonly root = new THREE.Group();

  private readonly material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly boneGeometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  private readonly jointGeometry = new THREE.SphereGeometry(1, 12, 8);
  private readonly palmGeometry = new THREE.BufferGeometry();
  private readonly bones: THREE.InstancedMesh;
  private readonly joints: THREE.InstancedMesh;
  private readonly palm: THREE.Mesh;

  private readonly shifted = Array.from({ length: 21 }, () => new THREE.Vector3());
  private readonly palmPositions = new Float32Array((PALM_OUTLINE.length + 1) * 3);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();

  /**
   * @param options.palmPlate  Include the flat palm plate. Off when the caller
   *   provides its own palm surface (e.g. one that follows a curved palm).
   */
  constructor({ palmPlate = true }: { palmPlate?: boolean } = {}) {
    this.bones = new THREE.InstancedMesh(this.boneGeometry, this.material, FINGER_BONES.length);
    this.joints = new THREE.InstancedMesh(this.jointGeometry, this.material, FINGER_JOINTS.length);

    const fan: number[] = [];
    for (let i = 1; i <= PALM_OUTLINE.length; i++) {
      fan.push(0, i, (i % PALM_OUTLINE.length) + 1);
    }
    this.palmGeometry.setIndex(fan);
    this.palmGeometry.setAttribute('position', new THREE.BufferAttribute(this.palmPositions, 3));
    this.palm = new THREE.Mesh(this.palmGeometry, this.material);
    this.palm.visible = palmPlate;

    for (const mesh of [this.bones, this.joints, this.palm]) {
      mesh.frustumCulled = false; // bounds change every frame
      mesh.renderOrder = -1; // write depth before anything it should hide
      this.root.add(mesh);
    }
  }

  /**
   * @param joints  The 21 hand landmarks in world space.
   * @param normal  Unit palm normal (out of the palm), in world space.
   * @param origin  A point on the palm plane (where the wound sits).
   * @param handScale  Scale applied to real-world hand dimensions.
   */
  update(joints: THREE.Vector3[], normal: THREE.Vector3, origin: THREE.Vector3, handScale: number) {
    const radius = FINGER_RADIUS * handScale;

    // Landmarks sit at the centre of each finger; push them back by a radius
    // so a flat finger's front surface lines up with the palm surface.
    for (let i = 0; i < joints.length; i++) {
      this.shifted[i].copy(joints[i]).addScaledVector(normal, -radius);
    }

    FINGER_BONES.forEach(([a, b], i) => {
      const start = this.shifted[a];
      const end = this.shifted[b];
      this.v.subVectors(end, start);
      const length = this.v.length();
      this.quaternion.setFromUnitVectors(this.up, length > 0 ? this.v.divideScalar(length) : this.up);
      this.centre.addVectors(start, end).multiplyScalar(0.5);
      this.scale.set(radius, length, radius);
      this.bones.setMatrixAt(i, this.matrix.compose(this.centre, this.quaternion, this.scale));
    });
    this.bones.instanceMatrix.needsUpdate = true;

    this.quaternion.identity();
    this.scale.setScalar(radius);
    FINGER_JOINTS.forEach((joint, i) => {
      this.joints.setMatrixAt(i, this.matrix.compose(this.shifted[joint], this.quaternion, this.scale));
    });
    this.joints.instanceMatrix.needsUpdate = true;

    if (!this.palm.visible) return;

    // Palm: outline flattened onto the palm plane, then moved just behind it.
    const backoff = PALM_BACKOFF * handScale;
    this.centre.set(0, 0, 0);
    PALM_OUTLINE.forEach((joint, i) => {
      this.v.copy(joints[joint]);
      const height = normal.dot(this.w.subVectors(this.v, origin));
      this.v.addScaledVector(normal, -height - backoff);
      this.v.toArray(this.palmPositions, (i + 1) * 3);
      this.centre.add(this.v);
    });
    this.centre.divideScalar(PALM_OUTLINE.length);
    this.centre.toArray(this.palmPositions, 0);
    for (let i = 1; i <= PALM_OUTLINE.length; i++) {
      this.v.fromArray(this.palmPositions, i * 3).sub(this.centre).multiplyScalar(PALM_OUTLINE_GROWTH);
      this.v.add(this.centre).toArray(this.palmPositions, i * 3);
    }
    this.palmGeometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.boneGeometry.dispose();
    this.jointGeometry.dispose();
    this.palmGeometry.dispose();
    this.material.dispose();
    this.bones.dispose();
    this.joints.dispose();
  }
}
