import * as THREE from 'three';

/**
 * Lays the wound onto the hand model's palm, and gives it the hand's own skin
 * weights, so the two deform as one.
 *
 * Working in the wound's frame (x across, y out of the palm, z along), the
 * hand's palm-facing triangles are rasterised into a height map over the
 * wound's footprint (the outermost surface wins), then smoothed. Each wound vertex is then
 * moved onto that surface along its normal, its normal tilted to match, and
 * its skin weights taken from the hand triangle under it.
 */

/** Height-map cell size (m). */
const CELL = 0.0015;
/** Smoothing of the palm surface: box blur radius (cells) and passes (~1 cm wide in all). */
const SMOOTH_RADIUS = 2;
const SMOOTH_PASSES = 3;
const MAX_BONES = 64;

export interface ConformSource {
  /** The wound in its own frame as loaded (metres): positions and normals. */
  restPositions: Float32Array;
  restNormals: Float32Array;
  /** Its half-size (m). */
  halfWidth: number;
  halfLength: number;
}

export interface HandSurface {
  /** Skinned hand vertices (world), 3 per vertex. */
  positions: Float32Array;
  index: ArrayLike<number>;
  skinIndex: THREE.BufferAttribute;
  skinWeight: THREE.BufferAttribute;
}

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();
const n = new THREE.Vector3();
const k = new THREE.Vector3();
const v = new THREE.Vector3();

/**
 * @param toWound  World → wound frame.
 * @param lift     Extra height above the surface (m).
 * @returns false if the hand's palm isn't under the wound at all.
 */
