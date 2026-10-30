import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { XREstimatedLight } from 'three/examples/jsm/webxr/XREstimatedLight.js';
import { normaliseWound, type WoundGeometryInfo } from '../lib/woundGeometry';
import { XRHandModel, prepareHandModel } from '../lib/xrHandModel';
import { conformWound } from '../lib/xrWoundConform';
import { SKIN_PRESETS, setAutoWorking, xrPrefs, type HandSide } from '../lib/xrPrefs';
import { XRSkinSampler } from '../lib/xrSkinSampler';
import { createXRWoundMaterial, skinToneColor } from '../lib/xrWoundMaterial';

const WOUND_URL = `${import.meta.env.BASE_URL}models/Wound.glb`;

/**
 * The wound's length (cm) on an average hand (REFERENCE_PALM_CM from wrist to
 * middle knuckle); it's scaled with the user's own palm…
 */
export const LENGTH_CM = 8.5;
export const REFERENCE_PALM_CM = 9.5;
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

/** Fix the wound to the hand model's skin (it then deforms with the hand); false: rigid on the palm frame. */
export const USE_SKINNING = true;

const HAND_URL = `${import.meta.env.BASE_URL}models/Hand.glb`;

/** Adds (empty) skin index/weight attributes, filled at each bind. */
function addSkinAttributes(geometry: THREE.BufferGeometry) {
  const n = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
}

/**
 * The wound in the headset: on the chosen hand only. A detailed hand model is
 * posed on that hand's joints every frame (no smoothing: the runtime already
 * predicts poses); the wound is laid onto the model's palm skin and skinned
 * with the model's own weights, so it stays on that skin as the hand moves and
 * bends. The model, drawn depth-only, hides the wound behind the real hand.
 * When the hand is lost the wound stays put for 0.5 s, then fades, and
 * reappears at once at the new pose.
 */
