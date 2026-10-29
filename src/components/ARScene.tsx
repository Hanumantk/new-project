import { memo, useRef, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { createHandPose, type HandPose } from '../lib/handPose';
import type { TrackingState } from '../lib/tracking';
import { PalmInjury } from './PalmInjury';
import { VideoBackground } from './VideoBackground';
import { WebcamPoseSource } from './WebcamPoseSource';

interface ARSceneProps {
  tracking: RefObject<TrackingState>;
  /** Receives the function that requests a render; called once per detected frame. */
  onReady: (invalidate: () => void) => void;
}

/**
 * The camera picture and the wound in one canvas. Renders on demand: the
 * detection loop calls `invalidate()` after each frame, so every render
 * shows one captured frame together with the pose detected on it.
 * Memoised so the HUD's updates never re-render the scene.
 */
export const ARScene = memo(function ARScene({ tracking, onReady }: ARSceneProps) {
  const pose = useRef<HandPose>(createHandPose());
  return (
    <Canvas
      frameloop="demand"
      gl={{ antialias: true }}
      dpr={[1, 2]}
      camera={{ fov: 45, near: 0.01, far: 10, position: [0, 0, 0] }}
      onCreated={(state) => onReady(state.invalidate)}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[0.6, 1, 0.8]} intensity={0.9} />
      <WebcamPoseSource tracking={tracking} pose={pose} />
      <VideoBackground tracking={tracking} pose={pose} />
      <PalmInjury pose={pose} />
    </Canvas>
  );
});
