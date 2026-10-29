/** Distance between recorded pen points (m). */
export const STROKE_SPACING = 0.01;
/** Most points one stroke keeps (20 m of drawing at 1 cm spacing). */
export const STROKE_CAPACITY = 2048;

/** The pen points of one stroke, in a fixed buffer (no allocation while drawing). */
export class StrokeBuffer {
  readonly positions = new Float32Array(STROKE_CAPACITY * 3);
  count = 0;

  reset() {
    this.count = 0;
  }

  /** Records the point if it's at least STROKE_SPACING from the last one. Returns whether it did. */
  add(x: number, y: number, z: number): boolean {
    const p = this.positions;
    if (this.count >= STROKE_CAPACITY) return false;
    if (this.count > 0) {
      const i = (this.count - 1) * 3;
      const dx = x - p[i];
      const dy = y - p[i + 1];
      const dz = z - p[i + 2];
      if (dx * dx + dy * dy + dz * dz < STROKE_SPACING * STROKE_SPACING) return false;
    }
    const i = this.count * 3;
    p[i] = x;
    p[i + 1] = y;
    p[i + 2] = z;
    this.count++;
    return true;
  }
}
