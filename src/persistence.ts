/**
 * Tiny wrappers around localStorage that swallow errors (private
 * browsing / disabled storage) so no caller needs a try/catch. Every
 * bar-config helper that persists a setting should call through these.
 *
 * Intentionally minimal — no JSON auto-parsing, no namespacing, no
 * default fallbacks. Each call site already owns its key constant
 * and knows how to parse its own value shape; centralizing only the
 * exception handling eliminates ~30 try/catch blocks without forcing
 * a new abstraction.
 */

/** Write a value to localStorage. Silently no-ops if storage is
 *  unavailable (Safari private mode, quota exceeded, etc.). */
export function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — not fatal */
  }
}

/** Persist an arbitrary JSON-serializable value. */
export function persistJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — not fatal */
  }
}

/** Read a raw string value, returning null if missing or unavailable. */
export function readPersisted(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Migrate a value stored under an old key into a new key. If the
 *  old key has a value AND the new key is empty, copy the value
 *  over, then delete the old key. Idempotent — safe to call on
 *  every module load. Used to evolve the storage namespace (e.g.
 *  the `rts-*` → `player-client-*` / `host-server-*` / `demo-battle-*`
 *  / `real-battle-*` rename) without nuking users' saved settings. */
export function migrateKey(oldKey: string, newKey: string): void {
  try {
    const oldVal = localStorage.getItem(oldKey);
    if (oldVal === null) return;
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, oldVal);
    }
    localStorage.removeItem(oldKey);
  } catch {
    /* storage unavailable — not fatal */
  }
}
