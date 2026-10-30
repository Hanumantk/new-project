import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLASS_FONT, GLASS_TEXT, GLASS_TEXT_ON_SELECTED, drawGlassSlider, drawGlassTile, drawSymbol } from '../lib/glassCanvas';
import { SKIN_PRESETS, requestReattach, setXRPrefs, xrPrefs, type HandSide } from '../lib/xrPrefs';

/** Panel size (metres) and canvas resolution. */
const W = 0.24;
const H = 0.17;
const PX = 1200;
const PY = 850;
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

// Layout (metres), as Control Center tiles: row 1 pills (hand, Calibrate,
// Mesh), row 2 round swatches and Auto, then two sideways sliders.
const ROW1 = { y0: 0.048, y1: 0.08 };
const ROW2 = { y0: 0.008, y1: 0.036 };
const REGIONS: Region[] = [
  { target: { kind: 'hand', side: 'left' }, x0: -0.115, x1: -0.07, ...ROW1 },
  { target: { kind: 'hand', side: 'right' }, x0: -0.065, x1: -0.02, ...ROW1 },
  { target: { kind: 'reattach' }, x0: -0.015, x1: 0.06, ...ROW1 },
  { target: { kind: 'mesh' }, x0: 0.065, x1: 0.115, ...ROW1 },
  ...SKIN_PRESETS.map((_, index) => ({
    target: { kind: 'skin', index } as Target,
    x0: -0.115 + index * 0.033,
    x1: -0.115 + index * 0.033 + 0.028,
    ...ROW2,
  })),
  { target: { kind: 'auto' }, x0: 0.083, x1: 0.115, ...ROW2 },
  { target: { kind: 'fine' }, x0: -0.115, x1: 0.115, y0: -0.032, y1: -0.002 },
  { target: { kind: 'height' }, x0: -0.115, x1: 0.115, y0: -0.072, y1: -0.042 },
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
  // No backing: the tiles float on their own, like Control Center.
  ctx.clearRect(0, 0, PX, PY);
  ctx.textBaseline = 'middle';
  for (const r of REGIONS) {
    const [x, y, w, h] = rect(r);
    const t = r.target;
    if (t.kind === 'skin') {
      // A round swatch of the tone, glass-rimmed; the chosen one gets a white ring.
      drawGlassTile(ctx, x, y, w, h, { tint: SKIN_PRESETS[t.index] });
      if (!xrPrefs.skinAuto && xrPrefs.skinPreset === t.index) {
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, w / 2 + 10, 0, Math.PI * 2);
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      continue;
    }
    if (t.kind === 'fine' || t.kind === 'height') {
      const value = t.kind === 'fine' ? xrPrefs.skinFine : (xrPrefs.skinHeightMm / HEIGHT_RANGE_MM + 1) / 2;
      drawGlassSlider(ctx, x, y, w, h, value);
      // Symbol and name on the left, value on the right: dark where the white fill covers them.
      const filled = x + w * value;
      const ink = (px: number) => (px < filled ? GLASS_TEXT_ON_SELECTED : GLASS_TEXT);
      const cy = y + h / 2;
      drawSymbol(ctx, t.kind === 'fine' ? 'sun' : 'target', x + 52, cy, 46, ink(x + 52));
      ctx.font = `600 40px ${GLASS_FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = ink(x + 90);
      ctx.fillText(t.kind === 'fine' ? 'Skin tone' : 'Height', x + 90, cy + 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = ink(x + w - 40);
      ctx.fillText(
        t.kind === 'fine'
          ? `${Math.round((xrPrefs.skinFine - 0.5) * 100)}`
          : `${xrPrefs.skinHeightMm > 0 ? '+' : ''}${xrPrefs.skinHeightMm} mm`,
        x + w - 40,
        cy + 2,
      );
      continue;
    }
    if (t.kind === 'auto') {
      // On: green glass (camera colour in use) or amber glass (no camera access: the presets are used).
      const tint = !xrPrefs.skinAuto ? undefined : xrPrefs.autoWorking ? 'rgba(48, 209, 88, 0.85)' : 'rgba(255, 159, 10, 0.85)';
      drawGlassTile(ctx, x, y, w, h, { tint });
      ctx.fillStyle = GLASS_TEXT;
      ctx.font = `600 34px ${GLASS_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('Auto', x + w / 2, y + h / 2 + 2);
      continue;
    }
    const on =
      (t.kind === 'hand' && xrPrefs.hand === t.side) ||
      (t.kind === 'reattach' && reattachFlash) ||
      (t.kind === 'mesh' && xrPrefs.showHandMesh);
    drawGlassTile(ctx, x, y, w, h, { on });
    ctx.fillStyle = on ? GLASS_TEXT_ON_SELECTED : GLASS_TEXT;
    ctx.font = `600 40px ${GLASS_FONT}`;
    ctx.textAlign = 'center';
    const label = t.kind === 'hand' ? (t.side === 'left' ? 'Left' : 'Right') : t.kind === 'mesh' ? 'Mesh' : 'Calibrate';
    ctx.fillText(label, x + w / 2, y + h / 2 + 2);
  }
}
