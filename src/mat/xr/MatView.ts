import * as THREE from 'three';
import type { Kit } from '../lib/kit';
import { layoutKit } from '../lib/layout';
import { cornerTicks, rectPath, ribbonGeometry } from './outlines';
import { SlotView } from './SlotView';
import { COLORS } from './text';

/** Lift above the table so lines don't flicker against virtual fills. */
const LINE_LIFT = 0.0015;
/** Strength of the other slots in step mode. */
const STEP_DIM = 0.2;

/**
 * The mat: a frame on the table (origin at the rectangle's centre, +Y up,
 * +Z towards the user, +X to their right), positioned from its anchor, with
 * the kit laid out on it.
 */
export class MatView {
  /** Placed in world space from the anchor every frame. */
  readonly root = new THREE.Group();
  /** Everything that fades with the overlay opacity. */
  readonly overlay = new THREE.Group();
  width = 0;
  depth = 0;
  pages = 1;
  page = 0;
  private slots: SlotView[] = [];
  private outline: THREE.Mesh | null = null;
  private ticks: THREE.Mesh | null = null;
  private readonly outlineMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.mint,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly tickMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.mint,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private opacity = 1;
  /** Index of the highlighted item in step mode, or -1. */
  private activeStep = -1;

  constructor() {
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    this.root.add(this.overlay);
  }

  get itemCount() {
    return this.slots.length;
  }

  /** The page an item is on. */
  pageOf(item: number) {
    return this.slots[item]?.page ?? 0;
  }

  /** Creates the slots for a kit (once per session). */
  setKit(kit: Kit) {
    for (const slot of this.slots) {
      this.overlay.remove(slot.group);
      slot.dispose();
    }
    this.slots = kit.items.map((item) => new SlotView(item));
    for (const slot of this.slots) this.overlay.add(slot.group);
  }

  /** Sizes the mat to width × depth (m) and lays the kit out on it. */
  build(width: number, depth: number) {
    this.width = width;
    this.depth = depth;
    this.outline?.geometry.dispose();
    this.ticks?.geometry.dispose();
    if (this.outline) this.overlay.remove(this.outline);
    if (this.ticks) this.overlay.remove(this.ticks);
    this.outline = new THREE.Mesh(ribbonGeometry([{ points: rectPath(width, depth), closed: true }], 0.0025), this.outlineMaterial);
    this.ticks = new THREE.Mesh(ribbonGeometry(cornerTicks(width, depth, 0.035), 0.006), this.tickMaterial);
    this.outline.position.y = this.ticks.position.y = LINE_LIFT;
    this.outline.renderOrder = this.ticks.renderOrder = 2;
    this.overlay.add(this.outline, this.ticks);

    const layout = layoutKit(
      this.slots.map((s) => s.item),
      width,
      depth,
    );
    layout.slots.forEach((slot, i) => this.slots[i].place(slot));
    this.pages = layout.pages;
    this.activeStep = -1;
    this.setPage(0);
  }

  setPage(page: number) {
    this.page = Math.min(Math.max(page, 0), this.pages - 1);
    this.applySlots();
  }

  /** Highlights one item (step mode) or none (-1). */
  setActiveStep(item: number) {
    this.activeStep = item;
    if (item >= 0) this.page = this.pageOf(item);
    this.applySlots();
  }

  /** Places the mat at a centre on the table, turned by yaw about +Y. */
  setPose(x: number, y: number, z: number, yaw: number) {
    this.root.matrix.makeRotationY(yaw).setPosition(x, y, z);
    this.root.matrixWorldNeedsUpdate = true;
  }

  /** Places the mat from a column-major 4×4 pose (an anchor's). */
  setMatrix(elements: ArrayLike<number>, offset = 0) {
    this.root.matrix.fromArray(elements as number[], offset);
    this.root.matrixWorldNeedsUpdate = true;
  }

  setVisible(visible: boolean) {
    this.root.visible = visible;
  }

  /** Overlay opacity, 0..1. */
  setOpacity(opacity: number) {
    if (opacity === this.opacity) return;
    this.opacity = opacity;
    this.outlineMaterial.opacity = 0.55 * opacity;
    this.tickMaterial.opacity = opacity;
    this.overlay.visible = opacity > 0.002;
    this.applySlots();
  }

  /** Per frame: labels face the user; the active step pulses. */
  update(head: THREE.Vector3, time: number) {
    if (!this.root.visible || !this.overlay.visible) return;
    this.root.updateMatrixWorld(true);
    for (const slot of this.slots) {
      if (!slot.group.visible) continue;
      slot.faceTowards(head);
      slot.pulse(time);
    }
  }

  private applySlots() {
    const stepping = this.activeStep >= 0;
    this.slots.forEach((slot, i) => {
      const onPage = slot.page === this.page;
      const active = stepping && i === this.activeStep;
      slot.setActive(active, active);
      slot.setAlpha(onPage ? this.opacity * (stepping && !active ? STEP_DIM : 1) : 0);
    });
  }
}
