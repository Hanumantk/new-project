/**
 * Headset-mode wound settings, chosen on the in-headset panel and kept in
 * localStorage. Read every frame (no React state), so a change applies on the
 * next frame.
 */

export type HandSide = 'left' | 'right';

export interface XRPrefs {
  /** The only hand the wound goes on (never switches by itself). */
  hand: HandSide;
  /** Skin tone preset (index into SKIN_PRESETS)… */
  skinPreset: number;
  /** …and a fine adjustment, 0..1 (0.5 = the preset as is). */
  skinFine: number;
}

const STORAGE_KEY = 'palm-injury.xr-prefs';

/** Skin tones from light to deep (sRGB). */
export const SKIN_PRESETS = ['#f1d3c2', '#e3b597', '#cf9a78', '#b07a57', '#8a5a3c', '#5e3b27'] as const;

function load(): XRPrefs {
  const defaults: XRPrefs = { hand: 'left', skinPreset: 2, skinFine: 0.5 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<XRPrefs> | null;
    if (!saved) return defaults;
    return {
      hand: saved.hand === 'right' ? 'right' : 'left',
      skinPreset:
        Number.isInteger(saved.skinPreset) && saved.skinPreset! >= 0 && saved.skinPreset! < SKIN_PRESETS.length
          ? saved.skinPreset!
          : defaults.skinPreset,
      skinFine: typeof saved.skinFine === 'number' ? Math.min(Math.max(saved.skinFine, 0), 1) : defaults.skinFine,
    };
  } catch {
    return defaults;
  }
}

/** Current settings; `version` bumps on every change, `reattach` on every Re-attach press. */
export const xrPrefs: XRPrefs & { version: number; reattach: number } = { ...load(), version: 0, reattach: 0 };

export function setXRPrefs(patch: Partial<XRPrefs>) {
  Object.assign(xrPrefs, patch);
  xrPrefs.version++;
  try {
    const { hand, skinPreset, skinFine } = xrPrefs;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ hand, skinPreset, skinFine }));
  } catch {
    // Storage unavailable: the settings last for this visit.
  }
}

export function requestReattach() {
  xrPrefs.reattach++;
}
