import { useEffect, useState } from 'react';
import { ARView } from './components/ARView';
import { XRView } from './components/XRView';
import { GlassGrid, GlassLabel, at } from './components/glass/Glass';
import { GlassKit } from './components/glass/GlassKit';

type Screen = { kind: 'start' } | { kind: 'ar' } | { kind: 'xr' } | { kind: 'error'; message: string };

/** The bundled test clip (an open palm moving), relative to the site. */
const SAMPLE_VIDEO_PATH = 'samples/palm-moving.webm';

/**
 * `?video=<path>` plays that file in a loop instead of the webcam. Only
 * same-origin files: the frames have to be readable for hand detection.
 */
function sampleVideoFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get('video');
  if (!value) return null;
  try {
    const url = new URL(value, document.baseURI);
    if (url.origin === window.location.origin) return url.href;
  } catch {
    // fall through
  }
  console.warn(`Ignoring ?video=${value}: only same-origin video files can be used.`);
  return null;
}

/** `?kit`: the Liquid Glass control-tile kit on its own page. */
const SHOW_KIT = new URLSearchParams(window.location.search).has('kit');

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'start' });
  const [sampleVideo] = useState(sampleVideoFromUrl);
  // In a headset browser with passthrough (e.g. Quest Browser), lead with mixed reality.
  const [canMixedReality, setCanMixedReality] = useState(false);

  useEffect(() => {
    navigator.xr
      ?.isSessionSupported('immersive-ar')
      .then(setCanMixedReality)
      .catch(() => setCanMixedReality(false));
  }, []);

  if (SHOW_KIT) return <GlassKit />;

  if (screen.kind === 'ar') {
    return (
      <ARView
        sampleVideo={sampleVideo}
        onError={(message) => setScreen({ kind: 'error', message })}
        onStop={() => setScreen({ kind: 'start' })}
      />
    );
  }

  if (screen.kind === 'xr') {
    return <XRView onExit={() => setScreen({ kind: 'start' })} />;
  }

  const startLabel = screen.kind === 'error' ? 'Try again' : sampleVideo ? 'Start sample video' : 'Start camera';
  return (
    <main className="cc-page intro">
      <div className="intro-inner">
        <div className="intro-icon" aria-hidden />
        <h1>Palm injury</h1>
        {screen.kind === 'error' ? (
          <p className="intro-error" role="alert">
            {screen.message}
          </p>
        ) : sampleVideo ? (
          <p>
            Test mode: a looping video plays instead of the webcam, so you can see the wound track
            a moving palm without a camera.
          </p>
        ) : canMixedReality ? (
          <p>
            Hold up your open palm and a realistic wound will appear on it in your real room,
            following your hand as it moves.
          </p>
        ) : (
          <p>
            Hold your open palm up to the webcam and a realistic wound will appear on it, following
            your hand as it moves. Everything runs locally in your browser.
          </p>
        )}
        {/* Control Center style: the main choices as 2×2 tiles, the rest as 2×1 pills. */}
        <GlassGrid label="Start">
          {canMixedReality && (
            <GlassLabel
              size="2x2"
              style={at(1, 1, 2, 2)}
              icon="headset"
              title="Start mixed reality"
              detail="Your real room"
              on
              onClick={() => setScreen({ kind: 'xr' })}
            />
          )}
          <GlassLabel
            size="2x2"
            style={at(canMixedReality ? 3 : 1, 1, 2, 2)}
            icon={sampleVideo ? 'play' : 'camera'}
            title={startLabel}
            detail={sampleVideo ? 'Looping clip' : 'Webcam'}
            on={!canMixedReality}
            onClick={() => setScreen({ kind: 'ar' })}
          />
          {!canMixedReality && !sampleVideo && (
            <GlassLabel
              size="2x2"
              style={at(3, 1, 2, 2)}
              icon="headset"
              title="Use a VR headset"
              detail="Meta Quest"
              onClick={() => setScreen({ kind: 'xr' })}
            />
          )}
          <GlassLabel
            style={at(1, 3, 2)}
            icon={sampleVideo ? 'camera' : 'play'}
            title={sampleVideo ? 'Webcam' : 'Sample'}
            detail={sampleVideo ? 'Use it' : 'Test video'}
            onClick={() => (window.location.search = sampleVideo ? '' : `?video=${SAMPLE_VIDEO_PATH}`)}
          />
          <GlassLabel
            style={at(3, 3, 2)}
            icon="sparkles"
            title="Glass kit"
            detail="Preview"
            onClick={() => (window.location.search = '?kit')}
          />
        </GlassGrid>
      </div>
    </main>
  );
}
