import { HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { CoverRect } from './coverMapping';

const LINE_COLOR = 'rgba(255, 255, 255, 0.9)';
const DOT_FILL = '#8EDDB0';
const DOT_STROKE = '#1f3d2c';
const DOT_RADIUS = 4;

/** Draws the 21 landmarks and their connections, in view (CSS) pixels. */
export function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  cover: CoverRect,
) {
  const px = (lm: NormalizedLandmark) => cover.offsetX + lm.x * cover.width;
  const py = (lm: NormalizedLandmark) => cover.offsetY + lm.y * cover.height;

  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = LINE_COLOR;
  ctx.beginPath();
  for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
    ctx.moveTo(px(landmarks[start]), py(landmarks[start]));
    ctx.lineTo(px(landmarks[end]), py(landmarks[end]));
  }
  ctx.stroke();

  ctx.fillStyle = DOT_FILL;
  ctx.strokeStyle = DOT_STROKE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const lm of landmarks) {
    const x = px(lm);
    const y = py(lm);
    ctx.moveTo(x + DOT_RADIUS, y);
    ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
}
