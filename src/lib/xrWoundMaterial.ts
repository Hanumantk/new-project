import * as THREE from 'three';

/**
 * The headset wound's material, seen over passthrough. Its skin tone comes
 * from the camera when the headset allows it, otherwise from the panel.
 *
 * Per vertex the wound carries `woundSurf` (computed at load, before
 * skinning; see woundGeometry.ts): x = height −1 (cut bottom) … 0 (skin
 * level, the outer edge) … +1 (top of the rim), y = distance in from the outer
 * edge 0..1, z = crease 0..1, w = nearness to the cut 0..1.
 *
 * The build stages (woundSteps.ts) are this same mesh and material: uStage
 * (0 = finished wound, 1…6) picks the shape (bare skin, wax mound or the
 * sculpted wound, moved along `palmUp` before skinning) and the look;
 * uStageFrom and uStageBlend (0..1) blend from the previous stage. Stages 0
 * and 5 are the finished wound exactly; stage 6 is it aged (Stage_6.glb):
 * the lips shaded dark brown, the cut a deeper red, the blood less glossy.
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
  /** Build stages: the dashed guide line (stage 1), the wax's lift over the skin (2–3), the powdered inside of the cut (3), the bruise (4). */
  guide: '#46607a',
  waxLighten: 0.12,
  cutPowder: '#b9a2a0',
  bruise: '#6e4f6a',
  bruiseAmount: 0.3,
  /** Stage 6, measured from Stage_6.glb against Stage_5.glb: the lips' and the cut's colour multipliers, and how much gloss the drying blood loses. */
  agedLips: [0.68, 0.59, 0.59],
  agedCut: [0.73, 0.64, 0.66],
  agedDry: 0.3,
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

export interface XRWoundUniforms {
  skinTone: { value: THREE.Color };
  uStage: { value: number };
  uStageFrom: { value: number };
  uStageBlend: { value: number };
  /** The wound's half-width and half-length (m, before scaling), for the stage 1 guide line. */
  uHalf: { value: THREE.Vector2 };
}

export type XRWoundMaterial = THREE.MeshPhysicalMaterial & { userData: { uniforms: XRWoundUniforms } };

