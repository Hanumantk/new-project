import { Text } from 'troika-three-text';

const fontUrl = (file: string) => new URL(`material-mat/fonts/${file}`, document.baseURI).href;

/** DM Sans, bundled (troika reads WOFF, not WOFF2). */
export const FONTS = {
  medium: fontUrl('dm-sans-latin-500-normal.woff'),
  bold: fontUrl('dm-sans-latin-700-normal.woff'),
};

/** Colours chosen to read over passthrough: off-white text on a soft dark halo, mint accent. */
export const COLORS = {
  label: '#f4f3ee',
  muted: '#cfd8d2',
  mint: '#8eddb0',
  ink: '#0e1512',
  warn: '#ffc7a8',
};

/** Opacity of the soft dark halo behind text. */
const HALO_OPACITY = 0.62;

export interface TextStyle {
  /** Cap-to-descender size in metres. */
  size: number;
  weight?: 'medium' | 'bold';
  color?: string;
  maxWidth?: number;
  anchorX?: 'left' | 'center' | 'right';
  anchorY?: 'top' | 'middle' | 'bottom' | 'top-baseline' | 'bottom-baseline';
  align?: 'left' | 'center' | 'right';
  /** A soft dark halo so off-white text stays legible over a bright room (default on). */
  halo?: boolean;
}

/** SDF text in the app's style. Call `setTextOpacity` to fade it. */
export function makeText(content: string, style: TextStyle): Text {
  const text = new Text();
  text.text = content;
  text.font = style.weight === 'bold' ? FONTS.bold : FONTS.medium;
  text.fontSize = style.size;
  text.color = style.color ?? COLORS.label;
  text.anchorX = style.anchorX ?? 'left';
  text.anchorY = style.anchorY ?? 'middle';
  text.textAlign = style.align ?? style.anchorX ?? 'left';
  text.lineHeight = 1.18;
  if (style.maxWidth) text.maxWidth = style.maxWidth;
  if (style.halo !== false) {
    text.outlineColor = COLORS.ink;
    text.outlineWidth = '14%';
    text.outlineBlur = '45%';
    text.outlineOpacity = HALO_OPACITY;
  }
  text.renderOrder = 20;
  text.sync();
  return text;
}

/** Fades text and its halo together (0..1). */
export function setTextOpacity(text: Text, opacity: number) {
  text.fillOpacity = opacity;
  if (text.outlineBlur) text.outlineOpacity = HALO_OPACITY * opacity;
  text.visible = opacity > 0.002;
}

/** Sets the text only when it changed (a change re-runs layout). */
export function setTextContent(text: Text, content: string) {
  if (text.text !== content) {
    text.text = content;
    text.sync();
  }
}
