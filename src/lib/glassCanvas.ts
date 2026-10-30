/**
 * Liquid Glass control tiles (after the iOS 26 Control Center kit) drawn
 * into a canvas, for the panels shown in the headset. A page can't blur the
 * passthrough behind a panel, so each tile is a smoky translucent glass with
 * a rim lit from the top left; "on" tiles are bright white glass with dark
 * symbols, as in the kit. Over a real room the "off" glass is kept a little
 * darker than the kit's, so white text stays readable on bright surroundings.
 */

export const GLASS_TEXT = '#ffffff';
export const GLASS_TEXT_MUTED = 'rgba(255, 255, 255, 0.6)';
/** Text and symbols on an "on" (white) tile. */
export const GLASS_TEXT_ON_SELECTED = '#000000';
export const GLASS_TEXT_ON_SELECTED_MUTED = 'rgba(0, 0, 0, 0.55)';
export const GLASS_FONT = '-apple-system, "SF Pro Text", "DM Sans", system-ui, sans-serif';

function path(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/** The glass rim: bright towards the top left (light at 315°), faint elsewhere. */
function rim(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, width: number) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, 'rgba(255, 255, 255, 0.75)');
  g.addColorStop(0.45, 'rgba(255, 255, 255, 0.12)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0.4)');
  ctx.lineWidth = width;
  ctx.strokeStyle = g;
  path(ctx, x + width / 2, y + width / 2, w - width, h - width, r - width / 2);
  ctx.stroke();
}

/**
 * A control tile (Toggle 1×1 when round, Label 2×1 as a pill, 2×2 with a
 * 30-unit corner…): off = smoky glass, on = bright white glass. Corner
 * radius defaults to a pill.
 */
export function drawGlassTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  options: { on?: boolean; tint?: string; radius?: number } = {},
) {
  const r = options.radius ?? Math.min(w, h) / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
  ctx.shadowBlur = 24;
  path(ctx, x, y, w, h, r);
  if (options.on) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  } else {
    ctx.fillStyle = options.tint ?? 'rgba(52, 52, 56, 0.58)';
  }
  ctx.fill();
  ctx.restore();
  if (!options.on) {
    // A soft sheen over the glass.
    const sheen = ctx.createLinearGradient(0, y, 0, y + h);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
    sheen.addColorStop(0.6, 'rgba(255, 255, 255, 0.03)');
    path(ctx, x, y, w, h, r);
    ctx.fillStyle = sheen;
    ctx.fill();
  }
  rim(ctx, x, y, w, h, r, Math.max(2, Math.min(w, h) * 0.035));
}

/** Kept for panels that want one glass backing behind their tiles. */
export function drawGlassPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  drawGlassTile(ctx, x, y, w, h, { radius: r });
}

/** A Control-Center slider laid sideways: a glass pill that fills with white from the left. */
export function drawGlassSlider(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, value: number) {
  drawGlassTile(ctx, x, y, w, h);
  const fillW = Math.max(h, w * Math.min(Math.max(value, 0), 1));
  ctx.save();
  path(ctx, x, y, w, h, h / 2);
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.fillRect(x, y, fillW, h);
  ctx.restore();
}

/** A filled symbol in a tile (the kit's SF Symbols, as simple canvas shapes). */
export function drawSymbol(ctx: CanvasRenderingContext2D, kind: 'drop' | 'sun' | 'hand' | 'mesh' | 'target', cx: number, cy: number, size: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const s = size / 24;
  ctx.translate(cx - 12 * s, cy - 12 * s);
  ctx.scale(s, s);
  const paths: Record<typeof kind, string> = {
    drop: 'M12 2.5c3.7 4.6 6.5 8.3 6.5 11.8a6.5 6.5 0 0 1-13 0c0-3.5 2.8-7.2 6.5-11.8Z',
    sun: 'M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm-1-5.5h2V5h-2V1.5Zm0 17.5h2v3.5h-2V19ZM1.5 11H5v2H1.5v-2ZM19 11h3.5v2H19v-2Z',
    hand: 'M11 2.5a1.5 1.5 0 0 1 1.5 1.5v6.5h.5V5a1.5 1.5 0 0 1 3 0v6h.5V7a1.5 1.5 0 0 1 3 0v7.5c0 4-3 7-6.8 7-2.6 0-4.4-1.2-5.8-3.3L4 14.2a1.6 1.6 0 0 1 2.6-1.8L8 14V5a1.5 1.5 0 0 1 3 0V4a1.5 1.5 0 0 1 0-1.5Z',
    mesh: 'M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Zm0 2.3L6.4 7.8 12 10.9l5.6-3.1L12 4.8Zm-6.5 4.7v6.3l5.5 3V12.6l-5.5-3.1Zm13 0-5.5 3.1v6.2l5.5-3V9.5Z',
    target: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 2.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 3a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z',
  };
  ctx.fill(new Path2D(paths[kind]), 'evenodd');
  ctx.restore();
}
