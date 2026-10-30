import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { normaliseWound, type WoundGeometryInfo } from '../lib/woundGeometry';
import { xrPrefs, type HandSide } from '../lib/xrPrefs';

const WOUND_URL = `${import.meta.env.BASE_URL}models/Wound.glb`;

/** The wound's length (cm)… */
export const LENGTH_CM = 4.5;
/** …turned this far from the palm's long axis towards the thumb (degrees)… */
export const ANGLE_DEG = 35;
/** …this far above the skin (mm)… */
export const OFFSET_MM = 0.5;
/** …and moved on the palm (mm): [towards the thumb, towards the fingers], from the metacarpals' centre (their joints sit at the base of the palm). */
export const PALM_OFFSET_MM: readonly [number, number] = [0, 20];

/** After the hand is lost the wound stays put this long (s)… */
const HOLD_SECONDS = 0.5;
/** …then fades out over this long (s). */
const FADE_SECONDS = 0.2;

const METACARPALS = [
  'index-finger-metacarpal',
  'middle-finger-metacarpal',
  'ring-finger-metacarpal',
  'pinky-finger-metacarpal',
] as const;

interface PalmFrame {
  /** Point on the palm's skin where the wound's centre goes (world). */
  point: THREE.Vector3;
  /** The wound's orientation: +Y out of the palm, +Z along its length. */
  quaternion: THREE.Quaternion;
}

/**
 * The palm, straight from the chosen hand's joints this frame:
 * origin at the four metacarpals' centre, normal = −Y of the middle
 * metacarpal (WebXR: out of the palm, on either hand), long axis from the
 * middle metacarpal to the middle knuckle, skin = origin + normal × the
 * metacarpals' mean radius.
 */
class PalmFrameReader {
  private readonly origin = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly along = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly x = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  radius = 0.01;

  read(hand: THREE.XRHandSpace, out: PalmFrame): boolean {
    const j = hand.joints;
    const middle = j['middle-finger-metacarpal'];
    const knuckle = j['middle-finger-phalanx-proximal'];
    const thumb = j['thumb-metacarpal'];
    if (!middle?.visible || !knuckle || !thumb) return false;
    this.origin.set(0, 0, 0);
    let radius = 0;
    for (const name of METACARPALS) {
      const joint = j[name];
      if (!joint) return false;
      this.origin.add(joint.position);
      radius += joint.jointRadius ?? 0.01;
    }
    this.origin.multiplyScalar(1 / METACARPALS.length);
    this.radius = radius / METACARPALS.length;

    this.normal.set(0, -1, 0).applyQuaternion(middle.quaternion);
    this.along.subVectors(knuckle.position, middle.position);
    this.along.addScaledVector(this.normal, -this.along.dot(this.normal)).normalize();
    // Across the palm, signed so + points to the thumb side (either hand).
    this.across.crossVectors(this.normal, this.along);
    if (this.dir.subVectors(thumb.position, this.origin).dot(this.across) < 0) this.across.negate();

    out.point
      .copy(this.origin)
      .addScaledVector(this.normal, this.radius + OFFSET_MM / 1000)
      .addScaledVector(this.across, PALM_OFFSET_MM[0] / 1000)
      .addScaledVector(this.along, PALM_OFFSET_MM[1] / 1000);
    // Length runs ANGLE_DEG from the long axis towards the thumb.
    const a = THREE.MathUtils.degToRad(ANGLE_DEG);
    this.dir.copy(this.along).multiplyScalar(Math.cos(a)).addScaledVector(this.across, Math.sin(a));
    this.x.crossVectors(this.normal, this.dir);
    this.basis.makeBasis(this.x, this.normal, this.dir);
    out.quaternion.setFromRotationMatrix(this.basis);
    return true;
  }
}

