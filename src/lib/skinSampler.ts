import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

/**
 * Reads the real skin around the wound from the camera picture, so the
 * wound can be lit and tinted to match it and given the camera's grain.
 * Everything is read from small offscreen canvases, never the full frame.
 */

/** What the scene uses to match the camera. Colours are linear RGB, 0..1. */
export interface SkinSample {
  valid: boolean;
  /** Mean skin colour in the ring around the wound (linear RGB). */
  color: [number, number, number];
  /** Its relative luminance (linear). */
  luminance: number;
  /** Camera noise as a standard deviation in sRGB 0..1 units. */
  noise: number;
}

export function createSkinSample(): SkinSample {
  return { valid: false, color: [0.5, 0.33, 0.25], luminance: 0.36, noise: 0.012 };
}

export interface Ring {
  /** Centre and radii in pixels of the sampled image. */
  cx: number;
  cy: number;
  inner: number;
  outer: number;
}

export interface RingStats {
  /** Mean sRGB colour, 0..255. */
  r: number;
  g: number;
  b: number;
  count: number;
}

/** Even-odd point-in-polygon test; polygon as flat [x0, y0, x1, y1, …]. */
export function insidePolygon(x: number, y: number, polygon: ArrayLike<number>): boolean {
  let inside = false;
  const n = polygon.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2];
    const yi = polygon[i * 2 + 1];
    const xj = polygon[j * 2];
    const yj = polygon[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Mean colour of the pixels in an annulus that also lie inside the palm
 * outline (so the background and the wound area itself are left out).
 */
export function ringStats(
  data: ArrayLike<number>,
  width: number,
  height: number,
  ring: Ring,
  palmOutline: ArrayLike<number>,
): RingStats {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const x0 = Math.max(0, Math.floor(ring.cx - ring.outer));
  const x1 = Math.min(width - 1, Math.ceil(ring.cx + ring.outer));
  const y0 = Math.max(0, Math.floor(ring.cy - ring.outer));
  const y1 = Math.min(height - 1, Math.ceil(ring.cy + ring.outer));
  const in2 = ring.inner * ring.inner;
  const out2 = ring.outer * ring.outer;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d2 = (px - ring.cx) ** 2 + (py - ring.cy) ** 2;
      if (d2 < in2 || d2 > out2 || !insidePolygon(px, py, palmOutline)) continue;
      const o = (y * width + x) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      count++;
    }
  }
  return count ? { r: r / count, g: g / count, b: b / count, count } : { r: 0, g: 0, b: 0, count: 0 };
}

/**
 * Camera noise from a small full-resolution patch: the mean absolute
 * Laplacian of luminance, converted to the standard deviation of white
 * noise that would produce it (std of 4c−n−s−e−w is √20·σ; E|x| = σ·√(2/π)).
 * Returns σ in 0..255 units.
 */
export function estimateNoise(data: ArrayLike<number>, width: number, height: number): number {
  const lum = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    return 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  };
  let sum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const lap = 4 * lum(x, y) - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1);
      sum += Math.abs(lap);
      count++;
    }
  }
  if (!count) return 0;
  return sum / count / (Math.sqrt(20) * Math.sqrt(2 / Math.PI));
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearLuminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const COLOR_WIDTH = 128;
const COLOR_HEIGHT = 72;
const NOISE_SIZE = 24;
/** Ring around the wound, as fractions of the wrist → middle-knuckle length. */
const RING_INNER = 0.36;
const RING_OUTER = 0.62;
/** Exponential smoothing of the readings (lighting changes slowly). */
const COLOR_EASE = 0.25;
const NOISE_EASE = 0.15;
const MIN_PIXELS = 12;

/** Samples colour every frame it's called and noise every `noiseEvery` calls. */
export class SkinSampler {
  private readonly colorCanvas = document.createElement('canvas');
  private readonly noiseCanvas = document.createElement('canvas');
  private readonly colorCtx: CanvasRenderingContext2D;
  private readonly noiseCtx: CanvasRenderingContext2D;
  private readonly outline = new Float32Array(14);
  private calls = 0;

  constructor(private readonly noiseEvery = 15) {
    this.colorCanvas.width = COLOR_WIDTH;
    this.colorCanvas.height = COLOR_HEIGHT;
    this.noiseCanvas.width = this.noiseCanvas.height = NOISE_SIZE;
    this.colorCtx = this.colorCanvas.getContext('2d', { willReadFrequently: true })!;
    this.noiseCtx = this.noiseCanvas.getContext('2d', { willReadFrequently: true })!;
  }

  update(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    landmarks: NormalizedLandmark[],
    out: SkinSample,
  ) {
    const W = COLOR_WIDTH;
    const H = COLOR_HEIGHT;
    this.colorCtx.drawImage(source, 0, 0, W, H);
    const image = this.colorCtx.getImageData(0, 0, W, H);

    // Palm outline: wrist, thumb base, knuckles, then the heel (the thumb
    // base mirrored across the wrist → middle-knuckle axis).
    const px = (i: number) => landmarks[i].x * W;
    const py = (i: number) => landmarks[i].y * H;
    const ax = px(9) - px(0);
    const ay = py(9) - py(0);
    const len = Math.hypot(ax, ay) || 1;
    const ux = ax / len;
    const uy = ay / len;
    const vx = px(1) - px(0);
    const vy = py(1) - py(0);
    const along = vx * ux + vy * uy;
    const heelX = px(0) + 2 * along * ux - vx;
    const heelY = py(0) + 2 * along * uy - vy;
    const o = this.outline;
    [0, 1, 5, 9, 13, 17].forEach((lm, k) => {
      o[k * 2] = px(lm);
      o[k * 2 + 1] = py(lm);
    });
    o[12] = heelX;
    o[13] = heelY;

    const ring: Ring = {
      cx: (px(0) + px(9)) / 2,
      cy: (py(0) + py(9)) / 2,
      inner: RING_INNER * len,
      outer: RING_OUTER * len,
    };
    const stats = ringStats(image.data, W, H, ring, o);
    if (stats.count >= MIN_PIXELS) {
      const lin = [srgbToLinear(stats.r / 255), srgbToLinear(stats.g / 255), srgbToLinear(stats.b / 255)];
      const ease = out.valid ? COLOR_EASE : 1;
      for (let c = 0; c < 3; c++) out.color[c] += (lin[c] - out.color[c]) * ease;
      out.luminance = linearLuminance(out.color[0], out.color[1], out.color[2]);
      out.valid = true;
    }

    // Noise: a small full-resolution patch of palm skin beside the wound.
    if (this.calls++ % this.noiseEvery === 0) {
      const sx = ((ring.cx + (ring.inner + ring.outer) / 2 * -uy) / W) * sourceWidth;
      const sy = ((ring.cy + (ring.inner + ring.outer) / 2 * ux) / H) * sourceHeight;
      const x = Math.round(Math.min(Math.max(sx - NOISE_SIZE / 2, 0), sourceWidth - NOISE_SIZE));
      const y = Math.round(Math.min(Math.max(sy - NOISE_SIZE / 2, 0), sourceHeight - NOISE_SIZE));
      this.noiseCtx.drawImage(source, x, y, NOISE_SIZE, NOISE_SIZE, 0, 0, NOISE_SIZE, NOISE_SIZE);
      const patch = this.noiseCtx.getImageData(0, 0, NOISE_SIZE, NOISE_SIZE);
      const sigma = estimateNoise(patch.data, NOISE_SIZE, NOISE_SIZE) / 255;
      out.noise += (Math.min(sigma, 0.06) - out.noise) * NOISE_EASE;
    }
  }
}