export function conformWound(
  wound: ConformSource,
  hand: HandSurface,
  toWound: THREE.Matrix4,
  lift: number,
  geometry: THREE.BufferGeometry,
): boolean {
  const x0 = -wound.halfWidth * 1.8 - 0.004;
  const z0 = -wound.halfLength - 0.006;
  const nx = Math.ceil((-2 * x0) / CELL) + 1;
  const nz = Math.ceil((-2 * z0) / CELL) + 1;
  const height = new Float32Array(nx * nz).fill(-Infinity);
  const tri = new Int32Array(nx * nz).fill(-1);
  const bary = new Float32Array(nx * nz * 3);

  // Rasterise palm-facing triangles (outermost surface wins).
  const idx = hand.index;
  const P = hand.positions;
  for (let t = 0; t < idx.length; t += 3) {
    a.fromArray(P, idx[t] * 3).applyMatrix4(toWound);
    b.fromArray(P, idx[t + 1] * 3).applyMatrix4(toWound);
    c.fromArray(P, idx[t + 2] * 3).applyMatrix4(toWound);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    const len = n.length();
    if (!(len > 0) || n.y / len < 0.25) continue; // not facing out of the palm
    const minX = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) / CELL));
    const maxX = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x, c.x) - x0) / CELL));
    const minZ = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) / CELL));
    const maxZ = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z, c.z) - z0) / CELL));
    if (minX > maxX || minZ > maxZ) continue;
    const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(det) < 1e-14) continue;
    for (let iz = minZ; iz <= maxZ; iz++) {
      const pz = z0 + iz * CELL;
      for (let ix = minX; ix <= maxX; ix++) {
        const px = x0 + ix * CELL;
        const w0 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / det;
        const w1 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const y = w0 * a.y + w1 * b.y + w2 * c.y;
        const cell = iz * nx + ix;
        if (y <= height[cell]) continue;
        height[cell] = y;
        tri[cell] = t;
        bary[cell * 3] = w0;
        bary[cell * 3 + 1] = w1;
        bary[cell * 3 + 2] = w2;
      }
    }
  }

  // Fill gaps (past the palm's edge) from the nearest filled cells.
  let filled = 0;
  for (let i = 0; i < tri.length; i++) if (tri[i] >= 0) filled++;
  if (filled === 0) return false;
  for (let pass = 0; pass < nx + nz && filled < tri.length; pass++) {
    const prev = tri.slice();
    const prevH = height.slice();
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const cell = iz * nx + ix;
        if (prev[cell] >= 0) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
          const other = jz * nx + jx;
          if (prev[other] < 0) continue;
          tri[cell] = prev[other];
          height[cell] = prevH[other];
          bary.copyWithin(cell * 3, other * 3, other * 3 + 3);
          filled++;
          break;
        }
      }
    }
  }

  // Smooth the surface (about 1 cm): the wound follows the palm's curve, not
  // every bump of the model (its thumb mound, creases), so it stays whole.
  const tmp = new Float32Array(height.length);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    for (const [sx, sz] of [[1, 0], [0, 1]]) {
      for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
          let sum = 0, n2 = 0;
          for (let r = -SMOOTH_RADIUS; r <= SMOOTH_RADIUS; r++) {
            const jx = ix + r * sx, jz = iz + r * sz;
            if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
            sum += height[jz * nx + jx];
            n2++;
          }
          tmp[iz * nx + ix] = sum / n2;
        }
      }
      height.set(tmp);
    }
  }

  const sample = (x: number, z: number) => {
    const fx = THREE.MathUtils.clamp((x - x0) / CELL, 0, nx - 1.001);
    const fz = THREE.MathUtils.clamp((z - z0) / CELL, 0, nz - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h = (i: number, j: number) => height[j * nx + i];
    return (h(ix, iz) * (1 - tx) + h(ix + 1, iz) * tx) * (1 - tz) + (h(ix, iz + 1) * (1 - tx) + h(ix + 1, iz + 1) * tx) * tz;
  };

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nor = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  const weights = new Float32Array(MAX_BONES);
  const order: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = wound.restPositions[i * 3], y = wound.restPositions[i * 3 + 1], z = wound.restPositions[i * 3 + 2];
    const h = sample(x, z);
    const gx = (sample(x + CELL, z) - sample(x - CELL, z)) / (2 * CELL);
    const gz = (sample(x, z + CELL) - sample(x, z - CELL)) / (2 * CELL);
    n.set(-gx, 1, -gz).normalize();
    // Onto the surface, raised along its normal by the wound's own height.
    pos.setXYZ(i, x + n.x * (y + lift), h + n.y * (y + lift), z + n.z * (y + lift));
    // Tilt the normal from flat (+Y) to the surface's.
    v.fromArray(wound.restNormals, i * 3);
    k.set(n.z, 0, -n.x);
    e1.crossVectors(k, v);
    e2.crossVectors(k, e1);
    v.add(e1).addScaledVector(e2, 1 / (1 + n.y)).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);

    // Skin weights: those of the hand triangle under the vertex.
    const ix = Math.round(THREE.MathUtils.clamp((x - x0) / CELL, 0, nx - 1));
    const iz = Math.round(THREE.MathUtils.clamp((z - z0) / CELL, 0, nz - 1));
    const cell = iz * nx + ix;
    const t = tri[cell];
    weights.fill(0);
    for (let corner = 0; corner < 3; corner++) {
      const vi = idx[t + corner];
      const w = bary[cell * 3 + corner];
      for (let s = 0; s < 4; s++) weights[hand.skinIndex.getComponent(vi, s)] += w * hand.skinWeight.getComponent(vi, s);
    }
    order.length = 0;
    for (let bone = 0; bone < MAX_BONES; bone++) if (weights[bone] > 0) order.push(bone);
    order.sort((p, q) => weights[q] - weights[p]);
    let sum = 0;
    for (let s = 0; s < 4 && s < order.length; s++) sum += weights[order[s]];
    for (let s = 0; s < 4; s++) {
      const bone = order[s];
      skinIndex.setComponent(i, s, bone ?? 0);
      skinWeight.setComponent(i, s, bone !== undefined && sum > 0 ? weights[bone] / sum : s === 0 ? 1 : 0);
    }
  }
  pos.needsUpdate = nor.needsUpdate = skinIndex.needsUpdate = skinWeight.needsUpdate = true;
  geometry.computeBoundingSphere();
  return true;
}
