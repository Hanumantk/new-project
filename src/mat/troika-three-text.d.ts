/** The parts of troika-three-text this app uses (the package ships no types). */
declare module 'troika-three-text' {
  import { Color, Mesh } from 'three';

  type Colorish = string | number | Color;

  export class Text extends Mesh {
    text: string;
    font: string | null;
    fontSize: number;
    color: Colorish;
    anchorX: number | string;
    anchorY: number | string;
    maxWidth: number;
    lineHeight: number | 'normal';
    letterSpacing: number;
    textAlign: 'left' | 'right' | 'center' | 'justify';
    whiteSpace: 'normal' | 'nowrap';
    overflowWrap: 'normal' | 'break-word';
    outlineWidth: number | string;
    outlineColor: Colorish;
    outlineOpacity: number;
    outlineBlur: number | string;
    fillOpacity: number;
    depthOffset: number;
    readonly textRenderInfo: {
      /** [minX, minY, maxX, maxY] of the laid-out block, in local units. */
      blockBounds: [number, number, number, number];
      visibleBounds: [number, number, number, number];
    } | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }

  export function preloadFont(
    options: { font?: string; characters?: string | string[] },
    callback: () => void,
  ): void;
}
