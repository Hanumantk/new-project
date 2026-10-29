import * as THREE from 'three';
import type { Text } from 'troika-three-text';
import { pokeSliderValue, type PokeSliderLayout } from '../../lib/pokeSlider';
import { PokeButton, POKE_HOVER } from '../lib/poke';
import type { HandState } from './hands';
import { COLORS, hex, makeText, setTextContent } from './text';

/** Panel size (m). */
const WIDTH = 0.3;
const HEIGHT = 0.14;
const BUTTON = { width: 0.064, height: 0.036, gap: 0.008, y: -0.034 };
const SLIDER_Y = 0.016;
const SLIDER: PokeSliderLayout = {
  width: WIDTH,
  // The touch band is taller than the drawn track: an easy 3.6 cm target.
  height: 0.036,
  trackStart: -0.07,
  trackEnd: 0.1,
  touchDepth: 0.015,
};
/** How long "Tap again" waits for the second tap on Redraw (s). */
const CONFIRM_TIME = 3;

export type PanelButton = 'prev' | 'step' | 'next' | 'redraw';

export interface PanelActions {
  /** The slider moved (done: the finger let go). */
  onOpacity: (value: number, done: boolean) => void;
  onButton: (button: PanelButton) => void;
}

export interface PanelState {
  opacity: number;
  stepMode: boolean;
  canPrev: boolean;
  canNext: boolean;
  /** "Page 1 of 2", "Step 4 of 13 · Nose & scar wax", … */
  status: string;
}

function roundedRect(width: number, height: number, radius: number) {
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(radius, w, h);
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  return new THREE.ShapeGeometry(shape, 6);
}

const material = (color: string, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });

interface ButtonView {
  id: PanelButton;
  poke: PokeButton;
  face: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  label: Text;
  enabled: boolean;
  toggled: boolean;
  /** Label drawn dark on a filled face (tracked to avoid resetting it every frame). */
  dark: boolean;
}

const local = new THREE.Vector3();
const inverse = new THREE.Matrix4();
const MINT = new THREE.Color(COLORS.mint);
const WARN = new THREE.Color(COLORS.warn);
const WHITE = new THREE.Color('#ffffff');
const INK_TEXT = hex(COLORS.ink);
const LABEL_TEXT = hex(COLORS.label);

/**
 * The mat's controls, floating by its front-right corner and tilted towards
 * the user: an opacity slider and Prev / Step mode / Next / Redraw, all
 * pressed with a fingertip (no controllers).
 */
export class ControlPanel {
  readonly group = new THREE.Group();
  private readonly buttons: ButtonView[];
  private readonly status: Text;
  private readonly valueText: Text;
  private readonly fill: THREE.Mesh;
  private readonly knob: THREE.Mesh;
  private dragging = false;
  private opacity = 1;
  private confirmRedraw = 0;

  constructor(private readonly actions: PanelActions) {
    this.group.rotation.order = 'YXZ';
    const backing = new THREE.Mesh(roundedRect(WIDTH, HEIGHT, 0.014), material(COLORS.ink, 0.5));
    backing.renderOrder = 40;

    this.status = makeText('', { size: 0.0105, color: COLORS.muted, anchorY: 'middle', maxWidth: WIDTH - 0.03, halo: false });
    this.status.position.set(-WIDTH / 2 + 0.014, HEIGHT / 2 - 0.016, 0.001);

    const label = makeText('Opacity', { size: 0.0105, color: COLORS.label, anchorY: 'middle', halo: false });
    label.position.set(-WIDTH / 2 + 0.014, SLIDER_Y, 0.001);
    const trackLength = SLIDER.trackEnd - SLIDER.trackStart;
    const track = new THREE.Mesh(roundedRect(trackLength, 0.006, 0.003), material('#ffffff', 0.22));
    track.position.set((SLIDER.trackStart + SLIDER.trackEnd) / 2, SLIDER_Y, 0.001);
    this.fill = new THREE.Mesh(roundedRect(1, 0.006, 0.003), material(COLORS.mint, 1));
    this.knob = new THREE.Mesh(new THREE.CircleGeometry(0.011, 32), material(COLORS.label, 1));
    this.valueText = makeText('', { size: 0.0105, weight: 'bold', anchorX: 'right', anchorY: 'middle', halo: false });
    this.valueText.position.set(WIDTH / 2 - 0.014, SLIDER_Y, 0.001);

    this.group.add(backing, this.status, label, track, this.fill, this.knob, this.valueText);
    for (const mesh of [track, this.fill, this.knob]) mesh.renderOrder = 41;

    const ids: PanelButton[] = ['prev', 'step', 'next', 'redraw'];
    const faceGeometry = roundedRect(BUTTON.width, BUTTON.height, 0.008);
    const firstX = -((ids.length - 1) * (BUTTON.width + BUTTON.gap)) / 2;
    this.buttons = ids.map((id, i) => {
      const x = firstX + i * (BUTTON.width + BUTTON.gap);
      const faceMaterial = material('#ffffff', 0.12);
      const face = new THREE.Mesh(faceGeometry, faceMaterial);
      face.position.set(x, BUTTON.y, 0.002);
      face.renderOrder = 41;
      const text = makeText('', { size: 0.0105, weight: 'bold', anchorX: 'center', anchorY: 'middle', halo: false });
      text.position.z = 0.001;
      text.renderOrder = 42;
      face.add(text);
      this.group.add(face);
      return {
        id,
        poke: new PokeButton({ x, y: BUTTON.y, width: BUTTON.width, height: BUTTON.height }),
        face,
        material: faceMaterial,
        label: text,
        enabled: true,
        toggled: false,
        dark: false,
      };
    });
    this.setOpacityDisplay(1);
  }

