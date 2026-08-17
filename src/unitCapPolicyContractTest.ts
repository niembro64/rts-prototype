import {
  BATTLE_CONFIG,
  getUnitCap,
  resetRealUnitCap,
  setUnitCap,
} from './battleBarConfig';
import battleBarConfig from './battleBarConfig.json';
import { getModeDefaultPreset } from './components/battlePresets';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[unit cap policy contract] ${message}`);
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

    assertContract(BATTLE_CONFIG.cap.default === 9, 'boot/demo cap must default to 9');
    assertContract(
      getModeDefaultPreset('demo').cap === 9,
      'DEMO BATTLE defaults must resolve to cap 9',
    );
    assertContract(
      getModeDefaultPreset('real').cap === 243,
      'Lobby/Real defaults must resolve to cap 243',
    );
    assertContract(getUnitCap('demo') === 9, 'an unsaved Demo profile must start at 9');
    assertContract(
      getUnitCap('real') === 243,
      'Real cap must ignore historical browser storage and start at 243',
    );

    setUnitCap('demo', 81);
    setUnitCap('real', 729);
    assertContract(
      window.localStorage.getItem(demoKey) === '81' && getUnitCap('demo') === 81,
      'Demo cap changes must persist in browser storage',
    );
    assertContract(getUnitCap('real') === 729, 'a live lobby may change its in-memory cap');
    assertContract(
      window.localStorage.getItem(retiredRealKey) === '1262',
      'Real cap changes must not write browser storage',
    );

    resetRealUnitCap();
    assertContract(
      getUnitCap('real') === 243,
      'a new Lobby/Real session must reset the cap to 243',
    );
  } finally {
    if (savedDemoCap === null) window.localStorage.removeItem(demoKey);
    else window.localStorage.setItem(demoKey, savedDemoCap);
    if (savedRetiredRealCap === null) window.localStorage.removeItem(retiredRealKey);
    else window.localStorage.setItem(retiredRealKey, savedRetiredRealCap);
    resetRealUnitCap();
  }
}
