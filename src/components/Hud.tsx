import type { Delegate } from '../lib/handLandmarker';

interface HudProps {
  handDetected: boolean;
  fps: number;
  delegate: Delegate | null;
  running: boolean;
  showLandmarks: boolean;
  onToggleLandmarks: () => void;
  onStop: () => void;
}

export function Hud({
  handDetected,
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
        <span className={`pill ${handDetected ? 'pill--on' : ''}`} role="status">
          <span className="pill-dot" aria-hidden />
          {handDetected ? 'Hand detected' : 'Show your hand'}
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