export function XRWound({ strength }: XRWoundProps) {
  const findHand = useHandSpaces();
  const [info, setInfo] = useState<WoundGeometryInfo | null>(null);
  const [handSource, setHandSource] = useState<THREE.SkinnedMesh | null>(null);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const material = useMemo(() => createXRWoundMaterial(), []);

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
        // The flat wound as loaded, kept to lay it onto the hand afresh at each bind.
        loaded.geometry.userData.restPositions = (loaded.geometry.getAttribute('position').array as Float32Array).slice();
        loaded.geometry.userData.restNormals = (loaded.geometry.getAttribute('normal').array as Float32Array).slice();
        setInfo(loaded);
      })
      .catch((error) => console.error('Could not load the wound model', error));
    new GLTFLoader()
      .loadAsync(HAND_URL)
      .then((gltf) => {
        let mesh: THREE.SkinnedMesh | null = null;
        gltf.scene.traverse((o) => {
          if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
        });
        if (!cancelled) setHandSource(mesh);
      })
      .catch((error) => console.error('Could not load the hand model', error));
    return () => {
      cancelled = true;
      loaded?.geometry.dispose();
    };
  }, []);
  useEffect(() => () => material.dispose(), [material]);

  // The hand model, as a left and a right hand.
  const hands = useMemo(() => {
    if (!handSource) return null;
    return { left: new XRHandModel(prepareHandModel(handSource, false)), right: new XRHandModel(prepareHandModel(handSource, true)) };
  }, [handSource]);
  useEffect(
    () => () => {
      hands?.left.dispose();
      hands?.right.dispose();
    },
    [hands],
  );

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

  // The wound, parented to the scene (never to the hand).
  const mesh = useMemo(() => {
    if (!info) return null;
    const o = USE_SKINNING ? new THREE.SkinnedMesh(info.geometry, material) : new THREE.Mesh(info.geometry, material);
    o.frustumCulled = false;
    o.renderOrder = 3;
    o.visible = false;
    return o;
  }, [info, material]);

  const state = useMemo(
    () => ({
      reader: new PalmFrameReader(),
      frame: { point: new THREE.Vector3(), quaternion: new THREE.Quaternion() } as PalmFrame,
      placed: false,
      bound: false,
      lostFor: Infinity,
      boundHand: null as HandSide | null,
      boundReattach: -1,
      skinVersion: -1,
      toWound: new THREE.Matrix4(),
      surface: null as Float32Array | null,
      sampler: new XRSkinSampler(),
      sampleIn: 0,
      samplePoints: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()),
    }),
    [],
  );

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __xrWound?: unknown }).__xrWound = { state, mesh, hands, findHand, prefs: xrPrefs, scene };
  }, [state, mesh, hands, findHand, scene]);

  useFrame((_, delta) => {
    if (!mesh || !hands) return;
    if (state.skinVersion !== xrPrefs.version) {
      state.skinVersion = xrPrefs.version;
      if (!(xrPrefs.skinAuto && xrPrefs.autoWorking)) {
        skinToneColor(SKIN_PRESETS[xrPrefs.skinPreset], xrPrefs.skinFine, material.userData.uniforms.skinTone.value);
      }
    }
    const model = xrPrefs.hand === 'left' ? hands.left : hands.right;
    const other = model === hands.left ? hands.right : hands.left;
    other.root.visible = false;
    const hand = findHand(xrPrefs.hand);
    // Joints are all-or-nothing: the wrist stands for the whole hand.
    const tracked = !!hand?.joints.wrist?.visible && state.reader.read(hand, state.frame) && model.update(hand);
    if (tracked) {
      if (USE_SKINNING) {
        // Lay the wound on the model's palm on the first frame, on Re-attach, and when the hand changes.
        if (!state.bound || state.boundHand !== xrPrefs.hand || state.boundReattach !== xrPrefs.reattach) {
          state.bound = bind(mesh as unknown as THREE.SkinnedMesh, model);
          state.boundHand = xrPrefs.hand;
          state.boundReattach = xrPrefs.reattach;
        }
      } else {
        mesh.position.copy(state.frame.point);
        mesh.quaternion.copy(state.frame.quaternion);
      }
      state.placed = state.bound || !USE_SKINNING;
      state.lostFor = 0;
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
    } else {
      state.lostFor += delta;
    }
    const fade = state.lostFor <= HOLD_SECONDS ? 1 : 1 - (state.lostFor - HOLD_SECONDS) / FADE_SECONDS;
    const opacity = state.placed ? THREE.MathUtils.clamp(fade, 0, 1) * THREE.MathUtils.clamp(strength.current ?? 1, 0, 1) : 0;
    material.opacity = opacity;
    mesh.visible = opacity > 0;
    // The hand model: hides the wound behind the real hand; its wireframe on request.
    model.root.visible = mesh.visible || (xrPrefs.showHandMesh && tracked);
    model.occluder.visible = mesh.visible;
    model.wire.visible = xrPrefs.showHandMesh;
  });

  /** Lays the wound onto the hand model's palm skin as it is this frame and binds it to the model's bones. */
  function bind(skinned: THREE.SkinnedMesh, model: XRHandModel): boolean {
    // In proportion to this hand: bigger on a bigger palm, smaller on a smaller one.
    const handScale = model.palmLength / (REFERENCE_PALM_CM / 100);
    skinned.position.copy(state.frame.point);
    skinned.quaternion.copy(state.frame.quaternion);
    skinned.scale.setScalar(handScale);
    skinned.updateMatrixWorld(true);
    const handGeometry = model.data.geometry;
    const count = handGeometry.getAttribute('position').count;
    if (!state.surface || state.surface.length !== count * 3) state.surface = new Float32Array(count * 3);
    model.skinnedPositions(state.surface);
    state.toWound.copy(skinned.matrixWorld).invert();
    const g = skinned.geometry;
    const ok = conformWound(
      {
        restPositions: g.userData.restPositions as Float32Array,
        restNormals: g.userData.restNormals as Float32Array,
        halfWidth: info!.halfWidth,
        halfLength: info!.halfLength,
      },
      {
        positions: state.surface,
        index: handGeometry.getIndex()!.array as ArrayLike<number>,
        skinIndex: handGeometry.getAttribute('skinIndex') as THREE.BufferAttribute,
        skinWeight: handGeometry.getAttribute('skinWeight') as THREE.BufferAttribute,
      },
      state.toWound,
      OFFSET_MM / 1000 / handScale,
      g,
    );
    if (!ok) return false;
    // A new skeleton on the model's bones, so its inverses capture this exact pose.
    const old = skinned.skeleton;
    skinned.bind(new THREE.Skeleton(model.bones), skinned.matrixWorld);
    old?.dispose();
    return true;
  }

  return (
    <>
      {hands && <primitive object={hands.left.root} />}
      {hands && <primitive object={hands.right.root} />}
      {mesh && <primitive object={mesh} />}
    </>
  );
}
