import * as THREE from 'three';
import type { PalmSurface, WoundPlacement } from './palmModel';
import { REF_SKIN_LINEAR } from './skinLighting';

/**
 * Shaders that lay the wound (and everything that goes with it) onto the
 * palm's curved surface, and the wound's and bruise's materials.
 *
 * Everything is drawn in the canonical palm frame (the object's matrix is
 * the palm's rigid pose), so the GPU bends each vertex onto the surface
 * every frame from a handful of uniforms; nothing is rebuilt on the CPU.
 */

export interface ConformUniforms {
  /** Bilinear patch coefficients c0..c3. */
  palmSurf: { value: THREE.Vector4 };
  /** Bow centre x, z and radii x, z… */
  palmBow: { value: THREE.Vector4 };
  /** …and its depth. */
  palmBowDepth: { value: number };
  /** Wound centre x, z on the palm and the angle of its long axis. */
  woundPlace: { value: THREE.Vector3 };
  /** Extra height above the surface for everything (canonical metres). */
  surfLift: { value: number };
}

export function createConformUniforms(): ConformUniforms {
  return {
    palmSurf: { value: new THREE.Vector4() },
    palmBow: { value: new THREE.Vector4(0, 0, 0.04, 0.04) },
    palmBowDepth: { value: 0 },
    woundPlace: { value: new THREE.Vector3() },
    surfLift: { value: 0 },
  };
}

export function setConformUniforms(u: ConformUniforms, s: PalmSurface, p: WoundPlacement) {
  u.palmSurf.value.set(s.c0, s.c1, s.c2, s.c3);
  u.palmBow.value.set(s.bowX, s.bowZ, s.bowRx, s.bowRz);
  u.palmBowDepth.value = s.bowDepth;
  u.woundPlace.value.set(p.x, p.z, p.angle);
}

/**
 * The palm surface y = H(x, z) and the mapping from wound-local to palm
 * coordinates. Mirrors `palmHeight`, `woundToPalm` and `conformPoint` in
 * palmModel.ts.
 */
export const CONFORM_PARS = /* glsl */ `
  uniform vec4 palmSurf;
  uniform vec4 palmBow;
  uniform float palmBowDepth;
  uniform vec3 woundPlace;
  uniform float surfLift;

  float palmHeight(vec2 p, out vec2 grad) {
    float h = palmSurf.x + palmSurf.y * p.x + palmSurf.z * p.y + palmSurf.w * p.x * p.y;
    grad = vec2(palmSurf.y + palmSurf.w * p.y, palmSurf.z + palmSurf.w * p.x);
    vec2 d = (p - palmBow.xy) / palmBow.zw;
    float r2 = dot(d, d);
    if (r2 < 1.0) {
      float k = 1.0 - r2;
      h -= palmBowDepth * k * k;
      grad += 4.0 * palmBowDepth * k * d / palmBow.zw;
    }
    return h;
  }

  vec2 woundToPalm(vec2 w) {
    float c = cos(woundPlace.z);
    float s = sin(woundPlace.z);
    return vec2(woundPlace.x + w.x * c + w.y * s, woundPlace.y - w.x * s + w.y * c);
  }

  // Wound-local direction → palm (turned by the wound's angle about +Y).
  vec3 woundDirToPalm(vec3 v) {
    float c = cos(woundPlace.z);
    float s = sin(woundPlace.z);
    return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
  }

  // A point at height y above the palm point p (palm x, z): returns the
  // position, and the surface normal there in n.
  vec3 palmPoint(vec2 p, float y, out vec3 n) {
    vec2 g;
    float h = palmHeight(p, g);
    n = normalize(vec3(-g.x, 1.0, -g.y));
    return vec3(p.x, h, p.y) + n * (y + surfLift);
  }

  // A wound-local point laid onto the palm.
  vec3 conformPoint(vec3 local, out vec3 n) {
    return palmPoint(woundToPalm(local.xz), local.y, n);
  }

  // Tilts a direction from a flat palm onto a surface with normal n
  // (the rotation taking +Y to n).
  vec3 tiltTo(vec3 v, vec3 n) {
    vec3 k = vec3(n.z, 0.0, -n.x);
    return v + cross(k, v) + cross(k, cross(k, v)) / (1.0 + n.y);
  }
`;

