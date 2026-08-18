// Demo BUILDINGS roster contract.
//
// The demo battle spawns the buildings in this roster and nothing else, so a
// building missing from a profile's stored roster is a building that never
// appears in the demo. The current ledger records which blueprints a current
// roster has seen, so newly authored blueprints can default on without decoding
// or guessing any obsolete storage shape.

import {
  adoptNewDemoBlueprints,
  getDefaultDemoUnits,
  getDefaultDemoBuildings,
  loadBattleBuildingRoster,
  loadBattleUnitRoster,
  migrateDemoUnitsToAllEnabledDefault,
  resetRealBattleSettings,
  saveBattleBuildingRoster,
  saveBattleUnitRoster,
} from './battleBarConfig';
import battleBarConfig from './battleBarConfig.json';
import { BUILDING_BLUEPRINT_IDS } from './types/blueprintIds';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './game/sim/blueprints/unitRoster';
import { BATTLE_PRESETS } from './components/battlePresets';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[demo building roster contract] ${message}`);
}

const ROSTER_KEY = battleBarConfig.storageKeys.demoBuildings;
const LEDGER_KEY = battleBarConfig.storageKeys.demoBuildingsKnownIds;
const UNIT_ROSTER_KEY = battleBarConfig.storageKeys.demoUnits;
const UNIT_LEDGER_KEY = battleBarConfig.storageKeys.demoUnitsKnownIds;
const UNIT_ALL_ENABLED_REVISION_KEY =
  battleBarConfig.storageKeys.demoUnitsAllEnabledRevision;

function readIds(key: string): string[] | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  return JSON.parse(raw) as string[];
}

export function runDemoBuildingRosterContractTest(): void {
  // Map presets describe maps/gameplay, never content availability. This is a
  // runtime assertion as well as a type-level rule so plain JSON/object spread
  // cannot silently reintroduce mode-dependent rosters.
  for (const preset of BATTLE_PRESETS) {
    assertContract(
      !Object.prototype.hasOwnProperty.call(preset, 'units') &&
        !Object.prototype.hasOwnProperty.call(preset, 'buildings'),
      `${preset.name} must not define unit or building roster fields`,
    );
  }

  // A profile with no stored roster falls back to the defaults, so those must
  // cover the whole roster or a fresh install is missing buildings outright.
  const defaults = new Set(getDefaultDemoBuildings());
  const missingDefaults = BUILDING_BLUEPRINT_IDS.filter((id) => !defaults.has(id));
  assertContract(
    missingDefaults.length === 0,
    `every building blueprint must default ON in the demo roster; missing ${missingDefaults.join(', ')}`,
  );
  const defaultUnits = new Set(getDefaultDemoUnits());
  const missingDefaultUnits = BUILDABLE_UNIT_BLUEPRINT_IDS.filter(
    (id) => !defaultUnits.has(id),
  );
  assertContract(
    missingDefaultUnits.length === 0,
    `every buildable unit must default ON in the demo roster; missing ${missingDefaultUnits.join(', ')}`,
  );

  const savedAllEnabledRoster = window.localStorage.getItem(UNIT_ROSTER_KEY);
  const savedAllEnabledRevision = window.localStorage.getItem(
    UNIT_ALL_ENABLED_REVISION_KEY,
  );
  try {
    const unrelatedOptOut = BUILDABLE_UNIT_BLUEPRINT_IDS[0];
    const legacyRoster = BUILDABLE_UNIT_BLUEPRINT_IDS.filter(
      (id) => id !== 'unitQueenBee' && id !== 'unitQueenTick' && id !== unrelatedOptOut,
    );
    window.localStorage.setItem(UNIT_ROSTER_KEY, JSON.stringify(legacyRoster));
    window.localStorage.removeItem(UNIT_ALL_ENABLED_REVISION_KEY);
    migrateDemoUnitsToAllEnabledDefault();
    const migrated = new Set(readIds(UNIT_ROSTER_KEY) ?? []);
    assertContract(
      migrated.has('unitQueenBee') && migrated.has('unitQueenTick'),
      'profiles saved under the old default-disabled Queen policy must adopt both Queens',
    );
    assertContract(
      !migrated.has(unrelatedOptOut),
      `the all-enabled policy migration must preserve unrelated opt-out ${unrelatedOptOut}`,
    );
  } finally {
    if (savedAllEnabledRoster === null) window.localStorage.removeItem(UNIT_ROSTER_KEY);
    else window.localStorage.setItem(UNIT_ROSTER_KEY, savedAllEnabledRoster);
    if (savedAllEnabledRevision === null) {
      window.localStorage.removeItem(UNIT_ALL_ENABLED_REVISION_KEY);
    } else {
      window.localStorage.setItem(
        UNIT_ALL_ENABLED_REVISION_KEY,
        savedAllEnabledRevision,
      );
    }
  }

  // Lobby/Real rosters are all-enabled after each session reset and remain
  // in memory only. In particular, changing the lobby must not overwrite the
  // user's persistent Demo sandbox selection.
  const savedDemoUnitRoster = window.localStorage.getItem(UNIT_ROSTER_KEY);
  const savedDemoBuildingRoster = window.localStorage.getItem(ROSTER_KEY);
  try {
    window.localStorage.setItem(UNIT_ROSTER_KEY, JSON.stringify([BUILDABLE_UNIT_BLUEPRINT_IDS[0]]));
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify([BUILDING_BLUEPRINT_IDS[0]]));
    resetRealBattleSettings();
    assertContract(
      loadBattleUnitRoster('real').length === BUILDABLE_UNIT_BLUEPRINT_IDS.length,
      'a fresh Lobby/Real session must enable every buildable unit',
    );
    assertContract(
      loadBattleBuildingRoster('real').length === BUILDING_BLUEPRINT_IDS.length,
      'a fresh Lobby/Real session must enable every building',
    );
    saveBattleUnitRoster([BUILDABLE_UNIT_BLUEPRINT_IDS[1]], 'real');
    saveBattleBuildingRoster([BUILDING_BLUEPRINT_IDS[1]], 'real');
    assertContract(
      loadBattleUnitRoster('real').join(',') === BUILDABLE_UNIT_BLUEPRINT_IDS[1] &&
        loadBattleBuildingRoster('real').join(',') === BUILDING_BLUEPRINT_IDS[1],
      'Lobby/Real roster changes must survive for the current in-memory session',
    );
    assertContract(
      window.localStorage.getItem(UNIT_ROSTER_KEY) ===
        JSON.stringify([BUILDABLE_UNIT_BLUEPRINT_IDS[0]]) &&
        window.localStorage.getItem(ROSTER_KEY) ===
        JSON.stringify([BUILDING_BLUEPRINT_IDS[0]]),
      'Lobby/Real roster changes must never write the Demo localStorage keys',
    );
    resetRealBattleSettings();
    assertContract(
      loadBattleUnitRoster('real').length === BUILDABLE_UNIT_BLUEPRINT_IDS.length &&
        loadBattleBuildingRoster('real').length === BUILDING_BLUEPRINT_IDS.length,
      'the next Lobby/Real session must return both rosters to all-enabled',
    );
  } finally {
    resetRealBattleSettings();
    if (savedDemoUnitRoster === null) window.localStorage.removeItem(UNIT_ROSTER_KEY);
    else window.localStorage.setItem(UNIT_ROSTER_KEY, savedDemoUnitRoster);
    if (savedDemoBuildingRoster === null) window.localStorage.removeItem(ROSTER_KEY);
    else window.localStorage.setItem(ROSTER_KEY, savedDemoBuildingRoster);
  }

  const savedRoster = window.localStorage.getItem(ROSTER_KEY);
  const savedLedger = window.localStorage.getItem(LEDGER_KEY);
  try {
    // A blueprint the ledger has never seen is new. One the user removed while
    // it WAS in the ledger is a deliberate opt-out and must stay off.
    const introduced = BUILDING_BLUEPRINT_IDS[BUILDING_BLUEPRINT_IDS.length - 1];
    const optedOut = BUILDING_BLUEPRINT_IDS[0];
    assertContract(
      introduced !== optedOut,
      'this contract needs at least two building blueprints to be meaningful',
    );
    const ledger = BUILDING_BLUEPRINT_IDS.filter((id) => id !== introduced);
    const roster = ledger.filter((id) => id !== optedOut);
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));

    adoptNewDemoBlueprints();
    const adopted = new Set(readIds(ROSTER_KEY) ?? []);
    assertContract(
      adopted.has(introduced),
      `${introduced} was introduced after this roster was saved and must default ON`,
    );
    assertContract(
      !adopted.has(optedOut),
      `${optedOut} was opted out while the ledger already knew it and must stay off`,
    );
    const rewrittenLedger = new Set(readIds(LEDGER_KEY) ?? []);
    assertContract(
      BUILDING_BLUEPRINT_IDS.every((id) => rewrittenLedger.has(id)),
      'adoption must rewrite the ledger to the full current blueprint list',
    );

    // Idempotent: a second pass with nothing new must not resurrect the opt-out.
    adoptNewDemoBlueprints();
    const secondPass = new Set(readIds(ROSTER_KEY) ?? []);
    assertContract(
      secondPass.has(introduced) && !secondPass.has(optedOut),
      'a second adoption pass with no new blueprints must change nothing',
    );

    // No ledger is not interpreted as an earlier schema. Seed the current
    // ledger and leave the unversioned roster untouched.
    window.localStorage.removeItem(LEDGER_KEY);
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
    adoptNewDemoBlueprints();
    const seeded = new Set(readIds(ROSTER_KEY) ?? []);
    assertContract(
      seeded.size === roster.length && roster.every((id) => seeded.has(id)),
      'an absent current ledger must not trigger an inferred roster migration',
    );
    assertContract(
      !seeded.has(optedOut),
      `the existing opt-out ${optedOut} must survive current-ledger seeding`,
    );
    assertContract(
      readIds(LEDGER_KEY) !== null,
      'an absent ledger must be seeded so the NEXT new blueprint is detectable',
    );

    // The UNITS roster runs the same mechanism. It used to carry a hardcoded
    // `unitOrca` push inside the same revision-gated block, so the next unit
    // added would have gone missing exactly the way the buildings did.
    const savedUnitRoster = window.localStorage.getItem(UNIT_ROSTER_KEY);
    const savedUnitLedger = window.localStorage.getItem(UNIT_LEDGER_KEY);
    try {
      const newUnit = BUILDABLE_UNIT_BLUEPRINT_IDS[BUILDABLE_UNIT_BLUEPRINT_IDS.length - 1];
      const droppedUnit = BUILDABLE_UNIT_BLUEPRINT_IDS[0];
      const unitLedger = BUILDABLE_UNIT_BLUEPRINT_IDS.filter((id: string) => id !== newUnit);
      window.localStorage.setItem(UNIT_LEDGER_KEY, JSON.stringify(unitLedger));
      window.localStorage.setItem(
        UNIT_ROSTER_KEY,
        JSON.stringify(unitLedger.filter((id: string) => id !== droppedUnit)),
      );
      adoptNewDemoBlueprints();
      const units = new Set(readIds(UNIT_ROSTER_KEY) ?? []);
      assertContract(
        units.has(newUnit) && !units.has(droppedUnit),
        `${newUnit} must be adopted into the units roster while the opted-out `
          + `${droppedUnit} stays off`,
      );
    } finally {
      if (savedUnitRoster === null) window.localStorage.removeItem(UNIT_ROSTER_KEY);
      else window.localStorage.setItem(UNIT_ROSTER_KEY, savedUnitRoster);
      if (savedUnitLedger === null) window.localStorage.removeItem(UNIT_LEDGER_KEY);
      else window.localStorage.setItem(UNIT_LEDGER_KEY, savedUnitLedger);
    }
  } finally {
    if (savedRoster === null) window.localStorage.removeItem(ROSTER_KEY);
    else window.localStorage.setItem(ROSTER_KEY, savedRoster);
    if (savedLedger === null) window.localStorage.removeItem(LEDGER_KEY);
    else window.localStorage.setItem(LEDGER_KEY, savedLedger);
  }
}
