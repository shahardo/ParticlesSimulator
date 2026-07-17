const USE_GPU_KEY = 'particles-simulator:useGpu';

/** The user's last explicit "Use GPU" choice, persisted across sessions --
 * `null` means no choice has ever been made (first-ever run), distinct from
 * an explicit `false`, so main.ts can tell "never asked" apart from "asked
 * to stay on CPU" and only auto-detect a default in the former case. */
export function loadUseGpuPreference(): boolean | null {
  const stored = localStorage.getItem(USE_GPU_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return null;
}

/** Persists an *explicit user action* (the panel checkbox) -- not called
 * for automatic fallbacks (e.g. GPU requested but unavailable this
 * session), so a temporary hardware/driver hiccup doesn't overwrite a
 * preference that was fine on the machine that set it. */
export function saveUseGpuPreference(useGpu: boolean): void {
  localStorage.setItem(USE_GPU_KEY, String(useGpu));
}
