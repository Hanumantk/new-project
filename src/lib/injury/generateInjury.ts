/**
 * Procedural maps for a fresh palm laceration: a curved gash with a smaller
 * branching cut, raw flesh walls with blood pooled at the bottom, swollen
 * torn edges, blood oozing out on the wrist side with drips and splatter, a
 * scrape with pinpoint bleeding, and bruising / inflammation around it.
 *
 * Pure maths on typed arrays (no three.js, no DOM) so it can run in a worker.
 * Units are millimetres on a square patch of palm; +Y points to the wrist.
 */

/** Side length of the square patch of palm the maps cover, in metres. */
export const INJURY_PATCH_SIZE = 0.07;
/** Height range encoded in the surface map's red channel, in metres. */
export const INJURY_HEIGHT_MIN = -0.0012;
export const INJURY_HEIGHT_MAX = 0.0012;

export interface InjuryMaps {
  size: number;
  /** Unlit skin discolouration (bruising, inflammation), sRGB + alpha. */
  tint: Uint8Array;
  /** Lit wound colour, sRGB + alpha. */
  wound: Uint8Array;
  /** Tangent-space normals. */
  normal: Uint8Array;
  /** R: height (displacement), G: roughness. */
  surface: Uint8Array;
}

type RGB = readonly [number, number, number];

const PATCH_MM = INJURY_PATCH_SIZE * 1000;
const HEIGHT_MIN_MM = INJURY_HEIGHT_MIN * 1000;
const HEIGHT_RANGE_MM = (INJURY_HEIGHT_MAX - INJURY_HEIGHT_MIN) * 1000;

/** Colours given to fully transparent pixels so filtering doesn't pull in black. */
const TINT_FALLBACK = [196, 42, 46, 0];
const WOUND_FALLBACK = [120, 10, 16, 0];

const FLESH_EDGE: RGB = [200, 78, 74];
const FLESH_MID: RGB = [142, 24, 30];
const FLESH_DEEP: RGB = [58, 6, 10];
const FAT: RGB = [214, 182, 118];
const BLOOD_THICK: RGB = [112, 5, 11];
const BLOOD_THIN: RGB = [168, 18, 24];
const BLOOD_POOL: RGB = [86, 3, 8];
const MARGIN_PALE: RGB = [222, 150, 136];
const MARGIN_RAW: RGB = [184, 96, 90];
const BRUISE_INNER: RGB = [84, 30, 72];
const BRUISE_OUTER: RGB = [132, 120, 60];
const INFLAMED: RGB = [188, 72, 70];

// ---------------------------------------------------------------- noise ---

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise in 0..1. */
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRGB = (out: number[], a: RGB, b: RGB, t: number) => {
  out[0] = mix(a[0], b[0], t);
  out[1] = mix(a[1], b[1], t);
  out[2] = mix(a[2], b[2], t);
  return out;
};

// ------------------------------------------------------------- geometry ---

interface Arc {
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
}

/** Circular arc from A to B bowing sideways by `bulge` mm. */
function arcThrough(ax: number, ay: number, bx: number, by: number, bulge: number): Arc {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const len = Math.hypot(bx - ax, by - ay);
  const nx = -(by - ay) / len;
  const ny = (bx - ax) / len;
  const r = (len * len) / 4 / (2 * bulge) + bulge / 2;
  const cx = mx + nx * (r - bulge);
  const cy = my + ny * (r - bulge);
  let a0 = Math.atan2(ay - cy, ax - cx);
  let a1 = Math.atan2(by - cy, bx - cx);
  let delta = a1 - a0;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < 0) {
    [a0, a1] = [a1, a0];
    delta = -delta;
  }
  return { cx, cy, r, a0, a1: a0 + delta };
}

const arcHit = { d: 0, t: 0 };

/** Distance to an arc (arcHit.d) and the position along it, 0..1 (arcHit.t). */
function arcDistance(px: number, py: number, arc: Arc) {
  const dx = px - arc.cx;
  const dy = py - arc.cy;
  let ang = Math.atan2(dy, dx);
  while (ang < arc.a0) ang += 2 * Math.PI;
  if (ang <= arc.a1) {
    arcHit.d = Math.abs(Math.hypot(dx, dy) - arc.r);
    arcHit.t = (ang - arc.a0) / (arc.a1 - arc.a0);
    return;
  }
  const d0 = Math.hypot(px - (arc.cx + arc.r * Math.cos(arc.a0)), py - (arc.cy + arc.r * Math.sin(arc.a0)));
  const d1 = Math.hypot(px - (arc.cx + arc.r * Math.cos(arc.a1)), py - (arc.cy + arc.r * Math.sin(arc.a1)));
  arcHit.d = Math.min(d0, d1);
  arcHit.t = d0 < d1 ? 0 : 1;
}

