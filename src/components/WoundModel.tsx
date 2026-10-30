import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FingerCoverage } from '../lib/fingerCoverage';
import { HandOccluder } from '../lib/handOccluder';
import type { HandPose } from '../lib/handPose';
import { LAYER_DEBUG, LAYER_MAIN, LAYER_OCCLUDER, LAYER_WOUND } from '../lib/layers';
import {
  conformPoint,
  createPalmSurface,
  fitPalmSurface,
  placeWound,
  type Vec3,
  type WoundPlacement,
} from '../lib/palmModel';
import type { SkinLighting } from '../lib/skinLighting';
import { normaliseWound, type WoundGeometryInfo } from '../lib/woundGeometry';
import {
  BRUISE_LOOK,
  createBruiseMaterial,
  createConformLineMaterial,
  createPalmSurfaceMaterial,
  createWoundMaterial,
  setConformUniforms,
  type ConformUniforms,
} from '../lib/woundShaders';

const WOUND_URL = `${import.meta.env.BASE_URL}models/Wound.glb`;

/** The wound sits this far above the palm surface (metres), so it never dips into the depth stand-in. */
const WOUND_LIFT = 0.0003;
/** The palm's depth stand-in sits this far below the skin (below the deepest cut). */
const PALM_BACKOFF = 0.006;
/** …and reaches this far past the palm's landmarks. */
const PALM_GROWTH = 1.15;
/** The wound fades out as the palm turns away: fully shown up to 55°, gone by 75°. */
const FADE_START_DEG = 55;
const FADE_END_DEG = 75;
const FADE_SECONDS = 0.2;
/**
 * When fingers hide this share of the wound (as the viewer sees it), fade the whole
 * wound out rather than show slivers of it between and over the fingers.
 */
const COVERED_FADE_START = 0.2;
const COVERED_FADE_END = 0.45;
const COVERED_EASE_SECONDS = 0.12;
/** Points on the wound sampled for finger coverage. */
const COVERAGE_SAMPLES = 48;

interface WoundModelProps {
  /** The tracked hand, filled each frame by a pose source (webcam or headset). */
  pose: RefObject<HandPose>;
  /**
   * Hide the wound behind an invisible stand-in for the real hand. Needed when
   * the real hand is seen (webcam video, passthrough); off when a visible
   * virtual hand is drawn, which hides the wound by itself.
   */
  occlude?: boolean;
  /**
   * Webcam mode: the bruise multiplies into the camera picture, and the wound
   * goes on its own layer for the compositor's camera-matching pass.
   * Otherwise (headset passthrough) both are drawn directly.
   */
  composite?: boolean;
  /** Light matching from the real skin (webcam mode). */
  lighting?: RefObject<SkinLighting>;
  /** User-set wound opacity, 0..1 (scales the wound and bruise together). */
  strength?: RefObject<number>;
  /** Show the palm surface as a wireframe… */
  debugSurface?: boolean;
  /** …and the wound's bounding box. */
  debugBox?: boolean;
}

/**
 * The 3D wound from public/models/Wound.glb, glued to the palm: its group's
 * matrix is the palm's rigid pose (set once per frame, from the same camera
 * frame the picture shows), and the GPU bends it onto the palm's curved
 * surface. With it: the bruise around it, depth stand-ins for the palm and
 * fingers, and the debug overlays.
 */
