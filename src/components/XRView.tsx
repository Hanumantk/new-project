import { useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { HandStatus } from './Hud';
import { XRScene, type XRMode } from './XRScene';

/** Used to drop the room to the floor when the runtime has no floor-level space. */
const STANDING_EYE_HEIGHT = 1.6;

/** Asks for a session, retrying with fewer requirements if the first ask is refused. */
async function requestSession(xr: XRSystem, mode: XRSessionMode): Promise<XRSession> {
  try {
    return await xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hand-tracking'],
    });
  } catch (err) {
    console.warn('Session with a floor-level space refused, retrying without requirements.', err);
    return xr.requestSession(mode, { optionalFeatures: ['local-floor', 'hand-tracking'] });
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error || err instanceof DOMException) {
    return err.message ? `${err.name}: ${err.message}` : err.name;
  }
  return String(err);
}

interface Support {
  ar: boolean;
  vr: boolean;
}

const STATUS_LABEL: Record<HandStatus, string> = {
  none: 'Looking for your hand…',
  closed: 'Open your hand',
  open: 'Hand detected',
};

interface XRViewProps {
  onExit: () => void;
}

/**
 * Headset mode (e.g. Meta Quest 3 over Quest Link, or the Quest's own
 * browser). The wound is placed with the headset's hand tracking, so no
 * webcam is used. The page stays on the laptop screen as a control panel.
 */
export function XRView({ onExit }: XRViewProps) {
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const [support, setSupport] = useState<Support | null>(null);
  const [mode, setMode] = useState<XRMode | null>(null);
  const [handStatus, setHandStatus] = useState<HandStatus>('none');
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);
  const [floorY, setFloorY] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const xr = navigator.xr;
    const check = (m: XRSessionMode) => (xr ? xr.isSessionSupported(m).catch(() => false) : Promise.resolve(false));
    Promise.all([check('immersive-ar'), check('immersive-vr')]).then(([ar, vr]) => {
      if (!cancelled) setSupport({ ar, vr });
    });
    return () => {
      cancelled = true;
      void rendererRef.current?.xr.getSession()?.end().catch(() => {});
    };
  }, []);

  const enter = async (next: XRMode) => {
    const renderer = rendererRef.current;
    const xr = navigator.xr;
    if (!renderer || !xr) return;
    setError(null);

    let session: XRSession | null = null;
    try {
      session = await requestSession(xr, next === 'ar' ? 'immersive-ar' : 'immersive-vr');
    } catch (err) {
      console.error(err);
      setError({ message: 'The headset refused to start the session.', detail: describeError(err) });
      return;
    }

    try {
      // Prefer a floor-level space; without one, the origin is at head height.
      const floorLevel = await session
        .requestReferenceSpace('local-floor')
        .then(() => true)
        .catch(() => false);
      session.addEventListener('end', () => setMode(null));
      renderer.xr.setReferenceSpaceType(floorLevel ? 'local-floor' : 'local');
      setFloorY(floorLevel ? 0 : -STANDING_EYE_HEIGHT);
      setMode(next);
      await renderer.xr.setSession(session);
    } catch (err) {
      console.error(err);
      setMode(null);
      void session.end().catch(() => {});
      setError({
        message: 'The session started but the page couldn’t draw into the headset.',
        detail: describeError(err),
      });
    }
  };

  const exitSession = () => {
    void rendererRef.current?.xr.getSession()?.end();
  };

  const supported = support && (support.ar || support.vr);

  return (
    <div className="xr-root">
      <div className="xr-canvas">
        <XRScene mode={mode} floorY={floorY} rendererRef={rendererRef} onHandStatus={setHandStatus} />
      </div>

      <div className="panel xr-card">
        <h1>Meta Quest</h1>

        {mode ? (
          <>
            <p>
              You’re in {mode === 'ar' ? 'mixed reality' : 'VR'}. Put the controllers down and hold up
              your open palm in front of you.
            </p>
            <span className={`pill pill--${handStatus}`} role="status">
              <span className="pill-dot" aria-hidden />
              {STATUS_LABEL[handStatus]}
            </span>
            <button type="button" className="button button--primary" onClick={exitSession}>
              Exit headset
            </button>
          </>
        ) : support === null ? (
          <p>Checking for a headset…</p>
        ) : supported ? (
          <>
            <p>
              Put on your headset, then start. The wound follows your palm using the headset’s own
              hand tracking — no webcam needed.
            </p>
            <div className="xr-actions">
              {support.ar && (
                <button type="button" className="button button--primary" onClick={() => enter('ar')}>
                  Enter mixed reality
                </button>
              )}
              {support.vr && (
                <button
                  type="button"
                  className={support.ar ? 'panel button' : 'button button--primary'}
                  onClick={() => enter('vr')}
                >
                  Enter VR
                </button>
              )}
            </div>
            {!support.ar && (
              <p className="xr-note">
                Over Quest Link you’ll see virtual hands in a VR room. For passthrough (your real
                hands), open this page in the Quest’s own browser.
              </p>
            )}
          </>
        ) : (
          <>
            <p>No headset found. To use a Meta Quest 3 over a USB cable:</p>
            <ol className="xr-steps">
              <li>Install the Meta Quest Link app on this Windows laptop and connect the headset with the USB cable.</li>
              <li>In the Link app, open Settings → General and make Meta Quest Link the active OpenXR runtime.</li>
              <li>In the headset, turn on hand tracking and start Quest Link.</li>
              <li>Open this page in Chrome or Edge on the laptop and reload it.</li>
            </ol>
            <p className="xr-note">
              Or skip the cable: open <strong>{window.location.href}</strong> in the Quest’s own browser for
              mixed reality with your real hands.
            </p>
          </>
        )}

        {error && (
          <div className="xr-error" role="alert">
            <p className="intro-error">
              {error.message}
              <span className="xr-error-detail">{error.detail}</span>
            </p>
            <p>Things to check, then press Enter VR again:</p>
            <ol className="xr-steps">
              <li>
                The headset is <strong>inside Quest Link</strong> (you see the Link home screen in it),
                not just plugged in.
              </li>
              <li>
                Laptops with two graphics chips: Windows Settings → System → Display → Graphics → add
                Chrome/Edge and choose <strong>High performance</strong>, then restart the browser.
              </li>
              <li>
                In the Meta Quest Link app, Settings → General → OpenXR runtime is set to
                <strong> Meta Quest Link</strong>, and SteamVR or other VR apps are closed.
              </li>
              <li>
                Still stuck? Open <strong>{window.location.href}</strong> in the Quest’s own browser —
                no cable needed.
              </li>
            </ol>
          </div>
        )}

        {!mode && (
          <button type="button" className="button button--quiet xr-back" onClick={onExit}>
            Back
          </button>
        )}
      </div>
    </div>
  );
}
