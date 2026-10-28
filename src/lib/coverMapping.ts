/**
 * Where a video drawn with `object-fit: cover` actually lands inside its box.
 * A normalised video coordinate (0..1) maps to view pixels as
 * `offsetX + x * width`, `offsetY + y * height`.
 */
export interface CoverRect {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export function createCoverRect(): CoverRect {
  return { scale: 1, offsetX: 0, offsetY: 0, width: 0, height: 0 };
}

/** Fills `out` (reused to avoid per-frame allocation) and returns it. */
export function computeCover(
  out: CoverRect,
  viewWidth: number,
  viewHeight: number,
  videoWidth: number,
  videoHeight: number,
): CoverRect {
  const scale = Math.max(viewWidth / videoWidth, viewHeight / videoHeight);
  out.scale = scale;
  out.width = videoWidth * scale;
  out.height = videoHeight * scale;
  out.offsetX = (viewWidth - out.width) / 2;
  out.offsetY = (viewHeight - out.height) / 2;
  return out;
}
