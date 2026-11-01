import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const cache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

/**
 * Soft studio reflections (a prefiltered room), made once per renderer and
 * shared. Call it when the scene mounts, before the headset session starts:
 * prefiltering renders off-screen, which mustn't happen outside the
 * session's own frames on a real headset.
 */
export function studioEnvironment(gl: THREE.WebGLRenderer): THREE.Texture {
  let texture = cache.get(gl);
  if (!texture) {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    texture = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    cache.set(gl, texture);
  }
  return texture;
}
