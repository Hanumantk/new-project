import * as THREE from 'three';
import { cornerTicks, rectPath, ribbonGeometry } from './outlines';
import { COLORS } from './text';

/** Lift above the table so lines don't flicker against virtual fills. */
const LINE_LIFT = 0.0015;

/**
 * The mat: a frame on the table (origin at the rectangle's centre, +Y up,
 * +Z towards the user, +X to their right), positioned from its anchor.
 */
export class MatView {
  /** Placed in world space from the anchor every frame. */
  readonly root = new THREE.Group();
  /** Everything that fades with the overlay opacity. */
  readonly overlay = new THREE.Group();
  width = 0;
  depth = 0;
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

  constructor() {
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    this.root.add(this.overlay);
  }

  /** Rebuilds the outline for a width × depth mat (m). */
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
    this.outlineMaterial.opacity = 0.55 * opacity;
    this.tickMaterial.opacity = opacity;
    this.overlay.visible = opacity > 0.002;
  }
}
