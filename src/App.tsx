import { useEffect, useState } from 'react';
import { ARView } from './components/ARView';
import { XRView } from './components/XRView';

type Screen = { kind: 'start' } | { kind: 'ar' } | { kind: 'xr' } | { kind: 'error'; message: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'start' });
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
          {screen.kind === 'error' ? 'Try again' : 'Start camera'}
        </button>
        {!canMixedReality && (
          <button type="button" className="panel button" onClick={() => setScreen({ kind: 'xr' })}>
            Use a VR headset
          </button>
        )}
      </div>
    </main>
  );
}