/** Cheap value noise and fBm, shared by the wound and the bruise. */
const NOISE_GLSL = /* glsl */ `
  float woundHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float woundNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = woundHash(i);
    float b = woundHash(i + vec2(1.0, 0.0));
    float c = woundHash(i + vec2(0.0, 1.0));
    float d = woundHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float woundFbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * woundNoise(p);
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return v;
  }
`;

const srgb = (hex: string) => new THREE.Color(hex); // three converts hex (sRGB) to linear

/** Look of the wound. Colours are sRGB hex. */
export const WOUND_LOOK = {
  /** Deepest part of the cut, and the darker shade it falls to. */
  deep: '#5a0a0f',
  deepest: '#3a0508',
  /** The cut's walls (raw tissue). */
  wall: '#8b1a1a',
  /** The swollen rim: the real skin pushed this far towards inflamed red. */
  inflamed: '#b4473c',
  inflamedAmount: 0.45,
  /** Roughness of the wet cut and of the skin around it. */
  wetRoughness: 0.1,
  dryRoughness: 0.6,
  /** Wrapped-light subsurface scattering: how far light wraps round, and its tint. */
  sssWrap: 0.55,
  sssTint: '#ff5a3c',
  sssStrength: 0.55,
  /** Occlusion: how dark the deepest point and the creases get (0..1). */
  depthOcclusion: 0.6,
  creaseOcclusion: 0.45,
  /** Micro bumps (metres) on raw tissue and on skin, and their size (per metre). */
  microBumpWet: 0.00006,
  microBumpSkin: 0.00002,
  microBumpScale: 1400,
  /** Faint studio reflections (the environment is far brighter than a room). */
  envIntensity: 0.18,
} as const;

export interface WoundMaterialUniforms extends ConformUniforms {
  skinAlbedo: { value: THREE.Color };
  colDeep: { value: THREE.Color };
  colDeepest: { value: THREE.Color };
  colWall: { value: THREE.Color };
  colInflamed: { value: THREE.Color };
  inflamedAmount: { value: number };
  wetRoughness: { value: number };
  dryRoughness: { value: number };
  sssWrap: { value: number };
  sssTint: { value: THREE.Color };
  depthOcclusion: { value: number };
  creaseOcclusion: { value: number };
  microBump: { value: THREE.Vector3 };
}

/**
 * The wound: three's physical material, with the mesh bent onto the palm and
 *  - colour from height and nearness to the cut: dark blood deep down, raw
 *    red walls with mottling, the rim as the real skin swollen red, and the
 *    outer edge fading into the real skin (alpha falls to 0),
 *  - wet clearcoat and low roughness only in the cut,
 *  - occlusion from depth and creases,
 *  - procedural micro bumps,
 *  - a wrapped-light subsurface term tinted red.
 */
