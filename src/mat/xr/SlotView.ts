import * as THREE from 'three';
import type { Text } from 'troika-three-text';
import type { KitItem, QuantityVisual } from '../lib/kit';
import type { SlotLayout } from '../lib/layout';
import { dashPath, fillGeometry, footprintPath, ribbonGeometry, type FootprintShape } from './outlines';
import { COLORS, makeText, setTextOpacity } from './text';

const LINE_LIFT = 0.0015;
const FILL_LIFT = 0.0006;
/** The label's lowest point, above the table. */
const LABEL_LIFT = 0.004;
const BADGE_RADIUS = 0.0075;
const TEXT_GAP = 0.0025;
const SIZES = { name: 0.0095, quantity: 0.0135, purpose: 0.016, badge: 0.0095 };

/** Geometry shared by every slot with the same footprint (and across rebuilds). */
const geometryCache = new Map<string, { dashed: THREE.BufferGeometry; solid: THREE.BufferGeometry; fill: THREE.BufferGeometry }>();
function footprintGeometry(shape: FootprintShape) {
  const key = `${shape.shape}:${shape.width.toFixed(4)}:${shape.depth.toFixed(4)}`;
  let entry = geometryCache.get(key);
  if (!entry) {
    const path = footprintPath(shape);
    entry = {
      dashed: ribbonGeometry(dashPath(path, 0.01, 0.006), 0.0025),
      solid: ribbonGeometry([{ points: path, closed: true }], 0.004),
      fill: fillGeometry(path),
    };
    geometryCache.set(key, entry);
  }
  return entry;
}

const sphereGeometry = new THREE.SphereGeometry(1, 24, 16);
/** Upper half of a unit sphere: a dome for liquids, scaled flat. */
const domeGeometry = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
const badgeGeometry = new THREE.CircleGeometry(BADGE_RADIUS, 28);

const unlit = (color: string, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });

/**
 * One item on the mat: a dashed true-size outline of where it goes (solid
 * and brighter when it's the active step), its quantity model, and a label
 * that turns to face the user.
 */
export class SlotView {
  readonly group = new THREE.Group();
  /** The label, turned towards the user every frame. */
  readonly label = new THREE.Group();
  page = 0;

  private readonly dashedMaterial = unlit(COLORS.mint, 0.9);
  private readonly solidMaterial = unlit(COLORS.mint, 1);
  private readonly fillMaterial = unlit(COLORS.mint, 0.07);
  private readonly badgeMaterial = unlit(COLORS.mint, 1);
  private readonly visualMaterial: THREE.MeshStandardMaterial | null;
  private readonly dashed: THREE.Mesh;
  private readonly solid: THREE.Mesh;
  private readonly fill: THREE.Mesh;
  private readonly footprint = new THREE.Group();
  private readonly visual = new THREE.Group();
  private readonly badge: THREE.Mesh;
  private readonly badgeText: Text;
  private readonly name: Text;
  private readonly quantity: Text;
  private readonly purpose: Text;
  private readonly texts: Text[];

  private alpha = 1;
  private active = false;
  private showPurpose = false;

  constructor(readonly item: KitItem) {
    const geometry = footprintGeometry(item.footprint);
    this.dashed = new THREE.Mesh(geometry.dashed, this.dashedMaterial);
    this.solid = new THREE.Mesh(geometry.solid, this.solidMaterial);
    this.fill = new THREE.Mesh(geometry.fill, this.fillMaterial);
    this.dashed.position.y = this.solid.position.y = LINE_LIFT;
    this.fill.position.y = FILL_LIFT;
    this.solid.visible = false;
    this.dashed.renderOrder = this.solid.renderOrder = 3;
    this.fill.renderOrder = 1;
    this.footprint.add(this.fill, this.dashed, this.solid);

    this.visualMaterial = item.visual
      ? new THREE.MeshStandardMaterial({ color: item.visual.color, roughness: 0.45, transparent: true })
      : null;
    if (item.visual && this.visualMaterial) buildVisual(this.visual, item.visual, this.visualMaterial);

    this.badge = new THREE.Mesh(badgeGeometry, this.badgeMaterial);
    this.badge.renderOrder = 19;
    this.badgeText = makeText(String(item.step), {
      size: SIZES.badge,
      weight: 'bold',
      color: COLORS.ink,
      anchorX: 'center',
      anchorY: 'middle',
      halo: false,
    });
    this.badgeText.position.z = 0.0005;
    this.badge.add(this.badgeText);
    this.name = makeText(item.name, { size: SIZES.name, color: COLORS.muted, anchorY: 'bottom' });
    this.quantity = makeText(item.quantity, { size: SIZES.quantity, weight: 'bold', anchorY: 'bottom' });
    this.purpose = makeText(item.purpose, { size: SIZES.purpose, weight: 'bold', color: COLORS.mint, anchorY: 'bottom' });
    this.purpose.visible = false;
    this.texts = [this.badgeText, this.name, this.quantity, this.purpose];
    this.label.add(this.badge, this.name, this.quantity, this.purpose);
    for (const text of [this.name, this.quantity, this.purpose]) text.sync(this.stackLabel);

    this.group.add(this.footprint, this.visual, this.label);
  }

