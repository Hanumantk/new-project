import * as THREE from 'three';

/**
 * The headset wound's material, seen over passthrough. Its skin tone comes
 * from the camera when the headset allows it, otherwise from the panel.
 *
 * Per vertex the wound carries `woundSurf` (computed at load, before
 * skinning; see woundGeometry.ts): x = height −1 (cut bottom) … 0 (skin
 * level, the outer edge) … +1 (top of the rim), y = distance in from the outer
 * edge 0..1, z = crease 0..1, w = nearness to the cut 0..1.
 */

/** Look of the headset wound (sRGB hex where a colour). */
export const XR_WOUND_LOOK = {
  inflamed: '#c9585a',
  inflamedAmount: 0.35,
  wall: '#8b1a1a',
  blood: '#5a0a0f',
  bloodDeep: '#3a0508',
  /** Warm wrapped light on the rim (fake subsurface scattering). */
  sssWrap: 0.6,
  sssTint: '#ff6a4a',
  sssStrength: 0.5,
  depthOcclusion: 0.65,
  /** Matching passthrough: slightly less saturation and contrast, a little noise. */
  saturation: 0.9,
  contrast: 0.94,
  noise: 0.012,
  envIntensity: 0.4,
} as const;

const srgb = (hex: string) => new THREE.Color(hex);

const NOISE = /* glsl */ `
  float xwHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float xwNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(xwHash(i), xwHash(i + vec2(1, 0)), f.x), mix(xwHash(i + vec2(0, 1)), xwHash(i + vec2(1, 1)), f.x), f.y);
  }
  float xwFbm(vec2 p) { return 0.55 * xwNoise(p) + 0.3 * xwNoise(p * 2.1 + 3.0) + 0.15 * xwNoise(p * 4.3 + 7.0); }
`;

export type XRWoundMaterial = THREE.MeshPhysicalMaterial & { userData: { uniforms: { skinTone: { value: THREE.Color } } } };