export function createWoundMaterial(): THREE.MeshPhysicalMaterial & { userData: { uniforms: WoundMaterialUniforms } } {
  const L = WOUND_LOOK;
  const material = new THREE.MeshPhysicalMaterial({
    transparent: true,
    roughness: L.dryRoughness,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMapIntensity: L.envIntensity,
    // Keep the authored colours; tone mapping washes reds out to pink.
    toneMapped: false,
  });
  const uniforms: WoundMaterialUniforms = {
    ...createConformUniforms(),
    skinAlbedo: { value: new THREE.Color().fromArray(REF_SKIN_LINEAR) },
    colDeep: { value: srgb(L.deep) },
    colDeepest: { value: srgb(L.deepest) },
    colWall: { value: srgb(L.wall) },
    colInflamed: { value: srgb(L.inflamed) },
    inflamedAmount: { value: L.inflamedAmount },
    wetRoughness: { value: L.wetRoughness },
    dryRoughness: { value: L.dryRoughness },
    sssWrap: { value: L.sssWrap },
    sssTint: { value: srgb(L.sssTint).multiplyScalar(L.sssStrength) },
    depthOcclusion: { value: L.depthOcclusion },
    creaseOcclusion: { value: L.creaseOcclusion },
    microBump: { value: new THREE.Vector3(L.microBumpWet, L.microBumpSkin, L.microBumpScale) },
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        ${CONFORM_PARS}
        attribute vec4 woundSurf;
        varying vec4 vWoundSurf;
        varying vec3 vWoundLocal;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 surfNormal;
        vec3 conformed = conformPoint(position, surfNormal);
        vec3 objectNormal = tiltTo(woundDirToPalm(normal), surfNormal);
        vWoundSurf = woundSurf;
        vWoundLocal = position;`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = conformed;');

    const sss = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
      'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
      `reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
      // Light scattered under the surface wraps past the terminator, reddened.
      float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + sssWrap ) / ( 1.0 + sssWrap ) );
      reflectedLight.directDiffuse += max( wrapNL - dotNL, 0.0 ) * directLight.color * sssTint * BRDF_Lambert( material.diffuseContribution );`,
    );
    if (sss === THREE.ShaderChunk.lights_physical_pars_fragment) console.warn('Wound: subsurface hook not found');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 skinAlbedo;
        uniform vec3 colDeep;
        uniform vec3 colDeepest;
        uniform vec3 colWall;
        uniform vec3 colInflamed;
        uniform float inflamedAmount;
        uniform float wetRoughness;
        uniform float dryRoughness;
        uniform float sssWrap;
        uniform vec3 sssTint;
        uniform float depthOcclusion;
        uniform float creaseOcclusion;
        uniform vec3 microBump;
        varying vec4 vWoundSurf;
        varying vec3 vWoundLocal;
        float woundWet = 0.0;
        float woundAO = 1.0;
        ${NOISE_GLSL}
        // Bump mapping from a procedural height (Mikkelsen's surface gradient).
        vec3 woundBump(vec3 surfPos, vec3 n, float height) {
          vec3 dpx = dFdx(surfPos);
          vec3 dpy = dFdy(surfPos);
          vec3 r1 = cross(dpy, n);
          vec3 r2 = cross(n, dpx);
          float det = dot(dpx, r1);
          vec3 grad = sign(det) * (dFdx(height) * r1 + dFdy(height) * r2);
          return normalize(abs(det) * n - grad);
        }`,
      )
      .replace('#include <lights_physical_pars_fragment>', sss)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float height = vWoundSurf.x;
        float inward = vWoundSurf.y;
        float crease = vWoundSurf.z;
        float cut = vWoundSurf.w;
        float depth = clamp(-height, 0.0, 1.0);
        float rise = clamp(height, 0.0, 1.0);
        vec2 np = vWoundLocal.xz * 900.0;
        float mottle = woundFbm(np);
        float fine = woundFbm(np * 3.1 + 5.0);

        // Rim: the real skin, swollen and inflamed, most at the top of the lips.
        vec3 rimCol = mix(skinAlbedo, colInflamed, inflamedAmount * smoothstep(0.0, 0.9, inward) * (0.55 + 0.45 * rise) * (0.8 + 0.4 * mottle));
        // Raw tissue on the lips' inner faces and the cut's walls, then blood in its depths.
        vec3 wallCol = colWall * (0.7 + 0.55 * mottle) * (0.9 + 0.2 * fine);
        vec3 deepCol = mix(colDeep, colDeepest, smoothstep(0.55, 1.0, depth) * (0.7 + 0.3 * fine));
        vec3 woundCol = mix(rimCol, wallCol, smoothstep(0.05, 0.85, cut));
        woundCol = mix(woundCol, deepCol, smoothstep(0.2, 0.8, depth));
        diffuseColor.rgb = woundCol;
        // The outer edge melts into the real skin.
        diffuseColor.a *= smoothstep(0.0, 1.0, inward);

        // Wet only in the cut (with a few drier patches on its walls).
        woundWet = smoothstep(0.55, 0.95, cut) * smoothstep(0.15, 0.45, mottle + 0.3 * depth);
        // Occlusion from depth and creases.
        woundAO = 1.0 - depthOcclusion * pow(depth, 1.3) - creaseOcclusion * crease * (0.6 + 0.4 * cut);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(dryRoughness, wetRoughness, woundWet);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          float bumpAmp = mix(microBump.y, microBump.x, smoothstep(0.2, 0.8, cut));
          float bumpH = (woundFbm(vWoundLocal.xz * microBump.z) + 0.5 * woundNoise(vWoundLocal.xz * microBump.z * 3.7)) * bumpAmp;
          normal = woundBump(-vViewPosition, normal, bumpH);
        }`,
      )
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = clearcoat * woundWet;')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        woundAO = clamp(woundAO, 0.0, 1.0);
        reflectedLight.indirectDiffuse *= woundAO;
        reflectedLight.indirectSpecular *= woundAO;
        reflectedLight.directDiffuse *= mix(1.0, woundAO, 0.75);
        reflectedLight.directSpecular *= mix(1.0, woundAO, 0.5);`,
      );
  };
  material.customProgramCacheKey = () => 'wound-glb';
  return material as THREE.MeshPhysicalMaterial & { userData: { uniforms: WoundMaterialUniforms } };
}

