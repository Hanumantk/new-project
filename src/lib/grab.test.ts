import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FIST_CLOSE, FIST_OPEN, FistDetector, GRAB_DWELL, fistRatio } from './fist';
import { createGrabHand, GrabSystem, type GrabHand, type GrabState, type Grabbable } from './grab';

/** A right hand with its wrist at `at`, fingers pointing −Z (away) turned by `yaw`, open or in a fist. */
function poseHand(hand: GrabHand, at: THREE.Vector3, fist: boolean, yaw = 0) {
  const turn = (v: THREE.Vector3) => v.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  hand.tracked = true;
  hand.wrist.copy(at);
  hand.knuckle.copy(at).add(turn(new THREE.Vector3(0, 0, -0.09)));
  const reach = fist ? -0.06 : -0.18; // fingertips: curled back near the palm, or out past the knuckles
  hand.tips.forEach((tip, i) => tip.copy(at).add(turn(new THREE.Vector3(-0.03 + i * 0.02, fist ? -0.025 : 0, reach))));
}

class Box implements Grabbable {
  readonly bounds: THREE.Box3;
  readonly object = new THREE.Object3D();
  states: GrabState[] = [];
  began = 0;
  ended = 0;
  constructor(readonly style: 'table' | 'panel', size: THREE.Vector3, position: THREE.Vector3) {
    this.bounds = new THREE.Box3(size.clone().multiplyScalar(-0.5), size.clone().multiplyScalar(0.5));
    this.object.position.copy(position);
    this.object.updateMatrixWorld();
  }
  canGrab() {
    return true;
  }
  worldMatrix(out: THREE.Matrix4) {
    out.copy(this.object.matrixWorld);
  }
  begin() {
    this.began++;
  }
  move(world: THREE.Matrix4) {
    world.decompose(this.object.position, this.object.quaternion, this.object.scale);
    this.object.updateMatrixWorld();
  }
  end() {
    this.ended++;
  }
  setGrabState(state: GrabState) {
    this.states.push(state);
  }
}

const head = new THREE.Vector3(0, 1.4, 0.4);
const run = (grab: GrabSystem, hands: GrabHand[], seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) grab.update(1 / 60, hands, head);
};

describe('fist', () => {
  it('tells a fist from an open hand', () => {
    const hand = createGrabHand();
    poseHand(hand, new THREE.Vector3(), false);
    expect(fistRatio(hand.wrist, hand.knuckle, hand.tips)).toBeGreaterThan(FIST_OPEN);
    poseHand(hand, new THREE.Vector3(), true);
    expect(fistRatio(hand.wrist, hand.knuckle, hand.tips)).toBeLessThan(FIST_CLOSE);
  });

  it('needs every finger curled: pointing is not a fist', () => {
    const hand = createGrabHand();
    poseHand(hand, new THREE.Vector3(), true);
    hand.tips[0].set(0, 0, -0.18); // index straight out
    expect(fistRatio(hand.wrist, hand.knuckle, hand.tips)).toBeGreaterThan(FIST_OPEN);
  });

  it('grabs after the dwell, holds through the hysteresis gap, releases when open', () => {
    const f = new FistDetector();
    expect(f.update(0.5, GRAB_DWELL * 0.4)).toBeNull(); // the closing frame counts
    expect(f.update(0.5, GRAB_DWELL * 0.4)).toBeNull();
    expect(f.update(0.5, GRAB_DWELL * 0.4)).toBe('grab');
    expect(f.update(0.75, 0.1)).toBeNull(); // between the thresholds: still holding
    expect(f.update(1.0, 0.016)).toBe('release');
  });

  it('a brief curl does not grab', () => {
    const f = new FistDetector();
    f.update(0.5, GRAB_DWELL * 0.6);
    expect(f.update(1.2, 0.016)).toBeNull();
    expect(f.update(0.5, GRAB_DWELL * 0.6)).toBeNull();
  });
});

