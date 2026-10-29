/**
 * The viewer's chosen wound opacity (0..1), remembered per browser. A
 * convenience only: it falls back to 100% whenever storage is unavailable.
 */
const KEY = 'palm-injury:wound-opacity';

export function loadWoundOpacity(): number {
  try {
    const saved = window.localStorage.getItem(KEY);
    const value = saved === null ? NaN : Number(saved);
    if (value >= 0 && value <= 1) return value;
  } catch {
    // storage unavailable (private mode, blocked): use the default
  }
  return 1;
}

export function saveWoundOpacity(value: number) {
  try {
    window.localStorage.setItem(KEY, String(value));
  } catch {
    // not remembered; fine
  }
}
