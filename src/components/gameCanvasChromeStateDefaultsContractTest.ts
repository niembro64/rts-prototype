import { effectScope, nextTick, ref } from 'vue';
import type { BattleMode } from '../battleBarConfig';
import {
  PLAYER_CLIENT_ENABLED_DEFAULT,
  useGameCanvasChromeState,
} from './gameCanvasChromeState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[chrome defaults contract] ${message}`);
}

function restoreStorageValue(key: string, value: string | null): void {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}

export async function runGameCanvasChromeStateDefaultsContractTest(): Promise<void> {
  const keys: Record<BattleMode, string> = {
    demo: 'demo-client-game-enabled',
    real: 'real-client-game-enabled',
  };
  const saved = new Map(
    Object.values(keys).map((key) => [key, window.localStorage.getItem(key)]),
  );
  const mode = ref<BattleMode>('demo');
  const seedScope = effectScope();
  const activeScope = effectScope();
  let state!: ReturnType<typeof useGameCanvasChromeState>;
  const playerClientIsEnabled = (): boolean => state.playerClientEnabled.value;

  try {
    window.localStorage.removeItem(keys.demo);
    seedScope.run(() => {
      state = useGameCanvasChromeState(mode, () => {});
    });
    assertContract(
      playerClientIsEnabled() === PLAYER_CLIENT_ENABLED_DEFAULT &&
        window.localStorage.getItem(keys.demo) === String(PLAYER_CLIENT_ENABLED_DEFAULT),
      'a missing CLIENT power selection must materialize its authored default',
    );
    seedScope.stop();

    window.localStorage.setItem(keys.demo, 'false');
    window.localStorage.setItem(keys.real, 'false');
    activeScope.run(() => {
      state = useGameCanvasChromeState(mode, () => {});
    });

    assertContract(
      !playerClientIsEnabled(),
      'the CLIENT power selection must load its per-mode browser value',
    );
    state.resetPlayerClientEnabled();
    assertContract(
      playerClientIsEnabled() === PLAYER_CLIENT_ENABLED_DEFAULT &&
        window.localStorage.getItem(keys.demo) === String(PLAYER_CLIENT_ENABLED_DEFAULT),
      'CLIENT DEFAULTS must select and persist the authored power default',
    );
    await nextTick();

    // Model the failure that a change-only watcher cannot repair: runtime is
    // already default while the browser still holds an older value.
    window.localStorage.setItem(keys.demo, 'false');
    assertContract(
      playerClientIsEnabled() === PLAYER_CLIENT_ENABLED_DEFAULT,
      'the stale-storage fixture must leave the live ref at its default',
    );
    state.resetPlayerClientEnabled();
    assertContract(
      window.localStorage.getItem(keys.demo) === String(PLAYER_CLIENT_ENABLED_DEFAULT),
      'DEFAULTS must overwrite stale storage even without a ref transition',
    );

    mode.value = 'real';
    await nextTick();
    assertContract(
      !playerClientIsEnabled(),
      'mode changes must continue to load an independent CLIENT power selection',
    );
    state.resetPlayerClientEnabled();
    mode.value = 'demo';
    await nextTick();
    assertContract(
      playerClientIsEnabled() === PLAYER_CLIENT_ENABLED_DEFAULT,
      'returning to a mode must reload the default committed by DEFAULTS',
    );
  } finally {
    seedScope.stop();
    activeScope.stop();
    for (const [key, value] of saved) restoreStorageValue(key, value);
  }
}
