import type { Delegate } from '../lib/handLandmarker';
import { GlassCluster, GlassGrid, GlassLabel, GlassSlider, GlassToggle, at } from './glass/Glass';
import type { GlassIconName } from './glass/icons';

/** No hand / a closed hand (wound hidden) / an open hand (wound on the palm). */
export type HandStatus = 'none' | 'closed' | 'open';

/** The status tile: a short title and a detail line (2×1 tiles are narrow). */
const STATUS_TILE: Record<HandStatus, { title: string; detail: string }> = {
  none: { title: 'No hand', detail: 'Show it' },
  closed: { title: 'Closed', detail: 'Open it' },
  open: { title: 'Tracking', detail: 'Hand' },
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

const DEBUG_LAYER_ICON: Record<DebugLayer, GlassIconName> = {
  landmarks: 'points',
  surface: 'surface',
  box: 'box',
  jitter: 'pulse',
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
  const status = STATUS_TILE[handStatus];
  return (
    <div className="hud">
      {/* Control Center style: Clear glass tiles over the video, on the kit's 68 px grid. */}
      <GlassGrid label="Controls">
        <GlassLabel
          style={at(1, 1, 2)}
          material="clear"
          icon="hand"
          title={status.title}
          detail={status.detail}
          on={handStatus === 'open'}
          role="status"
        />
        <GlassLabel
          style={at(3, 1, 2)}
          material="clear"
          icon="pulse"
          tooltip={delegate ? `Hand detection on the ${delegate}` : undefined}
          title={`${stats ? Math.round(stats.renderFps) : '–'} FPS`}
          detail={`${stats?.detectMs != null ? stats.detectMs.toFixed(1) : '–'} ms`}
        />
        <GlassSlider
          style={at(1, 2, 1, 2)}
          material="clear"
          icon="drop"
          label="Wound opacity"
          value={woundOpacity}
          onChange={onWoundOpacityChange}
        />
        <GlassToggle style={at(2, 2)} material="clear" icon="camera" label="Camera view" on={view === 'camera'} onClick={() => onViewChange('camera')} />
        <GlassToggle style={at(3, 2)} material="clear" icon="mesh" label="Mesh view" on={view === 'mesh'} onClick={() => onViewChange('mesh')} />
        <GlassToggle style={at(4, 2)} material="clear" icon="bug" label="Debug" on={debug} onClick={onToggleDebug} />
        <GlassToggle
          style={at(2, 3)}
          material="clear"
          icon="stop"
          label={source ? `Stop ${source.toLowerCase()}` : 'Stop camera'}
          onClick={onStop}
        />
        {debug && (
          <GlassCluster
            style={at(3, 3, 2, 2)}
            material="clear"
            label="Debug overlays"
            items={(Object.keys(DEBUG_LAYER_LABEL) as DebugLayer[]).map((layer, i) => ({
              icon: DEBUG_LAYER_ICON[layer],
              label: DEBUG_LAYER_LABEL[layer],
              on: debugLayers[layer],
              onClick: () => onToggleDebugLayer(layer),
              accent: i < 2 ? 'blue' : 'green',
            }))}
          />
        )}
        {debug && stats && (
          <GlassLabel
            style={at(1, 4, 2)}
            material="clear"
            icon="sparkles"
            title={stats.mismatches ? `${stats.mismatches} out of sync` : 'In sync'}
            detail={`frame ${stats.frameId}`}
            on={!stats.mismatches}
            role="status"
          />
        )}
        {debug && stats && debugLayers.jitter && (
          <GlassLabel
            style={at(1, 5, 2)}
            material="clear"
            icon="pulse"
            title={stats.jitterPx == null ? 'Moving' : `${stats.jitterPx.toFixed(2)} px`}
            detail={stats.rawJitterPx != null ? `raw ${stats.rawJitterPx.toFixed(2)}` : 'jitter'}
            on={stats.jitterPx != null && stats.jitterPx < JITTER_TARGET_PX}
            role="status"
          />
        )}
      </GlassGrid>
    </div>
  );
}
