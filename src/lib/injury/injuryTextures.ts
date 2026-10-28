import * as THREE from 'three';
import { generateInjury, type InjuryMaps } from './generateInjury';

export { INJURY_HEIGHT_MAX, INJURY_HEIGHT_MIN, INJURY_PATCH_SIZE } from './generateInjury';

const MAP_SIZE = 1024;

export interface InjuryTextures {
  tint: THREE.DataTexture;
  wound: THREE.DataTexture;
  normal: THREE.DataTexture;
  surface: THREE.DataTexture;
  dispose(): void;
}

/** Generates the maps in a worker (falling back to this thread) and wraps them as textures. */
export async function loadInjuryTextures(): Promise<InjuryTextures> {
  const maps = await generateInWorker().catch((err) => {
    console.warn('Injury worker unavailable, generating on the main thread.', err);
    return generateInjury(MAP_SIZE);
  });
  const tint = makeTexture(maps.tint, maps.size, THREE.SRGBColorSpace);
  const wound = makeTexture(maps.wound, maps.size, THREE.SRGBColorSpace);
  const normal = makeTexture(maps.normal, maps.size, THREE.NoColorSpace);
  const surface = makeTexture(maps.surface, maps.size, THREE.NoColorSpace);
  return {
    tint,
    wound,
    normal,
    surface,
    dispose() {
      tint.dispose();
      wound.dispose();
      normal.dispose();
      surface.dispose();
    },
  };
}

function generateInWorker(): Promise<InjuryMaps> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./injury.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<InjuryMaps>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event);
    };
    worker.postMessage({ size: MAP_SIZE });
  });
}

function makeTexture(data: Uint8Array, size: number, colorSpace: THREE.ColorSpace) {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = colorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
