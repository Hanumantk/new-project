import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { SKIN_PRESETS, requestReattach, setXRPrefs, xrPrefs, type HandSide } from '../lib/xrPrefs';

/** Panel size (metres) and canvas resolution. */
const W = 0.24;
const H = 0.1;
const PX = 1200;
const PY = 500;
/** A fingertip counts as pressing within this distance of the face (m)… */
const TOUCH = 0.015;
/** …and must pull back this far before it can press again. */
const RELEASE = 0.03;

type Target =
  | { kind: 'hand'; side: HandSide }
  | { kind: 'reattach' }
  | { kind: 'skin'; index: number }
  | { kind: 'auto' }
  | { kind: 'fine' };

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
  { target: { kind: 'hand', side: 'left' }, x0: -0.11, x1: -0.06, y0: 0.017, y1: 0.045 },
  { target: { kind: 'hand', side: 'right' }, x0: -0.055, x1: -0.005, y0: 0.017, y1: 0.045 },
  { target: { kind: 'reattach' }, x0: 0.02, x1: 0.11, y0: 0.017, y1: 0.045 },
  ...SKIN_PRESETS.map((_, index) => ({
    target: { kind: 'skin', index } as Target,
    x0: -0.11 + index * 0.031,
    x1: -0.11 + index * 0.031 + 0.026,
    y0: -0.016,
    y1: 0.011,
  })),
  { target: { kind: 'auto' }, x0: 0.076, x1: 0.11, y0: -0.016, y1: 0.011 },
  { target: { kind: 'fine' }, x0: -0.09, x1: 0.09, y0: -0.045, y1: -0.024 },
];

/**
 * In-headset settings for the wound: which hand (only that one is ever
 * used), Re-attach (place the wound on the palm afresh), and the skin tone
 * (six presets plus a fine adjustment). Press with an index fingertip.
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
      if (t.kind === 'fine') {
        // A slider: follows the fingertip while it's on it.
        const value = THREE.MathUtils.clamp((x - region.x0) / (region.x1 - region.x0), 0, 1);
        if (Math.abs(value - xrPrefs.skinFine) > 0.01 || xrPrefs.skinAuto) setXRPrefs({ skinFine: value, skinAuto: false });
        continue;
      }
      if (!s.armed[i]) continue;
      s.armed[i] = false;
      if (t.kind === 'hand') setXRPrefs({ hand: t.side });
      else if (t.kind === 'skin') setXRPrefs({ skinPreset: t.index, skinAuto: false });
      else if (t.kind === 'auto') setXRPrefs({ skinAuto: !xrPrefs.skinAuto });
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
  ctx.fillStyle = 'rgba(251, 250, 247, 0.94)';
  ctx.beginPath();
  ctx.roundRect(4, 4, PX - 8, PY - 8, 48);
  ctx.fill();
  ctx.font = '600 44px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of REGIONS) {
    const [x, y, w, h] = rect(r);
    const t = r.target;
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
    if (t.kind === 'fine') {
      const cy = y + h / 2;
      ctx.lineCap = 'round';
      ctx.lineWidth = 16;
      ctx.strokeStyle = '#d6dbd8';
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.lineTo(x + w, cy);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2f9e63';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(x + w * xrPrefs.skinFine, cy, 26, 0, Math.PI * 2);
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
    const selected = (t.kind === 'hand' && xrPrefs.hand === t.side) || (t.kind === 'reattach' && reattachFlash);
    ctx.fillStyle = selected ? '#2f9e63' : '#e4e8e5';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 28);
    ctx.fill();
    ctx.fillStyle = selected ? '#ffffff' : '#1f2a24';
    const label = t.kind === 'hand' ? (t.side === 'left' ? 'Left' : 'Right') : 'Re-attach';
    ctx.fillText(label, x + w / 2, y + h / 2 + 2);
  }
}
