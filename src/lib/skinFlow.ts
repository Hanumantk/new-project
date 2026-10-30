/**
 * Follows the skin itself: how far the real palm's pixels around the wound
 * moved since the last frame, by pyramidal Lucas–Kanade optical flow on a
 * grid of points, checked forwards and backwards, combined by median.
 *
 * Landmarks estimate where the joints are, which drifts relative to the skin
 * as the hand turns; the skin's own texture (creases, pores, shading) moves
 * exactly with it. So frame to frame the wound follows the skin, and the
 * landmarks only keep it from drifting off over time (`SkinLock`).
 */

/** Reads a square of the current video frame as grey levels (0..255): `size`×`size` from (x0, y0). */
export type PatchReader = (x0: number, y0: number, size: number, out: Float32Array) => boolean;

/** Pyramid levels (each half the size of the one below): covers moves of ~±40 px. */
const LEVELS = 3;
/** Half-size of the window each point is matched with (pixels, at every level). */
const WINDOW = 7;
const ITERATIONS = 12;
/** A point whose backward track misses its start by more than this (px) is dropped. */
const FB_MAX = 0.8;
/** Fewer good points than this and the frame's flow isn't trusted. */
const MIN_POINTS = 8;

class Level {
  data: Float32Array;
  constructor(public size: number) {
    this.data = new Float32Array(size * size);
  }
}

function makePyramid(size: number): Level[] {
  const levels: Level[] = [];
  for (let l = 0, s = size; l < LEVELS; l++, s = Math.max(1, s >> 1)) levels.push(new Level(s));
  return levels;
}

/** Builds the coarser levels from level 0 (2×2 box filter). */
function buildPyramid(p: Level[]) {
  for (let l = 1; l < p.length; l++) {
    const src = p[l - 1], dst = p[l];
    const n = dst.size, m = src.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = 2 * y * m + 2 * x;
        dst.data[y * n + x] = 0.25 * (src.data[i] + src.data[i + 1] + src.data[i + m] + src.data[i + m + 1]);
      }
    }
  }
}

function sample(level: Level, x: number, y: number): number {
  const n = level.size;
  if (x < 0) x = 0;
  else if (x > n - 1.001) x = n - 1.001;
  if (y < 0) y = 0;
  else if (y > n - 1.001) y = n - 1.001;
  const xi = x | 0, yi = y | 0;
  const fx = x - xi, fy = y - yi;
  const i = yi * n + xi;
  const d = level.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + n] * (1 - fx) + d[i + n + 1] * fx) * fy;
}

const win = 2 * WINDOW + 1;
const tI = new Float32Array(win * win);
const tX = new Float32Array(win * win);
const tY = new Float32Array(win * win);

/**
 * Tracks one point from image a to image b (both pyramids, same pixel frame).
 * @returns the displacement in out[0..1], or false if it couldn't be solved.
 */
