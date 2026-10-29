import { memo, useRef, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { createHandPose, type HandPose } from '../lib/handPose';
import { HandMeshView } from './HandMeshView';
import { createSkinLighting, type SkinLighting } from '../lib/skinLighting';
import type { TrackingState } from '../lib/tracking';
import { PalmInjury } from './PalmInjury';
import { VideoBackground } from './VideoBackground';
import { WebcamCompositor } from './WebcamCompositor';
import { WebcamPoseSource } from './WebcamPoseSource';

interface ARSceneProps {
  tracking: RefObject<TrackingState>;
  /** Receives the function that requests a render; called once per detected frame. */
  onReady: (invalidate: () => void) => void;
  /** Show the palm grid as a wireframe. */
  debug?: boolean;
  /** Wound opacity set in the HUD, 0..1. */
  woundOpacity: RefObject<number>;
  /** 'camera': the real picture; 'mesh': the hand as a grayscale mesh on a plain backdrop. */
  view?: 'camera' | 'mesh';
}

/** In the mesh view the wound sits on the model's palm, about this far above its bones. */
const MESH_PALM_SURFACE = 0.016;

/**
 * The camera picture and the wound in one canvas. Renders on demand: the
 * detection loop calls `invalidate()` after each frame, so every render
 * shows one captured frame together with the pose detected on it.
 * Memoised so the HUD's updates never re-render the scene.
 */
export const ARScene = memo(function ARScene({
  tracking,
  onReady,
  debug = false,
  woundOpacity,
  view = 'camera',
}: ARSceneProps) {
  const meshView = view === 'mesh';
  const pose = useRef<HandPose>(createHandPose());
  const lighting = useRef<SkinLighting>(createSkinLighting());
  return (
    <Canvas
      frameloop="demand"
      gl={{ antialias: true }}
      dpr={[1, 2]}
      camera={{ fov: 45, near: 0.01, far: 10, position: [0, 0, 0] }}
      onCreated={(state) => onReady(state.invalidate)}
    >
      <WebcamPoseSource tracking={tracking} pose={pose} surfaceOffset={meshView ? MESH_PALM_SURFACE : 0} />
      <VideoBackground tracking={tracking} pose={pose} plain={meshView} />
      <HandMeshView pose={pose} visible={meshView} />
      <PalmInjury
        pose={pose}
        composite
        lighting={meshView ? undefined : lighting}
        strength={woundOpacity}
        debug={debug}
      />
      <WebcamCompositor tracking={tracking} lighting={lighting} debug={debug} matchCamera={!meshView} />
    </Canvas>
  );
});