function arcPoint(arc: Arc, t: number): [number, number] {
  const a = mix(arc.a0, arc.a1, t);
  return [arc.cx + arc.r * Math.cos(a), arc.cy + arc.r * Math.sin(a)];
}

/** Half-gape of a cut along its length: spindle-shaped with an irregular edge. */
function halfWidth(t: number, max: number, seed: number): number {
  return max * Math.pow(Math.sin(Math.PI * t), 0.55) * (0.78 + 0.44 * valueNoise(t * 7 + seed, seed));
}

interface Drip {
  x0: number;
  y0: number;
  length: number;
  width: number;
  phase: number;
}

/** Signed distance to a blood drip running towards the wrist (+Y), ending in a drop. */
function dripDistance(px: number, py: number, d: Drip): number {
  const along = py - d.y0;
  if (along < -d.width - 1 || along > d.length + d.width * 4) return Infinity;
  const k = clamp01(along / d.length);
  const yEnd = d.y0 + d.length;
  const pathX = (y: number) => d.x0 + 0.45 * Math.sin((y - d.y0) * 0.33 + d.phase) + (y - d.y0) * 0.04;
  let dist = Infinity;
  if (along < 0) dist = Math.hypot(px - d.x0, py - d.y0) - d.width;
  else if (along <= d.length) dist = Math.abs(px - pathX(py)) - d.width * (1 - 0.35 * k);
  const dropR = d.width * 1.4;
  const drop = Math.hypot(px - pathX(yEnd), (py - (yEnd + dropR * 0.45)) * 0.8) - dropR;
  return Math.min(dist, drop);
}

/** Paints `rgb` at `alpha` over the straight-alpha RGBA pixel in `out`. */
function over(out: Float32Array, rgb: ArrayLike<number>, alpha: number) {
  if (alpha <= 0) return;
  const a = out[3];
  const outA = alpha + a * (1 - alpha);
  for (let c = 0; c < 3; c++) out[c] = (rgb[c] * alpha + out[c] * a * (1 - alpha)) / outA;
  out[3] = outA;
}

// ------------------------------------------------------------ generator ---

