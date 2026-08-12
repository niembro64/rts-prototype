/**
 * Persist and install one WORLD material selection.
 *
 * `storedMode` is deliberately the source for change detection. A local
 * GameConnection applies commands synchronously, so the process-wide runtime
 * mode can already equal `nextMode` by the time the UI reaches this helper.
 * Comparing the runtime value would then suppress the required whole-battle
 * rebuild even though the persisted battle configuration really changed.
 */
export function applyWorldSurfaceSelection<T extends string>({
  storedMode,
  nextMode,
  persist,
  installRuntime,
  onChanged,
}: {
  readonly storedMode: T;
  readonly nextMode: T;
  readonly persist: (mode: T) => void;
  readonly installRuntime: (mode: T) => void;
  readonly onChanged: () => void;
}): boolean {
  const changed = storedMode !== nextMode;
  persist(nextMode);
  installRuntime(nextMode);
  if (!changed) return false;
  onChanged();
  return true;
}
