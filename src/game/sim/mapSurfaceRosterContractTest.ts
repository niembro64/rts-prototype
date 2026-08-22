// "Is there water on this map? Is there land?" and what follows from the
// answers.
//
// Pins three things that must never drift apart:
//   1. The surface questions themselves — the authored facts they read and
//      the answers they give for every authored preset.
//   2. That the single-medium sets stay DERIVED. The expectations here are
//      written as blueprint PROPERTIES ("no waypoint domain outside water",
//      "no ground placement set" — and their land mirrors), then compared
//      against the classifier, so a hand-written id list can never quietly
//      replace the derivation.
//   3. That the roster surfaces narrow through that classification: a factory
//      offers no water-only hull on a dry map and no land-only hull on an
//      all-sea one, builders likewise for structures — and everything comes
//      back when the medium does.

import { getUnitLocomotion } from './blueprints';
import { UNIT_BLUEPRINTS } from './blueprints/units';
import { BUILDING_BLUEPRINTS } from './blueprints/buildings';
import {
  isLandOnlyBuildingBlueprintId,
  isLandOnlyUnitBlueprintId,
  isWaterOnlyBuildingBlueprintId,
  isWaterOnlyUnitBlueprintId,
} from './blueprints/mediumOnlyRoster';
import { getBuildingPlacementSetSquareType } from '../../types/buildingTypes';
import { getStructureFactoryAllowedUnitBlueprintIds } from './factoryProductionRoster';
import {
  getUnitAuthoredBuildBlueprintIds,
  getUnitBuilderAllowedBuildBlueprintIds,
} from './hostCapabilities';
import {
  MEDIUM_KEY_WATER,
  mapHasLand,
  mapHasLandForSetup,
  mapHasWater,
  mapHasWaterForSetup,
} from './mapSurface';
import {
  buildingBlueprintIdsForMediumKey,
  unitBlueprintIdsForMediumKey,
} from './mapRoster';
import { applyTerrainRuntimeConfig } from './terrain/terrainConfig';
import { getTerrainRuntimeConfig } from './terrain/terrainState';
import { getLiquidSurfaceMode, setLiquidSurfaceMode } from './worldSurfaceState';
import { BATTLE_PRESETS } from '../../components/battlePresets';
import type { LiquidSurfaceMode } from '../../types/worldSurfaceMode';
import type { UnitBlueprint } from './blueprints/types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[map surface roster] ${message}`);
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

