import * as THREE from 'three';

/**
 * The steps that build the headset wound (public/models/stages/Stage_1…5.glb,
 * in Wound.glb's own frame). Step 0 is the finished wound as usual; a pinch
 * by the other hand aimed at the wound shows stage 1, the next pinch stage 2,
 * and so on to stage 5; one more goes back to the finished wound.
 */
export const STAGE_COUNT = 5;

export const STAGE_URLS = Array.from(
  { length: STAGE_COUNT },
  (_, i) => `${import.meta.env.BASE_URL}models/stages/Stage_${i + 1}.glb`,
);

/** The step after `step` (0 = finished wound, 1…STAGE_COUNT = stages). */
export function nextStep(step: number): number {
  return (step + 1) % (STAGE_COUNT + 1);
}

/** What a step shows, for its label. */
export function stepLabel(step: number): { title: string; detail: string } {
  if (step === 0) return { title: 'Finished wound', detail: 'Pinch at the wound to see how it was built' };
  return { title: `Stage ${step} of ${STAGE_COUNT}`, detail: step < STAGE_COUNT ? 'Pinch for the next stage' : 'Pinch to see the finished wound' };
}

/** A pinch counts as at the wound within this distance of its centre (m)… */
export const PINCH_NEAR = 0.12;
/** …or when the line from the wrist through the pinch passes this close to it (m)… */
export const PINCH_AIM = 0.04;
/** …with the wound ahead of the pinch, no further than this (m). */
export const PINCH_AIM_RANGE = 0.6;

/** Where the wound is now (world), shared with the mat so a pinch at the wound doesn't start a drawing. */
export const woundTarget = {
  visible: false,
  /** The hand the wound is on: only the other hand's pinches step through the stages. */
  hand: 'left' as 'left' | 'right',
  point: new THREE.Vector3(),
};

const dir = new THREE.Vector3();
const toWound = new THREE.Vector3();

/** Whether a pinch at `pinch` (the thumb and index tips' midpoint), on a hand whose wrist is at `wrist`, is aimed at the wound. */
export function isPinchAtWound(
  pinch: THREE.Vector3,
  wrist: THREE.Vector3,
  target: { visible: boolean; point: THREE.Vector3 } = woundTarget,
): boolean {
  if (!target.visible) return false;
  toWound.subVectors(target.point, pinch);
  const distance = toWound.length();
  if (distance < PINCH_NEAR) return true;
  if (distance > PINCH_AIM_RANGE) return false;
  dir.subVectors(pinch, wrist);
  if (dir.lengthSq() < 1e-8) return false;
  dir.normalize();
  const ahead = toWound.dot(dir);
  if (ahead <= 0) return false;
  return Math.sqrt(Math.max(distance * distance - ahead * ahead, 0)) < PINCH_AIM;
}
