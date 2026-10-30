import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  GLASS_FONT,
  GLASS_TEXT,
  GLASS_TEXT_MUTED,
  GLASS_TEXT_ON_SELECTED,
  drawGlassButton,
  drawGlassPanel,
  drawGlassSlider,
} from '../lib/glassCanvas';
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

/**
 * In-headset settings for the wound: which hand (only that one is ever
 * used), Calibrate (measure the hand and lay the wound on its palm afresh),
 * Mesh (show the hand model), the skin tone (Auto from the camera, six
 * presets, a fine adjustment) and the wound's height on the skin. Press with
 * an index fingertip.
 */
export function XRWoundPanel({ active }: { active: boolean }) {
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
      drawn: -1,
      flash: 0,
      armed: [true, true],
      head: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      tip: new THREE.Vector3(),
    }),
    [],
  );

  useEffect(
    () => () => {
      texture.dispose();
      material.dispose();
    },
    [texture, material],
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

    for (let i = 0; i < 2; i++) {
      const tip = gl.xr.getHand(i).joints['index-finger-tip'];
      if (!tip?.visible) continue;
      mesh.worldToLocal(tip.getWorldPosition(s.tip));
      const { x, y, z } = s.tip;
      if (Math.abs(z) > RELEASE || Math.abs(x) > W / 2 || Math.abs(y) > H / 2) {
        s.armed[i] = true;
        continue;
      }
      if (Math.abs(z) > TOUCH) continue;
      let region: Region | null = null;
      for (const r of REGIONS) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) region = r;
      if (!region) continue;
      const t = region.target;
      if (t.kind === 'fine' || t.kind === 'height') {
        // A slider: follows the fingertip while it's on it.
        const value = THREE.MathUtils.clamp((x - region.x0) / (region.x1 - region.x0), 0, 1);
        if (t.kind === 'fine') {
          if (Math.abs(value - xrPrefs.skinFine) > 0.01 || xrPrefs.skinAuto) setXRPrefs({ skinFine: value, skinAuto: false });
        } else {
          // Skin height in 0.5 mm steps.
          const mm = Math.round((value * 2 - 1) * HEIGHT_RANGE_MM * 2) / 2;
          if (mm !== xrPrefs.skinHeightMm) setXRPrefs({ skinHeightMm: mm });
        }
        continue;
      }
      if (!s.armed[i]) continue;
      s.armed[i] = false;
      if (t.kind === 'hand') setXRPrefs({ hand: t.side });
      else if (t.kind === 'skin') setXRPrefs({ skinPreset: t.index, skinAuto: false });
      else if (t.kind === 'auto') setXRPrefs({ skinAuto: !xrPrefs.skinAuto });
      else if (t.kind === 'mesh') setXRPrefs({ showHandMesh: !xrPrefs.showHandMesh });
      else {
        requestReattach();
        s.flash = 0.4;
      }
    }

    if (s.flash > 0) s.flash = Math.max(0, s.flash - delta);
    const version = xrPrefs.version * 2 + (s.flash > 0 ? 1 : 0);
    if (version !== s.drawn) {
      s.drawn = version;
      draw(canvas, s.flash > 0);
      texture.needsUpdate = true;
    }
  });

  return (
    <mesh ref={meshRef} material={material} visible={false}>
      <planeGeometry args={[W, H]} />
    </mesh>
  );
}

function draw(canvas: HTMLCanvasElement, reattachFlash: boolean) {
  const ctx = canvas.getContext('2d')!;
  const k = PX / W;
  const rect = (r: Region) => [(r.x0 + W / 2) * k, (H / 2 - r.y1) * k, (r.x1 - r.x0) * k, (r.y1 - r.y0) * k] as const;
  ctx.clearRect(0, 0, PX, PY);
  drawGlassPanel(ctx, 4, 4, PX - 8, PY - 8, 64);
  ctx.font = `600 42px ${GLASS_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of REGIONS) {
    const [x, y, w, h] = rect(r);
    const t = r.target;
    if (t.kind === 'skin') {
      // Swatch: the colour as a glass capsule; the chosen one gets a white ring.
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h / 2);
      ctx.fillStyle = SKIN_PRESETS[t.index];
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.stroke();
      if (!xrPrefs.skinAuto && xrPrefs.skinPreset === t.index) {
        ctx.beginPath();
        ctx.roundRect(x - 7, y - 7, w + 14, h + 14, (h + 14) / 2);
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      continue;
    }
    if (t.kind === 'fine' || t.kind === 'height') {
      const cy = y + h / 2;
      const value = t.kind === 'fine' ? xrPrefs.skinFine : (xrPrefs.skinHeightMm / HEIGHT_RANGE_MM + 1) / 2;
      ctx.fillStyle = GLASS_TEXT_MUTED;
      ctx.font = `500 34px ${GLASS_FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(t.kind === 'fine' ? 'Tone' : `Height ${xrPrefs.skinHeightMm > 0 ? '+' : ''}${xrPrefs.skinHeightMm}`, 36, cy + 2);
      ctx.textAlign = 'center';
      ctx.font = `600 42px ${GLASS_FONT}`;
      drawGlassSlider(ctx, x, cy, w, value);
      continue;
    }
    if (t.kind === 'auto') {
      // On: green glass (camera colour in use) or amber glass (no camera access: presets are used).
      const tint = !xrPrefs.skinAuto ? undefined : xrPrefs.autoWorking ? 'rgba(47, 158, 99, 0.75)' : 'rgba(211, 154, 44, 0.75)';
      drawGlassButton(ctx, x, y, w, h, { tint });
      ctx.fillStyle = GLASS_TEXT;
      ctx.font = `600 36px ${GLASS_FONT}`;
      ctx.fillText('Auto', x + w / 2, y + h / 2 + 2);
      ctx.font = `600 42px ${GLASS_FONT}`;
      continue;
    }
    const selected =
      (t.kind === 'hand' && xrPrefs.hand === t.side) ||
      (t.kind === 'reattach' && reattachFlash) ||
      (t.kind === 'mesh' && xrPrefs.showHandMesh);
    drawGlassButton(ctx, x, y, w, h, { selected });
    ctx.fillStyle = selected ? GLASS_TEXT_ON_SELECTED : GLASS_TEXT;
    const label = t.kind === 'hand' ? (t.side === 'left' ? 'Left' : 'Right') : t.kind === 'mesh' ? 'Mesh' : 'Calibrate';
    ctx.fillText(label, x + w / 2, y + h / 2 + 2);
  }
}
