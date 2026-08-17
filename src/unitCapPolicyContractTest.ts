import {
  BATTLE_CONFIG,
  getUnitCap,
  resetRealUnitCap,
  setUnitCap,
} from './battleBarConfig';
import battleBarConfig from './battleBarConfig.json';
import { BATTLE_PRESETS, getModeDefaultPreset } from './components/battlePresets';

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
    resetRealUnitCap();

    assertContract(BATTLE_CONFIG.cap.default === 1000, 'boot/demo cap must default to 1000');
    assertContract(
      getModeDefaultPreset('demo').cap === 1000,
      'DEMO BATTLE defaults must resolve to cap 1000',
    );
    assertContract(
      getModeDefaultPreset('real').cap === 1000,
      'Lobby/Real defaults must resolve to cap 1000',
    );
    assertContract(getUnitCap('demo') === 1000, 'an unsaved Demo profile must start at 1000');
    assertContract(
      getUnitCap('real') === 1000,
      'Real cap must ignore historical browser storage and start at 1000',
    );

    // Every authored preset cap must be selectable, or applying a preset
    // leaves the CAP row with nothing highlighted and the map caption
    // stuck on CUSTOM.
    const options = new Set(BATTLE_CONFIG.cap.options);
    for (const preset of BATTLE_PRESETS) {
      assertContract(
        options.has(preset.cap),
        `preset ${preset.name} cap ${preset.cap} must be one of the CAP options`,
      );
    }

    setUnitCap('demo', 50);
    setUnitCap('real', 5000);
    assertContract(
      window.localStorage.getItem(demoKey) === '50' && getUnitCap('demo') === 50,
      'Demo cap changes must persist in browser storage',
    );
    assertContract(getUnitCap('real') === 5000, 'a live lobby may change its in-memory cap');
    assertContract(
      window.localStorage.getItem(retiredRealKey) === '1262',
      'Real cap changes must not write browser storage',
    );

    resetRealUnitCap();
    assertContract(
      getUnitCap('real') === 1000,
      'a new Lobby/Real session must reset the cap to 1000',
    );
  } finally {
    if (savedDemoCap === null) window.localStorage.removeItem(demoKey);
    else window.localStorage.setItem(demoKey, savedDemoCap);
    if (savedRetiredRealCap === null) window.localStorage.removeItem(retiredRealKey);
    else window.localStorage.setItem(retiredRealKey, savedRetiredRealCap);
    resetRealUnitCap();
  }
}
