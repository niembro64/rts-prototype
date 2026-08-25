/**
 * Tiny wrappers around localStorage that swallow errors (private
 * browsing / disabled storage) so no caller needs a try/catch. Every
 * bar-config helper that persists a setting should call through these.
 *
 * Intentionally minimal — no JSON auto-parsing or namespacing. Each call site
 * owns its key and value shape; this module only centralizes exception handling
 * and the one shared rule that a missing authored default is written once.
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

/** Return an existing value, or materialize the caller's authored default.
 * This keeps first-run state and reset state observable through the same
 * localStorage contract instead of leaving an implicit in-memory fallback. */
export function readPersistedOrSetDefault(key: string, defaultValue: string): string {
  const stored = readPersisted(key);
  if (stored !== null) return stored;
  persist(key, defaultValue);
  return defaultValue;
}
