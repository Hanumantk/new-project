import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HandOccluder } from '../lib/handOccluder';
import type { HandPose } from '../lib/handPose';
import {
  INJURY_HEIGHT_MAX,
  INJURY_HEIGHT_MIN,
  loadInjuryTextures,
  type InjuryTextures,
} from '../lib/injury/injuryTextures';
import { PalmMesh } from '../lib/palmMesh';

/**
 * Exaggerates the wound's relief so the swollen rim visibly bulges (and the
 * cut sinks) when the hand tilts: about ±1.2 mm in the texture → ±3.6 mm.
 */
const DISPLACEMENT_GAIN = 3;
/** The normal map was made for the un-exaggerated relief; match it part-way. */
const NORMAL_STRENGTH = 2.2;
/** The palm's depth stand-in sits this far behind the skin, for a 9 cm palm. */
const PALM_BACKOFF = 0.006;
/** The wound fades out as the palm turns away: fully shown up to 55°, gone by 75°. */
const FADE_START_DEG = 55;
const FADE_END_DEG = 75;
const FADE_SECONDS = 0.2;

interface PalmInjuryProps {
  /** The tracked hand, filled each frame by a pose source (webcam or headset). */
  pose: RefObject<HandPose>;
  /**
   * Hide the wound behind an invisible stand-in for the real hand. Needed when
   * the real hand is seen (webcam video, passthrough); off when a visible
   * virtual hand is drawn, which hides the wound by itself.
   */
  occlude?: boolean;
}

export function PalmInjury({ pose, occlude = true }: PalmInjuryProps) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const [textures, setTextures] = useState<InjuryTextures | null>(null);
  const tintRef = useRef<THREE.Mesh>(null);
  const woundRef = useRef<THREE.Mesh>(null);
  const palmBackRef = useRef<THREE.Mesh>(null);

  // One grid laid over the palm, shared by the bruise layer, the wound and
  // the depth stand-in for the palm.
  const palm = useMemo(() => new PalmMesh(), []);

  // Bruising and redness are unlit so they read as a change in skin colour.
  const tintMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
    [],
  );
  // The wound is lit: displaced, normal-mapped, and glossy where it's wet.
  const woundMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        transparent: true,
        depthWrite: false,
        roughness: 1, // scaled per pixel by the roughness map
        metalness: 0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.12,
        normalScale: new THREE.Vector2(NORMAL_STRENGTH, NORMAL_STRENGTH),
        envMapIntensity: 0.3,
        // Keep the authored wound colours; tone mapping washes reds out to pink.
        toneMapped: false,
      }),
    [],
  );
  // The palm itself, as depth only, pushed just behind the skin along its
  // normals: it hides the wound whenever the back of the hand faces the camera.
  const palmBackMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const backoff = { value: PALM_BACKOFF };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.backoff = backoff;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'uniform float backoff;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed -= normal * backoff;');
    };
    material.userData.backoff = backoff;
    return material;
  }, []);
  const occluder = useMemo(() => new HandOccluder({ palmPlate: false }), []);

  // Soft studio reflections for the wet surfaces.
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, 0.04).texture;
    woundMaterial.envMap = envMap;
    woundMaterial.needsUpdate = true;
    room.dispose();
    pmrem.dispose();
    return () => envMap.dispose();
  }, [gl, woundMaterial]);

  useEffect(() => {
    let cancelled = false;
    let loaded: InjuryTextures | null = null;
    loadInjuryTextures().then((t) => {
      if (cancelled) {
        t.dispose();
        return;
      }
      loaded = t;
      tintMaterial.map = t.tint;
      woundMaterial.map = t.wound;
      woundMaterial.normalMap = t.normal;
      woundMaterial.roughnessMap = t.surface;
      woundMaterial.displacementMap = t.surface;
      tintMaterial.needsUpdate = true;
      woundMaterial.needsUpdate = true;
      setTextures(t);
    });
    return () => {
      cancelled = true;
      loaded?.dispose();
    };
  }, [tintMaterial, woundMaterial]);

  useEffect(
    () => () => {
      palm.geometry.dispose();
      tintMaterial.dispose();
      woundMaterial.dispose();
      palmBackMaterial.dispose();
      occluder.dispose();
    },
    [palm, tintMaterial, woundMaterial, palmBackMaterial, occluder],
  );

  const scratch = useMemo(
    () => ({
      lastVersion: -1,
      hasShape: false,
      opacity: 0,
      eye: new THREE.Vector3(),
      toEye: new THREE.Vector3(),
    }),
    [],
  );

  useFrame((_, delta) => {
    const hand = pose.current;
    const tint = tintRef.current;
    const wound = woundRef.current;
    const palmBack = palmBackRef.current;
    if (!hand || !tint || !wound || !palmBack) return;
    const s = scratch;

    // Rebuild the palm grid from this frame's joints (no smoothing here: the
    // webcam landmarks are already One Euro filtered).
    if (hand.tracked && hand.version !== s.lastVersion) {
      s.lastVersion = hand.version;
      s.hasShape = palm.update(hand.joints, hand.isRightHand, hand.surfaceOffset) || s.hasShape;
    }

    // A closed hand covers the palm, so the wound only shows while it's open.
    const wanted = hand.tracked && hand.open && textures !== null && s.hasShape;
    const fadeStep = delta / FADE_SECONDS;
    s.opacity = THREE.MathUtils.clamp(s.opacity + (wanted ? fadeStep : -fadeStep), 0, 1);

    // Fade out as the palm turns away from the viewer.
    const eye = gl.xr.isPresenting ? gl.xr.getCamera() : camera;
    eye.getWorldPosition(s.eye);
    const facing = s.toEye.subVectors(s.eye, palm.centre).normalize().dot(palm.normal);
    const angleFade = THREE.MathUtils.smoothstep(
      facing,
      Math.cos(THREE.MathUtils.degToRad(FADE_END_DEG)),
      Math.cos(THREE.MathUtils.degToRad(FADE_START_DEG)),
    );

    const opacity = s.opacity * angleFade;
    tintMaterial.opacity = opacity;
    woundMaterial.opacity = opacity;
    tint.visible = wound.visible = opacity > 0;

    // Relief in metres, scaled with the hand like everything else.
    const relief = palm.handScale * DISPLACEMENT_GAIN;
    woundMaterial.displacementScale = (INJURY_HEIGHT_MAX - INJURY_HEIGHT_MIN) * relief;
    woundMaterial.displacementBias = INJURY_HEIGHT_MIN * relief;

    // Keep the invisible hand in step with the wound so the real hand hides
    // it whenever the palm is turned away or fingers curl over it.
    const occluding = occlude && s.opacity > 0;
    occluder.root.visible = occluding;
    palmBack.visible = occluding;
    if (occluding) {
      palmBackMaterial.userData.backoff.value = PALM_BACKOFF * palm.handScale;
      occluder.update(hand.joints, palm.normal, palm.centre, palm.handScale);
    }
  });

  return (
    <>
      <primitive object={occluder.root} />
      <mesh
        ref={palmBackRef}
        geometry={palm.geometry}
        material={palmBackMaterial}
        frustumCulled={false}
        renderOrder={-1}
        visible={false}
      />
      <mesh
        ref={tintRef}
        geometry={palm.geometry}
        material={tintMaterial}
        frustumCulled={false}
        renderOrder={1}
        visible={false}
      />
      <mesh
        ref={woundRef}
        geometry={palm.geometry}
        material={woundMaterial}
        frustumCulled={false}
        renderOrder={2}
        visible={false}
      />
    </>
  );
}
