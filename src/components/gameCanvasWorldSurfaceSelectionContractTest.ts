import { applyWorldSurfaceSelection } from './gameCanvasWorldSurfaceSelection';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[world surface selection contract] ${message}`);
}

export function runGameCanvasWorldSurfaceSelectionContractTest(): void {
  let stored = 'normal';
  // Reproduce the original local-connection race: the synchronous server
  // command has already installed METAL before the UI applies persistence.
  let runtime = 'metal';
  let rebuilds = 0;
  const changed = applyWorldSurfaceSelection({
    storedMode: stored,
    nextMode: 'metal',
    persist: (mode) => { stored = mode; },
    installRuntime: (mode) => { runtime = mode; },
    onChanged: () => { rebuilds++; },
  });
  assertContract(changed, 'persisted NORMAL -> METAL must count as a change');
  assertContract(stored === 'metal' && runtime === 'metal', 'both copies must be METAL');
  assertContract(rebuilds === 1, 'the changed world must rebuild exactly once');

  const unchanged = applyWorldSurfaceSelection({
    storedMode: stored,
    nextMode: 'metal',
    persist: (mode) => { stored = mode; },
    installRuntime: (mode) => { runtime = mode; },
    onChanged: () => { rebuilds++; },
  });
  assertContract(!unchanged, 'selecting the persisted mode again is not a change');
  assertContract(rebuilds === 1, 'an unchanged world must not rebuild');
}
