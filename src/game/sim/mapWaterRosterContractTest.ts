// "Is there water on this map?" and what follows from the answer.
//
// Pins three things that must never drift apart:
//   1. The water question itself — the two authored facts it reads and the
//      answer it gives for every authored preset.
//   2. That the water-only sets stay DERIVED. The expectations here are written
//      as blueprint PROPERTIES ("no waypoint domain outside water", "no ground
//      placement set"), then compared against the classifier, so a hand-written
//      id list can never quietly replace the derivation.
//   3. That the roster surfaces narrow through that classification: a factory
//      offers no water-only hull and a builder offers no water-only structure
//      on a map with no water, and both come back when the water does.

import { getUnitLocomotion } from './blueprints';
import { UNIT_BLUEPRINTS } from './blueprints/units';
import { BUILDING_BLUEPRINTS } from './blueprints/buildings';
import {
  isWaterOnlyBuildingBlueprintId,
  isWaterOnlyUnitBlueprintId,
} from './blueprints/waterOnlyRoster';
import { getBuildingPlacementSetSquareType } from '../../types/buildingTypes';
import { getStructureFactoryAllowedUnitBlueprintIds } from './factoryProductionRoster';
import {
  getUnitAuthoredBuildBlueprintIds,
  getUnitBuilderAllowedBuildBlueprintIds,
} from './hostCapabilities';
import { mapHasWater, mapHasWaterForSetup } from './mapWater';
import { applyTerrainRuntimeConfig } from './terrain/terrainConfig';
import { getTerrainRuntimeConfig } from './terrain/terrainState';
import { getLiquidSurfaceMode, setLiquidSurfaceMode } from './worldSurfaceState';
import { BATTLE_PRESETS } from '../../components/battlePresets';
import type { LiquidSurfaceMode } from '../../types/worldSurfaceMode';
import type { UnitBlueprint } from './blueprints/types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[map water roster] ${message}`);
}

/** Install a map setup, run `body`, and always put the previous one back —
 *  these are process-wide module singletons shared with every other test.
 *
 *  Writes the magnitudes through `applyTerrainRuntimeConfig`, NOT through
 *  terrainState's setter: the setter also invalidates the baked terrain and
 *  drops the WASM mesh, which would pull the ground out from under the demo
 *  battle this page is running. Only the magnitude bindings the water question
 *  reads are moved, and only for the duration of `body`. */
function withMapSetup(
  magnitudes: {
    centerMagnitude: number;
    ringMagnitude: number;
    dividersMagnitude: number;
    perimeterMagnitude: number;
  },
  liquidSurfaceMode: LiquidSurfaceMode,
  body: () => void,
): void {
  const previousTerrain = getTerrainRuntimeConfig();
  const previousLiquid = getLiquidSurfaceMode();
  try {
    applyTerrainRuntimeConfig({ ...previousTerrain, ...magnitudes });
    setLiquidSurfaceMode(liquidSurfaceMode);
    body();
  } finally {
    applyTerrainRuntimeConfig(previousTerrain);
    setLiquidSurfaceMode(previousLiquid);
  }
}

const DRY_MAGNITUDES = {
  centerMagnitude: 0,
  ringMagnitude: 0,
  dividersMagnitude: 0,
  perimeterMagnitude: 0,
};
const WET_MAGNITUDES = {
  centerMagnitude: 0,
  ringMagnitude: 0,
  dividersMagnitude: 0,
  perimeterMagnitude: -400,
};

function assertWaterQuestion(): void {
  // A map is wet only when something digs below datum AND the liquid is water.
  // Both halves are load-bearing, so both are pinned in isolation.
  assertContract(
    !mapHasWaterForSetup({ ...DRY_MAGNITUDES, liquidSurfaceMode: 'water' }),
    'a map whose every magnitude sits at or above datum must have no water',
  );
  assertContract(
    !mapHasWaterForSetup({ ...WET_MAGNITUDES, liquidSurfaceMode: 'lava' }),
    'molten rock filling an excavated basin must not count as water',
  );
  assertContract(
    mapHasWaterForSetup({ ...WET_MAGNITUDES, liquidSurfaceMode: 'water' }),
    'one negative magnitude under a water liquid must be enough for water',
  );
  // Each of the four magnitudes is a real map-shaping altitude, so any one of
  // them going negative excavates on its own.
  const magnitudeKeys = [
    'centerMagnitude',
    'ringMagnitude',
    'dividersMagnitude',
    'perimeterMagnitude',
  ] as const;
  for (const key of magnitudeKeys) {
    assertContract(
      mapHasWaterForSetup({
        ...DRY_MAGNITUDES,
        [key]: -200,
        liquidSurfaceMode: 'water',
      }),
      `a negative ${key} alone must excavate a sea`,
    );
  }

  // Every authored preset gets the same answer from the installed-map form as
  // from the explicit-setup form. Two entry points, one rule.
  for (const preset of BATTLE_PRESETS) {
    const expected = mapHasWaterForSetup(preset);
    withMapSetup(preset, preset.liquidSurfaceMode, () => {
      assertContract(
        mapHasWater() === expected,
        `preset ${preset.name}: installed-map and explicit-setup water answers must agree`,
      );
    });
  }
}

