import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { computeCover, createCoverRect } from '../lib/coverMapping';
import { LAYER_DEBUG, LAYER_MAIN, LAYER_OCCLUDER, LAYER_WOUND } from '../lib/layers';
import { BASE_AMBIENT, BASE_DIRECTIONAL, lightingFromSkin, type SkinLighting } from '../lib/skinLighting';
import type { TrackingState } from '../lib/tracking';

/** Blur of the wound layer, in camera pixels: never sharper than the video. */
const BLUR_CAMERA_PX = 0.7;
/** Slight grading so the wound sits in the webcam's flatter, softer colour. */
const SATURATION = 0.92;
const CONTRAST = 0.95;
/** Grain bounds (sRGB standard deviation) in case the noise reading is off. */
const MIN_GRAIN = 0.004;
const MAX_GRAIN = 0.05;

const compositeVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const compositeFragment = /* glsl */ `
  uniform sampler2D woundLayer;
  uniform vec2 blurStep;      // offset between blur taps, in UV
  uniform float grain;        // uniform-noise amplitude, sRGB units
  uniform float grainCell;    // device pixels per camera pixel
  uniform float seed;
  uniform float saturation;
  uniform float contrast;
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }
  vec3 toSRGB(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  vec4 tap(vec2 o) { return texture2D(woundLayer, vUv + o * blurStep); }

  void main() {
    // 3x3 binomial blur (σ = tap spacing / √2) on premultiplied colour.
    vec4 c = tap(vec2(0.0)) * 0.25
      + (tap(vec2(1.0, 0.0)) + tap(vec2(-1.0, 0.0)) + tap(vec2(0.0, 1.0)) + tap(vec2(0.0, -1.0))) * 0.125
      + (tap(vec2(1.0, 1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, -1.0))) * 0.0625;
    if (c.a < 0.002) discard;

    vec3 col = toSRGB(c.rgb / c.a);
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, saturation);
    col = (col - 0.5) * contrast + 0.5;
    // Grain the size of a camera pixel, changing every frame like sensor noise.
    col += (hash(floor(gl_FragCoord.xy / grainCell) + seed) - 0.5) * grain;
    col = clamp(col, 0.0, 1.0);
    gl_FragColor = vec4(col * c.a, c.a); // premultiplied, sRGB-encoded like the framebuffer
  }
`;

interface WebcamCompositorProps {
  tracking: RefObject<TrackingState>;
  lighting: RefObject<SkinLighting>;
  debug: boolean;
}

/**
 * Renders the webcam scene so the wound matches the camera: lights follow
 * the real skin; the wound is drawn on its own, softened, graded and given
 * the camera's grain, then laid over the picture (the bruise is multiplied
 * into the picture in the main pass, so real skin shows through it).
 */
export function WebcamCompositor({ tracking, lighting, debug }: WebcamCompositorProps) {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const directionalRef = useRef<THREE.DirectionalLight>(null);

  const pass = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    const material = new THREE.ShaderMaterial({
      vertexShader: compositeVertex,
      fragmentShader: compositeFragment,
      uniforms: {
        woundLayer: { value: target.texture },
        blurStep: { value: new THREE.Vector2() },
        grain: { value: 0 },
        grainCell: { value: 1 },
        seed: { value: 0 },
        saturation: { value: SATURATION },
        contrast: { value: CONTRAST },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    return {
      target,
      material,
      scene,
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      drawingBuffer: new THREE.Vector2(),
      clearColor: new THREE.Color(),
      cover: createCoverRect(),
    };
  }, []);

  useEffect(
    () => () => {
      pass.target.dispose();
      pass.material.dispose();
      (pass.scene.children[0] as THREE.Mesh).geometry.dispose();
    },
    [pass],
  );

  // Lights reach every layer, so the wound pass is lit too.
  useEffect(() => {
    ambientRef.current?.layers.enableAll();
    directionalRef.current?.layers.enableAll();
  }, []);

  // Before anything renders: light the scene like the real skin.
  useFrame(() => {
    const state = tracking.current;
    const light = lighting.current;
    const ambient = ambientRef.current;
    const directional = directionalRef.current;
    if (!state || !light || !ambient || !directional) return;
    lightingFromSkin(state.skin, light);
    ambient.color.setRGB(...light.cast);
    directional.color.setRGB(...light.cast);
    ambient.intensity = BASE_AMBIENT * light.exposure;
    directional.intensity = BASE_DIRECTIONAL * light.exposure;
  }, -1);

  // Take over rendering (positive priority): the passes below.
  useFrame((state) => {
    const { scene, camera } = state;
    const tracked = tracking.current;

    gl.getDrawingBufferSize(pass.drawingBuffer);
    const { x: width, y: height } = pass.drawingBuffer;
    if (pass.target.width !== width || pass.target.height !== height) pass.target.setSize(width, height);

    // Camera-matching parameters: how big one camera pixel is on screen.
    const frame = tracked?.frame;
    const cameraPx =
      frame && frame.width
        ? computeCover(pass.cover, size.width, size.height, frame.width, frame.height).scale * gl.getPixelRatio()
        : 1;
    const u = pass.material.uniforms;
    const step = BLUR_CAMERA_PX * cameraPx * Math.SQRT2;
    u.blurStep.value.set(step / width, step / height);
    const noise = THREE.MathUtils.clamp(tracked?.skin.noise ?? 0.01, MIN_GRAIN, MAX_GRAIN);
    u.grain.value = noise * Math.sqrt(12); // uniform noise with that standard deviation
    u.grainCell.value = Math.max(cameraPx, 1);
    u.seed.value = ((tracked?.frameId ?? 0) % 997) * 0.731;

    const autoClear = gl.autoClear;
    gl.getClearColor(pass.clearColor);
    const clearAlpha = gl.getClearAlpha();

    // 1. Camera picture, depth stand-ins, bruise (multiplied into the picture).
    camera.layers.set(LAYER_MAIN);
    gl.setRenderTarget(null);
    gl.render(scene, camera);

    // 2. The wound on its own, behind the same depth stand-ins.
    camera.layers.set(LAYER_WOUND);
    camera.layers.enable(LAYER_OCCLUDER);
    gl.setRenderTarget(pass.target);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, camera);
    gl.setClearColor(pass.clearColor, clearAlpha);

    // 3. Softened, graded, grained wound over the picture.
    gl.setRenderTarget(null);
    gl.autoClear = false;
    gl.render(pass.scene, pass.camera);

    // 4. Debug overlays, untouched.
    if (debug) {
      camera.layers.set(LAYER_DEBUG);
      gl.render(scene, camera);
    }

    gl.autoClear = autoClear;
    camera.layers.set(LAYER_MAIN);
  }, 1);

  return (
    <>
      <ambientLight ref={ambientRef} intensity={BASE_AMBIENT} />
      <directionalLight ref={directionalRef} position={[0.6, 1, 0.8]} intensity={BASE_DIRECTIONAL} />
    </>
  );
}
