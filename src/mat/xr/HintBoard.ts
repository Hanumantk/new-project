import * as THREE from 'three';
import type { Text } from 'troika-three-text';
import { COLORS, hex, makeText, setTextContent, setTextOpacity } from './text';

/** How far in front of the eyes, and how far below them, the hint floats. */
const DISTANCE = 0.62;
/** Low enough to sit below the injury simulation's own hint. */
const DROP = 0.24;
/** How quickly it catches up with the head (1/s). */
const FOLLOW_RATE = 3;
const FADE_RATE = 8;

/**
 * Instructions floating in front of the user, lazily following the head so
 * they stay readable without being glued to the view.
 */
export class HintBoard {
  readonly group = new THREE.Group();
  private readonly title: Text;
  private readonly detail: Text;
  private opacity = 0;
  private targetOpacity = 0;
  private placed = false;
  /** Seconds left to show a timed message, or Infinity. */
  private remaining = Infinity;

  private readonly target = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  constructor() {
    this.title = makeText('', { size: 0.026, weight: 'bold', anchorX: 'center', anchorY: 'bottom', maxWidth: 0.5 });
    this.detail = makeText('', {
      size: 0.016,
      color: COLORS.muted,
      anchorX: 'center',
      anchorY: 'top',
      maxWidth: 0.46,
    });
    this.title.position.y = 0.004;
    this.detail.position.y = -0.006;
    this.group.add(this.title, this.detail);
    this.group.visible = false;
  }

  /** Shows a message; with `seconds`, it fades away after that long. */
  show(title: string, detail = '', seconds = Infinity, tone: 'normal' | 'warn' = 'normal') {
    setTextContent(this.title, title);
    setTextContent(this.detail, detail);
    this.title.color = hex(tone === 'warn' ? COLORS.warn : COLORS.label);
    this.targetOpacity = 1;
    this.remaining = seconds;
  }

  hide() {
    this.targetOpacity = 0;
  }

  get showing() {
    return this.targetOpacity > 0;
  }

  /** @param head eye position; @param headMatrix the viewer's world matrix. */
  update(dt: number, head: THREE.Vector3, headMatrix: THREE.Matrix4) {
    if (this.remaining !== Infinity) {
      this.remaining -= dt;
      if (this.remaining <= 0) {
        this.remaining = Infinity;
        this.targetOpacity = 0;
      }
    }
    this.opacity += (this.targetOpacity - this.opacity) * (1 - Math.exp(-FADE_RATE * dt));
    if (this.targetOpacity === 0 && this.opacity < 0.01) this.opacity = 0;
    this.group.visible = this.opacity > 0;
    if (!this.group.visible) {
      this.placed = false;
      return;
    }
    setTextOpacity(this.title, this.opacity);
    setTextOpacity(this.detail, this.opacity);

    // Level forward direction of the head.
    this.forward.set(-headMatrix.elements[8], 0, -headMatrix.elements[10]);
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.target.copy(head).addScaledVector(this.forward, DISTANCE);
    this.target.y -= DROP;
    if (!this.placed) {
      this.group.position.copy(this.target);
      this.placed = true;
    } else {
      this.group.position.lerp(this.target, 1 - Math.exp(-FOLLOW_RATE * dt));
    }
    this.group.lookAt(head);
  }
}