  /**
   * Puts the panel just beyond the front-right corner of a width × depth mat,
   * low, tilted up and turned towards the user, so from their seat it
   * doesn't cover the mat and reaching for items doesn't pass through it.
   */
  placeFor(width: number, depth: number) {
    this.group.position.set(width / 2 + 0.12, 0.045, depth / 2 + 0.03);
    this.group.rotation.set(-THREE.MathUtils.degToRad(50), -THREE.MathUtils.degToRad(25), 0);
  }

  setState(state: PanelState) {
    if (!this.dragging) this.setOpacityDisplay(state.opacity);
    setTextContent(this.status, state.status);
    for (const b of this.buttons) {
      b.toggled = b.id === 'step' && state.stepMode;
      b.enabled = b.id === 'prev' ? state.canPrev : b.id === 'next' ? state.canNext : true;
    }
    this.refreshLabels();
  }

  /** Per frame: fingertip pokes and the slider. */
  update(dt: number, hands: readonly HandState[]) {
    if (this.confirmRedraw > 0) {
      this.confirmRedraw -= dt;
      if (this.confirmRedraw <= 0) this.refreshLabels();
    }
    const finger = this.nearestFingertip(hands);

    // Slider: a touch anywhere along its band sets the value.
    const value = finger ? pokeSliderValue(finger.x, finger.y - SLIDER_Y, finger.z, SLIDER) : null;
    if (value !== null) {
      this.dragging = true;
      if (Math.abs(value - this.opacity) > 0.002) {
        this.setOpacityDisplay(value);
        this.actions.onOpacity(value, false);
      }
    } else if (this.dragging) {
      this.dragging = false;
      this.actions.onOpacity(this.opacity, true);
    }

    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i];
      const pressed = this.dragging
        ? b.poke.update(null, 0, 0)
        : b.poke.update(finger ? finger.x : null, finger?.y ?? 0, finger?.z ?? 0, b.enabled);
      b.face.position.z = 0.002 - b.poke.push * 0.004;
      this.paintButton(b);
      if (!pressed) continue;
      if (b.id === 'redraw' && this.confirmRedraw <= 0) {
        this.confirmRedraw = CONFIRM_TIME;
        this.refreshLabels();
        continue;
      }
      if (b.id === 'redraw') {
        this.confirmRedraw = 0;
        this.refreshLabels();
      }
      this.actions.onButton(b.id);
    }
  }

  /** The fingertip closest to the panel face, in panel space (z = finger surface), if one is near. */
  private nearestFingertip(hands: readonly HandState[]) {
    this.group.updateWorldMatrix(true, false);
    inverse.copy(this.group.matrixWorld).invert();
    let best: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < hands.length; i++) {
      const hand = hands[i];
      // A pinching hand is drawing or holding something, not poking.
      if (!hand.tracked || hand.pinchDistance < 0.03) continue;
      local.copy(hand.indexTip).applyMatrix4(inverse);
      const z = local.z - hand.indexTipRadius;
      if (Math.abs(local.x) > WIDTH / 2 + 0.02 || Math.abs(local.y) > HEIGHT / 2 + 0.02) continue;
      if (z > POKE_HOVER + 0.03 || z < -0.04) continue;
      if (!best || Math.abs(z) < Math.abs(best.z)) best = this.fingerSlot(local.x, local.y, z);
    }
    return best;
  }

  private readonly finger = { x: 0, y: 0, z: 0 };
  private fingerSlot(x: number, y: number, z: number) {
    this.finger.x = x;
    this.finger.y = y;
    this.finger.z = z;
    return this.finger;
  }

  private setOpacityDisplay(value: number) {
    this.opacity = value;
    const length = (SLIDER.trackEnd - SLIDER.trackStart) * value;
    this.fill.visible = length > 0.001;
    this.fill.scale.x = Math.max(length, 0.001);
    this.fill.position.set(SLIDER.trackStart + length / 2, SLIDER_Y, 0.0015);
    this.knob.position.set(SLIDER.trackStart + length, SLIDER_Y, 0.002);
    setTextContent(this.valueText, `${Math.round(value * 100)}%`);
  }

  private refreshLabels() {
    for (const b of this.buttons) {
      const text =
        b.id === 'prev' ? '‹ Prev' : b.id === 'next' ? 'Next ›' : b.id === 'step' ? 'Step mode' : this.confirmRedraw > 0 ? 'Tap again' : 'Redraw';
      setTextContent(b.label, text);
    }
  }

  private paintButton(b: ButtonView) {
    const warn = b.id === 'redraw' && this.confirmRedraw > 0;
    const filled = b.toggled || b.poke.state === 'pressed' || warn;
    if (filled) {
      b.material.color.copy(warn ? WARN : MINT);
      b.material.opacity = b.poke.state === 'pressed' ? 1 : 0.85;
    } else if (b.poke.state === 'hover') {
      b.material.color.copy(MINT);
      b.material.opacity = 0.3;
    } else {
      b.material.color.copy(WHITE);
      b.material.opacity = 0.12;
    }
    if (filled !== b.dark) {
      b.dark = filled;
      b.label.color = filled ? INK_TEXT : LABEL_TEXT;
    }
    b.label.fillOpacity = b.enabled ? 1 : 0.35;
  }
}
