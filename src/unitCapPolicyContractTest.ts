import {
  BATTLE_CONFIG,
  getModeDefaultEntityCountCap,
  getUnitCap,
  resetRealBattleSettings,
  setUnitCap,
} from './battleBarConfig';
import battleBarConfig from './battleBarConfig.json';
import { BATTLE_PRESETS } from './components/battlePresets';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[entity count cap policy contract] ${message}`);
}

export function runUnitCapPolicyContractTest(): void {
  const demoKey = battleBarConfig.storageKeys.demoCap;
  const retiredRealKey = 'real-battle-cap';
  const savedDemoCap = window.localStorage.getItem(demoKey);
  const savedRetiredRealCap = window.localStorage.getItem(retiredRealKey);

  try {
    window.localStorage.removeItem(demoKey);
    window.localStorage.setItem(retiredRealKey, '1262');
    resetRealBattleSettings();

    assertContract(BATTLE_CONFIG.cap.default === 500, 'boot/demo cap must default to 500');
    assertContract(
      getModeDefaultEntityCountCap('demo') === 500,
      'DEMO BATTLE must default to cap 500',
    );
    assertContract(
      getModeDefaultEntityCountCap('real') === 1000,
      'Lobby/Real must default to cap 1000',
    );
    assertContract(getUnitCap('demo') === 500, 'an unsaved Demo profile must start at 500');
    assertContract(
      getUnitCap('real') === 1000,
      'Real cap must ignore historical browser storage and start at 1000',
    );

    // The cap is a standalone global setting, not a map property: no preset
    // may carry one, so switching maps can never resize the battle.
    for (const preset of BATTLE_PRESETS) {
      assertContract(
        !('cap' in preset),
        `preset ${preset.name} must not carry an entity count cap`,
      );
    }

    // Both mode defaults must be selectable, or the CAP row boots with
    // nothing highlighted.
    const options = new Set(BATTLE_CONFIG.cap.options);
    for (const mode of ['demo', 'real'] as const) {
      const value = getModeDefaultEntityCountCap(mode);
      assertContract(
        options.has(value),
        `${mode} default cap ${value} must be one of the CAP options`,
      );
    }

    setUnitCap('demo', 100);
    setUnitCap('real', 5000);
    assertContract(
      window.localStorage.getItem(demoKey) === '100' && getUnitCap('demo') === 100,
      'Demo cap changes must persist in browser storage',
    );
    assertContract(getUnitCap('real') === 5000, 'a live lobby may change its in-memory cap');
    assertContract(
      window.localStorage.getItem(retiredRealKey) === '1262',
      'Real cap changes must not write browser storage',
    );

    resetRealBattleSettings();
    assertContract(
      getUnitCap('real') === 1000,
      'a new Lobby/Real session must reset the cap to 1000',
    );
  } finally {
    if (savedDemoCap === null) window.localStorage.removeItem(demoKey);
    else window.localStorage.setItem(demoKey, savedDemoCap);
    if (savedRetiredRealCap === null) window.localStorage.removeItem(retiredRealKey);
    else window.localStorage.setItem(retiredRealKey, savedRetiredRealCap);
    resetRealBattleSettings();
  }
}
