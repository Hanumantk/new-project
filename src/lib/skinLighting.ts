import { linearLuminance, srgbToLinear, type SkinSample } from './skinSampler';

/**
 * Turns a reading of the real skin into scene lighting, so the wound is lit
 * like the hand it sits on.
 *
 * The wound's colours were authored for a reference skin tone under neutral
 * light. A brighter or darker reading scales the lights (exposure); a warmer
 * or cooler one tints them (cast). Skin-coloured parts of the wound get an
 * albedo chosen so that, under those lights, they come out as the sampled
 * skin colour.
 */

/** Skin tone the wound textures were designed against (sRGB 0..255). */
export const REF_SKIN_SRGB = [205, 150, 125] as const;
export const REF_SKIN_LINEAR = REF_SKIN_SRGB.map((c) => srgbToLinear(c / 255)) as [number, number, number];
const REF_LUMINANCE = linearLuminance(...REF_SKIN_LINEAR);

/** Light levels that render the reference skin at its own colour. */
export const BASE_AMBIENT = 0.55;
export const BASE_DIRECTIONAL = 0.9;
/** How much of the skin's colour cast goes into the lights (the rest is in its albedo). */
const CAST_AMOUNT = 0.5;
const MIN_EXPOSURE = 0.3;
const MAX_EXPOSURE = 2.5;

export interface SkinLighting {
  exposure: number;
  /** Light colour, luminance 1 (linear RGB). */
  cast: [number, number, number];
  /** Albedo for skin-coloured parts of the wound (linear RGB). */
  skinAlbedo: [number, number, number];
  /** The skin as the camera sees it around the palm (linear RGB); null before a reading. */
  seen: [number, number, number] | null;
}

export function createSkinLighting(): SkinLighting {
  return { exposure: 1, cast: [1, 1, 1], skinAlbedo: [...REF_SKIN_LINEAR], seen: null };
}

export function lightingFromSkin(sample: SkinSample, out: SkinLighting): SkinLighting {
  if (!sample.valid || sample.luminance <= 0) {
    out.exposure = 1;
    out.cast = [1, 1, 1];
    out.skinAlbedo = [...REF_SKIN_LINEAR];
    out.seen = null;
    return out;
  }
  out.seen = [sample.color[0], sample.color[1], sample.color[2]];
  out.exposure = Math.min(Math.max(sample.luminance / REF_LUMINANCE, MIN_EXPOSURE), MAX_EXPOSURE);
  for (let c = 0; c < 3; c++) {
    const chroma = sample.color[c] / sample.luminance;
    const refChroma = REF_SKIN_LINEAR[c] / REF_LUMINANCE;
    out.cast[c] = 1 + (chroma / refChroma - 1) * CAST_AMOUNT;
  }
  const castLuminance = linearLuminance(...out.cast);
  for (let c = 0; c < 3; c++) out.cast[c] /= castLuminance;
  for (let c = 0; c < 3; c++) {
    out.skinAlbedo[c] = (REF_LUMINANCE * (sample.color[c] / sample.luminance)) / out.cast[c];
  }
  return out;
}