/** Tracks which hand space is which hand (they connect in any order). */
function useHandSpaces() {
  const gl = useThree((s) => s.gl);
  const handedness = useMemo(() => new Map<THREE.XRHandSpace, XRHandedness>(), []);
  useEffect(() => {
    const hands = [gl.xr.getHand(0), gl.xr.getHand(1)];
    const offs = hands.map((hand) => {
      const onConnected = (event: { data: XRInputSource }) => {
        if (event.data.hand) handedness.set(hand, event.data.handedness);
      };
      const onDisconnected = () => handedness.delete(hand);
      hand.addEventListener('connected', onConnected);
      hand.addEventListener('disconnected', onDisconnected);
      return () => {
        hand.removeEventListener('connected', onConnected);
        hand.removeEventListener('disconnected', onDisconnected);
      };
    });
    return () => offs.forEach((off) => off());
  }, [gl, handedness]);
  return (side: HandSide): THREE.XRHandSpace | null => {
    for (const [hand, h] of handedness) if (h === side) return hand;
    return null;
  };
}

interface XRWoundProps {
  /** Wound opacity 0..1 (the shared slider). */
  strength: RefObject<number>;
}

/** Bend the wound with the palm (skinned to six hand bones); false: rigid on the palm frame. */
export const USE_SKINNING = true;

/** The joints the wound is skinned to. */
const BONE_JOINTS = ['wrist', 'thumb-metacarpal', ...METACARPALS] as const;
/** Bones each vertex follows. */
const INFLUENCES = 4;

/** Adds (empty) skin index/weight attributes, filled at each bind. */
function addSkinAttributes(geometry: THREE.BufferGeometry) {
  const n = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
}

const weightScratch = { p: new THREE.Vector3(), d: new Float64Array(BONE_JOINTS.length), order: [0, 1, 2, 3, 4, 5] };

/**
 * Skin weights for a mesh as it sits now (its matrixWorld) against the bones
 * as they are now: each vertex to its 4 nearest bones, by 1/distance², normalised.
 */
function computeSkinWeights(mesh: THREE.Mesh, bones: THREE.Bone[]) {
  const geometry = mesh.geometry;
  const pos = geometry.getAttribute('position');
  const index = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const weight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  const { p, d, order } = weightScratch;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    for (let b = 0; b < bones.length; b++) {
      const e = bones[b].matrixWorld.elements;
      d[b] = (p.x - e[12]) ** 2 + (p.y - e[13]) ** 2 + (p.z - e[14]) ** 2;
      order[b] = b;
    }
    order.sort((a, b) => d[a] - d[b]);
    let sum = 0;
    for (let k = 0; k < INFLUENCES; k++) sum += 1 / Math.max(d[order[k]], 1e-8);
    for (let k = 0; k < INFLUENCES; k++) {
      index.setComponent(i, k, order[k]);
      weight.setComponent(i, k, 1 / Math.max(d[order[k]], 1e-8) / sum);
    }
  }
  index.needsUpdate = true;
  weight.needsUpdate = true;
}

/**
 * The wound in the headset: on the chosen hand only, driven by that hand's
 * joints in the same frame they're read (no smoothing: the runtime already
 * predicts poses). It's skinned to six bones that copy the wrist, thumb and
 * metacarpal joints every frame, so it moves and bends with the palm. Never
 * hidden while the hand is tracked; when it's lost the wound stays where it
 * was for 0.5 s, then fades, and reappears at once at the new pose.
 */
