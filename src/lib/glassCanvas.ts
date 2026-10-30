/**
 * Apple-style spatial glass (as in visionOS) drawn into a canvas, for the
 * panels shown in the headset. A page can't blur the passthrough behind a
 * panel, so the glass is a smoky translucent body with a soft top sheen and a
 * bright rim, white text, capsule controls, and a white "selected" state.
 */

export const GLASS_TEXT = '#ffffff';
export const GLASS_TEXT_MUTED = 'rgba(255, 255, 255, 0.72)';
/** Text on a selected (white) control. */
export const GLASS_TEXT_ON_SELECTED = '#1c2420';
export const GLASS_FONT = '"DM Sans", system-ui, -apple-system, sans-serif';

function path(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

/** A glass panel filling (x, y, w, h) with corner radius r. */
export function drawGlassPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  // Body: smoky, a touch lighter at the top.
  const body = ctx.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, 'rgba(96, 104, 100, 0.66)');
  body.addColorStop(1, 'rgba(44, 50, 47, 0.6)');
  path(ctx, x, y, w, h, r);
  ctx.fillStyle = body;
  ctx.fill();
  // Sheen over the top half.
  const sheen = ctx.createLinearGradient(0, y, 0, y + h * 0.55);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.2)');
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fill();
  // Rim: bright along the top edge, faint at the sides, a little light again at the bottom.
  const rim = ctx.createLinearGradient(0, y, 0, y + h);
  rim.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
  rim.addColorStop(0.35, 'rgba(255, 255, 255, 0.18)');
  rim.addColorStop(1, 'rgba(255, 255, 255, 0.38)');
  ctx.lineWidth = 4;
  ctx.strokeStyle = rim;
  path(ctx, x + 2, y + 2, w - 4, h - 4, r - 2);
  ctx.stroke();
}

/**
 * A capsule control. `selected`: solid white (dark text); `tint`: a coloured
 * glass (e.g. a status colour); otherwise clear glass.
 */
export function drawGlassButton(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  options: { selected?: boolean; tint?: string; radius?: number } = {},
) {
  const r = options.radius ?? h / 2;
  path(ctx, x, y, w, h, r);
  if (options.selected) {
    const fill = ctx.createLinearGradient(0, y, 0, y + h);
    fill.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
    fill.addColorStop(1, 'rgba(236, 240, 238, 0.92)');
    ctx.fillStyle = fill;
    ctx.fill();
    return;
  }
  ctx.fillStyle = options.tint ?? 'rgba(255, 255, 255, 0.16)';
  ctx.fill();
  const sheen = ctx.createLinearGradient(0, y, 0, y + h);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  sheen.addColorStop(0.55, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  path(ctx, x + 1, y + 1, w - 2, h - 2, r - 1);
  ctx.stroke();
}

/** A glass slider: a thin translucent track, white fill, a white capsule thumb. */
export function drawGlassSlider(ctx: CanvasRenderingContext2D, x: number, cy: number, w: number, value: number) {
  const track = 14;
  path(ctx, x, cy - track / 2, w, track, track / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.fill();
  const fillW = Math.max(track, w * value);
  path(ctx, x, cy - track / 2, fillW, track, track / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fill();
  const tw = 62;
  const th = 40;
  const tx = Math.min(Math.max(x + w * value - tw / 2, x - tw / 4), x + w - (tw * 3) / 4);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;
  path(ctx, tx, cy - th / 2, tw, th, th / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}
