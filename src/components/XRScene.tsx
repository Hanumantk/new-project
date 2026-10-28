import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { createHandPose, type HandPose } from '../lib/handPose';
import type { HandStatus } from './Hud';
import { PalmInjury } from './PalmInjury';
import { XRPoseSource } from './XRPoseSource';

export type XRMode = 'ar' | 'vr';

interface XRSceneProps {
  /** The active session's mode, or null before entering / after leaving. */
  mode: XRMode | null;
  rendererRef: RefObject<THREE.WebGLRenderer | null>;
  onHandStatus: (status: HandStatus) => void;
}

/**
 * The headset scene: the wound on the user's palm driven by the headset's
 * hand tracking. In VR it adds virtual hands and a simple room; in mixed
 * reality the real room and hands show through passthrough.
 */
export const XRScene = memo(function XRScene({ mode, rendererRef, onHandStatus }: XRSceneProps) {
  const pose = useRef<HandPose>(createHandPose());
  const isVR = mode !== 'ar';

  return (
    <Canvas
      gl={{ alpha: true, antialias: true }}
      dpr={[1, 2]}
      camera={{ fov: 60, near: 0.01, far: 50, position: [0, 1.5, 0.8] }}
      onCreated={({ gl }) => {
        rendererRef.current = gl;
      }}
    >
      {isVR && <VRRoom />}
      <hemisphereLight args={['#ffffff', '#c9cfc7', 0.8]} />
      <directionalLight position={[0.6, 2.2, 0.8]} intensity={1} />
      <XRPoseSource pose={pose} showHands={isVR} />
      <PalmInjury pose={pose} occlude={!isVR} />
      <HintPanel pose={pose} active={mode !== null} />
      <StatusReporter pose={pose} onHandStatus={onHandStatus} />
    </Canvas>
  );
});

/** A calm, light room so VR isn't a black void: backdrop, floor and a grid. */
function VRRoom() {
  return (
    <>
      <color attach="background" args={['#e9ece8']} />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[6, 64]} />
        <meshStandardMaterial color="#d6dbd4" roughness={1} />
      </mesh>
      <gridHelper args={[12, 24, '#b9c1b7', '#c8cec6']} position={[0, 0.001, 0]} />
    </>
  );
}

const HINTS: Record<'none' | 'closed', string> = {
  none: 'Hold up your open palm',
  closed: 'Open your hand',
};

/** A small panel floating in front of the user while no open hand is tracked. */
function HintPanel({ pose, active }: { pose: RefObject<HandPose>; active: boolean }) {
  const gl = useThree((s) => s.gl);
  const meshRef = useRef<THREE.Mesh>(null);
  const { canvas, texture, material } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 192;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
    return { canvas, texture, material };
  }, []);
  const scratch = useMemo(
    () => ({ shown: '' as string, head: new THREE.Vector3(), forward: new THREE.Vector3(), target: new THREE.Vector3(), placed: false }),
    [],
  );

  useEffect(
    () => () => {
      texture.dispose();
      material.dispose();
    },
    [texture, material],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    const hand = pose.current;
    if (!mesh || !hand) return;
    const hint = !active ? '' : !hand.tracked ? HINTS.none : !hand.open ? HINTS.closed : '';
    mesh.visible = hint !== '';
    if (!hint) {
      scratch.placed = false;
      return;
    }
    if (hint !== scratch.shown) {
      scratch.shown = hint;
      drawHint(canvas, hint);
      texture.needsUpdate = true;
    }

    // Float about 80 cm ahead of the head, easing after it as the user turns.
    const head = gl.xr.getCamera();
    head.getWorldPosition(scratch.head);
    head.getWorldDirection(scratch.forward);
    scratch.forward.y = 0;
    scratch.forward.normalize();
    scratch.target.copy(scratch.head).addScaledVector(scratch.forward, 0.8);
    scratch.target.y -= 0.12;
    if (!scratch.placed) mesh.position.copy(scratch.target);
    else mesh.position.lerp(scratch.target, 0.06);
    scratch.placed = true;
    mesh.lookAt(scratch.head);
  });

  return (
    <mesh ref={meshRef} material={material} visible={false}>
      <planeGeometry args={[0.4, 0.075]} />
    </mesh>
  );
}

function drawHint(canvas: HTMLCanvasElement, text: string) {
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(251, 250, 247, 0.94)';
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, h / 2 - 4);
  ctx.fill();
  ctx.fillStyle = '#1f2a24';
  ctx.font = '600 76px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 4);
}

/** Tells the page (outside the headset) whether a hand is tracked. */
function StatusReporter({
  pose,
  onHandStatus,
}: {
  pose: RefObject<HandPose>;
  onHandStatus: (status: HandStatus) => void;
}) {
  const last = useRef<HandStatus>('none');
  useFrame(() => {
    const hand = pose.current;
    if (!hand) return;
    const status: HandStatus = !hand.tracked ? 'none' : hand.open ? 'open' : 'closed';
    if (status !== last.current) {
      last.current = status;
      onHandStatus(status);
    }
  });
  return null;
}
