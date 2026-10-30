import * as THREE from 'three';

/**
 * A right hand's six palm points (wrist, thumb base, index, middle, ring and
 * pinky knuckles) in camera space, palm facing the camera, fingers up: a
 * fixture for tests.
 */
export function rightPalm(scale = 1) {
  return [
    [0, -0.045, 0],
    [-0.03, -0.03, 0.006],
    [-0.035, 0.035, 0.002],
    [-0.012, 0.042, 0.004],
    [0.012, 0.04, 0.003],
    [0.034, 0.03, 0],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z).multiplyScalar(scale));
}
