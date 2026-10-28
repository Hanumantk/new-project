import { useState } from 'react';
import { ARView } from './components/ARView';

type Screen = { kind: 'start' } | { kind: 'ar' } | { kind: 'error'; message: string };

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

  return (
    <main className="intro">
      <div className="panel intro-card">
        <div className="intro-cube" aria-hidden />
        <h1>Palm cube</h1>
        {screen.kind === 'error' ? (
          <p className="intro-error" role="alert">
            {screen.message}
          </p>
        ) : (
          <p>
            Hold your hand up to the webcam and a little 3D cube will sit on your palm and follow
            it around. Everything runs locally in your browser.
          </p>
        )}
        <button type="button" className="button button--primary" onClick={() => setScreen({ kind: 'ar' })}>
          {screen.kind === 'error' ? 'Try again' : 'Start camera'}
        </button>
      </div>
    </main>
  );
}
