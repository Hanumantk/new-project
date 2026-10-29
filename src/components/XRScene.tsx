import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GrabSystem, type GrabState } from '../lib/grab';
import { createHandPose, type HandPose } from '../lib/handPose';
import { GrabController } from './GrabController';
import type { Kit } from '../mat/lib/kit';
import { MaterialMat } from '../mat/MaterialMat';
import type { MatSystem } from '../mat/xr/MatSystem';
import { HEADSET_SLIDER, pokeSliderValue } from '../lib/pokeSlider';
import type { HandStatus } from './Hud';
import { PalmInjury } from './PalmInjury';
import { XRPoseSource } from './XRPoseSource';

export type XRMode = 'ar' | 'vr';

interface XRSceneProps {
  /** The active session's mode, or null before entering / after leaving. */
  mode: XRMode | null;
  /** Height of the floor in the session's reference space (below 0 without a floor-level space). */
  floorY: number;
  rendererRef: RefObject<THREE.WebGLRenderer | null>;
  onHandStatus: (status: HandStatus) => void;
  /** Wound opacity 0..1, shared with the page's slider. */
  woundOpacity: RefObject<number>;
  /** Called when the in-headset slider changes the opacity. */
  onWoundOpacityChange: (value: number) => void;
  /** The material mat's kit (mixed reality only), or null if it didn't load. */
  kit: Kit | null;
  onMatSystem?: (system: MatSystem | null) => void;
}

/**
 * The headset scene: the wound on the user's palm driven by the headset's
 * hand tracking. In VR it adds virtual hands and a simple room; in mixed
 * reality the real room and hands show through passthrough.
 */
export const XRScene = memo(function XRScene({
  mode,
  floorY,
  rendererRef,
  onHandStatus,
  woundOpacity,
  onWoundOpacityChange,
  kit,
  onMatSystem,
}: XRSceneProps) {
  const pose = useRef<HandPose>(createHandPose());
  // Panels and the material mat can be carried with a fist.
  const grab = useMemo(() => new GrabSystem(), []);
  const isVR = mode !== 'ar';

  return (
    <Canvas
      gl={createXRRenderer}
      dpr={[1, 2]}
      camera={{ fov: 60, near: 0.01, far: 50, position: [0, 1.5, 0.8] }}
      onCreated={({ gl }) => {
        rendererRef.current = gl;
      }}
    >
      {isVR && <VRRoom floorY={floorY} />}
      <hemisphereLight args={['#ffffff', '#c9cfc7', 0.8]} />
      <directionalLight position={[0.6, 2.2, 0.8]} intensity={1} />
      <XRPoseSource pose={pose} showHands={isVR} />
      <PalmInjury pose={pose} occlude={!isVR} strength={woundOpacity} />
      <HintPanel pose={pose} active={mode !== null} />
      <HeadsetSlider value={woundOpacity} active={mode !== null} onChange={onWoundOpacityChange} grab={grab} />
      <StatusReporter pose={pose} onHandStatus={onHandStatus} />
      <MaterialMat active={mode === 'ar'} kit={kit} onSystem={onMatSystem} grab={grab} />
      <GrabController grab={grab} active={mode !== null} />
    </Canvas>
  );
});

/**
 * Creates the WebGL context XR-compatible from the start. Otherwise three.js
 * converts it when the session starts, which on laptops with two GPUs can
 * lose the context and make the session fail to start.
 */
function createXRRenderer(props: { canvas: unknown }) {
  const canvas = props.canvas as HTMLCanvasElement;
  const attributes = {
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    xrCompatible: true,
  } as const;
  const context = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext | null;
  return new THREE.WebGLRenderer({ canvas, ...attributes, ...(context ? { context } : {}) });
}

