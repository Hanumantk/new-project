import * as THREE from 'three';

/** The wound's real length along its long axis (metres), for an 8 cm wide palm. */
export const WOUND_LENGTH = 0.065;
/** Width of the outer band over which the wound blends into the real skin (metres). */
export const EDGE_BLEND = 0.0035;
/** How far beyond the cut's edge torn, raw tissue reaches up the lips (metres). */
export const CUT_BLEND = 0.0012;
/** The cut starts this far below the lowest point of the outer edge (metres). */
const CUT_MARGIN = 0.0001;

/**
 * Normalising Wound.glb for the palm. The model is an open surface (no
 * underside) whose outer edge sits at skin level: the swollen rim rises
 * above it and the cut sinks below. So its skin level is the height of its
 * boundary, not its lowest point.
 *
 * The result is in metres, wound-local: centred in x/z, skin level at y = 0,
 * long axis along z, `length` long (default WOUND_LENGTH); thickness scales with it (rim ≈ +1.9 mm,
 * cut ≈ −1.9 mm). Per vertex it adds `woundSurf` (vec3):
 *   x: height, −1 (deepest cut) … 0 (skin level) … +1 (top of the rim)
 *   y: inwardness, 0 on the outer edge … 1 once EDGE_BLEND inside it
 *   z: concavity, 0 (flat or convex) … 1 (deep crease), for occlusion
 */
export interface WoundGeometryInfo {
  geometry: THREE.BufferGeometry;
  /** Height of the rim top and depth of the cut below skin level (metres). */
  rimHeight: number;
  cutDepth: number;
  /** Half-extents in x and z (metres). */
  halfWidth: number;
  halfLength: number;
  /** The scale applied to the model's units. */
  scale: number;
}