function trackPoint(a: Level[], b: Level[], px: number, py: number, gx: number, gy: number, out: Float64Array): boolean {
  let dx = gx / (1 << (LEVELS - 1));
  let dy = gy / (1 << (LEVELS - 1));
  for (let l = LEVELS - 1; l >= 0; l--) {
    const scale = 1 / (1 << l);
    const x = px * scale, y = py * scale;
    const A = a[l], B = b[l];
    if (x < WINDOW + 1 || y < WINDOW + 1 || x > A.size - WINDOW - 2 || y > A.size - WINDOW - 2) {
      if (l > 0) {
        dx *= 2;
        dy *= 2;
        continue;
      }
      return false;
    }
    // Template and its gradient around the point in a.
    let gxx = 0, gxy = 0, gyy = 0, k = 0;
    for (let j = -WINDOW; j <= WINDOW; j++) {
      for (let i = -WINDOW; i <= WINDOW; i++, k++) {
        const ix = (sample(A, x + i + 1, y + j) - sample(A, x + i - 1, y + j)) * 0.5;
        const iy = (sample(A, x + i, y + j + 1) - sample(A, x + i, y + j - 1)) * 0.5;
        tI[k] = sample(A, x + i, y + j);
        tX[k] = ix;
        tY[k] = iy;
        gxx += ix * ix;
        gxy += ix * iy;
        gyy += iy * iy;
      }
    }
    const det = gxx * gyy - gxy * gxy;
    // Too little texture to match on.
    if (!(det > 1e-3 * win * win * win * win)) return false;
    for (let it = 0; it < ITERATIONS; it++) {
      let bx = 0, by = 0;
      k = 0;
      for (let j = -WINDOW; j <= WINDOW; j++) {
        for (let i = -WINDOW; i <= WINDOW; i++, k++) {
          const diff = sample(B, x + dx + i, y + dy + j) - tI[k];
          bx += diff * tX[k];
          by += diff * tY[k];
        }
      }
      const ux = -(gyy * bx - gxy * by) / det;
      const uy = -(gxx * by - gxy * bx) / det;
      dx += ux;
      dy += uy;
      if (ux * ux + uy * uy < 1e-4) break;
    }
    if (l > 0) {
      dx *= 2;
      dy *= 2;
    }
  }
  out[0] = dx;
  out[1] = dy;
  return Number.isFinite(dx) && Number.isFinite(dy);
}

/**
 * Optical flow of a patch of skin: the median motion of a grid of points
 * around a centre, between the previous frame and this one.
 */
export class SkinFlow {
  private size = 0;
  private prev: Level[] = [];
  private cur: Level[] = [];
  private prevX0 = 0;
  private prevY0 = 0;
  private hasPrev = false;
  private readonly dxs: number[] = [];
  private readonly dys: number[] = [];
  private readonly d = new Float64Array(2);
  private readonly back = new Float64Array(2);
  /** Points that passed the checks in the last call. */
  goodPoints = 0;

  /**
   * Reads this frame's patch around (cx, cy) and measures how the skin
   * around the previous frame's centre moved.
   * @param cx, cy   Where the tracked spot is expected (video px).
   * @param spacing  Grid spacing (px): points sit at −2…2 spacings around it.
   * @returns the motion in out (px), or false (first frame, too few good points).
   */
  track(read: PatchReader, cx: number, cy: number, spacing: number, out: { x: number; y: number }): boolean {
    const reach = 2 * spacing + WINDOW * 4 + 48;
    const size = Math.min(320, Math.max(96, Math.ceil((2 * reach) / 16) * 16));
    if (size !== this.size) {
      this.size = size;
      this.prev = makePyramid(size);
      this.cur = makePyramid(size);
      this.hasPrev = false;
    }
    const x0 = Math.round(cx - size / 2);
    const y0 = Math.round(cy - size / 2);
    if (!read(x0, y0, size, this.cur[0].data)) {
      this.hasPrev = false;
      return false;
    }
    buildPyramid(this.cur);
    let ok = false;
    if (this.hasPrev) {
      // Points around the previous centre, in the previous patch's pixels; the
      // current patch is offset by (x0 − prevX0, y0 − prevY0).
      const ox = x0 - this.prevX0, oy = y0 - this.prevY0;
      const pcx = cx - this.prevX0, pcy = cy - this.prevY0;
      this.dxs.length = this.dys.length = 0;
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const px = pcx + i * spacing, py = pcy + j * spacing;
          // Track in a common frame: shift the current patch's coordinates by the offset.
          if (!trackShifted(this.prev, this.cur, px, py, ox, oy, this.d)) continue;
          // Backwards from where it landed: it must come back to its start.
          if (!trackShifted(this.cur, this.prev, px + this.d[0] - ox, py + this.d[1] - oy, -ox, -oy, this.back, -this.d[0], -this.d[1])) continue;
          if (Math.hypot(this.d[0] + this.back[0], this.d[1] + this.back[1]) > FB_MAX) continue;
          this.dxs.push(this.d[0]);
          this.dys.push(this.d[1]);
        }
      }
      this.goodPoints = this.dxs.length;
      if (this.dxs.length >= MIN_POINTS) {
        out.x = median(this.dxs);
        out.y = median(this.dys);
        ok = true;
      }
    }
    // This frame becomes the previous one.
    const t = this.prev;
    this.prev = this.cur;
    this.cur = t;
    this.prevX0 = x0;
    this.prevY0 = y0;
    this.hasPrev = true;
    return ok;
  }

  reset() {
    this.hasPrev = false;
  }
}