function assertLandQuestion(): void {
  // The generation pipeline's baseline surface sits at the datum, so land
  // survives EVERY authored bar combination — including a map whose four
  // bars all dig. (An earlier rule declared all-negative bars "landless",
  // which wrongly emptied fabricator build lists on dug-everywhere maps
  // that are mostly dry ground between the basins.)
  assertContract(
    mapHasLandForSetup({ ...DRY_MAGNITUDES, liquidSurfaceMode: 'water' }),
    'a map whose magnitudes sit at datum must have land',
  );
  assertContract(
    mapHasLandForSetup({
      centerMagnitude: -400,
      ringMagnitude: -400,
      dividersMagnitude: -400,
      perimeterMagnitude: -400,
      liquidSurfaceMode: 'water',
    }),
    'even a map whose every bar digs keeps its baseline ground — the bars carve features, they cannot flood the map',
  );
  // The liquid is irrelevant to the land question — lava fills basins.
  assertContract(
    mapHasLandForSetup({ ...WET_MAGNITUDES, liquidSurfaceMode: 'lava' }) &&
      mapHasLandForSetup({ ...WET_MAGNITUDES, liquidSurfaceMode: 'water' }),
    'the land answer must ignore what fills the basins',
  );
  for (const preset of BATTLE_PRESETS) {
    // No authored preset may be landless — the commander swims, but a map
    // with no ground at all fields no factories and no economy. Pinned so an
    // all-sea preset is a deliberate act, not an accident of bar values.
    assertContract(
      mapHasLandForSetup(preset),
      `preset ${preset.name} must have land`,
    );
    const expected = mapHasLandForSetup(preset);
    withMapSetup(preset, preset.liquidSurfaceMode, () => {
      assertContract(
        mapHasLand() === expected,
        `preset ${preset.name}: installed-map and explicit-setup land answers must agree`,
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

  // The LAND mirror, restated from the same properties.
  for (const blueprint of Object.values(UNIT_BLUEPRINTS)) {
    const waypoint = getUnitLocomotion(blueprint.unitBlueprintId).navigation.waypoint;
    const expected = waypoint.allowOnGround && !waypoint.allowInWater && !waypoint.allowInAir;
    assertContract(
      isLandOnlyUnitBlueprintId(blueprint.unitBlueprintId) === expected,
      `${blueprint.unitBlueprintId} land-only classification must follow its waypoint domain`,
    );
  }
  for (const blueprint of Object.values(BUILDING_BLUEPRINTS)) {
    const expected = !blueprint.placementSets.some(
      (placementSet) => getBuildingPlacementSetSquareType(placementSet) !== 'ground',
    );
    assertContract(
      isLandOnlyBuildingBlueprintId(blueprint.buildingBlueprintId) === expected,
      `${blueprint.buildingBlueprintId} land-only classification must follow its placement sets`,
    );
  }
  assertContract(
    isLandOnlyUnitBlueprintId('unitLynx') && isLandOnlyUnitBlueprintId('unitMammoth'),
    'pure ground hulls must be classified land-only',
  );
  assertContract(
    !isLandOnlyUnitBlueprintId('unitCommander'),
    'the commander swims — it must survive a landless map, which keeps such a map playable at all',
  );
  assertContract(
    !isLandOnlyUnitBlueprintId('unitSeaTurtle') && !isLandOnlyUnitBlueprintId('unitHippo'),
    'amphibious hulls must survive a map with no land',
  );
  assertContract(
    !isLandOnlyUnitBlueprintId('unitEagle') && !isLandOnlyUnitBlueprintId('unitDuck'),
    'flyers are neither land-only nor water-only',
  );
  assertContract(
    isLandOnlyBuildingBlueprintId('buildingSolar') && isLandOnlyBuildingBlueprintId('buildingWind'),
    'ground-only structures must be classified land-only',
  );
  assertContract(
    !isLandOnlyBuildingBlueprintId('towerFabricator') &&
      !isLandOnlyBuildingBlueprintId('buildingExtractor'),
    'structures with a water placement set must survive a map with no land',
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

  // The LAND mirror: an all-sea map fields no pure ground hull and no
  // ground-only structure, while everything that swims or flies stays. No
  // AUTHORED setup is landless — the pipeline's baseline surface is ground —
  // so the landless narrowing is exercised through the medium-key primitive
  // an authorable all-sea map would resolve to. The wet BOTH-key setup keeps
  // the ambient rosters unnarrowed as the baseline.
  withMapSetup(WET_MAGNITUDES, 'water', () => {
    const factoryRoster = unitBlueprintIdsForMediumKey(
      getStructureFactoryAllowedUnitBlueprintIds('towerFabricator'),
      MEDIUM_KEY_WATER,
    );
    for (const unitBlueprintId of factoryRoster) {
      assertContract(
        !isLandOnlyUnitBlueprintId(unitBlueprintId),
        `a map with no land must not offer ${unitBlueprintId}`,
      );
    }
    assertContract(
      factoryRoster.includes('unitOrca') &&
        factoryRoster.includes('unitSeaTurtle') &&
        factoryRoster.includes('unitDuck'),
      'a map with no land must keep every hull that swims or flies',
    );
    // Anti-vacuous: the pass must actually have been narrowing something.
    const offersLandOnly = builderBlueprints().some((blueprint) =>
      getUnitAuthoredBuildBlueprintIds(blueprint).some(isLandOnlyBuildingBlueprintId));
    assertContract(
      offersLandOnly,
      'the authored rosters must contain land-only structures for this pass to exercise',
    );
    for (const blueprint of builderBlueprints()) {
      const builderRoster = buildingBlueprintIdsForMediumKey(
        getUnitBuilderAllowedBuildBlueprintIds(blueprint),
        MEDIUM_KEY_WATER,
      );
      for (const buildingBlueprintId of builderRoster) {
        assertContract(
          !isLandOnlyBuildingBlueprintId(buildingBlueprintId),
          `a map with no land must not let ${blueprint.unitBlueprintId} build ${buildingBlueprintId}`,
        );
      }
    }
    const commanderRoster = buildingBlueprintIdsForMediumKey(
      getUnitBuilderAllowedBuildBlueprintIds(UNIT_BLUEPRINTS['unitCommander']),
      MEDIUM_KEY_WATER,
    );
    assertContract(
      commanderRoster.includes('buildingExtractor') && commanderRoster.includes('towerFabricator'),
      'a map with no land must keep every structure that still has a square',
    );
  });

  // THE REGRESSION THAT SHIPPED: a dug-everywhere map (all four bars
  // negative) is mostly dry ground, and its fabricators must still offer
  // ground hulls. The old "all-negative = landless" rule emptied them.
  withMapSetup(
    {
      centerMagnitude: -400,
      ringMagnitude: -400,
      dividersMagnitude: -400,
      perimeterMagnitude: -400,
    },
    'water',
    () => {
      const factoryRoster = getStructureFactoryAllowedUnitBlueprintIds('towerFabricator');
      assertContract(
        factoryRoster.includes('unitLynx'),
        'a dug-everywhere map still has ground — fabricators must keep their tanks',
      );
    },
  );
}

export function runMapSurfaceRosterContractTest(): void {
  assertWaterQuestion();
  assertLandQuestion();
  assertWaterOnlyClassificationIsDerived();
  assertRostersNarrowWithTheMap();
}