export function XRWound({ strength }: XRWoundProps) {
  const findHand = useHandSpaces();
  const [info, setInfo] = useState<WoundGeometryInfo | null>(null);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8b1a1a', transparent: true }), []);

  useEffect(() => {
    let cancelled = false;
    let loaded: WoundGeometryInfo | null = null;
    new GLTFLoader()
      .loadAsync(WOUND_URL)
      .then((gltf) => {
        let geometry: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((o) => {
          if (!geometry && (o as THREE.Mesh).isMesh) geometry = (o as THREE.Mesh).geometry;
        });
        if (!geometry || cancelled) return;
        loaded = normaliseWound(geometry, LENGTH_CM / 100);
        (geometry as THREE.BufferGeometry).dispose();
        addSkinAttributes(loaded.geometry);
        setInfo(loaded);
      })
      .catch((error) => console.error('Could not load the wound model', error));
    return () => {
      cancelled = true;
      loaded?.geometry.dispose();
    };
  }, []);
  useEffect(() => () => material.dispose(), [material]);

  // Six bones under a root at the scene origin; their world matrices are set
  // straight from the joints each frame.
  const rig = useMemo(() => {
    const root = new THREE.Object3D();
    root.matrixAutoUpdate = false;
    const bones = BONE_JOINTS.map((name) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.matrixAutoUpdate = false;
      bone.matrixWorldAutoUpdate = false;
      root.add(bone);
      return bone;
    });
    return { root, bones };
  }, []);

  // The wound mesh, parented to the scene (never to the hand).
  const mesh = useMemo(() => {
    if (!info) return null;
    const m = USE_SKINNING ? new THREE.SkinnedMesh(info.geometry, material) : new THREE.Mesh(info.geometry, material);
    if (m instanceof THREE.SkinnedMesh) m.bind(new THREE.Skeleton(rig.bones), new THREE.Matrix4());
    m.frustumCulled = false;
    m.renderOrder = 3;
    m.visible = false;
    return m;
  }, [info, material, rig]);

  const state = useMemo(
    () => ({
      reader: new PalmFrameReader(),
      frame: { point: new THREE.Vector3(), quaternion: new THREE.Quaternion() } as PalmFrame,
      placed: false,
      lostFor: Infinity,
      boundHand: null as HandSide | null,
      boundReattach: -1,
      one: new THREE.Vector3(1, 1, 1),
    }),
    [],
  );

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __xrWound?: unknown }).__xrWound = { state, mesh, rig, findHand };
  }, [state, mesh, rig, findHand]);

  useFrame((_, delta) => {
    if (!mesh) return;
    const hand = findHand(xrPrefs.hand);
    // Joints are all-or-nothing: the wrist stands for the whole hand.
    const tracked = !!hand?.joints.wrist?.visible && state.reader.read(hand, state.frame);
    if (tracked) {
      if (USE_SKINNING) {
        // Bones = this frame's joints, as is (also straight after a loss: no blending).
        for (const bone of rig.bones) {
          const joint = hand.joints[bone.name as XRHandJoint]!;
          bone.matrix.compose(joint.position, joint.quaternion, state.one);
          bone.matrixWorld.copy(bone.matrix);
        }
        // Bind on the first frame, on Re-attach, and when the hand changes.
        if (!state.placed || state.boundHand !== xrPrefs.hand || state.boundReattach !== xrPrefs.reattach) {
          bind(mesh as THREE.SkinnedMesh);
          state.boundHand = xrPrefs.hand;
          state.boundReattach = xrPrefs.reattach;
        }
      } else {
        mesh.position.copy(state.frame.point);
        mesh.quaternion.copy(state.frame.quaternion);
      }
      state.placed = true;
      state.lostFor = 0;
    } else {
      state.lostFor += delta;
    }
    const fade = state.lostFor <= HOLD_SECONDS ? 1 : 1 - (state.lostFor - HOLD_SECONDS) / FADE_SECONDS;
    const opacity = state.placed ? THREE.MathUtils.clamp(fade, 0, 1) * THREE.MathUtils.clamp(strength.current ?? 1, 0, 1) : 0;
    material.opacity = opacity;
    mesh.visible = opacity > 0;
  });

  /** Puts the wound on the palm surface and binds it to the bones as they are this frame. */
  function bind(skinned: THREE.SkinnedMesh) {
    skinned.position.copy(state.frame.point);
    skinned.quaternion.copy(state.frame.quaternion);
    skinned.updateMatrixWorld(true);
    computeSkinWeights(skinned, rig.bones);
    // A new skeleton, so its inverses capture this exact pose.
    const old = skinned.skeleton;
    skinned.bind(new THREE.Skeleton(rig.bones), skinned.matrixWorld);
    old?.dispose();
  }

  return (
    <>
      <primitive object={rig.root} />
      {mesh && <primitive object={mesh} />}
    </>
  );
}