export function WoundModel({
  pose,
  occlude = true,
  composite = false,
  lighting,
  strength,
  debugSurface = false,
  debugBox = false,
}: WoundModelProps) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const [info, setInfo] = useState<WoundGeometryInfo | null>(null);
  const groupRef = useRef<THREE.Group>(null);
  const woundRef = useRef<THREE.Mesh>(null);
  const bruiseRef = useRef<THREE.Mesh>(null);
  const palmRef = useRef<THREE.Mesh>(null);
  const wireRef = useRef<THREE.Mesh>(null);
  const boxRef = useRef<THREE.LineSegments>(null);

  const woundMaterial = useMemo(() => createWoundMaterial(), []);
  const bruiseMaterial = useMemo(() => createBruiseMaterial(composite), [composite]);
  const palmMaterial = useMemo(() => createPalmSurfaceMaterial('depth'), []);
  const wireMaterial = useMemo(() => createPalmSurfaceMaterial('wire'), []);
  const boxMaterial = useMemo(() => createConformLineMaterial('#ffd34d'), []);
  const occluder = useMemo(() => new HandOccluder({ palmPlate: false }), []);
  // A grid over −1..1 in x/z, mapped onto the palm by the shader.
  const palmGrid = useMemo(() => new THREE.PlaneGeometry(2, 2, 24, 24).rotateX(-Math.PI / 2), []);

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
        loaded = normaliseWound(geometry);
        (geometry as THREE.BufferGeometry).dispose();
        setInfo(loaded);
      })
      .catch((error) => console.error('Could not load the wound model', error));
    return () => {
      cancelled = true;
      loaded?.geometry.dispose();
    };
  }, []);

  // The bruise plane and the debug box follow the wound's size.
  const bruiseGeometry = useMemo(() => {
    if (!info) return null;
    const reach = info.halfWidth * BRUISE_LOOK.spread * 1.35;
    return new THREE.PlaneGeometry(2 * (info.halfWidth + reach), 2 * (info.halfLength + reach), 32, 64).rotateX(-Math.PI / 2);
  }, [info]);
  const boxGeometry = useMemo(() => {
    if (!info) return null;
    const box = info.geometry.boundingBox!;
    const s = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    return new THREE.EdgesGeometry(new THREE.BoxGeometry(s.x, s.y, s.z)).translate(c.x, c.y, c.z);
  }, [info]);
  useEffect(() => () => bruiseGeometry?.dispose(), [bruiseGeometry]);
  useEffect(() => () => boxGeometry?.dispose(), [boxGeometry]);

  // Layers: in webcam mode the wound is rendered in its own pass; the depth
  // stand-ins take part in both passes.
  useEffect(() => {
    occluder.root.traverse((o) => o.layers.enable(LAYER_OCCLUDER));
    palmRef.current?.layers.enable(LAYER_OCCLUDER);
    woundRef.current?.layers.set(composite ? LAYER_WOUND : LAYER_MAIN);
    wireRef.current?.layers.set(LAYER_DEBUG);
    boxRef.current?.layers.set(LAYER_DEBUG);
  }, [occluder, composite, info]);

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

  useEffect(() => () => bruiseMaterial.dispose(), [bruiseMaterial]);
  useEffect(
    () => () => {
      woundMaterial.dispose();
      palmMaterial.dispose();
      wireMaterial.dispose();
      boxMaterial.dispose();
      palmGrid.dispose();
      occluder.dispose();
    },
    [woundMaterial, palmMaterial, wireMaterial, boxMaterial, palmGrid, occluder],
  );

  const scratch = useMemo(
    () => ({
      templateVersion: -2,
      surface: createPalmSurface(),
      placement: { x: 0, z: 0, angle: 0 } as WoundPlacement,
      samples: [] as Vec3[],
      sampleLocal: [] as number[],
      local: { x: 0, y: 0, z: 0 } as Vec3,
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      eye: new THREE.Vector3(),
      toEye: new THREE.Vector3(),
      coverage: new FingerCoverage(),
      lastVersion: -1,
      opacity: 0,
      uncoveredTarget: 1,
      uncovered: 1,
    }),
    [],
  );

  // Coverage samples: wound vertices spread over its inner part.
  useEffect(() => {
    if (!info) return;
    const pos = info.geometry.getAttribute('position');
    const surf = info.geometry.getAttribute('woundSurf');
    const picked: number[] = [];
    const step = Math.max(1, Math.floor(pos.count / (COVERAGE_SAMPLES * 4)));
    for (let i = 0; i < pos.count && picked.length < COVERAGE_SAMPLES * 3; i += step) {
      if (surf.getY(i) > 0.6) picked.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    scratch.sampleLocal = picked;
    scratch.samples = Array.from({ length: picked.length / 3 }, () => ({ x: 0, y: 0, z: 0 }));
  }, [info, scratch]);

  useFrame((_, delta) => {
    const hand = pose.current;
    const group = groupRef.current;
    const wound = woundRef.current;
    const bruise = bruiseRef.current;
    const palmMesh = palmRef.current;
    const wire = wireRef.current;
    const box = boxRef.current;
    if (!hand || !group || !wound || !bruise || !palmMesh || !wire || !box || !info) return;
    const s = scratch;
    const palm = hand.palm;
    // Shown only once the palm's shape is captured, so it never shifts on it.
    const placed = hand.tracked && palm.valid && palm.templateVersion !== -1;

    if (placed) {
      // The surface and the wound's place on it change only with the template.
      if (palm.templateVersion !== s.templateVersion) {
        s.templateVersion = palm.templateVersion;
        fitPalmSurface(palm.template, s.surface);
        placeWound(palm.template, s.placement);
        for (const u of [woundMaterial.userData.uniforms, bruiseMaterial.uniforms, palmMaterial.uniforms, wireMaterial.uniforms, boxMaterial.uniforms] as ConformUniforms[]) {
          setConformUniforms(u, s.surface, s.placement);
        }
        const cx = (s.surface.minX + s.surface.maxX) / 2;
        const cz = (s.surface.minZ + s.surface.maxZ) / 2;
        const hx = ((s.surface.maxX - s.surface.minX) / 2) * PALM_GROWTH;
        const hz = ((s.surface.maxZ - s.surface.minZ) / 2) * PALM_GROWTH;
        palmMaterial.uniforms.palmExtent.value.set(cx, cz, hx, hz);
        wireMaterial.uniforms.palmExtent.value.set(cx, cz, hx, hz);
      }

      // The palm's rigid pose, raised to the skin when the joints sit below it.
      s.normal.set(0, 1, 0).applyQuaternion(palm.quaternion);
      s.position.copy(palm.position).addScaledVector(s.normal, hand.surfaceOffset);
      s.scale.setScalar(palm.scale);
      group.matrix.compose(s.position, palm.quaternion, s.scale);
      group.matrixWorldNeedsUpdate = true;

      const lift = WOUND_LIFT;
      woundMaterial.userData.uniforms.surfLift.value = lift;
      bruiseMaterial.uniforms.surfLift.value = lift * 0.5;
      boxMaterial.uniforms.surfLift.value = lift;
      palmMaterial.uniforms.lift.value = -PALM_BACKOFF;

      // How much of the wound do the fingers hide, as seen by the viewer?
      if (hand.version !== s.lastVersion) {
        s.lastVersion = hand.version;
        const view = coverageView(gl, camera, size);
        if (view) {
          const covered = s.coverage.measure(
            s.samples.length,
            (i, out) => {
              const l = s.sampleLocal;
              conformPoint(s.surface, s.placement, l[i * 3], l[i * 3 + 1], l[i * 3 + 2], lift, s.local);
              return out.set(s.local.x, s.local.y, s.local.z).applyMatrix4(group.matrix);
            },
            hand.joints,
            view.camera,
            view.width,
            view.height,
            palm.scale,
          );
          s.uncoveredTarget = 1 - THREE.MathUtils.smoothstep(covered, COVERED_FADE_START, COVERED_FADE_END);
        }
      }
    }

    // A closed hand covers the palm, so the wound only shows while it's open.
    const wanted = placed && hand.open;
    const fadeStep = delta / FADE_SECONDS;
    s.opacity = THREE.MathUtils.clamp(s.opacity + (wanted ? fadeStep : -fadeStep), 0, 1);

    // Fade out as the palm turns away from the viewer.
    const eye = gl.xr.isPresenting ? gl.xr.getCamera() : camera;
    eye.getWorldPosition(s.eye);
    const facing = s.toEye.subVectors(s.eye, s.position).normalize().dot(s.normal);
    const angleFade = THREE.MathUtils.smoothstep(
      facing,
      Math.cos(THREE.MathUtils.degToRad(FADE_END_DEG)),
      Math.cos(THREE.MathUtils.degToRad(FADE_START_DEG)),
    );

    // Fade out while fingers cover most of it (eased, so it doesn't flicker).
    if (s.opacity === 0) s.uncovered = s.uncoveredTarget;
    else s.uncovered += (s.uncoveredTarget - s.uncovered) * Math.min(1, delta / COVERED_EASE_SECONDS);

    const opacity = s.opacity * angleFade * s.uncovered * THREE.MathUtils.clamp(strength?.current ?? 1, 0, 1);
    woundMaterial.opacity = opacity;
    bruiseMaterial.uniforms.opacity.value = opacity;
    wound.visible = bruise.visible = opacity > 0;
    wire.visible = debugSurface && placed;
    box.visible = debugBox && placed;

    // The rim and torn skin take on the real skin's colour.
    const light = lighting?.current;
    if (light) woundMaterial.userData.uniforms.skinAlbedo.value.fromArray(light.skinAlbedo);

    // Keep the invisible hand in step so the real hand hides the wound
    // whenever the palm is turned away or fingers curl over it.
    const occluding = occlude && s.opacity > 0 && placed;
    occluder.root.visible = occluding;
    palmMesh.visible = occluding;
    if (occluding) occluder.update(hand.joints, s.normal, s.position, palm.scale);
  });

  return (
    <>
      <primitive object={occluder.root} />
      <group ref={groupRef} matrixAutoUpdate={false}>
        <mesh ref={palmRef} geometry={palmGrid} material={palmMaterial} frustumCulled={false} renderOrder={-1} visible={false} />
        {bruiseGeometry && (
          <mesh ref={bruiseRef} geometry={bruiseGeometry} material={bruiseMaterial} frustumCulled={false} renderOrder={1} visible={false} />
        )}
        {info && (
          <mesh ref={woundRef} geometry={info.geometry} material={woundMaterial} frustumCulled={false} renderOrder={2} visible={false} />
        )}
        <mesh ref={wireRef} geometry={palmGrid} material={wireMaterial} frustumCulled={false} renderOrder={10} visible={false} />
        {boxGeometry && (
          <lineSegments ref={boxRef} geometry={boxGeometry} material={boxMaterial} frustumCulled={false} renderOrder={11} visible={false} />
        )}
      </group>
    </>
  );
}

/**
 * The camera (and a pixel size matching its aspect) to judge finger coverage
 * from: the webcam scene's camera, or in a headset the left eye's.
 */
function coverageView(
  gl: THREE.WebGLRenderer,
  camera: THREE.Camera,
  size: { width: number; height: number },
): { camera: THREE.PerspectiveCamera; width: number; height: number } | null {
  if (gl.xr.isPresenting) {
    const eye = gl.xr.getCamera().cameras[0];
    if (!eye) return null;
    const p = eye.projectionMatrix.elements;
    return { camera: eye, width: (1000 * p[5]) / p[0], height: 1000 };
  }
  return camera instanceof THREE.PerspectiveCamera ? { camera, width: size.width, height: size.height } : null;
}
