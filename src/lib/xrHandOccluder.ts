import * as THREE from 'three';

/** Thumb and finger bones as joint chains (each consecutive pair is a capsule). */
const CHAINS: readonly (readonly XRHandJoint[])[] = [
  ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  ['middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
];
const SEGMENTS = CHAINS.reduce((n, chain) => n + chain.length - 1, 0);
const CHAIN_JOINTS = CHAINS.flat();

/** The palm's outline, round from the wrist (projected onto the palm plane). */
const PALM_OUTLINE: readonly XRHandJoint[] = [
  'wrist',
  'thumb-metacarpal',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'middle-finger-phalanx-proximal',
  'ring-finger-phalanx-proximal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-metacarpal',
];
/** The slab's top face sits this far below the skin (m), so it never covers the wound from the front… */
const SLAB_BELOW_SKIN = 0.002;
/** …and it's this thick (m), so it hides the wound when the back of the hand faces you. */
const SLAB_THICKNESS = 0.015;
/** The outline is grown by this factor about its centre to reach the palm's edges. */
const SLAB_GROWTH = 1.1;

/**
 * Invisible stand-ins for the real hand that only write depth, rebuilt from
 * the hand's joints every frame: a capsule per thumb and finger bone (radius
 * = the mean of its two joints' radii) and a thin palm slab just below the
 * skin. Real fingers then cover the wound, and the back of the hand hides it.
 */
export class XRHandOccluder {
  readonly root = new THREE.Group();
  readonly material = new THREE.MeshBasicMaterial({ colorWrite: false, color: '#36c', side: THREE.DoubleSide });
  private readonly cylinders: THREE.InstancedMesh;
  private readonly spheres: THREE.InstancedMesh;
  private readonly slab: THREE.Mesh;
  private readonly slabPositions: Float32Array;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly top = new THREE.Vector3();
  private readonly outline = PALM_OUTLINE.map(() => new THREE.Vector3());

  constructor() {
    this.cylinders = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1, true), this.material, SEGMENTS);
    this.spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), this.material, CHAIN_JOINTS.length);
    // Slab: top fan, bottom fan and sides around the outline (positions set each frame).
    const n = PALM_OUTLINE.length;
    this.slabPositions = new Float32Array((2 + 2 * n) * 3);
    const indices: number[] = [];
    const topC = 0, botC = 1, topV = (i: number) => 2 + (i % n), botV = (i: number) => 2 + n + (i % n);
    for (let i = 0; i < n; i++) {
      indices.push(topC, topV(i), topV(i + 1));
      indices.push(botC, botV(i + 1), botV(i));
      indices.push(topV(i), botV(i), botV(i + 1), topV(i), botV(i + 1), topV(i + 1));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.slabPositions, 3));
    geometry.setIndex(indices);
    this.slab = new THREE.Mesh(geometry, this.material);
    for (const o of [this.cylinders, this.spheres, this.slab]) {
      o.frustumCulled = false;
      o.renderOrder = -1;
      this.root.add(o);
    }
  }

  /** Show the stand-ins (debug) or keep them depth-only. */
  setVisible(visible: boolean) {
    this.material.colorWrite = visible;
    this.material.transparent = visible;
    this.material.opacity = visible ? 0.35 : 1;
  }

  /**
   * @param skin    A point on the palm's skin (world)…
   * @param normal  …and the palm's normal there (unit, out of the palm).
   */
  update(hand: THREE.XRHandSpace, skin: THREE.Vector3, normal: THREE.Vector3): boolean {
    const j = hand.joints;
    let segment = 0;
    let sphere = 0;
    for (const chain of CHAINS) {
      for (let k = 0; k < chain.length; k++) {
        const a = j[chain[k]];
        if (!a) return false;
        this.s.setScalar(a.jointRadius ?? 0.008);
        this.q.identity();
        this.spheres.setMatrixAt(sphere++, this.m.compose(a.position, this.q, this.s));
        if (k === chain.length - 1) continue;
        const b = j[chain[k + 1]];
        if (!b) return false;
        const r = ((a.jointRadius ?? 0.008) + (b.jointRadius ?? 0.008)) / 2;
        this.d.subVectors(b.position, a.position);
        const length = this.d.length();
        this.q.setFromUnitVectors(this.up, length > 0 ? this.d.divideScalar(length) : this.up);
        this.c.addVectors(a.position, b.position).multiplyScalar(0.5);
        this.s.set(r, length, r);
        this.cylinders.setMatrixAt(segment++, this.m.compose(this.c, this.q, this.s));
      }
    }
    this.cylinders.instanceMatrix.needsUpdate = true;
    this.spheres.instanceMatrix.needsUpdate = true;

    // Palm slab: the outline flattened onto a plane just below the skin.
    this.top.copy(skin).addScaledVector(normal, -SLAB_BELOW_SKIN);
    this.c.set(0, 0, 0);
    for (let i = 0; i < PALM_OUTLINE.length; i++) {
      const joint = j[PALM_OUTLINE[i]];
      if (!joint) return false;
      const v = this.outline[i].copy(joint.position);
      v.addScaledVector(normal, -normal.dot(this.p.subVectors(v, this.top)));
      this.c.add(v);
    }
    this.c.multiplyScalar(1 / PALM_OUTLINE.length);
    const n = PALM_OUTLINE.length;
    this.write(0, this.c, normal, 0);
    this.write(1, this.c, normal, SLAB_THICKNESS);
    for (let i = 0; i < n; i++) {
      const v = this.outline[i].sub(this.c).multiplyScalar(SLAB_GROWTH).add(this.c);
      this.write(2 + i, v, normal, 0);
      this.write(2 + n + i, v, normal, SLAB_THICKNESS);
    }
    this.slab.geometry.getAttribute('position').needsUpdate = true;
    return true;
  }

  /** Writes slab vertex `index` at v, `depth` behind it along the normal. */
  private write(index: number, v: THREE.Vector3, normal: THREE.Vector3, depth: number) {
    const out = this.slabPositions;
    out[index * 3] = v.x - normal.x * depth;
    out[index * 3 + 1] = v.y - normal.y * depth;
    out[index * 3 + 2] = v.z - normal.z * depth;
  }

  dispose() {
    this.cylinders.geometry.dispose();
    this.spheres.geometry.dispose();
    this.slab.geometry.dispose();
    this.material.dispose();
  }
}
