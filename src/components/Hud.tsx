import type { Delegate } from '../lib/handLandmarker';

/** No hand / a closed hand (no cube) / an open hand (cube on the palm). */
export type HandStatus = 'none' | 'closed' | 'open';

const STATUS_LABEL: Record<HandStatus, string> = {
  none: 'Show your hand',
  closed: 'Open your hand',
  open: 'Hand detected',
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
