import { memo, useRef, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { createHandPose, type HandPose } from '../lib/handPose';
import type { TrackingState } from '../lib/tracking';
import { PalmInjury } from './PalmInjury';
import { WebcamPoseSource } from './WebcamPoseSource';

interface ARSceneProps {
  tracking: RefObject<TrackingState>;
}

/**
 * Transparent three.js canvas layered over the video. Memoised so the HUD's
 * FPS / status updates never re-render the scene.
 */
export const ARScene = memo(function ARScene({ tracking }: ARSceneProps) {
  const pose = useRef<HandPose>(createHandPose());
  return (
    <Canvas
      gl={{ alpha: true, antialias: true }}
      dpr={[1, 2]}
      camera={{ fov: 45, near: 0.01, far: 10, position: [0, 0, 0] }}
      style={{ background: 'transparent' }}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[0.6, 1, 0.8]} intensity={0.9} />
      <WebcamPoseSource tracking={tracking} pose={pose} />
      <PalmInjury pose={pose} />
    </Canvas>
  );
});
