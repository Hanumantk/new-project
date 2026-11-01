import * as THREE from 'three';

/**
 * Buddy, the companion that floats beside the wound hand in the headset
 * (public/models/buddy.glb; its spec is scripts/buddy/README.md).
 */

/** Face atlas cells (4 × 4), left to right, top to bottom. */
export const EXPRESSIONS = [
  'happy', 'excited', 'curious', 'thinking',
  'surprised', 'sleepy', 'wink', 'sad',
  'confused', 'cheerful', 'shy', 'determined',
  'blink', 'talk', 'love', 'neutral',
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** UV offset of the face texture for an expression (three.js, flipY = false). */
export function expressionOffset(expression: Expression, out = new THREE.Vector2()): THREE.Vector2 {
  const index = EXPRESSIONS.indexOf(expression);
  return out.set((index % 4) * 0.25, Math.floor(index / 4) * 0.25);
}

/** Expressions with the eyes already closed (or hearts): no blinking over them. */
export const NO_BLINK: ReadonlySet<Expression> = new Set(['sleepy', 'cheerful', 'wink', 'blink', 'love']);

/** Sprout growth stages: weights of the cumulative morph targets [Leaf_Grow, Bud, Bloom]. */
export const GROWTH: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], // tiny leaf
  [1, 0, 0], // growing leaf
  [1, 1, 0], // bud
  [1, 1, 0.5], // opening
  [1, 1, 1], // full flower
];
export const GROWTH_TARGETS = ['Leaf_Grow', 'Bud', 'Bloom'] as const;

/**
 * The flower grows with the wound's build stages: stage 1 is a tiny leaf, …,
 * stage 5 the full flower; the finished wound (step 0) is the full flower too.
 */
export function growthForStep(step: number): number {
  return step <= 0 ? GROWTH.length - 1 : Math.min(step - 1, GROWTH.length - 1);
}

/** Buddy's size: the model is ~24 cm wide; beside a hand it's this fraction of that (~10 cm). */
export const BUDDY_SCALE = 0.42;

/** Where Buddy hovers relative to the palm (m): up, out to the side of the hand, and how far it wanders around that. */
export const HOVER_UP = 0.1;
export const HOVER_SIDE = 0.13;
export const WANDER_ANGLE = 0.5;

const forward = new THREE.Vector3();
const right = new THREE.Vector3();

/**
 * The point Buddy floats towards at time `t` (s): above the palm and out to
 * the side of the hand away from the body (left of a left hand, right of a
 * right hand, as the viewer sees it), slowly circling there so it never sits
 * between the eyes and the palm.
 */
export function hoverPoint(palm: THREE.Vector3, eye: THREE.Vector3, side: 'left' | 'right', t: number, out: THREE.Vector3) {
  forward.subVectors(palm, eye).setY(0);
  if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
  forward.normalize();
  right.set(-forward.z, 0, forward.x);
  const sign = side === 'left' ? -1 : 1;
  const angle = WANDER_ANGLE * Math.sin(t * 0.45);
  const radius = HOVER_SIDE * (1 + 0.12 * Math.sin(t * 0.8));
  return out
    .copy(palm)
    .addScaledVector(right, sign * radius * Math.cos(angle))
    .addScaledVector(forward, radius * Math.sin(angle))
    .setY(palm.y + HOVER_UP + 0.015 * Math.sin(t * 1.1));
}