function assertWaterOnlyClassificationIsDerived(): void {
  for (const blueprint of Object.values(UNIT_BLUEPRINTS)) {
    const waypoint = getUnitLocomotion(blueprint.unitBlueprintId).navigation.waypoint;
    // Restated from the locomotion model, not from a list of names: a hull is
    // water-only exactly when water is the ONLY medium a player may send it to.
    const expected = waypoint.allowInWater && !waypoint.allowOnGround && !waypoint.allowInAir;
    assertContract(
      isWaterOnlyUnitBlueprintId(blueprint.unitBlueprintId) === expected,
      `${blueprint.unitBlueprintId} water-only classification must follow its waypoint domain`,
    );
  }
  for (const blueprint of Object.values(BUILDING_BLUEPRINTS)) {
    const expected = !blueprint.placementSets.some(
      (placementSet) => getBuildingPlacementSetSquareType(placementSet) === 'ground',
    );
    assertContract(
      isWaterOnlyBuildingBlueprintId(blueprint.buildingBlueprintId) === expected,
      `${blueprint.buildingBlueprintId} water-only classification must follow its placement sets`,
    );
  }

  // The emergency water drive every unit authors, so a body shoved into a lake
  // can swim out, must never read as aquatic intent.
  assertContract(
    !isWaterOnlyUnitBlueprintId('unitLynx'),
    'a tank must not be classified water-only by its recovery water drive',
  );
  // A hull that can be ordered somewhere else keeps its place on a dry map.
  assertContract(
    !isWaterOnlyUnitBlueprintId('unitSeaTurtle') && !isWaterOnlyUnitBlueprintId('unitHippo'),
    'amphibious hulls must survive a map with no water',
  );
  assertContract(
    !isWaterOnlyUnitBlueprintId('unitDuck'),
    'an aerosub must survive a map with no water — it still flies',
  );
  assertContract(
    isWaterOnlyUnitBlueprintId('unitOrca') && isWaterOnlyUnitBlueprintId('unitConstructionSubmarine'),
    'submarines must be classified water-only',
  );
  // Dual-domain structures author a ground set; the sea-only three do not.
  assertContract(
    !isWaterOnlyBuildingBlueprintId('buildingExtractor') &&
      !isWaterOnlyBuildingBlueprintId('towerFabricator'),
    'structures with a ground placement set must survive a map with no water',
  );
  assertContract(
    isWaterOnlyBuildingBlueprintId('buildingSonar') &&
      isWaterOnlyBuildingBlueprintId('buildingSonarJammer') &&
      isWaterOnlyBuildingBlueprintId('towerTorpedo'),
    'sea-only structures must be classified water-only',
  );
}

/** Every unit that authors a build roster, so no builder can be added later and
 *  quietly keep offering a structure the map cannot host. Selected by the
 *  AUTHORED roster, which does not move with the map — the narrowed one could
 *  empty a builder out of this list exactly when it most needs checking. */
function builderBlueprints(): readonly UnitBlueprint[] {
  return Object.values(UNIT_BLUEPRINTS).filter(
    (blueprint) => getUnitAuthoredBuildBlueprintIds(blueprint).length > 0,
  );
}

function assertRostersNarrowWithTheMap(): void {
  withMapSetup(WET_MAGNITUDES, 'water', () => {
    const builders = builderBlueprints();
    assertContract(builders.length > 0, 'the roster must contain at least one builder');
    const factoryRoster = getStructureFactoryAllowedUnitBlueprintIds('towerFabricator');
    assertContract(
      factoryRoster.includes('unitOrca') && factoryRoster.includes('unitConstructionSubmarine'),
      'a map with water must offer its submarines',
    );
    // The authored rosters must actually exercise the narrowing, or the dry
    // pass below would pass vacuously.
    const offersWaterOnly = builders.some((blueprint) =>
      getUnitBuilderAllowedBuildBlueprintIds(blueprint).some(isWaterOnlyBuildingBlueprintId));
    assertContract(
      offersWaterOnly,
      'a map with water must offer sea-only structures through at least one builder',
    );
  });

  withMapSetup(DRY_MAGNITUDES, 'water', () => {
    const factoryRoster = getStructureFactoryAllowedUnitBlueprintIds('towerFabricator');
    for (const unitBlueprintId of factoryRoster) {
      assertContract(
        !isWaterOnlyUnitBlueprintId(unitBlueprintId),
        `a map with no water must not offer ${unitBlueprintId}`,
      );
    }
    assertContract(
      factoryRoster.includes('unitSeaTurtle') && factoryRoster.includes('unitDuck'),
      'a map with no water must keep every hull that still has somewhere to be',
    );
    for (const blueprint of builderBlueprints()) {
      const builderRoster = getUnitBuilderAllowedBuildBlueprintIds(blueprint);
      for (const buildingBlueprintId of builderRoster) {
        assertContract(
          !isWaterOnlyBuildingBlueprintId(buildingBlueprintId),
          `a map with no water must not let ${blueprint.unitBlueprintId} build ${buildingBlueprintId}`,
        );
      }
    }
    const commanderRoster = getUnitBuilderAllowedBuildBlueprintIds(UNIT_BLUEPRINTS['unitCommander']);
    assertContract(
      commanderRoster.includes('buildingExtractor'),
      'a map with no water must keep every structure that still has a square',
    );
  });

  // Same narrowing when the basin is there but the liquid burns.
  withMapSetup(WET_MAGNITUDES, 'lava', () => {
    const factoryRoster = getStructureFactoryAllowedUnitBlueprintIds('towerFabricator');
    assertContract(
      !factoryRoster.includes('unitOrca'),
      'a lava map must not offer submarines despite its excavated basins',
    );
  });
}

export function runMapWaterRosterContractTest(): void {
  assertWaterQuestion();
  assertWaterOnlyClassificationIsDerived();
  assertRostersNarrowWithTheMap();
}
