import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WOUND_LENGTH, normaliseWound } from './woundGeometry';

// Node's fs, typed just enough here (the app itself has no Node types).
const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(path: URL): Uint8Array };

/** Reads the first mesh of public/models/Wound.glb (positions, normals, uvs, indices). */
function loadWoundGlb(): THREE.BufferGeometry {
  const file = fs.readFileSync(new URL('../../public/models/Wound.glb', import.meta.url));
  const data = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const jsonLength = data.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLength)));
  const binStart = 20 + jsonLength + 8;
  const read = (accessorIndex: number) => {
    const accessor = json.accessors[accessorIndex];
    const view = json.bufferViews[accessor.bufferView];
    const start = file.byteOffset + binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[accessor.type as 'SCALAR' | 'VEC2' | 'VEC3'];
    const n = accessor.count * size;
    switch (accessor.componentType) {
      case 5126:
        return new THREE.BufferAttribute(new Float32Array(file.buffer.slice(start, start + n * 4)), size);
      case 5125:
        return new THREE.BufferAttribute(new Uint32Array(file.buffer.slice(start, start + n * 4)), 1);
      default:
        return new THREE.BufferAttribute(new Uint16Array(file.buffer.slice(start, start + n * 2)), 1);
    }
  };
  const primitive = json.meshes[0].primitives[0];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', read(primitive.attributes.POSITION));
  geometry.setAttribute('normal', read(primitive.attributes.NORMAL));
  geometry.setAttribute('uv', read(primitive.attributes.TEXCOORD_0));
  geometry.setIndex(read(primitive.indices));
  return geometry;
}

describe('normaliseWound (Wound.glb)', () => {
  const info = normaliseWound(loadWoundGlb());
  const pos = info.geometry.getAttribute('position');
  const surf = info.geometry.getAttribute('woundSurf');

  it('is 5 cm long along z, centred, skin level at y = 0', () => {
    const box = info.geometry.boundingBox!;
    expect(box.max.z - box.min.z).toBeCloseTo(WOUND_LENGTH, 5);
    expect((box.max.z + box.min.z) / 2).toBeCloseTo(0, 5);
    expect((box.max.x + box.min.x) / 2).toBeCloseTo(0, 5);
    expect(info.halfLength).toBeCloseTo(WOUND_LENGTH / 2, 6);
    expect(info.halfWidth).toBeGreaterThan(0.004);
    expect(info.halfWidth).toBeLessThan(0.02);
  });

  it('keeps its relief in proportion: a raised rim and a sunken cut of about 2 mm', () => {
    expect(info.rimHeight).toBeGreaterThan(0.001);
    expect(info.rimHeight).toBeLessThan(0.003);
    expect(info.cutDepth).toBeGreaterThan(0.001);
    expect(info.cutDepth).toBeLessThan(0.003);
  });

  it('tags every vertex with height, inwardness, concavity and nearness to the cut', () => {
    expect(surf.itemSize).toBe(4);
    let outerEdge = 0;
    for (let i = 0; i < surf.count; i++) {
      const h = surf.getX(i);
      expect(h).toBeGreaterThanOrEqual(-1.0001);
      expect(h).toBeLessThanOrEqual(1.0001);
      for (const v of [surf.getY(i), surf.getZ(i), surf.getW(i)]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      if (pos.getY(i) < -0.0006) expect(surf.getW(i)).toBe(1);
      if (surf.getY(i) === 0) {
        outerEdge++;
        // The outer edge sits at skin level and far from the cut.
        expect(Math.abs(pos.getY(i))).toBeLessThan(0.0006);
        expect(surf.getW(i)).toBeLessThan(0.05);
      }
    }
    expect(outerEdge).toBeGreaterThan(100);
  });
});
