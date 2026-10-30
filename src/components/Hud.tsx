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
  /**
   * Wound jitter: RMS movement of its centre over the last second (video px,
   * drift removed), as drawn and of the unfiltered pose, while the hand is
   * roughly still (null while it moves).
   */
  jitterPx: number | null;
  rawJitterPx: number | null;
}

/** Debug overlays that can be switched on and off one by one. */
export type DebugLayer = 'landmarks' | 'surface' | 'box' | 'jitter';
export type DebugLayers = Record<DebugLayer, boolean>;
export const ALL_DEBUG_LAYERS: DebugLayers = { landmarks: true, surface: true, box: true, jitter: true };
const DEBUG_LAYER_LABEL: Record<DebugLayer, string> = {
  landmarks: 'Landmarks',
  surface: 'Palm surface',
  box: 'Wound box',
  jitter: 'Jitter',
};

/** Target for the wound's jitter with the hand at rest. */
const JITTER_TARGET_PX = 0.5;

interface HudProps {
  handStatus: HandStatus;
  stats: HudStats | null;
  delegate: Delegate | null;
  /** Shown instead of the camera, e.g. "Sample video". */
  source: string | null;
  debug: boolean;
  onToggleDebug: () => void;
  debugLayers: DebugLayers;
  onToggleDebugLayer: (layer: DebugLayer) => void;
  /** Wound opacity, 0..1. */
  woundOpacity: number;
  onWoundOpacityChange: (value: number) => void;
  /** Camera picture, or the hand as a grayscale mesh. */
  view: 'camera' | 'mesh';
  onViewChange: (view: 'camera' | 'mesh') => void;
  onStop: () => void;
}

export function Hud({
  handStatus,
  stats,
  delegate,
  source,
  debug,
  onToggleDebug,
  debugLayers,
  onToggleDebugLayer,
  woundOpacity,
  onWoundOpacityChange,
  view,
  onViewChange,
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
          {debugLayers.jitter && (
            <span
              className={stats.jitterPx == null ? undefined : stats.jitterPx < JITTER_TARGET_PX ? 'hud-good' : 'hud-bad'}
              title="Wound centre, RMS over the last second with the hand still (unfiltered pose in brackets)"
            >
              jitter{' '}
              <strong>{stats.jitterPx == null ? 'moving' : `${stats.jitterPx.toFixed(2)} px`}</strong>
              {stats.rawJitterPx != null && ` (raw ${stats.rawJitterPx.toFixed(2)})`}
            </span>
          )}
        </div>
      )}
      {debug && (
        <div className="panel hud-debug hud-debug-layers" role="group" aria-label="Debug overlays">
          {(Object.keys(DEBUG_LAYER_LABEL) as DebugLayer[]).map((layer) => (
            <label key={layer}>
              <input type="checkbox" checked={debugLayers[layer]} onChange={() => onToggleDebugLayer(layer)} />
              {DEBUG_LAYER_LABEL[layer]}
            </label>
          ))}
        </div>
      )}
      <div className="panel hud-segmented" role="radiogroup" aria-label="View">
        {(['camera', 'mesh'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={view === option}
            className={view === option ? 'is-selected' : ''}
            onClick={() => onViewChange(option)}
          >
            {option === 'camera' ? 'Camera' : 'Mesh'}
          </button>
        ))}
      </div>
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
