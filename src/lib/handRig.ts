import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Poses a skinned hand model (the WebXR "generic hand", MIT licence) from
 * MediaPipe's 21 landmarks, so the tracked hand can be shown as a clean mesh.
 *
 * The model's bones are WebXR hand joints: each sits at its joint, with −Z
 * pointing along the bone towards the fingertip. For every bone we record,
 * in the rest pose, how its orientation relates to an anatomical frame
 * (bone direction + back-of-hand direction); at run time we rebuild that
 * frame from the landmarks and apply the same relation. That copes with the
 * thumb's twist and mirrors correctly for left hands.
 */

const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
const MP_MCP = { index: 5, middle: 9, ring: 13, pinky: 17 } as const;

/** Bone name → [MediaPipe landmark index, or null for a finger metacarpal base]. */
const BONES: Array<{ name: string; landmark: number | null; finger?: (typeof FINGERS)[number]; child: string | null }> = [
  { name: 'wrist', landmark: 0, child: 'middle-finger-phalanx-proximal' },
  { name: 'thumb-metacarpal', landmark: 1, child: 'thumb-phalanx-proximal' },
  { name: 'thumb-phalanx-proximal', landmark: 2, child: 'thumb-phalanx-distal' },
  { name: 'thumb-phalanx-distal', landmark: 3, child: 'thumb-tip' },
  { name: 'thumb-tip', landmark: 4, child: null },
  ...FINGERS.flatMap((f) => {
    const m = MP_MCP[f];
    return [
      { name: `${f}-finger-metacarpal`, landmark: null, finger: f, child: `${f}-finger-phalanx-proximal` },
      { name: `${f}-finger-phalanx-proximal`, landmark: m, child: `${f}-finger-phalanx-intermediate` },
      { name: `${f}-finger-phalanx-intermediate`, landmark: m + 1, child: `${f}-finger-phalanx-distal` },
      { name: `${f}-finger-phalanx-distal`, landmark: m + 2, child: `${f}-finger-tip` },
      { name: `${f}-finger-tip`, landmark: m + 3, child: null },
    ];
  }),
];
const BONE_INDEX = new Map(BONES.map((b, i) => [b.name, i]));
/** Bone whose direction a tip (which has no child) borrows. */
const parentOf = (i: number) => i - 1;

export class HandRig {
  readonly root = new THREE.Group();
  private bones: THREE.Bone[] = [];
  /** Per bone: rest orientation relative to its anatomical frame. */
  private offsets: THREE.Quaternion[] = [];
  /** Per finger: where the metacarpal base sits along wrist → knuckle (0..1). */
  private metacarpalAt = new Map<string, number>();
  private restPalmLength = 0.092;
  private ready = false;

  private readonly positions = BONES.map(() => new THREE.Vector3());
  private readonly frame = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly x = new THREE.Vector3();
  private readonly y = new THREE.Vector3();
  private readonly z = new THREE.Vector3();
  private readonly dorsal = new THREE.Vector3();

  /**
   * @param url  glTF of the generic hand (left or right).
   * @param material  Applied to the skinned mesh.
   * @param isRightHand  Which hand the model is (sets the back-of-hand direction).
   */
  constructor(
    url: string,
    material: THREE.Material,
    private readonly isRightHand: boolean,
    onReady?: () => void,
  ) {
    new GLTFLoader().load(url, (gltf) => {
      const object = clone(gltf.scene.children[0]);
      object.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
          const mesh = o as THREE.SkinnedMesh;
          mesh.material = material;
          mesh.frustumCulled = false;
        }
      });
      this.bones = BONES.map((b) => object.getObjectByName(b.name) as THREE.Bone);
      this.learnRestPose();
      this.root.add(object);
      this.ready = true;
      onReady?.();
    });
  }

  get loaded() {
    return this.ready;
  }

  /** Records rest-pose metacarpal placement and bone-to-anatomy offsets. */
  private learnRestPose() {
    const rest = this.bones.map((b) => b.position.clone());
    const at = (name: string) => rest[BONE_INDEX.get(name)!];
    const wrist = at('wrist');
    this.restPalmLength = wrist.distanceTo(at('middle-finger-phalanx-proximal'));
    for (const f of FINGERS) {
      const base = at(`${f}-finger-metacarpal`).clone().sub(wrist);
      const knuckle = at(`${f}-finger-phalanx-proximal`).clone().sub(wrist);
      this.metacarpalAt.set(f, base.dot(knuckle) / knuckle.lengthSq());
    }
    rest.forEach((p, i) => this.positions[i].copy(p));
    this.computeDorsal();
    this.offsets = this.bones.map((bone, i) => {
      this.anatomicalFrame(i);
      return this.q.setFromRotationMatrix(this.frame).invert().multiply(bone.quaternion).clone();
    });
  }

  /** Back-of-hand direction from the wrist, index and pinky knuckles. */
  private computeDorsal() {
    const p = this.positions;
    const wrist = p[BONE_INDEX.get('wrist')!];
    this.x.subVectors(p[BONE_INDEX.get('index-finger-phalanx-proximal')!], wrist);
    this.y.subVectors(p[BONE_INDEX.get('pinky-finger-phalanx-proximal')!], wrist);
    // (5−0)×(17−0) points out of the palm for a right hand; the back is the opposite.
    this.dorsal.crossVectors(this.x, this.y).normalize();
    if (this.isRightHand) this.dorsal.negate();
  }

  /** this.frame ← basis with −Z along bone i and +Y towards the back of the hand. */
  private anatomicalFrame(i: number) {
    const p = this.positions;
    const child = BONES[i].child;
    if (child) this.z.subVectors(p[i], p[BONE_INDEX.get(child)!]);
    else this.z.subVectors(p[parentOf(i)], p[i]);
    this.z.normalize();
    this.y.copy(this.dorsal).addScaledVector(this.z, -this.dorsal.dot(this.z));
    if (this.y.lengthSq() < 1e-10) this.y.set(0, 1, 0);
    this.y.normalize();
    this.x.crossVectors(this.y, this.z);
    this.frame.makeBasis(this.x, this.y, this.z);
  }

  /**
   * Poses the model on 21 MediaPipe-ordered joints (world space).
   * @returns false until the model has loaded.
   */
  update(joints: THREE.Vector3[]): boolean {
    if (!this.ready) return false;
    BONES.forEach((b, i) => {
      if (b.landmark !== null) this.positions[i].copy(joints[b.landmark]);
      else {
        const t = this.metacarpalAt.get(b.finger!)!;
        this.positions[i].lerpVectors(joints[0], joints[MP_MCP[b.finger!]], t);
      }
    });
    this.computeDorsal();
    const scale = joints[0].distanceTo(joints[9]) / this.restPalmLength;
    this.bones.forEach((bone, i) => {
      this.anatomicalFrame(i);
      bone.position.copy(this.positions[i]);
      bone.quaternion.setFromRotationMatrix(this.frame).multiply(this.offsets[i]);
      bone.scale.setScalar(scale);
    });
    return true;
  }
}
