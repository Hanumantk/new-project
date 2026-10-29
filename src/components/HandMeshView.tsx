import { useEffect, useMemo, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { HandRig } from '../lib/handRig';
import type { HandPose } from '../lib/handPose';

const MODEL_URL = (side: 'left' | 'right') => `${import.meta.env.BASE_URL}models/generic-hand-${side}.glb`;

interface HandMeshViewProps {
  pose: RefObject<HandPose>;
  visible: boolean;
}

/**
 * The "map" view of the hand: the tracked hand redrawn as a clean grayscale
 * mesh (faceted shading with its wireframe on top), posed every frame from
 * the same joints as the wound.
 */
export function HandMeshView({ pose, visible }: HandMeshViewProps) {
  const invalidate = useThree((s) => s.invalidate);
  const { rigs, materials } = useMemo(() => {
    const fill = new THREE.MeshStandardMaterial({
      color: '#c9cbc9',
      roughness: 0.85,
      metalness: 0,
      flatShading: true,
      polygonOffset: true, // keep the wireframe on top of the faces
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const wire = new THREE.MeshBasicMaterial({
      color: '#6f7471',
      wireframe: true,
      transparent: true,
      opacity: 0.35,
    });
    const make = (side: 'left' | 'right') => {
      const group = new THREE.Group();
      const solid = new HandRig(MODEL_URL(side), fill, side === 'right', invalidate);
      const lines = new HandRig(MODEL_URL(side), wire, side === 'right', invalidate);
      group.add(solid.root, lines.root);
      group.visible = false;
      return { group, solid, lines };
    };
    return { rigs: { left: make('left'), right: make('right') }, materials: [fill, wire] };
  }, [invalidate]);

  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  useFrame(() => {
    const hand = pose.current;
    const show = visible && !!hand?.tracked;
    const active = hand?.isRightHand ? rigs.right : rigs.left;
    const other = hand?.isRightHand ? rigs.left : rigs.right;
    other.group.visible = false;
    active.group.visible = show && active.solid.loaded;
    if (show && hand) {
      active.solid.update(hand.joints);
      active.lines.update(hand.joints);
    }
  });

  return (
    <>
      <primitive object={rigs.left.group} />
      <primitive object={rigs.right.group} />
    </>
  );
}