export function normaliseWound(source: THREE.BufferGeometry, length = WOUND_LENGTH): WoundGeometryInfo {
  const geometry = source.clone();
  // Only shape matters: the model's own UVs and material aren't used.
  geometry.deleteAttribute('uv');
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const count = pos.count;
  const index = geometry.getIndex();

  // Vertices at the same place (split along UV seams) are one point for topology.
  const weld = new Int32Array(count);
  const keyToId = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
    let id = keyToId.get(key);
    if (id === undefined) keyToId.set(key, (id = keyToId.size));
    weld[i] = id;
  }
  const welded = keyToId.size;
  const tri = (k: number) => (index ? index.getX(k) : k);
  const triangles = (index ? index.count : count) / 3;

  // Boundary: welded edges used by only one triangle.
  const edgeUse = new Map<number, number>();
  const edgeKey = (a: number, b: number) => (a < b ? a * welded + b : b * welded + a);
  const neighbours: Set<number>[] = Array.from({ length: welded }, () => new Set());
  for (let t = 0; t < triangles; t++) {
    const v = [weld[tri(t * 3)], weld[tri(t * 3 + 1)], weld[tri(t * 3 + 2)]];
    for (let e = 0; e < 3; e++) {
      const a = v[e];
      const b = v[(e + 1) % 3];
      const k = edgeKey(a, b);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
      neighbours[a].add(b);
      neighbours[b].add(a);
    }
  }
  const onBoundary = new Uint8Array(welded);
  for (const [k, uses] of edgeUse) {
    if (uses !== 1) continue;
    onBoundary[Math.floor(k / welded)] = 1;
    onBoundary[k % welded] = 1;
  }

  // One representative position per welded vertex.
  const wp = new Float64Array(welded * 3);
  const wn = new Float64Array(welded * 3);
  for (let i = 0; i < count; i++) {
    const w = weld[i];
    wp[w * 3] = pos.getX(i);
    wp[w * 3 + 1] = pos.getY(i);
    wp[w * 3 + 2] = pos.getZ(i);
    wn[w * 3] += normal.getX(i);
    wn[w * 3 + 1] += normal.getY(i);
    wn[w * 3 + 2] += normal.getZ(i);
  }

  // Frame: centred in x/z, skin level = the boundary's mean height.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let skin = 0, boundaryCount = 0;
  for (let w = 0; w < welded; w++) {
    minX = Math.min(minX, wp[w * 3]);
    maxX = Math.max(maxX, wp[w * 3]);
    minZ = Math.min(minZ, wp[w * 3 + 2]);
    maxZ = Math.max(maxZ, wp[w * 3 + 2]);
    if (onBoundary[w]) {
      skin += wp[w * 3 + 1];
      boundaryCount++;
    }
  }
  if (boundaryCount === 0) {
    // A closed mesh has no edge: fall back to its lowest point.
    skin = Infinity;
    for (let w = 0; w < welded; w++) skin = Math.min(skin, wp[w * 3 + 1]);
  } else {
    skin /= boundaryCount;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const scale = length / (maxZ - minZ);

  let rim = 0, cut = 0;
  for (let w = 0; w < welded; w++) {
    wp[w * 3] = (wp[w * 3] - cx) * scale;
    wp[w * 3 + 1] = (wp[w * 3 + 1] - skin) * scale;
    wp[w * 3 + 2] = (wp[w * 3 + 2] - cz) * scale;
    rim = Math.max(rim, wp[w * 3 + 1]);
    cut = Math.min(cut, wp[w * 3 + 1]);
  }
  const cutDepth = -cut;

  // Inwardness: plan-view distance to the nearest boundary point.
  const bx: number[] = [];
  const bz: number[] = [];
  for (let w = 0; w < welded; w++) {
    if (!onBoundary[w]) continue;
    bx.push(wp[w * 3]);
    bz.push(wp[w * 3 + 2]);
  }
  const inward = new Float32Array(welded);
  for (let w = 0; w < welded; w++) {
    if (onBoundary[w] || bx.length === 0) continue;
    let best = Infinity;
    const x = wp[w * 3], z = wp[w * 3 + 2];
    for (let b = 0; b < bx.length; b++) best = Math.min(best, (bx[b] - x) ** 2 + (bz[b] - z) ** 2);
    inward[w] = Math.min(Math.sqrt(best) / EDGE_BLEND, 1);
  }

  // Concavity: how far a vertex sits below its neighbours' average, along its normal.
  const concave = new Float32Array(welded);
  let concaveMax = 1e-9;
  for (let w = 0; w < welded; w++) {
    const n = neighbours[w];
    if (n.size === 0) continue;
    let ax = 0, ay = 0, az = 0;
    for (const m of n) {
      ax += wp[m * 3];
      ay += wp[m * 3 + 1];
      az += wp[m * 3 + 2];
    }
    ax = ax / n.size - wp[w * 3];
    ay = ay / n.size - wp[w * 3 + 1];
    az = az / n.size - wp[w * 3 + 2];
    const nl = Math.hypot(wn[w * 3], wn[w * 3 + 1], wn[w * 3 + 2]) || 1;
    const c = (ax * wn[w * 3] + ay * wn[w * 3 + 1] + az * wn[w * 3 + 2]) / nl;
    concave[w] = Math.max(c, 0);
  }
  // Normalise by a high percentile so a few spikes don't flatten the rest.
  const sorted = Array.from(concave).sort((a, b) => a - b);
  concaveMax = Math.max(sorted[Math.floor(sorted.length * 0.97)], 1e-9);

  // The cut: below skin level by more than the outer edge ever dips (the
  // edge isn't perfectly flat), plus a margin.
  let edgeDip = 0;
  for (let w = 0; w < welded; w++) if (onBoundary[w]) edgeDip = Math.max(edgeDip, -wp[w * 3 + 1]);
  const cutLevel = -(edgeDip + CUT_MARGIN);
  const inCut = (w: number) => wp[w * 3 + 1] < cutLevel;

  // Nearness to the cut: plan-view distance to the nearest vertex in it,
  // looked up in a grid of cells CUT_BLEND wide.
  const cell = (v: number) => Math.floor(v / CUT_BLEND);
  const cutCells = new Map<string, number[]>();
  for (let w = 0; w < welded; w++) {
    if (!inCut(w)) continue;
    const key = `${cell(wp[w * 3])},${cell(wp[w * 3 + 2])}`;
    let list = cutCells.get(key);
    if (!list) cutCells.set(key, (list = []));
    list.push(w);
  }
  const cutNear = new Float32Array(welded);
  for (let w = 0; w < welded; w++) {
    if (inCut(w)) {
      cutNear[w] = 1;
      continue;
    }
    const x = wp[w * 3], z = wp[w * 3 + 2];
    const cx0 = cell(x), cz0 = cell(z);
    let best = CUT_BLEND * CUT_BLEND;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = cutCells.get(`${cx0 + i},${cz0 + j}`);
        if (!list) continue;
        for (const m of list) best = Math.min(best, (wp[m * 3] - x) ** 2 + (wp[m * 3 + 2] - z) ** 2);
      }
    }
    const t = 1 - Math.sqrt(best) / CUT_BLEND;
    cutNear[w] = t * t * (3 - 2 * t);
  }

  const surf = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const w = weld[i];
    pos.setXYZ(i, wp[w * 3], wp[w * 3 + 1], wp[w * 3 + 2]);
    const h = wp[w * 3 + 1];
    surf[i * 4] = h >= 0 ? (rim > 0 ? h / rim : 0) : cutDepth > 0 ? h / cutDepth : 0;
    surf[i * 4 + 1] = inward[w];
    surf[i * 4 + 2] = Math.min(concave[w] / concaveMax, 1);
    surf[i * 4 + 3] = cutNear[w];
  }
  pos.needsUpdate = true;
  geometry.setAttribute('woundSurf', new THREE.BufferAttribute(surf, 4));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    rimHeight: rim,
    cutDepth,
    halfWidth: ((maxX - minX) / 2) * scale,
    halfLength: length / 2,
    scale,
  };
}
