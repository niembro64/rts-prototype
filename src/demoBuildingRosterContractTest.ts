// Demo BUILDINGS roster contract.
//
// The demo battle spawns the buildings in this roster and nothing else, so a
// building missing from a profile's stored roster is a building that never
// appears in the demo — which has now happened three times, once per batch of
// tech structures added after the roster feature shipped. The repair used to be
// a hand-written id list inside a revision-gated migration, which does nothing
// at all for a profile already sitting at the current revision.
//
// This pins the mechanism that replaces it: the roster is a list of opt-OUTS,
// and a blueprint nobody has ever seen cannot have been opted out of.

import {
  adoptNewBuildingBlueprints,
  getDefaultDemoBuildings,
} from './battleBarConfig';
import battleBarConfig from './battleBarConfig.json';
import { BUILDING_BLUEPRINT_IDS } from './types/blueprintIds';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[demo building roster contract] ${message}`);
}

const ROSTER_KEY = battleBarConfig.storageKeys.demoBuildings;
const LEDGER_KEY = battleBarConfig.storageKeys.demoBuildingsKnownIds;

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

    adoptNewBuildingBlueprints();
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
    adoptNewBuildingBlueprints();
    const secondPass = new Set(readIds(ROSTER_KEY) ?? []);
    assertContract(
      secondPass.has(introduced) && !secondPass.has(optedOut),
      'a second adoption pass with no new blueprints must change nothing',
    );

    // No ledger yet: seed it, adopt nothing. The revision-gated migration owns
    // that one reconciliation, and adopting here would undo every opt-out.
    window.localStorage.removeItem(LEDGER_KEY);
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
    adoptNewBuildingBlueprints();
    const seeded = new Set(readIds(ROSTER_KEY) ?? []);
    assertContract(
      !seeded.has(introduced) && !seeded.has(optedOut),
      'seeding an absent ledger must not silently adopt anything into the roster',
    );
    assertContract(
      readIds(LEDGER_KEY) !== null,
      'an absent ledger must be seeded so the NEXT new blueprint is detectable',
    );
  } finally {
    if (savedRoster === null) window.localStorage.removeItem(ROSTER_KEY);
    else window.localStorage.setItem(ROSTER_KEY, savedRoster);
    if (savedLedger === null) window.localStorage.removeItem(LEDGER_KEY);
    else window.localStorage.setItem(LEDGER_KEY, savedLedger);
  }
}
