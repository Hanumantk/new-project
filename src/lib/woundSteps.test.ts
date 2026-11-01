import { describe, expect, it } from 'vitest';
import { CUT_OPEN_SECONDS, STAGE_COUNT, STEP_COOLDOWN, StageFlow } from './woundSteps';

const OPEN = 0.05;
const CLOSED = 0.005;

/** A tap: pinch closed for a moment, then open, then wait out the cooldown. */
function tap(flow: StageFlow, inRange = true) {
  flow.update(0.016, CLOSED, inRange);
  flow.update(0.1, CLOSED, inRange);
  flow.update(0.016, OPEN, inRange);
  flow.update(STEP_COOLDOWN + 0.01, OPEN, inRange);
}

describe('StageFlow', () => {
  it('starts on the finished wound', () => {
    expect(new StageFlow().stage).toBe(0);
  });

  it('steps 0 → 1 … 6 → 0, one stage per tap', () => {
    const flow = new StageFlow();
    const seen = [flow.stage];
    for (let i = 0; i < STAGE_COUNT + 1; i++) {
      tap(flow);
      seen.push(flow.stage);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 0]);
  });

  it('fires on release, not on the pinch itself', () => {
    const flow = new StageFlow();
    flow.update(0.016, CLOSED, true);
    expect(flow.stage).toBe(0);
    flow.update(0.016, OPEN, true);
    expect(flow.stage).toBe(1);
  });

  it('ignores pinches away from the wound', () => {
    const flow = new StageFlow();
    tap(flow, false);
    expect(flow.stage).toBe(0);
  });

  it('ignores a second release inside the cooldown (tracking jitter)', () => {
    const flow = new StageFlow();
    flow.update(0.016, CLOSED, true);
    flow.update(0.016, OPEN, true);
    flow.update(0.016, CLOSED, true);
    flow.update(0.016, OPEN, true);
    expect(flow.stage).toBe(1);
  });

  it('only ever goes forward, however long the pinch is held', () => {
    const flow = new StageFlow();
    tap(flow);
    tap(flow);
    expect(flow.stage).toBe(2);
    flow.update(0.016, CLOSED, true);
    for (let t = 0; t < 3; t += 0.016) flow.update(0.016, CLOSED, true);
    expect(flow.stage).toBe(2);
    flow.update(0.016, OPEN, true);
    expect(flow.stage).toBe(3);
  });

  it('counts a real headset pinch (tips ~1.8 cm apart)', () => {
    const flow = new StageFlow();
    flow.update(0.016, 0.018, true);
    flow.update(0.016, OPEN, true);
    expect(flow.stage).toBe(1);
  });

  it('counts a pinch that starts on the way to the wound', () => {
    const flow = new StageFlow();
    flow.update(0.016, CLOSED, false);
    flow.update(0.016, CLOSED, true);
    flow.update(0.016, CLOSED, false);
    flow.update(0.016, OPEN, false);
    expect(flow.stage).toBe(1);
  });

  it('a brief tracking loss mid-pinch is ignored, and the release still counts once', () => {
    const flow = new StageFlow();
    flow.update(0.016, CLOSED, true);
    flow.update(0.5, null, false);
    flow.update(0.016, CLOSED, true);
    flow.update(0.016, OPEN, true);
    expect(flow.stage).toBe(1);
  });

  it('a hand lost mid-pinch still steps once, then keeps the stage', () => {
    const flow = new StageFlow();
    tap(flow);
    flow.update(0.016, CLOSED, true);
    flow.update(2, null, false);
    flow.update(2, null, false);
    expect(flow.stage).toBe(2);
  });

  it('opens the cut more slowly', () => {
    const flow = new StageFlow();
    tap(flow);
    tap(flow);
    flow.update(0.016, CLOSED, true);
    flow.update(0.016, OPEN, true);
    expect(flow.stage).toBe(3);
    flow.update(CUT_OPEN_SECONDS / 2, OPEN, true);
    expect(flow.blend).toBeCloseTo(0.5, 1);
  });
});
