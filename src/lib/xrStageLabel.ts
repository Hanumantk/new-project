import * as THREE from 'three';
import type { Text } from 'troika-three-text';
import { COLORS, hex, makeText, setTextContent, setTextOpacity } from '../mat/xr/text';
import { STAGE_COUNT, STAGE_LABELS } from './woundSteps';

/** The label's text size (m, em; capitals ≈ 1 cm) and width. */
export const LABEL_TEXT_SIZE = 0.014;
export const LABEL_WIDTH = 0.2;
const DOT_RADIUS = 0.0028;
const DOT_SPACING = 0.011;

/**
 * The build stage's instruction and five progress dots, in the headset's
 * text style (off-white on a soft dark halo, mint accent). Drawn over
 * everything so the real hand never hides it; the caller places it beside
 * the wound and turns it to the viewer.
 */
export class StageLabel {
  readonly group = new THREE.Group();
  private readonly text: Text;
  private readonly dots: THREE.Mesh[] = [];
  private readonly dotMaterials: THREE.MeshBasicMaterial[] = [];
  private stage = -1;
  private opacity = -1;

  constructor() {
    this.text = makeText('', {
      size: LABEL_TEXT_SIZE,
      weight: 'bold',
      anchorX: 'center',
      anchorY: 'bottom',
      maxWidth: LABEL_WIDTH,
    });
    (this.text.material as THREE.Material).depthTest = false;
    this.text.position.y = 0.004;
    this.group.add(this.text);
    const dot = new THREE.CircleGeometry(DOT_RADIUS, 20);
    for (let i = 0; i < STAGE_COUNT; i++) {
      const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, toneMapped: false });
      const mesh = new THREE.Mesh(dot, material);
      mesh.position.set((i - (STAGE_COUNT - 1) / 2) * DOT_SPACING, -0.004, 0);
      mesh.renderOrder = 20;
      this.dots.push(mesh);
      this.dotMaterials.push(material);
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  /** Shows a stage's text and progress (0 = the finished wound's hint). */
  setStage(stage: number) {
    if (stage === this.stage) return;
    this.stage = stage;
    setTextContent(this.text, STAGE_LABELS[stage]);
    this.dotMaterials.forEach((material, i) => material.color.setHex(hex(i < stage ? COLORS.mint : COLORS.muted)));
    this.opacity = -1;
  }

  setOpacity(opacity: number) {
    if (opacity === this.opacity) return;
    this.opacity = opacity;
    this.group.visible = opacity > 0.002;
    setTextOpacity(this.text, opacity);
    this.dotMaterials.forEach((material, i) => (material.opacity = opacity * (i < this.stage ? 1 : 0.45)));
  }

  dispose() {
    this.text.dispose();
    this.dots[0].geometry.dispose();
    this.dotMaterials.forEach((material) => material.dispose());
  }
}