export function createXRWoundMaterial(): XRWoundMaterial {
  const L = XR_WOUND_LOOK;
  const material = new THREE.MeshPhysicalMaterial({
    transparent: true,
    roughness: 0.6,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: L.envIntensity,
    toneMapped: false,
    // Always wins over the palm slab just below it.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  const uniforms = {
    skinTone: { value: srgb('#cf9a78') },
    colInflamed: { value: srgb(L.inflamed) },
    colWall: { value: srgb(L.wall) },
    colBlood: { value: srgb(L.blood) },
    colBloodDeep: { value: srgb(L.bloodDeep) },
    sssWrap: { value: L.sssWrap },
    sssTint: { value: srgb(L.sssTint).multiplyScalar(L.sssStrength) },
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 woundSurf;\nvarying vec4 vSurf;\nvarying vec2 vLocal;\nvarying vec3 vFlatNormal;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = woundSurf;\nvLocal = position.xz;')
      .replace(
        '#include <defaultnormal_vertex>',
        `#include <defaultnormal_vertex>
        // The palm's own normal here (model +Y, bent by the same skinning), for shading relative to a flat palm.
        vec3 flatNormal = vec3(0.0, 1.0, 0.0);
        #ifdef USE_SKINNING
          flatNormal = (skinMatrix * vec4(flatNormal, 0.0)).xyz;
        #endif
        vFlatNormal = normalize(normalMatrix * flatNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 skinTone;
        uniform vec3 colInflamed;
        uniform vec3 colWall;
        uniform vec3 colBlood;
        uniform vec3 colBloodDeep;
        uniform float sssWrap;
        uniform vec3 sssTint;
        varying vec4 vSurf;
        varying vec2 vLocal;
        varying vec3 vFlatNormal;
        float xwWet = 0.0;
        float xwRim = 0.0;
        float xwAO = 1.0;
        // Skin-coloured share of this point (0 in the cut), and the light on its
        // actual surface vs. on a flat palm at the same spot.
        float xwSkin = 0.0;
        vec3 xwShapeIrr = vec3(0.0);
        vec3 xwFlatIrr = vec3(0.0);
        ${NOISE}`,
      )
      .replace(
        '#include <lights_physical_pars_fragment>',
        THREE.ShaderChunk.lights_physical_pars_fragment
          .replace(
            'vec3 irradiance = dotNL * directLight.color;',
            `vec3 irradiance = dotNL * directLight.color;
            // Soft light on the skin-coloured lips (wrapped well round), so their slopes never go grey.
            float softNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.9 ) / 1.9 );
            xwShapeIrr += mix( dotNL, softNL, xwSkin ) * directLight.color;
            xwFlatIrr += saturate( dot( normalize( vFlatNormal ), directLight.direction ) ) * directLight.color;`,
          )
          .replace(
            'vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - singleScattering - multiScattering );',
            `vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - singleScattering - multiScattering );
            xwShapeIrr += irradiance;
            xwFlatIrr += irradiance;`,
          )
          .replace(
          'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
          `reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
          // Fleshy rim: light wraps past the terminator, warm (fake subsurface scattering).
          float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + sssWrap ) / ( 1.0 + sssWrap ) );
          reflectedLight.directDiffuse += max( wrapNL - dotNL, 0.0 ) * xwRim * directLight.color * sssTint * BRDF_Lambert( material.diffuseContribution );`,
        ),
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float height = vSurf.x;
        float inward = vSurf.y;
        float crease = vSurf.z;
        float cut = vSurf.w;
        float rise = clamp(height, 0.0, 1.0);
        float depth = clamp(-height, 0.0, 1.0);
        float n1 = xwFbm(vLocal * 700.0);
        float n2 = xwFbm(vLocal * 2200.0 + 11.0);
        // Outer edge: the skin; rising rim: towards inflamed red-pink.
        xwRim = smoothstep(0.0, 0.6, inward) * (1.0 - smoothstep(0.3, 0.9, cut));
        vec3 col = mix(skinTone, colInflamed, ${L.inflamedAmount.toFixed(2)} * smoothstep(0.05, 0.8, rise) * smoothstep(0.1, 0.8, inward) * (0.8 + 0.4 * n1));
        // Inner walls: raw flesh with subtle variation.
        vec3 wall = colWall * (0.75 + 0.45 * n1) * (0.9 + 0.2 * n2);
        col = mix(col, wall, smoothstep(0.1, 0.8, cut));
        // Cut bottom: dark wet blood.
        vec3 blood = mix(colBlood, colBloodDeep, smoothstep(0.5, 1.0, depth) * (0.7 + 0.3 * n2));
        col = mix(col, blood, smoothstep(0.25, 0.75, depth));
        diffuseColor.rgb = col;
        // Real passthrough skin shows at the edge and everywhere near skin
        // level, so no lit copy of the skin can form a grey ring round the wound.
        diffuseColor.a *= smoothstep(0.0, 1.0, inward) * smoothstep(0.05, 0.45, rise + cut);
        xwSkin = 1.0 - smoothstep(0.1, 0.8, cut);
        xwWet = smoothstep(0.3, 0.7, depth) * smoothstep(0.5, 0.9, cut);
        // Darkening only in and right by the cut.
        xwAO = 1.0 - ${L.depthOcclusion.toFixed(2)} * pow(depth, 1.2) - 0.35 * crease * cut;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.6, 0.1, xwWet);',
      )
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = clearcoat * xwWet;')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        xwAO = clamp(xwAO, 0.0, 1.0);
        reflectedLight.indirectDiffuse *= xwAO;
        // Reflections only on the wet cut (on dry skin they read as a grey sheen).
        reflectedLight.indirectSpecular *= xwAO * mix(0.15, 1.0, xwWet);
        reflectedLight.directDiffuse *= mix(1.0, xwAO, 0.7);`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          // Skin-coloured parts: the skin tone itself, shaded only by how their
          // shape catches the light compared with a flat palm.
          vec3 shapeShade = xwShapeIrr / max(xwFlatIrr, vec3(1e-4));
          outgoingLight = mix(outgoingLight, diffuseColor.rgb * shapeShade, xwSkin);
          // The raw parts sit in passthrough: a little less saturation and contrast.
          float luma = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
          vec3 graded = mix(vec3(luma), outgoingLight, ${L.saturation.toFixed(2)});
          graded = (graded - 0.18) * ${L.contrast.toFixed(2)} + 0.18;
          outgoingLight = mix(graded, outgoingLight, xwSkin);
          outgoingLight *= 1.0 + (xwHash(gl_FragCoord.xy) - 0.5) * ${(L.noise * 2).toFixed(3)};
          outgoingLight = max(outgoingLight, 0.0);
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'xr-wound';
  return material as XRWoundMaterial;
}

/** The skin tone for a preset colour and a fine adjustment (0..1, 0.5 = as is): brightness ±15%, a slight hue shift. */
const hsl = { h: 0, s: 0, l: 0 };
export function skinToneColor(hex: string, fine: number, out: THREE.Color) {
  out.set(hex);
  out.getHSL(hsl);
  out.setHSL(hsl.h + (fine - 0.5) * 0.04, hsl.s, THREE.MathUtils.clamp(hsl.l * (1 + (fine - 0.5) * 0.3), 0, 1));
  return out;
}
