import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { XREstimatedLight } from 'three/examples/jsm/webxr/XREstimatedLight.js';
import { normaliseWound, type WoundGeometryInfo } from '../lib/woundGeometry';
import { XRHandOccluder } from '../lib/xrHandOccluder';
import { SKIN_PRESETS, setAutoWorking, xrPrefs, type HandSide } from '../lib/xrPrefs';
import { XRSkinSampler } from '../lib/xrSkinSampler';
import { createXRWoundMaterial, skinToneColor } from '../lib/xrWoundMaterial';

const WOUND_URL = `${import.meta.env.BASE_URL}models/Wound.glb`;

/** The wound's length (cm)… */
export const LENGTH_CM = 6.5;
/** …turned this far from the palm's long axis towards the thumb (degrees)… */
export const ANGLE_DEG = 35;
/** …this far above the skin (mm)… */
export const OFFSET_MM = 0.5;
/** …and moved on the palm (mm): [towards the thumb, towards the fingers], from the metacarpals' centre (their joints sit at the base of the palm). */
export const PALM_OFFSET_MM: readonly [number, number] = [0, 20];

/** How often the palm's colour is read from the camera, when allowed (s). */
const SKIN_SAMPLE_SECONDS = 0.5;

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
  readonly origin = new THREE.Vector3();
  /** Along the palm (towards the fingers) and across it (towards the thumb), unit. */
  readonly along = new THREE.Vector3();
  readonly across = new THREE.Vector3();
  /** Out of the palm (unit). */
  readonly normal = new THREE.Vector3();
  /** On the skin above the metacarpals' centre. */
  readonly skin = new THREE.Vector3();
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

    this.skin.copy(this.origin).addScaledVector(this.normal, this.radius);
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
  // Slot per hand space: its handedness while connected (no per-frame allocation to look up).
  const slots = useMemo(() => [null, null] as (XRHandedness | null)[], []);
  useEffect(() => {
    const offs = [0, 1].map((i) => {
      const hand = gl.xr.getHand(i);
      const onConnected = (event: { data: XRInputSource }) => {
        if (event.data.hand) slots[i] = event.data.handedness;
      };
      const onDisconnected = () => (slots[i] = null);
      hand.addEventListener('connected', onConnected);
      hand.addEventListener('disconnected', onDisconnected);
      return () => {
        hand.removeEventListener('connected', onConnected);
        hand.removeEventListener('disconnected', onDisconnected);
      };
    });
    return () => offs.forEach((off) => off());
  }, [gl, slots]);
  return (side: HandSide): THREE.XRHandSpace | null => {
    for (let i = 0; i < 2; i++) if (slots[i] === side) return gl.xr.getHand(i);
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
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const material = useMemo(() => createXRWoundMaterial(), []);
  // Real fingers cover the wound; the back of the hand hides it.
  const occluder = useMemo(() => new XRHandOccluder(), []);
  useEffect(() => () => occluder.dispose(), [occluder]);

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

  // Soft studio reflections for the wet blood (or the room's own, if the
  // session estimates the real light).
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, 0.04).texture;
    material.envMap = envMap;
    material.needsUpdate = true;
    room.dispose();
    pmrem.dispose();

    const estimated = new XREstimatedLight(gl);
    const ownLights: THREE.Light[] = [];
    const onStart = () => {
      // The real room's light replaces the scene's fixed lights.
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight && o.visible) ownLights.push(o as THREE.Light);
      });
      ownLights.forEach((light) => (light.visible = false));
      scene.add(estimated);
      if (estimated.environment) {
        material.envMap = estimated.environment;
        material.needsUpdate = true;
      }
    };
    const onEnd = () => {
      scene.remove(estimated);
      ownLights.forEach((light) => (light.visible = true));
      ownLights.length = 0;
      material.envMap = envMap;
      material.needsUpdate = true;
    };
    estimated.addEventListener('estimationstart', onStart);
    estimated.addEventListener('estimationend', onEnd);
    return () => {
      estimated.removeEventListener('estimationstart', onStart);
      estimated.removeEventListener('estimationend', onEnd);
      onEnd();
      estimated.dispose();
      envMap.dispose();
    };
  }, [gl, scene, material]);

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

  // The wound, parented to the scene (never to the hand). No decals around
  // it: nothing draws a border or halo on the skin.
  const parts = useMemo(() => {
    if (!info) return null;
    const o = USE_SKINNING ? new THREE.SkinnedMesh(info.geometry, material) : new THREE.Mesh(info.geometry, material);
    if (o instanceof THREE.SkinnedMesh) o.bind(new THREE.Skeleton(rig.bones), new THREE.Matrix4());
    o.frustumCulled = false;
    o.renderOrder = 3;
    o.visible = false;
    o.userData.lift = 0;
    return { wound: o, all: [o] };
  }, [info, material, rig]);
  const mesh = parts?.wound ?? null;

  const state = useMemo(
    () => ({
      reader: new PalmFrameReader(),
      frame: { point: new THREE.Vector3(), quaternion: new THREE.Quaternion() } as PalmFrame,
      placed: false,
      lostFor: Infinity,
      boundHand: null as HandSide | null,
      boundReattach: -1,
      skinVersion: -1,
      one: new THREE.Vector3(1, 1, 1),
      lifted: new THREE.Vector3(),
      up: new THREE.Vector3(),
      sampler: new XRSkinSampler(),
      sampleIn: 0,
      samplePoints: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()),
    }),
    [],
  );

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __xrWound?: unknown }).__xrWound = { state, mesh, rig, findHand, occluder };
  }, [state, mesh, rig, findHand, occluder]);

  useFrame((_, delta) => {
    if (!mesh || !parts) return;
    if (state.skinVersion !== xrPrefs.version) {
      state.skinVersion = xrPrefs.version;
      if (!(xrPrefs.skinAuto && xrPrefs.autoWorking)) {
        skinToneColor(SKIN_PRESETS[xrPrefs.skinPreset], xrPrefs.skinFine, material.userData.uniforms.skinTone.value);
      }
    }
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
          bind();
          state.boundHand = xrPrefs.hand;
          state.boundReattach = xrPrefs.reattach;
        }
      } else {
        for (const o of parts.all) place(o);
      }
      occluder.update(hand, state.reader.skin, state.reader.normal);
      // Auto skin tone: the real palm's colour from the camera, if the session allows it.
      state.sampleIn -= delta;
      if (xrPrefs.skinAuto && state.sampleIn <= 0) {
        state.sampleIn = SKIN_SAMPLE_SECONDS;
        const r = state.reader;
        const pts = state.samplePoints;
        pts[0].copy(r.skin);
        pts[1].copy(r.skin).addScaledVector(r.along, 0.015);
        pts[2].copy(r.skin).addScaledVector(r.along, -0.015);
        pts[3].copy(r.skin).addScaledVector(r.across, 0.015);
        pts[4].copy(r.skin).addScaledVector(r.across, -0.015);
        if (state.sampler.sample(gl, pts)) {
          const c = state.sampler.srgb;
          material.userData.uniforms.skinTone.value.setRGB(c.x, c.y, c.z, THREE.SRGBColorSpace);
          setAutoWorking(true);
        } else if (!state.sampler.available) {
          setAutoWorking(false);
        }
      }
      state.placed = true;
      state.lostFor = 0;
    } else {
      state.lostFor += delta;
    }
    const fade = state.lostFor <= HOLD_SECONDS ? 1 : 1 - (state.lostFor - HOLD_SECONDS) / FADE_SECONDS;
    const opacity = state.placed ? THREE.MathUtils.clamp(fade, 0, 1) * THREE.MathUtils.clamp(strength.current ?? 1, 0, 1) : 0;
    for (const o of parts.all) {
      (o.material as THREE.Material).opacity = opacity;
      o.visible = opacity > 0;
    }
    occluder.root.visible = mesh.visible;
  });

  /** Puts a part on the palm surface (decals a hair above it) as the palm frame says this frame. */
  function place(o: THREE.Object3D) {
    state.up.set(0, 1, 0).applyQuaternion(state.frame.quaternion);
    o.position.copy(state.frame.point).addScaledVector(state.up, o.userData.lift as number);
    o.quaternion.copy(state.frame.quaternion);
    o.updateMatrixWorld(true);
  }

  /** Puts the wound and decals on the palm surface and binds them to the bones as they are this frame. */
  function bind() {
    // A new skeleton, so its inverses capture this exact pose.
    const skeleton = new THREE.Skeleton(rig.bones);
    for (const o of parts!.all) {
      const skinned = o as THREE.SkinnedMesh;
      place(skinned);
      computeSkinWeights(skinned, rig.bones);
      const old = skinned.skeleton;
      skinned.bind(skeleton, skinned.matrixWorld);
      if (old !== skeleton) old?.dispose();
    }
  }

  return (
    <>
      <primitive object={rig.root} />
      <primitive object={occluder.root} />
      {parts?.all.map((o) => <primitive key={o.uuid} object={o} />)}
    </>
  );
}
