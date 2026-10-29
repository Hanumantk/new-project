import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { createGrabHand, type GrabSystem } from '../lib/grab';

const TIPS: readonly XRHandJoint[] = ['index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];

/**
 * Feeds the headset's hand joints to the grab system every frame, so a
 * fist can pick up and carry the panels and the material mat.
 */
export function GrabController({ grab, active }: { grab: GrabSystem; active: boolean }) {
  const gl = useThree((s) => s.gl);
  const state = useMemo(() => ({ hands: [createGrabHand(), createGrabHand()], head: new THREE.Vector3() }), []);

  useFrame((_, delta) => {
    if (!active) return;
    for (let i = 0; i < 2; i++) {
      const out = state.hands[i];
      const joints = gl.xr.getHand(i).joints;
      const wrist = joints['wrist'];
      const knuckle = joints['middle-finger-phalanx-proximal'];
      out.tracked = !!wrist?.visible && !!knuckle?.visible;
      if (!out.tracked) continue;
      wrist!.getWorldPosition(out.wrist);
      knuckle!.getWorldPosition(out.knuckle);
      for (let t = 0; t < TIPS.length; t++) {
        const tip = joints[TIPS[t]];
        if (!tip?.visible) {
          out.tracked = false;
          break;
        }
        tip.getWorldPosition(out.tips[t]);
      }
    }
    gl.xr.getCamera().getWorldPosition(state.head);
    grab.update(Math.min(delta, 0.1), state.hands, state.head);
  });

  return null;
}