describe('GrabSystem', () => {
  it('a fist on the mat slides it on the table, level and at its height, and it stays where the hand opens', () => {
    const grab = new GrabSystem();
    const mat = new Box('table', new THREE.Vector3(0.6, 0.1, 0.4), new THREE.Vector3(0, 0.75, -0.5));
    grab.add(mat);
    const hand = createGrabHand();
    const hands = [createGrabHand(), hand];
    poseHand(hand, new THREE.Vector3(0.1, 0.8, -0.45), false);
    run(grab, hands, 0.1);
    expect(mat.states.at(-1)).toBe('hover');
    poseHand(hand, new THREE.Vector3(0.1, 0.8, -0.45), true);
    run(grab, hands, 0.3);
    expect(mat.began).toBe(1);
    expect(mat.states.at(-1)).toBe('held');
    // Move the fist 30 cm right and lift it 20 cm.
    poseHand(hand, new THREE.Vector3(0.4, 1.0, -0.45), true);
    run(grab, hands, 1);
    expect(mat.object.position.x).toBeCloseTo(0.3, 2);
    expect(mat.object.position.y).toBeCloseTo(0.75, 6); // stays on the table
    poseHand(hand, new THREE.Vector3(0.4, 1.0, -0.45), false);
    run(grab, hands, 0.05);
    expect(mat.ended).toBe(1);
    poseHand(hand, new THREE.Vector3(0.9, 1.0, -0.45), false);
    run(grab, hands, 0.5);
    expect(mat.object.position.x).toBeCloseTo(0.3, 2); // fixed once released
  });

  it('turns the mat with the fist', () => {
    const grab = new GrabSystem();
    const mat = new Box('table', new THREE.Vector3(0.6, 0.1, 0.4), new THREE.Vector3(0, 0.75, -0.5));
    grab.add(mat);
    const hand = createGrabHand();
    const at = new THREE.Vector3(0, 0.8, -0.45);
    poseHand(hand, at, false); // the hand arrives open, then closes
    run(grab, [createGrabHand(), hand], 0.1);
    poseHand(hand, at, true);
    run(grab, [createGrabHand(), hand], 0.3);
    // Turn the fist 90° to the left (fingers now pointing −X).
    poseHand(hand, at, true, Math.PI / 2);
    run(grab, [createGrabHand(), hand], 1);
    const yaw = new THREE.Euler().setFromQuaternion(mat.object.quaternion, 'YXZ').y;
    expect(yaw).toBeCloseTo(Math.PI / 2, 1);
  });

  it('pointing at a panel from a distance grabs it; the panel follows in 3D and faces the eyes', () => {
    const grab = new GrabSystem();
    const panel = new Box('panel', new THREE.Vector3(0.3, 0.14, 0.02), new THREE.Vector3(0, 1.0, -1.2));
    grab.add(panel);
    const hand = createGrabHand();
    poseHand(hand, new THREE.Vector3(0, 1.0, -0.2), false); // fingers point −Z, at the panel a metre away
    run(grab, [createGrabHand(), hand], 0.1);
    expect(panel.states.at(-1)).toBe('hover');
    poseHand(hand, new THREE.Vector3(0, 1.0, -0.2), true);
    run(grab, [createGrabHand(), hand], 0.3);
    poseHand(hand, new THREE.Vector3(0.2, 1.2, -0.2), true);
    run(grab, [createGrabHand(), hand], 1);
    expect(panel.object.position.x).toBeCloseTo(0.2, 2);
    expect(panel.object.position.y).toBeCloseTo(1.2, 2);
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(panel.object.quaternion);
    const toHead = head.clone().sub(panel.object.position).normalize();
    expect(facing.dot(toHead)).toBeGreaterThan(0.999);
  });

  it('ignores a fist far from anything, and one hand cannot take what the other holds', () => {
    const grab = new GrabSystem();
    const panel = new Box('panel', new THREE.Vector3(0.3, 0.14, 0.02), new THREE.Vector3(0, 1.0, -0.5));
    grab.add(panel);
    const left = createGrabHand();
    const right = createGrabHand();
    poseHand(left, new THREE.Vector3(1.5, 0.2, 0), true); // pointing nowhere near it
    run(grab, [left, right], 0.5);
    expect(panel.began).toBe(0);
    poseHand(right, new THREE.Vector3(0, 1.0, -0.47), false);
    run(grab, [left, right], 0.1);
    poseHand(right, new THREE.Vector3(0, 1.0, -0.47), true);
    run(grab, [left, right], 0.3);
    expect(panel.began).toBe(1);
    poseHand(left, new THREE.Vector3(0.05, 1.0, -0.47), false);
    run(grab, [left, right], 0.1);
    poseHand(left, new THREE.Vector3(0.05, 1.0, -0.47), true);
    run(grab, [left, right], 0.3);
    expect(panel.began).toBe(1);
  });
});
