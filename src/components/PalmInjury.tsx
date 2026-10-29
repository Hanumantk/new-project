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
import { LAYER_DEBUG, LAYER_OCCLUDER, LAYER_WOUND } from '../lib/layers';
import { PalmMesh } from '../lib/palmMesh';
import { REF_SKIN_LINEAR, type SkinLighting } from '../lib/skinLighting';

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
/** How strongly the wound's skin-coloured parts take on the real skin's colour. */
const SKIN_MATCH = 0.75;
/** How much the displacement depth darkens the cut's cavity (ambient occlusion). */
const CAVITY_OCCLUSION = 0.5;
/** Bruise strength when multiplied into the camera picture. */
const BRUISE_STRENGTH = 0.7;

/** Soft falloff across the outer 20% of the palm grid, so no edge ever shows. */
const FEATHER_GLSL = /* glsl */ `
  float gridFeather(vec2 grid) {
    float edge = max(abs(grid.x), abs(grid.y));
    return 1.0 - smoothstep(0.78, 0.98, edge);
  }
`;

interface PalmInjuryProps {
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
  /** Show the palm grid as a wireframe. */
  debug?: boolean;
}

export function PalmInjury({ pose, occlude = true, composite = false, lighting, debug = false }: PalmInjuryProps) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const [textures, setTextures] = useState<InjuryTextures | null>(null);
  const tintRef = useRef<THREE.Mesh>(null);
  const woundRef = useRef<THREE.Mesh>(null);
  const palmBackRef = useRef<THREE.Mesh>(null);
  const wireRef = useRef<THREE.Mesh>(null);

  // One grid laid over the palm, shared by the bruise layer, the wound, the
  // depth stand-in for the palm and the debug wireframe.
  const palm = useMemo(() => new PalmMesh(), []);

  const tintMaterial = useMemo(
    () => (composite ? createMultiplyTintMaterial() : createOverlayTintMaterial()),
    [composite],
  );
  const woundMaterial = useMemo(() => createWoundMaterial(), []);
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
    material.customProgramCacheKey = () => 'palm-back';
    material.userData.backoff = backoff;
    return material;
  }, []);
  const wireMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#7cf0b0', wireframe: true, transparent: true, opacity: 0.6, depthTest: false }),
    [],
  );
  const occluder = useMemo(() => new HandOccluder({ palmPlate: false }), []);

  // Layers: in webcam mode the wound is rendered in its own pass; the depth
  // stand-ins must take part in both passes.
  useEffect(() => {
    occluder.root.traverse((o) => o.layers.enable(LAYER_OCCLUDER));
    palmBackRef.current?.layers.enable(LAYER_OCCLUDER);
    if (woundRef.current) {
      if (composite) woundRef.current.layers.set(LAYER_WOUND);
      else woundRef.current.layers.set(0);
    }
    wireRef.current?.layers.set(LAYER_DEBUG);
  }, [occluder, composite]);

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
      woundMaterial.map = t.wound;
      woundMaterial.normalMap = t.normal;
      woundMaterial.roughnessMap = t.surface;
      woundMaterial.displacementMap = t.surface;
      woundMaterial.userData.uniforms.surfaceMap.value = t.surface;
      woundMaterial.needsUpdate = true;
      setTextures(t);
    });
    return () => {
      cancelled = true;
      loaded?.dispose();
    };
  }, [woundMaterial]);

  // The bruise material can be swapped (mode change); give it the texture.
  useEffect(() => {
    if (!textures) return;
    if (tintMaterial instanceof THREE.ShaderMaterial) tintMaterial.uniforms.tintMap.value = textures.tint;
    else tintMaterial.map = textures.tint;
    tintMaterial.needsUpdate = true;
  }, [textures, tintMaterial]);

  useEffect(() => () => tintMaterial.dispose(), [tintMaterial]);
  useEffect(
    () => () => {
      palm.geometry.dispose();
      woundMaterial.dispose();
      palmBackMaterial.dispose();
      wireMaterial.dispose();
      occluder.dispose();
    },
    [palm, woundMaterial, palmBackMaterial, wireMaterial, occluder],
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
    const wire = wireRef.current;
    if (!hand || !tint || !wound || !palmBack || !wire) return;
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
    if (tintMaterial instanceof THREE.ShaderMaterial) tintMaterial.uniforms.opacity.value = opacity;
    else tintMaterial.opacity = opacity;
    woundMaterial.opacity = opacity;
    tint.visible = wound.visible = opacity > 0;
    wire.visible = debug && hand.tracked && s.hasShape;

    // Relief in metres, scaled with the hand like everything else.
    const relief = palm.handScale * DISPLACEMENT_GAIN;
    woundMaterial.displacementScale = (INJURY_HEIGHT_MAX - INJURY_HEIGHT_MIN) * relief;
    woundMaterial.displacementBias = INJURY_HEIGHT_MIN * relief;

    // Skin-coloured parts of the wound take on the real skin's colour.
    const u = woundMaterial.userData.uniforms;
    const light = lighting?.current;
    if (light) {
      u.skinAlbedo.value.fromArray(light.skinAlbedo);
      u.skinMatch.value = SKIN_MATCH;
    } else {
      u.skinMatch.value = 0;
    }

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
      <mesh
        ref={wireRef}
        geometry={palm.geometry}
        material={wireMaterial}
        frustumCulled={false}
        renderOrder={10}
        visible={false}
      />
    </>
  );
}

