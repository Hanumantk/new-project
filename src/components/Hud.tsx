import type { Delegate } from '../lib/handLandmarker';
import { OpacitySlider } from './OpacitySlider';

/** No hand / a closed hand (wound hidden) / an open hand (wound on the palm). */
export type HandStatus = 'none' | 'closed' | 'open';

const STATUS_LABEL: Record<HandStatus, string> = {
  none: 'Show your hand',
  closed: 'Open your hand',
  open: 'Hand detected',
};

export interface HudStats {
  /** Frames drawn per second (one per detected camera frame). */
  renderFps: number;
  /** Mean detectForVideo time over the last window, in ms. */
  detectMs: number | null;
  /** Latest captured camera frame, and the frames last drawn as pose / background. */
  frameId: number;
  poseFrameId: number;
  backgroundFrameId: number;
  /** Renders where the pose and the background came from different frames. */
  mismatches: number;
}

interface HudProps {
  handStatus: HandStatus;
  stats: HudStats | null;
  delegate: Delegate | null;
  /** Shown instead of the camera, e.g. "Sample video". */
  source: string | null;
  debug: boolean;
  onToggleDebug: () => void;
  /** Wound opacity, 0..1. */
  woundOpacity: number;
  onWoundOpacityChange: (value: number) => void;
  onStop: () => void;
}

export function Hud({
  handStatus,
  stats,
  delegate,
  source,
  debug,
  onToggleDebug,
  woundOpacity,
  onWoundOpacityChange,
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
          <strong>{stats ? Math.round(stats.renderFps) : '–'}</strong> FPS
          <span className="hud-sep" aria-hidden>·</span>
          <strong>{stats?.detectMs != null ? stats.detectMs.toFixed(1) : '–'}</strong> ms detect
          {delegate && <span className="delegate">{delegate}</span>}
        </span>
      </div>
      {debug && stats && (
        <div className="panel hud-debug" aria-label="Frame sync">
          <span>
            frame <strong>{stats.frameId}</strong>
          </span>
          <span>
            pose <strong>{stats.poseFrameId}</strong>
          </span>
          <span>
            background <strong>{stats.backgroundFrameId}</strong>
          </span>
          <span className={stats.mismatches ? 'hud-bad' : 'hud-good'}>
            {stats.mismatches ? `${stats.mismatches} out of sync` : 'in sync'}
          </span>
        </div>
      )}
      <OpacitySlider value={woundOpacity} onChange={onWoundOpacityChange} />
      <div className="hud-actions">
        <button type="button" className="panel button" aria-pressed={debug} onClick={onToggleDebug}>
          Debug
        </button>
        <button type="button" className="panel button button--quiet" onClick={onStop}>
          {source ? `Stop ${source.toLowerCase()}` : 'Stop camera'}
        </button>
      </div>
    </div>
  );
}
