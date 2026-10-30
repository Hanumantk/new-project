import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GrabSystem, type GrabState } from '../lib/grab';
import { createHandPose, type HandPose } from '../lib/handPose';
import { GrabController } from './GrabController';
import type { Kit } from '../mat/lib/kit';
import { MaterialMat } from '../mat/MaterialMat';
import type { MatSystem } from '../mat/xr/MatSystem';
import { GLASS_FONT, GLASS_TEXT, GLASS_TEXT_ON_SELECTED, drawGlassSlider, drawGlassTile, drawSymbol } from '../lib/glassCanvas';
import { HEADSET_SLIDER, pokeSliderValue } from '../lib/pokeSlider';
import type { HandStatus } from './Hud';
import { XRPoseSource } from './XRPoseSource';
import { XRWound } from './XRWound';
import { XRWoundPanel } from './XRWoundPanel';

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
      {mode === 'vr' && <VRRoom floorY={floorY} />}
      <hemisphereLight args={['#ffffff', '#c9cfc7', 0.8]} />
      <directionalLight position={[0.6, 2.2, 0.8]} intensity={1} />
      <XRPoseSource pose={pose} showHands={isVR} />
      <XRWound strength={woundOpacity} />
      <XRWoundPanel active={mode !== null} />
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

const HINT_NO_HAND = 'Hold up your palm';

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
    // Only while the chosen hand isn't tracked (the wound never waits for an open hand).
    const hint = !active ? '' : !hand.tracked ? HINT_NO_HAND : '';
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
  drawGlassTile(ctx, 6, 6, w - 12, h - 12);
  ctx.fillStyle = GLASS_TEXT;
  ctx.font = `600 76px ${GLASS_FONT}`;
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
  // A Control-Center slider laid sideways: the glass pill fills with white up to the fingertip.
  const edge = 6 + (w - 12) * value;
  ctx.clearRect(0, 0, w, h);
  drawGlassSlider(ctx, 6, 6, w - 12, h - 12, value);
  const ink = (px: number) => (px < edge ? GLASS_TEXT_ON_SELECTED : GLASS_TEXT);
  const cy = h / 2;
  ctx.textBaseline = 'middle';
  drawSymbol(ctx, 'drop', 70, cy, 52, ink(70));
  ctx.font = `600 44px ${GLASS_FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = ink(112);
  ctx.fillText('Wound opacity', 112, cy + 2);
  ctx.textAlign = 'right';
  ctx.fillStyle = ink(w - 52);
  ctx.fillText(`${Math.round(value * 100)}%`, w - 52, cy + 2);
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
    const status: HandStatus = hand.tracked ? 'open' : 'none';
    if (status !== last.current) {
      last.current = status;
      onHandStatus(status);
    }
  });
  return null;
}