export interface BruiseUniforms extends ConformUniforms {
  opacity: { value: number };
  /** Wound half-width and half-length (wound-local metres). */
  woundHalf: { value: THREE.Vector2 };
  skinRef: { value: THREE.Color };
  bruiseCol: { value: THREE.Color };
  rednessCol: { value: THREE.Color };
  strength: { value: number };
}

/** The bruise and contact shadow around the wound. Colours are sRGB hex. */
export const BRUISE_LOOK = {
  /** Purple-blue bruise, and the inflamed red closer in. */
  bruise: '#7a5a8c',
  redness: '#c0625a',
  strength: 0.65,
  /** How far beyond the wound the bruise spreads (multiples of its half-width). */
  spread: 2.4,
} as const;

/**
 * The bruise: a plane around the wound laid onto the palm. In webcam mode it
 * multiplies the camera picture (the real skin's texture and noise show
 * through); in a headset it's laid over the passthrough.
 */
export function createBruiseMaterial(multiply: boolean): THREE.ShaderMaterial & { uniforms: BruiseUniforms } {
  const B = BRUISE_LOOK;
  const uniforms: BruiseUniforms = {
    ...createConformUniforms(),
    opacity: { value: 0 },
    woundHalf: { value: new THREE.Vector2(0.008, 0.025) },
    skinRef: { value: new THREE.Color().fromArray(REF_SKIN_LINEAR) },
    bruiseCol: { value: srgb(B.bruise) },
    rednessCol: { value: srgb(B.redness) },
    strength: { value: B.strength },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    defines: multiply ? { MULTIPLY: '' } : {},
    vertexShader: /* glsl */ `
      ${CONFORM_PARS}
      varying vec2 vLocal;
      void main() {
        vec3 n;
        vec3 p = conformPoint(vec3(position.x, 0.0, position.z), n);
        vLocal = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float opacity;
      uniform vec2 woundHalf;
      uniform vec3 skinRef;
      uniform vec3 bruiseCol;
      uniform vec3 rednessCol;
      uniform float strength;
      varying vec2 vLocal;
      ${NOISE_GLSL}
      void main() {
        // Distance from the wound's outline, measured in wound half-widths:
        // a stadium (capsule) around its long axis.
        float along = max(abs(vLocal.y) - (woundHalf.y - woundHalf.x), 0.0);
        float d = length(vec2(vLocal.x, along)) / woundHalf.x; // 1 = the wound's edge
        float mottle = woundFbm(vLocal * 260.0);
        float blotch = woundFbm(vLocal * 90.0 + 3.0);
        float spread = ${B.spread.toFixed(2)} * (0.8 + 0.5 * blotch);
        float bruise = (1.0 - smoothstep(0.6, spread, d)) * (0.65 + 0.5 * mottle);
        float red = 1.0 - smoothstep(0.8, 1.5, d);
        // Contact shadow just outside the swollen rim.
        float shadow = smoothstep(0.75, 1.0, d) * (1.0 - smoothstep(1.0, 1.35, d));
        vec3 tint = mix(bruiseCol, rednessCol, red * 0.7);
        float amount = clamp(bruise * strength, 0.0, 1.0) * opacity;
        vec3 factor = mix(vec3(1.0), clamp(tint / skinRef, 0.0, 1.0), amount);
        factor *= 1.0 - 0.22 * shadow * opacity;
        #ifdef MULTIPLY
          // The framebuffer holds sRGB-encoded colour: encode the (linear) factor to match.
          gl_FragColor = vec4(pow(factor, vec3(1.0 / 2.2)), 1.0);
        #else
          // Over passthrough: the bruise colour, as strong as the multiply would darken.
          float a = clamp(1.0 - dot(factor, vec3(0.333)), 0.0, 1.0) * 1.6;
          gl_FragColor = vec4(tint * skinRef / max(dot(skinRef, vec3(0.333)), 1e-3) * 0.9, clamp(a, 0.0, 1.0));
          #include <colorspace_fragment>
        #endif
      }
    `,
    transparent: true,
    depthWrite: false,
    ...(multiply
      ? {
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.ZeroFactor,
          blendDst: THREE.SrcColorFactor,
        }
      : {}),
  });
  return material as THREE.ShaderMaterial & { uniforms: BruiseUniforms };
}

