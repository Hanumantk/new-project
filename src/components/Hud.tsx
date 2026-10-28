import type { Delegate } from '../lib/handLandmarker';

/** No hand / back of the hand towards the camera / palm towards the camera. */
export type HandStatus = 'none' | 'back' | 'palm';

const STATUS_LABEL: Record<HandStatus, string> = {
  none: 'Show your hand',
  back: 'Turn your palm to the camera',
  palm: 'Hand detected',
};

interface HudProps {
  handStatus: HandStatus;
  fps: number;
  delegate: Delegate | null;
  running: boolean;
  showLandmarks: boolean;
  onToggleLandmarks: () => void;
  onStop: () => void;
}

export function Hud({
  handStatus,
  fps,
  delegate,
  running,
  showLandmarks,
  onToggleLandmarks,
  onStop,
}: HudProps) {
  return (
    <div className="hud">
      <div className="panel hud-status">
        <span className={`pill pill--${handStatus}`} role="status">
          <span className="pill-dot" aria-hidden />
          {STATUS_LABEL[handStatus]}
        </span>
        <span className="fps" title={delegate ? `Inference on ${delegate}` : undefined}>
          <strong>{running ? fps : '–'}</strong> FPS
          {delegate && <span className="delegate">{delegate}</span>}
        </span>
      </div>
      <div className="hud-actions">
        <button
          type="button"
          className="panel button"
          aria-pressed={showLandmarks}
          onClick={onToggleLandmarks}
        >
          {showLandmarks ? 'Hide landmarks' : 'Show landmarks'}
        </button>
        <button type="button" className="panel button button--quiet" onClick={onStop}>
          Stop camera
        </button>
      </div>
    </div>
  );
}