  /** Moves the slot to its cell. */
  place(slot: SlotLayout) {
    this.page = slot.page;
    this.footprint.position.set(slot.footprintX, 0, slot.footprintZ);
    this.visual.position.set(slot.visualX, 0, slot.visualZ);
    this.label.position.set(slot.labelX, LABEL_LIFT, slot.labelZ);
    const textX = 2 * BADGE_RADIUS + 0.004;
    this.name.maxWidth = slot.width - textX;
    this.quantity.maxWidth = slot.width;
    this.purpose.maxWidth = Math.max(slot.width + 0.04, 0.16);
    for (const text of [this.name, this.quantity, this.purpose]) text.sync(this.stackLabel);
  }

  /** Overall strength (overlay opacity × step-mode dimming), 0..1. */
  setAlpha(alpha: number) {
    if (alpha === this.alpha) return;
    this.alpha = alpha;
    this.applyAlpha();
  }

  /** Highlights the slot as the current step and shows its purpose. */
  setActive(active: boolean, showPurpose: boolean) {
    if (active === this.active && showPurpose === this.showPurpose) return;
    this.active = active;
    this.showPurpose = showPurpose;
    this.solid.visible = active;
    this.dashed.visible = !active;
    this.purpose.visible = showPurpose;
    this.stackLabel();
    this.applyAlpha();
  }

  /** Turns the label to face a point (the user's eyes). */
  faceTowards(target: THREE.Vector3) {
    this.label.lookAt(target);
  }

  /** Pulses the active outline (t in seconds). */
  pulse(t: number) {
    if (!this.active) return;
    this.fillMaterial.opacity = (0.1 + 0.06 * Math.sin(t * 4)) * this.alpha;
  }

  dispose() {
    for (const text of this.texts) text.dispose();
    for (const material of [this.dashedMaterial, this.solidMaterial, this.fillMaterial, this.badgeMaterial]) material.dispose();
    this.visualMaterial?.dispose();
  }

  private applyAlpha() {
    const a = this.alpha;
    this.group.visible = a > 0.002;
    this.dashedMaterial.opacity = 0.9 * a;
    this.solidMaterial.opacity = a;
    this.fillMaterial.opacity = (this.active ? 0.12 : 0.07) * a;
    this.badgeMaterial.opacity = a;
    if (this.visualMaterial) {
      this.visualMaterial.opacity = 0.95 * a;
      this.visualMaterial.depthWrite = a > 0.98;
    }
    for (const text of this.texts) setTextOpacity(text, a);
    this.purpose.visible = this.showPurpose && a > 0.002;
  }

  /**
   * Stacks the label upwards from the table: purpose (in step mode) at the
   * bottom, then quantity, then the badge and name on top — so it reads
   * name, quantity, purpose from the top, and never dips below the table.
   */
  private readonly stackLabel = () => {
    const height = (text: Text) => {
      const b = text.textRenderInfo?.blockBounds;
      return b ? b[3] - b[1] : text.fontSize * 1.2;
    };
    const textX = 2 * BADGE_RADIUS + 0.004;
    let y = 0;
    if (this.showPurpose) {
      this.purpose.position.set(0, y, 0);
      y += height(this.purpose) + TEXT_GAP;
    }
    this.quantity.position.set(0, y, 0);
    y += height(this.quantity) + TEXT_GAP;
    this.name.position.set(textX, y, 0);
    const nameHeight = height(this.name);
    const lineHeight = SIZES.name * 1.18;
    this.badge.position.set(BADGE_RADIUS, y + nameHeight - lineHeight / 2, -0.0005);
  };
}

/** True-scale model of the amount, resting on the table. */
function buildVisual(group: THREE.Group, visual: QuantityVisual, material: THREE.Material) {
  switch (visual.type) {
    case 'sphere': {
      const mesh = new THREE.Mesh(sphereGeometry, material);
      mesh.scale.setScalar(visual.radius);
      mesh.position.y = visual.radius;
      group.add(mesh);
      break;
    }
    case 'blob': {
      const mesh = new THREE.Mesh(domeGeometry, material);
      mesh.scale.set(visual.radius, visual.height, visual.radius);
      group.add(mesh);
      break;
    }
    case 'drops': {
      const start = -((visual.count - 1) * visual.spacing) / 2;
      for (let i = 0; i < visual.count; i++) {
        const mesh = new THREE.Mesh(domeGeometry, material);
        mesh.scale.set(visual.radius, visual.height, visual.radius);
        mesh.position.x = start + i * visual.spacing;
        group.add(mesh);
      }
      break;
    }
  }
}
