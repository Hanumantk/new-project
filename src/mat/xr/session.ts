/** What the Material Mat asks the headset for. */
export const MAT_SESSION_INIT: XRSessionInit = {
  requiredFeatures: ['local-floor', 'hand-tracking'],
  optionalFeatures: ['plane-detection', 'anchors', 'hit-test'],
};

export type ARSupport = 'checking' | 'supported' | 'no-ar' | 'no-webxr' | 'insecure';

/** Whether this browser can run a passthrough AR session. */
export async function checkARSupport(): Promise<Exclude<ARSupport, 'checking'>> {
  if (!window.isSecureContext) return 'insecure';
  const xr = navigator.xr;
  if (!xr) return 'no-webxr';
  try {
    return (await xr.isSessionSupported('immersive-ar')) ? 'supported' : 'no-ar';
  } catch {
    return 'no-ar';
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error || err instanceof DOMException) {
    return err.message ? `${err.name}: ${err.message}` : err.name;
  }
  return String(err);
}
