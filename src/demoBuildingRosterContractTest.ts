// Demo BUILDINGS roster contract.
//
// The demo battle spawns the buildings in this roster and nothing else, so a
// building missing from a profile's stored roster is a building that never
// appears in the demo — which has now happened three times, once per batch of
// tech structures added after the roster feature shipped. The repair used to be
// a hand-written id list inside a revision-gated migration, which does nothing
// at all for a profile already sitting at the current revision. The UNITS
// roster carried the same shape and the same latent bug.
//
// This pins the mechanism that replaces it: the roster is a list of opt-OUTS,
// and a blueprint nobody has ever seen cannot have been opted out of.

import {
  adoptNewDemoBlueprints,
  getDefaultDemoBuildings,
} from './battleBarConfig';
import battleBarConfig from './battleBarConfig.json';
import { BUILDING_BLUEPRINT_IDS } from './types/blueprintIds';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './game/sim/blueprints/unitRoster';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[demo building roster contract] ${message}`);
}

const ROSTER_KEY = battleBarConfig.storageKeys.demoBuildings;
const LEDGER_KEY = battleBarConfig.storageKeys.demoBuildingsKnownIds;
const UNIT_ROSTER_KEY = battleBarConfig.storageKeys.demoUnits;
const UNIT_LEDGER_KEY = battleBarConfig.storageKeys.demoUnitsKnownIds;

function readIds(key: string): string[] | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  return JSON.parse(raw) as string[];
}

export function runDemoBuildingRosterContractTest(): void {
  // A profile with no stored roster falls back to the defaults, so those must
  // cover the whole roster or a fresh install is missing buildings outright.
  const defaults = new Set(getDefaultDemoBuildings());
  const missingDefaults = BUILDING_BLUEPRINT_IDS.filter((id) => !defaults.has(id));
  assertContract(
    missingDefaults.length === 0,
    `every building blueprint must default ON in the demo roster; missing ${missingDefaults.join(', ')}`,
  );

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

    // No ledger yet — a profile that predates the mechanism. It is seeded from
    // the recorded PRE-LEDGER id list, so blueprints added after the ledger
    // shipped are still adopted (this is the case that was leaving the
    // precision lab out of the demo), while an older opt-out stands.
    window.localStorage.removeItem(LEDGER_KEY);
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
    adoptNewDemoBlueprints();
    const seeded = new Set(readIds(ROSTER_KEY) ?? []);
    assertContract(
      seeded.has('buildingPrecisionTargetingTech'),
      'a pre-ledger profile must still adopt blueprints added after the ledger shipped',
    );
    assertContract(
      !seeded.has(optedOut),
      `a pre-ledger profile's existing opt-out ${optedOut} must survive seeding`,
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
