import { useState } from 'react';
import { ARView } from './components/ARView';
import { XRView } from './components/XRView';

type Screen = { kind: 'start' } | { kind: 'ar' } | { kind: 'xr' } | { kind: 'error'; message: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'start' });

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
        ) : (
          <p>
            Hold your open palm up to the webcam and a realistic wound will appear on it, following
            your hand as it moves. Everything runs locally in your browser.
          </p>
        )}
        <button type="button" className="button button--primary" onClick={() => setScreen({ kind: 'ar' })}>
          {screen.kind === 'error' ? 'Try again' : 'Start camera'}
        </button>
        <button type="button" className="panel button" onClick={() => setScreen({ kind: 'xr' })}>
          Use a VR headset
        </button>
      </div>
    </main>
  );
}
