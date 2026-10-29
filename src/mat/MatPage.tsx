import { useEffect, useRef, useState } from 'react';
import { loadSavedMat, type SavedMat } from './lib/matStore';
import { MatExperience } from './xr/MatExperience';
import { checkARSupport, describeError, MAT_SESSION_INIT, type ARSupport } from './xr/session';

const EMULATOR_URL =
  'https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik';

/**
 * The Material Mat's 2D page: checks for passthrough AR and starts the
 * headset session. Everything else happens in the headset.
 */
export function MatPage() {
  const [support, setSupport] = useState<ARSupport>('checking');
  const [inSession, setInSession] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);
  const [savedMat, setSavedMat] = useState<SavedMat | null>(loadSavedMat);
  const experienceRef = useRef<MatExperience | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkARSupport().then((result) => !cancelled && setSupport(result));
    return () => {
      cancelled = true;
      experienceRef.current?.dispose();
      experienceRef.current = null;
    };
  }, []);

  const enter = async (restore: SavedMat | null) => {
    const xr = navigator.xr;
    if (!xr) return;
    setError(null);
    let session: XRSession;
    try {
      // Straight from the click: browsers only grant sessions inside a user gesture.
      session = await xr.requestSession('immersive-ar', MAT_SESSION_INIT);
    } catch (err) {
      console.error(err);
      setError({
        message: 'The headset didn’t start AR.',
        detail: describeError(err),
      });
      return;
    }
    const experience = (experienceRef.current ??= new MatExperience({
      onEnd: () => setInSession(false),
      onSavedMatChange: setSavedMat,
    }));
    try {
      setInSession(true);
      await experience.start(session, { restore });
    } catch (err) {
      console.error(err);
      setInSession(false);
      void session.end().catch(() => {});
      setError({ message: 'AR started but the page couldn’t draw into it.', detail: describeError(err) });
    }
  };

  return (
    <main className="intro mat-page">
      <div className="panel intro-card mat-card">
        <div className="mat-icon" aria-hidden />
        <h1>Material Mat</h1>
        <p>
          Draw a rectangle on your table with a pinch, and it becomes a mat with a true-to-size outline
          for every material and tool you need for a 5&nbsp;cm scar-wax cut on the palm. Put each real
          item on its outline.
        </p>

        {inSession ? (
          <>
            <p className="mat-note">You’re in AR. Press the Meta button or the button below to leave.</p>
            <button type="button" className="button button--primary" onClick={() => experienceRef.current?.end()}>
              Exit AR
            </button>
          </>
        ) : support === 'checking' ? (
          <p className="mat-note">Checking for passthrough AR…</p>
        ) : support === 'supported' ? (
          <div className="mat-actions">
            <button type="button" className="button button--primary" onClick={() => enter(null)}>
              Enter AR
            </button>
            {savedMat && (
              <button type="button" className="panel button" onClick={() => enter(savedMat)}>
                Restore last mat ({Math.round(savedMat.width * 100)} × {Math.round(savedMat.depth * 100)} cm)
              </button>
            )}
          </div>
        ) : (
          <Unsupported support={support} />
        )}

        {error && (
          <div className="mat-error" role="alert">
            <p className="intro-error">
              {error.message}
              <span className="xr-error-detail">{error.detail}</span>
            </p>
            <p className="mat-note">
              The mat needs hand tracking: in the headset, open Settings → Movement tracking and turn on
              Hand tracking, then put the controllers down and try again.
            </p>
          </div>
        )}

        <a className="intro-link" href="./">
          Back to the palm injury prototype
        </a>
      </div>
    </main>
  );
}

function Unsupported({ support }: { support: Exclude<ARSupport, 'checking' | 'supported'> }) {
  return (
    <div className="mat-unsupported">
      <p>
        <strong>
          {support === 'insecure' ? 'This page needs HTTPS for AR.' : 'This browser can’t show passthrough AR.'}
        </strong>{' '}
        Open this page in the <strong>Quest Browser</strong> on a Meta Quest 3 or 3S.
      </p>
      <p className="mat-note">
        Testing on a computer? Install Meta’s{' '}
        <a href={EMULATOR_URL} target="_blank" rel="noreferrer">
          Immersive Web Emulator
        </a>{' '}
        for Chrome or Edge, pick a Quest 3, reload, and Enter AR appears here.
      </p>
    </div>
  );
}