/**
 * The lit wound. On top of three's physical material:
 *  - clearcoat only where the blood mask (surface B) says it's wet,
 *  - the displacement depth (surface R) darkens the cut's cavity,
 *  - skin-coloured parts (surface A) take on the real skin's colour,
 *  - the palm grid's border fades out.
 */
function createWoundMaterial() {
  const material = new THREE.MeshPhysicalMaterial({
    transparent: true,
    depthWrite: false,
    roughness: 1, // scaled per pixel by the roughness map (surface G)
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    normalScale: new THREE.Vector2(NORMAL_STRENGTH, NORMAL_STRENGTH),
    // The studio environment is far brighter than a real room; keep its
    // reflections faint so wet blood shows highlights, not a white sheet.
    envMapIntensity: 0.06,
    // Keep the authored wound colours; tone mapping washes reds out to pink.
    toneMapped: false,
  });
  const uniforms = {
    surfaceMap: { value: null as THREE.Texture | null },
    skinAlbedo: { value: new THREE.Color().fromArray(REF_SKIN_LINEAR) },
    skinMatch: { value: 0 },
    cavityOcclusion: { value: CAVITY_OCCLUSION },
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec2 gridCoord;\nvarying vec2 vGrid;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGrid = gridCoord;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform sampler2D surfaceMap;
        uniform vec3 skinAlbedo;
        uniform float skinMatch;
        uniform float cavityOcclusion;
        varying vec2 vGrid;
        float woundWet = 0.0;
        ${FEATHER_GLSL}
        void main() {`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec4 woundSurface = texture2D(surfaceMap, vMapUv);
        woundWet = woundSurface.b;
        // Torn and scraped skin takes the real skin's hue, keeping its shading.
        vec3 matchedSkin = skinAlbedo * (luminance(diffuseColor.rgb) / max(luminance(skinAlbedo), 1e-4));
        diffuseColor.rgb = mix(diffuseColor.rgb, matchedSkin, woundSurface.a * skinMatch);
        // Ambient occlusion from the displacement depth (0.5 = skin level).
        diffuseColor.rgb *= mix(1.0, smoothstep(0.0, 0.42, woundSurface.r), cavityOcclusion);
        diffuseColor.a *= gridFeather(vGrid);`,
      )
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = clearcoat * woundWet;');
  };
  material.customProgramCacheKey = () => 'palm-wound';
  return material;
}

/**
 * Webcam bruise: multiplies the camera picture, so the real skin's texture
 * and noise show through. Outputs a multiply factor; the framebuffer holds
 * sRGB-encoded colour, so the (linear) factor is encoded to match.
 */
function createMultiplyTintMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      tintMap: { value: null },
      opacity: { value: 0 },
      skinRef: { value: new THREE.Color().fromArray(REF_SKIN_LINEAR) },
      strength: { value: BRUISE_STRENGTH },
    },
    vertexShader: /* glsl */ `
      attribute vec2 gridCoord;
      varying vec2 vUv;
      varying vec2 vGrid;
      void main() {
        vUv = uv;
        vGrid = gridCoord;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tintMap;
      uniform float opacity;
      uniform vec3 skinRef;
      uniform float strength;
      varying vec2 vUv;
      varying vec2 vGrid;
      ${FEATHER_GLSL}
      void main() {
        vec4 tint = texture2D(tintMap, vUv); // linear (sRGB texture)
        float amount = tint.a * strength * opacity * gridFeather(vGrid);
        vec3 factor = mix(vec3(1.0), clamp(tint.rgb / skinRef, 0.0, 1.0), amount);
        gl_FragColor = vec4(pow(factor, vec3(1.0 / 2.2)), 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
  });
}

/** Headset bruise: passthrough can't be multiplied, so it's laid over, feathered. */
function createOverlayTintMaterial() {
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec2 gridCoord;\nvarying vec2 vGrid;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGrid = gridCoord;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `varying vec2 vGrid;\n${FEATHER_GLSL}\nvoid main() {`)
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= gridFeather(vGrid);');
  };
  material.customProgramCacheKey = () => 'palm-tint-overlay';
  return material;
}