/**
 * Depth-only palm: a grid over the palm (−1..1 → its extent) pushed `lift`
 * below the skin, so the real palm hides whatever is behind it. Also used as
 * the debug wireframe of the palm surface.
 */
export function createPalmSurfaceMaterial(
  kind: 'depth' | 'wire',
): THREE.ShaderMaterial & { uniforms: ConformUniforms & { palmExtent: { value: THREE.Vector4 }; lift: { value: number } } } {
  const uniforms = {
    ...createConformUniforms(),
    /** Centre x, z and half-extents x, z of the grid. */
    palmExtent: { value: new THREE.Vector4(0, 0, 0.05, 0.05) },
    lift: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      ${CONFORM_PARS}
      uniform vec4 palmExtent;
      uniform float lift;
      void main() {
        vec3 n;
        vec3 p = palmPoint(palmExtent.xy + position.xz * palmExtent.zw, lift, n);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader:
      kind === 'depth'
        ? 'void main() { gl_FragColor = vec4(0.0); }'
        : 'void main() { gl_FragColor = vec4(0.49, 0.94, 0.69, 0.7); }',
    side: THREE.DoubleSide,
    colorWrite: kind !== 'depth',
    wireframe: kind === 'wire',
    transparent: kind === 'wire',
    depthTest: kind !== 'wire',
  });
  return material as THREE.ShaderMaterial & { uniforms: typeof uniforms };
}

/** Lines in wound-local coordinates bent onto the palm (the debug bounding box). */
export function createConformLineMaterial(color: string): THREE.ShaderMaterial & { uniforms: ConformUniforms } {
  const material = new THREE.ShaderMaterial({
    uniforms: createConformUniforms() as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      ${CONFORM_PARS}
      void main() {
        vec3 n;
        vec3 p = conformPoint(position, n);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `uniform vec3 lineColor; void main() { gl_FragColor = vec4(lineColor, 1.0); }`,
    depthTest: false,
    transparent: true,
  });
  material.uniforms.lineColor = { value: new THREE.Color(color) };
  return material as THREE.ShaderMaterial & { uniforms: ConformUniforms };
}
