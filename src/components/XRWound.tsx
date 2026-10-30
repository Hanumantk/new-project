import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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

/**
 * The wound in the headset: on the chosen hand only, placed from that hand's
 * joints in the same frame they're read (no smoothing: the runtime already
 * predicts poses). Never hidden while the hand is tracked; when it's lost the
 * wound stays where it was for 0.5 s, then fades, and reappears at once at the
 * new pose when the hand is back.
 */
export function XRWound({ strength }: XRWoundProps) {
  const findHand = useHandSpaces();
  const [info, setInfo] = useState<WoundGeometryInfo | null>(null);
  const meshRef = useRef<THREE.Mesh>(null);
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
        setInfo(loaded);
      })
      .catch((error) => console.error('Could not load the wound model', error));
    return () => {
      cancelled = true;
      loaded?.geometry.dispose();
    };
  }, []);
  useEffect(() => () => material.dispose(), [material]);

  const state = useMemo(
    () => ({
      reader: new PalmFrameReader(),
      frame: { point: new THREE.Vector3(), quaternion: new THREE.Quaternion() } as PalmFrame,
      placed: false,
      lostFor: Infinity,
    }),
    [],
  );

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __xrWound?: unknown }).__xrWound = { state, meshRef, findHand };
  }, [state, findHand]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const hand = findHand(xrPrefs.hand);
    // Joints are all-or-nothing: the wrist stands for the whole hand.
    const tracked = !!hand?.joints.wrist?.visible && state.reader.read(hand, state.frame);
    if (tracked) {
      // This frame's pose, as is (also straight away after a loss: no blending).
      mesh.position.copy(state.frame.point);
      mesh.quaternion.copy(state.frame.quaternion);
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

  if (!info) return null;
  return <mesh ref={meshRef} geometry={info.geometry} material={material} frustumCulled={false} renderOrder={3} visible={false} />;
}
