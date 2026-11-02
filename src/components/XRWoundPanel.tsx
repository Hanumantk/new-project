import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { FingerCursor } from '../lib/fingerCursor';
import { PANEL_GRAB_TINT, type GrabState, type GrabSystem } from '../lib/grab';
import { SliderGrip, type PokeSliderLayout } from '../lib/pokeSlider';
import { uiSound } from '../lib/uiSound';
import { SKIN_PRESETS, requestReattach, setXRPrefs, xrPrefs, type HandSide } from '../lib/xrPrefs';

/** Panel size (metres) and canvas resolution. */
const W = 0.24;
const H = 0.13;
const PX = 1200;
const PY = 650;
/** The skin-height slider's range (± mm). */
const HEIGHT_RANGE_MM = 5;
/** A fingertip counts as pressing within this distance of the face (m)… */
const TOUCH = 0.015;
/** …and must pull back this far before it can press again. */
const RELEASE = 0.03;

type Target =
  | { kind: 'hand'; side: HandSide }
  | { kind: 'reattach' }
  | { kind: 'mesh' }
  | { kind: 'skin'; index: number }
  | { kind: 'auto' }
  | { kind: 'fine' }
  | { kind: 'height' };

interface Region {
  target: Target;
  /** Panel-space rectangle (metres, origin at the centre, y up). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// Layout (metres): row 1 hand + re-attach, row 2 skin swatches, row 3 fine tone.
const REGIONS: Region[] = [
  { target: { kind: 'hand', side: 'left' }, x0: -0.11, x1: -0.065, y0: 0.032, y1: 0.06 },
  { target: { kind: 'hand', side: 'right' }, x0: -0.06, x1: -0.015, y0: 0.032, y1: 0.06 },
  { target: { kind: 'reattach' }, x0: -0.005, x1: 0.058, y0: 0.032, y1: 0.06 },
  { target: { kind: 'mesh' }, x0: 0.063, x1: 0.11, y0: 0.032, y1: 0.06 },
  ...SKIN_PRESETS.map((_, index) => ({
    target: { kind: 'skin', index } as Target,
    x0: -0.11 + index * 0.031,
    x1: -0.11 + index * 0.031 + 0.026,
    y0: -0.001,
    y1: 0.026,
  })),
  { target: { kind: 'auto' }, x0: 0.076, x1: 0.11, y0: -0.001, y1: 0.026 },
  { target: { kind: 'fine' }, x0: -0.07, x1: 0.1, y0: -0.031, y1: -0.011 },
  { target: { kind: 'height' }, x0: -0.07, x1: 0.1, y0: -0.059, y1: -0.039 },
];

/** A pressed button flashes this long (s). */
const PRESS_FLASH = 0.3;

/** A slider region's layout for its grip (panel-space x; y measured from the region's centre line). */
const sliderLayout = (r: Region): PokeSliderLayout => ({
  width: W,
  height: r.y1 - r.y0,
  trackStart: r.x0,
  trackEnd: r.x1,
  touchDepth: TOUCH,
});
const FINE = REGIONS.findIndex((r) => r.target.kind === 'fine');
const HEIGHT = REGIONS.findIndex((r) => r.target.kind === 'height');
const SLIDERS = [
  { region: FINE, layout: sliderLayout(REGIONS[FINE]), centre: (REGIONS[FINE].y0 + REGIONS[FINE].y1) / 2 },
  { region: HEIGHT, layout: sliderLayout(REGIONS[HEIGHT]), centre: (REGIONS[HEIGHT].y0 + REGIONS[HEIGHT].y1) / 2 },
];

/**
 * In-headset settings for the wound: which hand (only that one is ever
 * used), Calibrate (measure the hand and lay the wound on its palm afresh),
 * Mesh (show the hand model), the skin tone (Auto from the camera, six
 * presets, a fine adjustment) and the wound's height on the skin. Press with
 * an index fingertip.
 */
export function XRWoundPanel({ active, grab }: { active: boolean; grab: GrabSystem }) {
  const gl = useThree((s) => s.gl);
  const meshRef = useRef<THREE.Mesh>(null);
  const { canvas, texture, material } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = PX;
    canvas.height = PY;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
    return { canvas, texture, material };
  }, []);
  const s = useMemo(
    () => ({
      placed: false,
      active: false,
      held: false,
      drawn: -1,
      flash: 0,
      armed: [true, true],
      // Feedback: the button under the finger, the one just pressed, the sliders' grips, the cursor.
      hover: -1,
      pressed: -1,
      pressedFor: 0,
      grips: [new SliderGrip(), new SliderGrip()],
      owner: -1,
      cursor: new FingerCursor(),
      head: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      tip: new THREE.Vector3(),
    }),
    [],
  );

  s.active = active;

  // Carry it with a fist (as the mat and the opacity slider): it follows, turns to face you, and stays where you let go.
  useEffect(
    () =>
      grab.add({
        bounds: new THREE.Box3(new THREE.Vector3(-W / 2, -H / 2, -0.03), new THREE.Vector3(W / 2, H / 2, 0.03)),
        style: 'panel',
        canGrab: () => s.active && s.placed && !!meshRef.current?.visible,
        worldMatrix: (out) => {
          const mesh = meshRef.current!;
          mesh.updateWorldMatrix(true, false);
          out.copy(mesh.matrixWorld);
        },
        begin: () => {
          s.held = true;
        },
        move: (world) => {
          const mesh = meshRef.current!;
          world.decompose(mesh.position, mesh.quaternion, mesh.scale);
        },
        end: () => {
          s.held = false;
        },
        setGrabState: (state: GrabState) => material.color.copy(PANEL_GRAB_TINT[state]),
      }),
    [grab, material, s],
  );

  useEffect(
    () => () => {
      texture.dispose();
      material.dispose();
      s.cursor.dispose();
    },
    [texture, material, s],
  );

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.visible = active;
    if (!active) {
      s.placed = false;
      return;
    }
    if (!s.placed) {
      // Below and to the right of straight ahead (the opacity slider is on the left).
      const head = gl.xr.getCamera();
      head.getWorldPosition(s.head);
      if (s.head.lengthSq() === 0) return;
      head.getWorldDirection(s.forward);
      s.forward.y = 0;
      s.forward.normalize();
      s.right.set(-s.forward.z, 0, s.forward.x);
      mesh.position.copy(s.head).addScaledVector(s.forward, 0.42).addScaledVector(s.right, 0.17);
      mesh.position.y -= 0.24;
      mesh.lookAt(s.head);
      mesh.updateMatrixWorld();
      s.placed = true;
    }

    // The nearest index fingertip over the panel (once a slider is grabbed, only that hand's); none while it's carried.
    const sliding = s.grips[0].state === 'held' || s.grips[1].state === 'held';
    let finger = -1;
    let fx = 0, fy = 0, fz = Infinity;
    for (let i = 0; i < 2 && !s.held; i++) {
      if (sliding && s.owner !== i) continue;
      const tip = gl.xr.getHand(i).joints['index-finger-tip'];
      if (!tip?.visible) continue;
      mesh.worldToLocal(tip.getWorldPosition(s.tip));
      const { x, y, z } = s.tip;
      if (Math.abs(z) > RELEASE) s.armed[i] = true;
      if (Math.abs(x) > W / 2 + 0.05 || Math.abs(y) > H / 2 + 0.05) {
        s.armed[i] = true;
        continue;
      }
      if (Math.abs(z) >= Math.abs(fz)) continue;
      finger = i;
      fx = x;
      fy = y;
      fz = z;
    }

    // Sliders: a touch grabs one; from then on only sideways movement counts, until the finger is pulled away.
    let holding = false;
    for (let k = 0; k < SLIDERS.length; k++) {
      const grip = s.grips[k];
      if (sliding && grip.state !== 'held') continue;
      const slider = SLIDERS[k];
      const wasHeld = grip.state === 'held';
      const held = grip.update(finger >= 0 ? fx : null, fy - slider.centre, fz, slider.layout, delta);
      if (held && !wasHeld) {
        uiSound.press();
        s.owner = finger;
      }
      if (!held && wasHeld) uiSound.release();
      if (!held) continue;
      holding = true;
      const value = grip.value;
      if (k === 0) {
        if (Math.abs(value - xrPrefs.skinFine) > 0.01 || xrPrefs.skinAuto) {
          if (Math.floor(value * 10) !== Math.floor(xrPrefs.skinFine * 10)) uiSound.tick();
          setXRPrefs({ skinFine: value, skinAuto: false });
        }
      } else {
        // Skin height in 0.5 mm steps, a tick each.
        const mm = Math.round((value * 2 - 1) * HEIGHT_RANGE_MM * 2) / 2;
        if (mm !== xrPrefs.skinHeightMm) {
          uiSound.tick();
          setXRPrefs({ skinHeightMm: mm });
        }
      }
    }

    // Buttons: lit while the finger is over one, flashed and clicked when pressed.
    s.hover = -1;
    if (finger >= 0 && !holding && fz < 0.06 && fz > -RELEASE) {
      for (let r = 0; r < REGIONS.length; r++) {
        const region = REGIONS[r];
        if (region.target.kind === 'fine' || region.target.kind === 'height') continue;
        if (fx >= region.x0 && fx <= region.x1 && fy >= region.y0 && fy <= region.y1) s.hover = r;
      }
      if (s.hover >= 0 && Math.abs(fz) <= TOUCH && s.armed[finger]) {
        s.armed[finger] = false;
        s.pressed = s.hover;
        s.pressedFor = PRESS_FLASH;
        uiSound.press();
        const t = REGIONS[s.hover].target;
        if (t.kind === 'hand') setXRPrefs({ hand: t.side });
        else if (t.kind === 'skin') setXRPrefs({ skinPreset: t.index, skinAuto: false });
        else if (t.kind === 'auto') setXRPrefs({ skinAuto: !xrPrefs.skinAuto });
        else if (t.kind === 'mesh') setXRPrefs({ showHandMesh: !xrPrefs.showHandMesh });
        else {
          requestReattach();
          s.flash = 0.4;
        }
      }
    }
    if (s.pressedFor > 0) {
      s.pressedFor -= delta;
      if (s.pressedFor <= 0) s.pressed = -1;
    }
    s.cursor.update(finger >= 0 ? fx : null, fy, fz, holding || (s.hover >= 0 && Math.abs(fz) <= TOUCH));

    if (s.flash > 0) s.flash = Math.max(0, s.flash - delta);
    const fineState = s.grips[0].state === 'held' ? 2 : s.grips[0].state === 'hover' ? 1 : 0;
    const heightState = s.grips[1].state === 'held' ? 2 : s.grips[1].state === 'hover' ? 1 : 0;
    const version = ((((xrPrefs.version * 2 + (s.flash > 0 ? 1 : 0)) * 32 + s.hover + 1) * 32 + s.pressed + 1) * 3 + fineState) * 3 + heightState;
    if (version !== s.drawn) {
      s.drawn = version;
      draw(canvas, s.flash > 0, s.hover, s.pressed, fineState, heightState);
      texture.needsUpdate = true;
    }
  });

  return (
    <mesh ref={meshRef} material={material} visible={false}>
      <planeGeometry args={[W, H]} />
      <primitive object={s.cursor.mesh} />
    </mesh>
  );
}

