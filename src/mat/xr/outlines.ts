import * as THREE from 'three';

/** A footprint in metres; a pill's or rect's `width` runs along X. */
export interface FootprintShape {
  shape: 'circle' | 'rect' | 'pill';
  width: number;
  depth: number;
}

/**
 * Flat geometry lying on the table: everything here is in the XZ plane at
 * y = 0, facing up. Paths are flat arrays of x, z pairs.
 */

/** A closed outline of a footprint, centred on the origin (pill and rect run along X). */
export function footprintPath(footprint: FootprintShape): number[] {
  switch (footprint.shape) {
    case 'circle':
      return arcPath(0, 0, footprint.width / 2, 0, Math.PI * 2, 48, false);
    case 'pill': {
      const r = Math.min(footprint.width, footprint.depth) / 2;
      const half = footprint.width / 2 - r;
      return [
        ...arcPath(half, 0, r, -Math.PI / 2, Math.PI / 2, 12, true),
        ...arcPath(-half, 0, r, Math.PI / 2, (Math.PI * 3) / 2, 12, true),
      ];
    }
    case 'rect': {
      const w = footprint.width / 2;
      const d = footprint.depth / 2;
      const r = Math.min(0.006, w / 2, d / 2);
      return [
        ...arcPath(w - r, -d + r, r, -Math.PI / 2, 0, 4, true),
        ...arcPath(w - r, d - r, r, 0, Math.PI / 2, 4, true),
        ...arcPath(-w + r, d - r, r, Math.PI / 2, Math.PI, 4, true),
        ...arcPath(-w + r, -d + r, r, Math.PI, (Math.PI * 3) / 2, 4, true),
      ];
    }
  }
}

/** Points on an arc (x = cx + r cos a, z = cz + r sin a). */
function arcPath(cx: number, cz: number, r: number, from: number, to: number, steps: number, inclusive: boolean) {
  const out: number[] = [];
  const n = inclusive ? steps + 1 : steps;
  for (let i = 0; i < n; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push(cx + r * Math.cos(a), cz + r * Math.sin(a));
  }
  return out;
}

export function rectPath(width: number, depth: number): number[] {
  const w = width / 2;
  const d = depth / 2;
  return [-w, -d, w, -d, w, d, -w, d];
}

export interface Polyline {
  points: number[];
  closed: boolean;
}

/** Splits a closed path into dashes `dash` long with `gap` between, evened out to fit the loop. */
export function dashPath(path: number[], dash: number, gap: number): Polyline[] {
  const n = path.length / 2;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l = Math.hypot(path[j * 2] - path[i * 2], path[j * 2 + 1] - path[i * 2 + 1]);
    lengths.push(l);
    total += l;
  }
  const count = Math.max(3, Math.round(total / (dash + gap)));
  const period = total / count;
  const on = period * (dash / (dash + gap));
  const at = (s: number): [number, number] => {
    let i = 0;
    while (i < n - 1 && s > lengths[i]) s -= lengths[i++];
    const j = (i + 1) % n;
    const t = lengths[i] ? Math.min(s / lengths[i], 1) : 0;
    return [path[i * 2] + (path[j * 2] - path[i * 2]) * t, path[i * 2 + 1] + (path[j * 2 + 1] - path[i * 2 + 1]) * t];
  };
  const dashes: Polyline[] = [];
  for (let k = 0; k < count; k++) {
    const start = k * period;
    const points: number[] = [];
    const steps = 3; // enough to follow a curve over one dash
    for (let s = 0; s <= steps; s++) points.push(...at(start + (on * s) / steps));
    dashes.push({ points, closed: false });
  }
  return dashes;
}

/** A flat strip `width` wide along each polyline, with mitred joins. */
export function ribbonGeometry(lines: Polyline[], width: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = width / 2;
  for (const { points, closed } of lines) {
    const n = points.length / 2;
    if (n < 2) continue;
    const base = positions.length / 3;
    for (let i = 0; i < n; i++) {
      const prev = closed ? (i - 1 + n) % n : Math.max(i - 1, 0);
      const next = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
      // Unit directions of the segments in and out of this point.
      let ix = points[i * 2] - points[prev * 2];
      let iz = points[i * 2 + 1] - points[prev * 2 + 1];
      let ox = points[next * 2] - points[i * 2];
      let oz = points[next * 2 + 1] - points[i * 2 + 1];
      const il = Math.hypot(ix, iz);
      const ol = Math.hypot(ox, oz);
      if (il < 1e-9) [ix, iz] = [ox, oz];
      else [ix, iz] = [ix / il, iz / il];
      if (ol < 1e-9) [ox, oz] = [ix, iz];
      else [ox, oz] = [ox / ol, oz / ol];
      let tx = ix + ox;
      let tz = iz + oz;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // Perpendicular, stretched at corners so the strip keeps its width (capped).
      const cos = Math.max(tx * ox + tz * oz, 0.5);
      const m = half / cos;
      const x = points[i * 2];
      const z = points[i * 2 + 1];
      positions.push(x - tz * m, 0, z + tx * m, x + tz * m, 0, z - tx * m);
    }
    const segments = closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      const b = base + ((i + 1) % n) * 2;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** The filled area inside a closed path. */
export function fillGeometry(path: number[]): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  // Shape space is XY; rotating it −90° about X maps (x, y) to (x, 0, −y).
  shape.moveTo(path[0], -path[1]);
  for (let i = 2; i < path.length; i += 2) shape.lineTo(path[i], -path[i + 1]);
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape, 1);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** L-shaped marks at the four corners of a width × depth rectangle, `arm` long. */
export function cornerTicks(width: number, depth: number, arm: number): Polyline[] {
  const w = width / 2;
  const d = depth / 2;
  const ticks: Polyline[] = [];
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const x = sx * w;
    const z = sz * d;
    ticks.push({ points: [x - sx * arm, z, x, z, x, z - sz * arm], closed: false });
  }
  return ticks;
}