/** A calm, light room so VR isn't a black void: backdrop, floor and a grid. */
function VRRoom({ floorY }: { floorY: number }) {
  return (
    <>
      <color attach="background" args={['#e9ece8']} />
      <group position={[0, floorY, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[6, 64]} />
          <meshStandardMaterial color="#d6dbd4" roughness={1} />
        </mesh>
        <gridHelper args={[12, 24, '#b9c1b7', '#c8cec6']} position={[0, 0.001, 0]} />
      </group>
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

/**
 * The wound-opacity slider inside the headset: a small panel placed below
 * and to the left of where the user looks when the session starts. Press
 * and slide along it with either index fingertip.
 */
function HeadsetSlider({
  value,
  active,
  onChange,
  grab,
}: {
  value: RefObject<number>;
  active: boolean;
  onChange: (value: number) => void;
  grab: GrabSystem;
}) {
  const gl = useThree((s) => s.gl);
  const meshRef = useRef<THREE.Mesh>(null);
  const { canvas, texture, material } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 220;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
    return { canvas, texture, material };
  }, []);
  const scratch = useMemo(
    () => ({
      placed: false,
      drawn: -1,
      sent: -1,
      head: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      active: false,
      held: false,
    }),
    [],
  );
  scratch.active = active;

  // Carry it with a fist: it follows, turns to face you, and stays where you let go.
  useEffect(
    () =>
      grab.add({
        bounds: new THREE.Box3(
          new THREE.Vector3(-HEADSET_SLIDER.width / 2, -HEADSET_SLIDER.height / 2, -0.03),
          new THREE.Vector3(HEADSET_SLIDER.width / 2, HEADSET_SLIDER.height / 2, 0.03),
        ),
        style: 'panel',
        canGrab: () => scratch.active && scratch.placed && !!meshRef.current?.visible,
        worldMatrix: (out) => {
          const mesh = meshRef.current!;
          mesh.updateWorldMatrix(true, false);
          out.copy(mesh.matrixWorld);
        },
        begin: () => {
          scratch.held = true;
        },
        move: (world) => {
          const mesh = meshRef.current!;
          world.decompose(mesh.position, mesh.quaternion, mesh.scale);
        },
        end: () => {
          scratch.held = false;
        },
        setGrabState: (state: GrabState) => material.color.copy(GRAB_TINT[state]),
      }),
    [grab, material, scratch],
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
    const opacity = value.current;
    if (!mesh || opacity === null) return;
    mesh.visible = active;
    if (!active) {
      scratch.placed = false;
      return;
    }

    if (!scratch.placed) {
      const head = gl.xr.getCamera();
      head.getWorldPosition(scratch.head);
      if (scratch.head.lengthSq() === 0) return; // no head pose yet
      head.getWorldDirection(scratch.forward);
      scratch.forward.y = 0;
      scratch.forward.normalize();
      scratch.right.set(-scratch.forward.z, 0, scratch.forward.x);
      mesh.position
        .copy(scratch.head)
        .addScaledVector(scratch.forward, 0.42)
        .addScaledVector(scratch.right, -0.17);
      mesh.position.y -= 0.22;
      mesh.lookAt(scratch.head);
      mesh.updateMatrixWorld();
      scratch.placed = true;
    }

    // Either index fingertip pressing the panel sets the value (not while it's carried).
    for (let i = 0; i < 2 && !scratch.held; i++) {
      const tip = gl.xr.getHand(i).joints['index-finger-tip'];
      if (!tip?.visible) continue;
      mesh.worldToLocal(tip.getWorldPosition(scratch.tip));
      const next = pokeSliderValue(scratch.tip.x, scratch.tip.y, scratch.tip.z, HEADSET_SLIDER);
      if (next === null) continue;
      value.current = next;
      const percent = Math.round(next * 100);
      if (percent !== scratch.sent) {
        scratch.sent = percent;
        onChange(next);
      }
    }

    const percent = Math.round(value.current * 100);
    if (percent !== scratch.drawn) {
      scratch.drawn = percent;
      drawSlider(canvas, value.current);
      texture.needsUpdate = true;
    }
  });

  return (
    <mesh ref={meshRef} material={material} visible={false}>
      <planeGeometry args={[HEADSET_SLIDER.width, HEADSET_SLIDER.height]} />
    </mesh>
  );
}

/** The slider panel's tint: normal, with a hand on it, and while it's carried. */
const GRAB_TINT: Record<GrabState, THREE.Color> = {
  none: new THREE.Color('#ffffff'),
  hover: new THREE.Color('#d9f5e4'),
  held: new THREE.Color('#b5ecca'),
};

function drawSlider(canvas: HTMLCanvasElement, value: number) {
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  const toPx = (x: number) => (x / HEADSET_SLIDER.width + 0.5) * w;
  const x0 = toPx(HEADSET_SLIDER.trackStart);
  const x1 = toPx(HEADSET_SLIDER.trackEnd);
  const cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(251, 250, 247, 0.94)';
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 48);
  ctx.fill();

  ctx.fillStyle = '#6b746f';
  ctx.font = '500 40px "DM Sans", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('Wound', 44, cy - 24);
  ctx.fillText('opacity', 44, cy + 24);

  ctx.lineCap = 'round';
  ctx.lineWidth = 16;
  ctx.strokeStyle = '#d6dbd8';
  ctx.beginPath();
  ctx.moveTo(x0, cy);
  ctx.lineTo(x1, cy);
  ctx.stroke();
  const knob = x0 + (x1 - x0) * value;
  ctx.strokeStyle = '#2f9e63';
  ctx.beginPath();
  ctx.moveTo(x0, cy);
  ctx.lineTo(Math.max(knob, x0 + 0.1), cy);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#2f9e63';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(knob, cy, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#1f2a24';
  ctx.font = '600 46px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(value * 100)}%`, w - 40, cy + 2);
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