/** Per stage: (flat, mound) shape weights; the sculpted wound is the rest. */
const SHAPE = /* glsl */ `
  uniform float uStage;
  uniform float uStageFrom;
  uniform float uStageBlend;
  vec2 xwShapeOf(float s) {
    if (s > 0.5 && s < 1.5) return vec2(1.0, 0.0);
    if (s > 1.5 && s < 2.5) return vec2(0.0, 1.0);
    return vec2(0.0);
  }
  float xwBlend() { return smoothstep(0.0, 1.0, uStageBlend); }
  vec2 xwShape() { return mix(xwShapeOf(uStageFrom), xwShapeOf(uStage), xwBlend()); }
`;

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
    colGuide: { value: srgb(L.guide) },
    colPowder: { value: srgb(L.cutPowder) },
    colBruise: { value: srgb(L.bruise) },
    uStage: { value: 0 },
    uStageFrom: { value: 0 },
    uStageBlend: { value: 1 },
    uHalf: { value: new THREE.Vector2(0.01, 0.04) },
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 woundSurf;
        attribute vec2 woundShape;
        attribute vec3 moundNormal;
        attribute vec3 palmUp;
        varying vec4 vSurf;
        varying vec2 vLocal;
        ${SHAPE}`,
      )
      // The stage's shape, before skinning (so it moves with the palm exactly as the wound does).
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vec2 xwW = xwShape();
        if (xwW.x + xwW.y > 0.0) objectNormal = normalize(objectNormal * (1.0 - xwW.x - xwW.y) + palmUp * xwW.x + moundNormal * xwW.y);`,
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSurf = woundSurf;\nvLocal = position.xz;\ntransformed += palmUp * dot(xwW, woundShape);',
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
        uniform vec3 colGuide;
        uniform vec3 colPowder;
        uniform vec3 colBruise;
        uniform vec2 uHalf;
        varying vec4 vSurf;
        varying vec2 vLocal;
        float xwWet = 0.0;
        float xwRim = 0.0;
        float xwAO = 1.0;
        float xwCoat = 0.0;
        float xwRough = 0.6;
        float xwRaw = 0.0;
        ${NOISE}
        ${SHAPE}
        struct XwLook { vec3 col; float alpha; float wet; float coat; float rough; float ao; float rim; float raw; };
        XwLook xwMix(XwLook a, XwLook b, float t) {
          if (t >= 1.0) return b;
          return XwLook(mix(a.col, b.col, t), mix(a.alpha, b.alpha, t), mix(a.wet, b.wet, t), mix(a.coat, b.coat, t),
            mix(a.rough, b.rough, t), mix(a.ao, b.ao, t), mix(a.rim, b.rim, t), mix(a.raw, b.raw, t));
        }
        // A build stage's look; stages 0 and 5 are the finished wound, as given.
        XwLook xwStageLook(float s, XwLook done, float inward, float cut, float depth, float rise, float n1, float n2) {
          if (s > 5.5) {
            // Aged: a smudgy dark brown shadow on the lips, a deeper red in the cut, drier blood.
            float lips = max(smoothstep(0.0, 0.35, cut), 0.9 * smoothstep(0.3, 0.9, rise)) * (1.0 - smoothstep(0.75, 1.0, cut)) * (0.75 + 0.5 * n1);
            float inCut = smoothstep(0.7, 1.0, cut);
            vec3 shade = mix(vec3(1.0), vec3(${L.agedLips.join(', ')}), clamp(lips, 0.0, 1.0));
            shade *= mix(vec3(1.0), vec3(${L.agedCut.join(', ')}), inCut);
            float wet = done.wet * (1.0 - ${L.agedDry.toFixed(2)});
            return XwLook(done.col * shade, done.alpha, wet, wet, mix(0.6, 0.1, wet), done.ao, done.rim, done.raw);
          }
          if (s < 0.5 || s > 4.5) return done;
          float edge = smoothstep(0.0, 1.0, inward);
          if (s < 1.5) {
            // Spirit gum: a faint glossy film in the outline, and a dashed guide line just inside its edge.
            float band = smoothstep(0.2, 0.3, inward) * (1.0 - smoothstep(0.45, 0.55, inward));
            float dash = step(0.5, fract(atan(vLocal.y / uHalf.y, vLocal.x / uHalf.x) * 5.73));
            float line = band * dash;
            return XwLook(mix(skinTone * 1.05, colGuide, line), mix(0.22 * edge, 0.85, line), 0.0, 0.7 * (1.0 - line), mix(0.15, 0.6, line), 1.0, 0.0, 0.0);
          }
          vec3 wax = mix(skinTone, vec3(1.0), ${L.waxLighten.toFixed(2)}) * (0.98 + 0.04 * xwFbm(vLocal * 250.0));
          if (s < 2.5) return XwLook(wax, edge, 0.0, 0.0, 0.85, 1.0, 0.25, 0.0);
          float inCut = smoothstep(0.1, 0.8, cut);
          if (s < 3.5) {
            // Sculpted: wax lips, a pale powdered pinkish-grey inside the cut.
            vec3 powder = colPowder * (0.9 + 0.15 * n1) * (1.0 - 0.18 * depth);
            return XwLook(mix(wax, powder, inCut), edge, 0.0, 0.0, 0.9, done.ao, 0.25, 0.5 * inCut);
          }
          // Coloured: rim matched to the skin, raw red in the cut, a bruise around it; still matte.
          vec3 col = skinTone * (0.97 + 0.06 * n1);
          float bruise = (1.0 - smoothstep(0.2, 0.8, cut)) * (1.0 - smoothstep(0.5, 1.0, rise)) * (0.7 + 0.6 * n1);
          col = mix(col, colBruise, ${L.bruiseAmount.toFixed(2)} * bruise);
          vec3 flesh = mix(colWall * (0.75 + 0.45 * n1) * (0.9 + 0.2 * n2), colBloodDeep * 1.4, smoothstep(0.4, 1.0, depth));
          col = mix(col, flesh, inCut);
          return XwLook(col, edge, 0.0, 0.0, 0.75, done.ao, done.rim, done.raw);
        }`,
      )
      .replace(
        '#include <lights_physical_pars_fragment>',
        THREE.ShaderChunk.lights_physical_pars_fragment.replace(
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
        // Real passthrough skin shows at the outermost vertices.
        float doneWet = smoothstep(0.3, 0.7, depth) * smoothstep(0.5, 0.9, cut);
        XwLook done = XwLook(col, smoothstep(0.0, 1.0, inward), doneWet, doneWet, mix(0.6, 0.1, doneWet),
          1.0 - ${L.depthOcclusion.toFixed(2)} * pow(depth, 1.2) - 0.35 * crease * cut, xwRim, smoothstep(0.1, 0.8, cut));
        XwLook look = xwMix(
          xwStageLook(uStageFrom, done, inward, cut, depth, rise, n1, n2),
          xwStageLook(uStage, done, inward, cut, depth, rise, n1, n2),
          xwBlend());
        diffuseColor.rgb = look.col;
        diffuseColor.a *= look.alpha;
        xwWet = look.wet;
        xwCoat = look.coat;
        xwRough = look.rough;
        xwAO = look.ao;
        xwRim = look.rim;
        xwRaw = look.raw;`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = xwRough;',
      )
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = clearcoat * xwCoat;')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        xwAO = clamp(xwAO, 0.0, 1.0);
        reflectedLight.indirectDiffuse *= xwAO;
        // Reflections only on the wet cut (on dry skin they read as a grey sheen).
        reflectedLight.indirectSpecular *= xwAO * mix(0.15, 1.0, xwCoat);
        reflectedLight.directDiffuse *= mix(1.0, xwAO, 0.7);`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          // The raw parts sit in passthrough: a little less saturation and
          // contrast (not the skin-coloured rim, which it would grey).
          float rawPart = xwRaw;
          float luma = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
          vec3 graded = mix(vec3(luma), outgoingLight, ${L.saturation.toFixed(2)});
          graded = (graded - 0.18) * ${L.contrast.toFixed(2)} + 0.18;
          outgoingLight = mix(outgoingLight, graded, rawPart);
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
