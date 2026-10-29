import { useEffect, useState } from 'react';
import { ARView } from './components/ARView';
import { XRView } from './components/XRView';

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

  return (
    <main className="intro">
      <div className="panel intro-card">
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
        {canMixedReality && (
          <button type="button" className="button button--primary" onClick={() => setScreen({ kind: 'xr' })}>
            Start mixed reality
          </button>
        )}
        <button
          type="button"
          className={canMixedReality ? 'panel button' : 'button button--primary'}
          onClick={() => setScreen({ kind: 'ar' })}
        >
          {screen.kind === 'error' ? 'Try again' : sampleVideo ? 'Start sample video' : 'Start camera'}
        </button>
        {!canMixedReality && !sampleVideo && (
          <button type="button" className="panel button" onClick={() => setScreen({ kind: 'xr' })}>
            Use a VR headset
          </button>
        )}
        <a className="intro-link" href={sampleVideo ? '?' : `?video=${SAMPLE_VIDEO_PATH}`}>
          {sampleVideo ? 'Use the webcam instead' : 'No camera? Try the sample video'}
        </a>
        <a className="intro-link" href="material-mat.html">
          Material Mat: lay out the kit on your table (Quest)
        </a>
      </div>
    </main>
  );
}
