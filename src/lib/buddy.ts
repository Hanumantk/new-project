import * as THREE from 'three';

/**
 * Buddy, the companion that floats beside the wound hand in the headset
 * (public/models/buddy_character.glb: Y-up, metres, faces +Z, pivot at the
 * body's centre, ~23.9 cm wide).
 */

/** Buddy's width (cm) in the headset. */
export const BUDDY_SIZE_CM = 8;
const MODEL_WIDTH_M = 0.239;
export const BUDDY_SCALE = BUDDY_SIZE_CM / 100 / MODEL_WIDTH_M;
/** Body colour (MAT_Buddy_Body's base colour; its vertex-colour gradient stays). */
export const BUDDY_COLOR = '#EC6A67';

/** Where Buddy floats (m): beside the wound hand on the thumb side, above it, and pulled towards the eyes. */
export const BUDDY_SIDE = 0.12;
export const BUDDY_UP = 0.04;
export const BUDDY_TOWARD_EYE = 0.03;
/** Never closer than this to the palm centre (m), so it never touches the hand. */
export const BUDDY_MIN_PALM_DISTANCE = 0.08;
/** Never within this angle of the wound as seen from the eyes (degrees), so it never hides it. */
export const NO_BLOCK_DEG = 12;
/** Kept within this cone around the gaze (degrees), so it stays in view. */
export const VIEW_CONE_DEG = 25;
/** Without the hand: this far ahead of the eyes and this far below them (m). */
export const WAIT_AHEAD = 0.45;
export const WAIT_BELOW = 0.1;
/** The speech bubble follows Buddy on a critically damped spring that settles in about this long (s). */
export const SPRING_SETTLE_SECONDS = 0.35;

/** Face atlas cells (4 × 4), left to right, top to bottom. */
export const EXPRESSIONS = [
  'happy', 'excited', 'curious', 'thinking',
  'surprised', 'sleepy', 'wink', 'sad',
  'confused', 'cheerful', 'shy', 'determined',
  'blink', 'talk', 'love', 'neutral',
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** UV offset of the face texture for an expression (three.js, flipY = false). */
export function expressionOffset(expression: Expression, out: THREE.Vector2): THREE.Vector2 {
  const index = EXPRESSIONS.indexOf(expression);
  return out.set((index % 4) * 0.25, Math.floor(index / 4) * 0.25);
}

/** Expressions with the eyes already closed (or hearts): no blinking over them. */
export const NO_BLINK: ReadonlySet<Expression> = new Set(['sleepy', 'cheerful', 'wink', 'blink', 'love']);

/** Sprout growth: weights of the cumulative morph targets [Leaf_Grow, Bud, Bloom]. */
export const GROWTH: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], // tiny leaf
  [1, 0, 0], // growing leaf
  [1, 1, 0], // bud
  [1, 1, 0.5], // opening
  [1, 1, 1], // full flower
];
export const GROWTH_TARGETS = ['Leaf_Grow', 'Bud', 'Bloom'] as const;
const FULL_FLOWER = GROWTH.length - 1;

/**
 * The flower is the progress: before the flow starts and on the finished
 * wound it's the full flower; stage 1 is a tiny leaf, stage 2 a growing leaf,
 * 3 a bud, 4 opening, and from stage 5 on the full flower again.
 */
export function growthForStage(stage: number, started: boolean): number {
  if (!started || stage <= 0) return FULL_FLOWER;
  return Math.min(stage - 1, FULL_FLOWER);
}

const d = new THREE.Vector3();
const w = new THREE.Vector3();
const perp = new THREE.Vector3();

/** Keeps `point` at least `deg` away from direction `axis` (unit) as seen from `eye`, swinging it sideways if needed. */
function keepAngleFrom(point: THREE.Vector3, eye: THREE.Vector3, axis: THREE.Vector3, deg: number, fallback: THREE.Vector3, atMost: boolean) {
  d.subVectors(point, eye);
  const len = d.length();
  if (len < 1e-6) return;
  const cos = d.dot(axis) / len;
  const limit = Math.cos(THREE.MathUtils.degToRad(deg));
  if (atMost ? cos >= limit : cos <= limit) return;
  perp.copy(d).addScaledVector(axis, -d.dot(axis));
  if (perp.lengthSq() < 1e-10) perp.copy(fallback).addScaledVector(axis, -fallback.dot(axis));
  if (perp.lengthSq() < 1e-10) return;
  perp.normalize();
  const a = THREE.MathUtils.degToRad(deg);
  point.copy(eye).addScaledVector(axis, len * Math.cos(a)).addScaledVector(perp, len * Math.sin(a));
}

/**
 * Where Buddy wants to be (world). With the hand: beside it on the thumb
 * side, a little above and towards the eyes; never in front of the wound
 * (NO_BLOCK_DEG) nor touching the palm; and clamped into the VIEW_CONE_DEG
 * cone around the gaze. Without it: ahead of the eyes, a little low.
 */
export function buddyTarget(
  out: THREE.Vector3,
  eye: THREE.Vector3,
  gaze: THREE.Vector3,
  palm: THREE.Vector3 | null,
  thumbSide: THREE.Vector3,
): THREE.Vector3 {
  if (!palm) {
    w.copy(gaze).setY(0);
    if (w.lengthSq() < 1e-8) w.set(0, 0, -1);
    w.normalize();
    return out.copy(eye).addScaledVector(w, WAIT_AHEAD).setY(eye.y - WAIT_BELOW);
  }
  out.copy(palm).addScaledVector(thumbSide, BUDDY_SIDE);
  out.y += BUDDY_UP;
  w.subVectors(eye, palm);
  if (w.lengthSq() > 1e-8) out.addScaledVector(w.normalize(), BUDDY_TOWARD_EYE);
  // Not in front of the wound.
  w.subVectors(palm, eye).normalize();
  keepAngleFrom(out, eye, w, NO_BLOCK_DEG, thumbSide, false);
  // Not in the hand.
  d.subVectors(out, palm);
  if (d.length() < BUDDY_MIN_PALM_DISTANCE) {
    if (d.lengthSq() < 1e-10) d.copy(thumbSide);
    out.copy(palm).addScaledVector(d.normalize(), BUDDY_MIN_PALM_DISTANCE);
  }
  // In view: on the cone's edge nearest the hand if outside it.
  keepAngleFrom(out, eye, gaze, VIEW_CONE_DEG, thumbSide, true);
  return out;
}

/**
 * One step of a critically damped spring towards `target` (in place, no
 * allocation): settles in about SPRING_SETTLE_SECONDS, never overshoots.
 */
export function springStep(position: THREE.Vector3, velocity: THREE.Vector3, target: THREE.Vector3, dt: number) {
  const omega = 5.8 / SPRING_SETTLE_SECONDS;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  // change = position − target; temp = (velocity + ω·change)·dt
  d.subVectors(position, target);
  perp.copy(velocity).addScaledVector(d, omega).multiplyScalar(dt);
  velocity.addScaledVector(perp, -omega).multiplyScalar(decay);
  position.copy(target).add(d.add(perp).multiplyScalar(decay));
}