/**
 * Tracks a point at (px, py) in `a`'s pixels into `b`, whose pixels are
 * offset by (ox, oy) from a's (b = a − offset). Displacement in image pixels.
 */
function trackShifted(a: Level[], b: Level[], px: number, py: number, ox: number, oy: number, out: Float64Array, gx = 0, gy = 0) {
  // In b's pixels the start is (px − ox, py − oy); pass the shift as the initial guess.
  if (!trackPointOffset(a, b, px, py, -ox, -oy, gx, gy, out)) return false;
  return true;
}

/** Like trackPoint, with b sampled at (x + sx, y + sy): b's pixel frame shifted by (sx, sy). */
function trackPointOffset(a: Level[], b: Level[], px: number, py: number, sx: number, sy: number, gx: number, gy: number, out: Float64Array) {
  // Shift b's sampling by moving the initial guess: tracking in b's frame
  // from (px + sx) with guess g is the same as tracking from px with guess g + s.
  if (!trackPoint(a, b, px, py, gx + sx, gy + sy, out)) return false;
  out[0] -= sx;
  out[1] -= sy;
  return true;
}

function median(values: number[]) {
  values.sort((p, q) => p - q);
  const n = values.length;
  return n % 2 ? values[n >> 1] : 0.5 * (values[n / 2 - 1] + values[n / 2]);
}

/**
 * Where the wound is pinned in the image: carried along by the skin's flow
 * each frame, and pulled gently towards where the landmarks put it (so it
 * can't drift away), snapping back if the two disagree by too much.
 */
export class SkinLock {
  readonly flow = new SkinFlow();
  x = 0;
  y = 0;
  locked = false;
  /** Whether the last update followed the skin (false: fell back to the landmarks). */
  followed = false;
  private t = 0;
  private readonly motion = { x: 0, y: 0 };

  /**
   * @param mx, my  Where the landmarks put the anchor this frame (video px).
   * @param pxPerMetre  The palm's apparent size, for the spacing and the limits.
   */
  update(read: PatchReader | null, mx: number, my: number, pxPerMetre: number, t: number, params = SKIN_LOCK) {
    const spacing = Math.max(4, params.spacing * pxPerMetre);
    const dt = this.locked ? Math.min(Math.max(t - this.t, 0), 0.5) : 0;
    this.t = t;
    const moved = read !== null && this.flow.track(read, this.locked ? this.x : mx, this.locked ? this.y : my, spacing, this.motion);
    this.followed = this.locked && moved;
    if (!this.followed) {
      this.x = mx;
      this.y = my;
      this.locked = read !== null;
      return;
    }
    this.x += this.motion.x;
    this.y += this.motion.y;
    // Towards the landmarks, slowly (time constant `pull`)…
    const k = 1 - Math.exp(-dt / params.pull);
    this.x += (mx - this.x) * k;
    this.y += (my - this.y) * k;
    // …or at once if the skin lock has clearly lost the place.
    if (Math.hypot(mx - this.x, my - this.y) > params.maxOffset * pxPerMetre) {
      this.x = mx;
      this.y = my;
    }
  }

  reset() {
    this.locked = false;
    this.flow.reset();
  }
}

export interface SkinLockParams {
  /** Spacing of the tracked points on the palm (metres). */
  spacing: number;
  /** How quickly the anchor returns to the landmarks' estimate (time constant, s). */
  pull: number;
  /** Beyond this disagreement with the landmarks (metres on the palm), snap back. */
  maxOffset: number;
}

export const SKIN_LOCK: SkinLockParams = { spacing: 0.008, pull: 1.5, maxOffset: 0.015 };