export function generateInjury(size = 1024): InjuryMaps {
  const mmPerPx = PATCH_MM / size;

  const mainCut = arcThrough(-20, -13, 19, 9, 4.5);
  const MAIN_GAPE = 2.7;
  // +1 on the wrist side of the main cut's arc, -1 on the finger side.
  const wristSide = Math.sign(Math.hypot(0 - mainCut.cx, 25 - mainCut.cy) - mainCut.r);
  const branchStart = arcPoint(mainCut, 0.62);
  const branchCut = arcThrough(branchStart[0], branchStart[1], branchStart[0] + 4, branchStart[1] - 11, 1.6);
  const BRANCH_GAPE = 0.8;

  const drips: Drip[] = [
    [0.3, 8, 0.6, 0.4],
    [0.55, 14, 0.75, 1.7],
    [0.78, 6, 0.5, 2.9],
  ].map(([t, length, width, phase]) => {
    const [x, y] = arcPoint(mainCut, t);
    return { x0: x, y0: y + halfWidth(t, MAIN_GAPE, 3) + 0.6, length, width, phase };
  });

  const splatters = Array.from({ length: 9 }, (_, i) => ({
    x: (hash(i, 17) - 0.45) * 40,
    y: (hash(i, 29) - 0.2) * 30,
    r: 0.2 + hash(i, 41) * 0.5,
  }));

  const cutAngle = Math.atan2(9 + 13, 19 + 20);
  const scrape = { x: -24, y: -19, rx: 8, ry: 4.5 };
  const bruise = { x: 0, y: -1, rx: 30, ry: 18 };
  const ca = Math.cos(cutAngle);
  const sa = Math.sin(cutAngle);

  const tint = new Uint8Array(size * size * 4);
  const wound = new Uint8Array(size * size * 4);
  const surface = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);
  const tintPx = new Float32Array(4);
  const woundPx = new Float32Array(4);
  const rgb = [0, 0, 0];

  for (let row = 0; row < size; row++) {
    const Y = (row / size - 0.5) * PATCH_MM;
    for (let col = 0; col < size; col++) {
      const X = (col / size - 0.5) * PATCH_MM;
      const i = row * size + col;
      tintPx.fill(0);
      woundPx.fill(0);
      let roughness = 0.55;
      let height = 0;

      // --- cuts: signed distance to the nearest wound edge (negative inside)
      arcDistance(X, Y, mainCut);
      const t1 = arcHit.t;
      const raw1 = arcHit.d;
      arcDistance(X, Y, branchCut);
      const raw2 = arcHit.d;
      const t2 = arcHit.t;
      const nearCut = Math.min(raw1 - MAIN_GAPE, raw2 - BRANCH_GAPE) < 7;
      const ragged = nearCut ? (fbm(X * 0.55 + 11, Y * 0.55 + 7, 3) - 0.5) * 1.1 : 0;
      const w1 = halfWidth(t1, MAIN_GAPE, 3);
      const w2 = halfWidth(t2, BRANCH_GAPE, 9);
      const d1 = raw1 + ragged - w1;
      const d2 = raw2 + ragged * 0.6 - w2;
      const cutEdge = Math.min(d1, d2);
      const gape = d1 < d2 ? w1 : w2;
      const depthQ = cutEdge < 0 ? clamp01(-cutEdge / Math.max(gape, 0.3)) : 0;
      const towardsWrist = (Math.hypot(X - mainCut.cx, Y - mainCut.cy) - mainCut.r) * wristSide;

      // --- blood outside the cut: ooze on the wrist side, drips, splatter
      let blood = Infinity;
      if (cutEdge >= 0 && nearCut) {
        const ooze = 2.8 * smoothstep(0.38, 0.68, fbm(X * 0.2 + 40, Y * 0.2, 3)) * smoothstep(-1, 2.5, towardsWrist);
        blood = cutEdge - ooze;
      }
      for (const drip of drips) blood = Math.min(blood, dripDistance(X, Y, drip));
      for (const s of splatters) blood = Math.min(blood, Math.hypot(X - s.x, Y - s.y) - s.r);
      if (blood < 1) blood += (fbm(X * 1.4, Y * 1.4 + 90, 2) - 0.5) * 0.3;
      const bloodCover = smoothstep(0.1, -0.1, blood);

      // --- tint (unlit): bruise, then inflammation
      const bAlong = (X - bruise.x) * ca + (Y - bruise.y) * sa;
      const bAcross = -(X - bruise.x) * sa + (Y - bruise.y) * ca;
      const bruiseR =
        Math.hypot(bAlong / bruise.rx, bAcross / bruise.ry) + (fbm(X * 0.11 + 70, Y * 0.11, 4) - 0.5) * 0.55;
      if (bruiseR < 1.3) {
        const amount = smoothstep(1, 0.3, bruiseR) * (0.6 + 0.8 * fbm(X * 0.3 + 3, Y * 0.3, 3));
        over(tintPx, mixRGB(rgb, BRUISE_INNER, BRUISE_OUTER, smoothstep(0.35, 0.95, bruiseR)), clamp01(0.42 * amount));
      }

      // --- scrape: streaks along the cut direction plus pinpoint bleeding
      const sAlong = (X - scrape.x) * ca + (Y - scrape.y) * sa;
      const sAcross = -(X - scrape.x) * sa + (Y - scrape.y) * ca;
      let scrapeR = Math.hypot(sAlong / scrape.rx, sAcross / scrape.ry);
      let scrapeMask = 0;
      if (scrapeR < 1.6) {
        scrapeR += (fbm(X * 0.4 + 5, Y * 0.4, 3) - 0.5) * 0.6;
        scrapeMask = smoothstep(1, 0.55, scrapeR);
      }

      if (cutEdge < 15 || scrapeMask > 0) {
        const redness = cutEdge < 15 ? Math.exp(-Math.max(cutEdge, 0) / 5.5) * (0.6 + 0.8 * fbm(X * 0.5, Y * 0.5 + 33, 3)) : 0;
        over(tintPx, INFLAMED, clamp01(0.22 * redness + 0.2 * scrapeMask));
      }

      if (scrapeMask > 0) {
        const streak = valueNoise(sAlong * 0.12 + 3, sAcross * 2.6);
        const amount = scrapeMask * smoothstep(0.5, 0.78, streak);
        const s2 = fbm(X * 2 + 13, Y * 2, 2);
        over(woundPx, [mix(200, 158, s2), mix(84, 30, s2), mix(76, 36, s2)], 0.6 * amount);
        const cell = 0.6;
        const cx = Math.floor(X / cell);
        const cy = Math.floor(Y / cell);
        if (hash(cx, cy) < 0.2 * scrapeMask) {
          const dot = smoothstep(0.22, 0.08, Math.hypot(X - (cx + 0.5) * cell, Y - (cy + 0.5) * cell));
          over(woundPx, [150, 18, 24], 0.85 * dot);
        }
        roughness = mix(roughness, 0.35, amount);
        height -= 0.05 * amount;
      }

      if (nearCut) {
        // Swollen, torn skin margin just outside the cut.
        if (cutEdge > -0.15) {
          height += 0.75 * Math.exp(-Math.max(cutEdge, 0) / 3.2) * (0.75 + 0.5 * fbm(X * 0.6, Y * 0.6 + 21, 2));
          const margin = smoothstep(0.9, 0.2, cutEdge);
          over(woundPx, mixRGB(rgb, MARGIN_PALE, MARGIN_RAW, fbm(X * 3.1 + 7, Y * 3.1, 2)), 0.55 * margin);
          roughness = mix(roughness, 0.45, margin);
        }

        // The gash: raw flesh walls falling away to dark tissue, blood pooled at the bottom.
        if (cutEdge < 0.15) {
          const tissue = 0.84 + 0.32 * fbm(X * 2.6 + 50, Y * 2.6, 3);
          if (depthQ < 0.45) mixRGB(rgb, FLESH_EDGE, FLESH_MID, smoothstep(0.02, 0.45, depthQ));
          else mixRGB(rgb, FLESH_MID, FLESH_DEEP, smoothstep(0.45, 0.95, depthQ));
          const fat = depthQ > 0.1 && depthQ < 0.4 ? 0.4 * smoothstep(0.74, 0.82, fbm(X * 2.2 + 51, Y * 2.2, 2)) : 0;
          for (let c = 0; c < 3; c++) rgb[c] = mix(rgb[c] * tissue, FAT[c], fat);
          over(woundPx, rgb, smoothstep(0.15, -0.15, cutEdge));
          if (cutEdge < 0) {
            height = 0.75 * (1 - smoothstep(0, 0.35, depthQ)) - 1.05 * smoothstep(0.2, 1, depthQ);
            roughness = 0.18;
            const pool = smoothstep(0.5, 0.75, depthQ + (fbm(X * 0.8 + 9, Y * 0.8, 2) - 0.5) * 0.5);
            over(woundPx, BLOOD_POOL, 0.9 * pool);
            height = mix(height, -0.55, pool);
            roughness = mix(roughness, 0.05, pool);
          }
        }
      }

      // Wet blood outside the cut: translucent where thin, darker where thick.
      if (bloodCover > 0) {
        const thick = clamp01(-blood / 0.8);
        const v = 0.9 + 0.2 * fbm(X * 0.9 + 77, Y * 0.9, 2);
        mixRGB(rgb, BLOOD_THIN, BLOOD_THICK, smoothstep(0, 0.7, thick));
        for (let c = 0; c < 3; c++) rgb[c] *= v;
        over(woundPx, rgb, bloodCover * mix(0.6, 0.95, smoothstep(0, 0.5, thick)));
        height += 0.3 * Math.sqrt(thick) * bloodCover;
        roughness = mix(roughness, 0.07, bloodCover);
      }

      if (tintPx[3] === 0) tintPx.set(TINT_FALLBACK);
      if (woundPx[3] === 0) woundPx.set(WOUND_FALLBACK);
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        tint[o + c] = Math.round(tintPx[c]);
        wound[o + c] = Math.round(woundPx[c]);
      }
      tint[o + 3] = Math.round(tintPx[3] * 255);
      wound[o + 3] = Math.round(woundPx[3] * 255);
      heights[i] = height;
      surface[o] = Math.round(clamp01((height - HEIGHT_MIN_MM) / HEIGHT_RANGE_MM) * 255);
      surface[o + 1] = Math.round(clamp01(roughness) * 255);
      surface[o + 3] = 255;
    }
  }

  // Normals from the height field (row index grows with the texture's v).
  const normal = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const l = heights[row * size + Math.max(col - 1, 0)];
      const r = heights[row * size + Math.min(col + 1, size - 1)];
      const d = heights[Math.max(row - 1, 0) * size + col];
      const u = heights[Math.min(row + 1, size - 1) * size + col];
      const nx = -(r - l) / (2 * mmPerPx);
      const ny = -(u - d) / (2 * mmPerPx);
      const len = Math.hypot(nx, ny, 1);
      const o = (row * size + col) * 4;
      normal[o] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      normal[o + 3] = 255;
    }
  }

  return { size, tint, wound, normal, surface };
}