/**
 * Draws the panel. Feedback: the button under the finger gets a green
 * outline, a pressed one flashes green, a hovered slider's track glows and a
 * held one's knob grows and fills (slider states: 0 idle, 1 hover, 2 held).
 */
function draw(canvas: HTMLCanvasElement, reattachFlash: boolean, hover: number, pressed: number, fineState: number, heightState: number) {
  const ctx = canvas.getContext('2d')!;
  const k = PX / W;
  const rect = (r: Region) => [(r.x0 + W / 2) * k, (H / 2 - r.y1) * k, (r.x1 - r.x0) * k, (r.y1 - r.y0) * k] as const;
  ctx.clearRect(0, 0, PX, PY);
  ctx.fillStyle = 'rgba(251, 250, 247, 0.94)';
  ctx.beginPath();
  ctx.roundRect(4, 4, PX - 8, PY - 8, 48);
  ctx.fill();
  ctx.font = '600 44px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < REGIONS.length; i++) {
    const r = REGIONS[i];
    const [x, y, w, h] = rect(r);
    const t = r.target;
    if (i === pressed) {
      // Just pressed: a green flash behind it.
      ctx.fillStyle = 'rgba(47, 158, 99, 0.35)';
      ctx.beginPath();
      ctx.roundRect(x - 10, y - 10, w + 20, h + 20, 32);
      ctx.fill();
    }
    if (t.kind === 'skin') {
      ctx.fillStyle = SKIN_PRESETS[t.index];
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 18);
      ctx.fill();
      if (!xrPrefs.skinAuto && xrPrefs.skinPreset === t.index) {
        ctx.lineWidth = 10;
        ctx.strokeStyle = '#2f9e63';
        ctx.stroke();
      }
      continue;
    }
    if (t.kind === 'fine' || t.kind === 'height') {
      const cy = y + h / 2;
      const value = t.kind === 'fine' ? xrPrefs.skinFine : (xrPrefs.skinHeightMm / HEIGHT_RANGE_MM + 1) / 2;
      ctx.fillStyle = '#6b746f';
      ctx.font = '500 36px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(t.kind === 'fine' ? 'Tone' : `Height ${xrPrefs.skinHeightMm > 0 ? '+' : ''}${xrPrefs.skinHeightMm}`, 28, cy + 2);
      ctx.textAlign = 'center';
      ctx.font = '600 44px "DM Sans", system-ui, sans-serif';
      const state = t.kind === 'fine' ? fineState : heightState;
      ctx.lineCap = 'round';
      if (state > 0) {
        ctx.lineWidth = 50;
        ctx.strokeStyle = state === 2 ? 'rgba(47, 158, 99, 0.22)' : 'rgba(47, 158, 99, 0.12)';
        ctx.beginPath();
        ctx.moveTo(x, cy);
        ctx.lineTo(x + w, cy);
        ctx.stroke();
      }
      ctx.lineWidth = 16;
      ctx.strokeStyle = '#d6dbd8';
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.lineTo(x + w, cy);
      ctx.stroke();
      ctx.fillStyle = state === 2 ? '#2f9e63' : '#ffffff';
      ctx.strokeStyle = '#2f9e63';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(x + w * value, cy, state === 2 ? 34 : state === 1 ? 30 : 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      continue;
    }
    if (t.kind === 'auto') {
      // On: green (camera colour in use) or amber (no camera access: presets are used).
      ctx.fillStyle = !xrPrefs.skinAuto ? '#e4e8e5' : xrPrefs.autoWorking ? '#2f9e63' : '#d39a2c';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 24);
      ctx.fill();
      ctx.fillStyle = xrPrefs.skinAuto ? '#ffffff' : '#1f2a24';
      ctx.font = '600 38px "DM Sans", system-ui, sans-serif';
      ctx.fillText('Auto', x + w / 2, y + h / 2 + 2);
      ctx.font = '600 44px "DM Sans", system-ui, sans-serif';
      continue;
    }
    const selected =
      (t.kind === 'hand' && xrPrefs.hand === t.side) ||
      (t.kind === 'reattach' && reattachFlash) ||
      (t.kind === 'mesh' && xrPrefs.showHandMesh);
    ctx.fillStyle = selected ? '#2f9e63' : '#e4e8e5';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 28);
    ctx.fill();
    ctx.fillStyle = selected ? '#ffffff' : '#1f2a24';
    const label = t.kind === 'hand' ? (t.side === 'left' ? 'Left' : 'Right') : t.kind === 'mesh' ? 'Mesh' : 'Calibrate';
    ctx.fillText(label, x + w / 2, y + h / 2 + 2);
  }
  // The button under the finger: a green outline, so you can see what you're about to press.
  if (hover >= 0) {
    const [x, y, w, h] = rect(REGIONS[hover]);
    ctx.lineWidth = 9;
    ctx.strokeStyle = '#2f9e63';
    ctx.beginPath();
    ctx.roundRect(x - 7, y - 7, w + 14, h + 14, 30);
    ctx.stroke();
  }
}
