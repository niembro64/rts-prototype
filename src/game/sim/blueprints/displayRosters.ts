import { COST_MULTIPLIER } from '../../../config';
import type { ResourceCost } from '@/types/economyTypes';
import type { BuildingBlueprintId } from '../types';
import { getAllBuildings } from '../buildConfigs';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './unitRoster';
import { UNIT_BLUEPRINTS } from './units';

type UnitRosterDisplay = {
  unitBlueprintId: string;
  label: string;
  shortName: string;
  tinyName: string;
  cost: number;
  energyCost: number;
  metalCost: number;
  locomotion: string;
};

type BuildingRosterDisplay = {
  buildingBlueprintId: BuildingBlueprintId;
  label: string;
  shortName: string;
  tinyName: string;
  key: string;
  cost: number;
  energyCost: number;
  metalCost: number;
  category: BuildMenuCategory;
};

export type BuildMenuCategory = 'Economy' | 'Intel' | 'Production' | 'Defense';

export const BUILD_MENU_CATEGORY_ORDER: readonly BuildMenuCategory[] = [
  'Economy',
  'Intel',
  'Production',
  'Defense',
];

function scaledTotalCost(cost: ResourceCost): number {
  return (cost.energy + cost.metal) * COST_MULTIPLIER;
}

function scaledCostPart(value: number): number {
  return value * COST_MULTIPLIER;
}

function fallbackShortName(id: string): string {
  return id.toUpperCase().slice(0, 3);
}

function buildUnitRosterDisplay(): UnitRosterDisplay[] {
  const display = new Array<UnitRosterDisplay>(BUILDABLE_UNIT_BLUEPRINT_IDS.length);
  for (let i = 0; i < BUILDABLE_UNIT_BLUEPRINT_IDS.length; i++) {
    const id = BUILDABLE_UNIT_BLUEPRINT_IDS[i];
    const bp = UNIT_BLUEPRINTS[id];
    if (!bp) {
      display[i] = {
        unitBlueprintId: id,
        label: id,
        shortName: fallbackShortName(id),
        tinyName: fallbackShortName(id).slice(0, 3),
        cost: 0,
        energyCost: 0,
        metalCost: 0,
        locomotion: 'unknown',
      };
      continue;
    }
    display[i] = {
      unitBlueprintId: bp.unitBlueprintId,
      label: bp.name,
      shortName: bp.shortName,
      tinyName: bp.tinyName,
      cost: scaledTotalCost(bp.cost),
      energyCost: scaledCostPart(bp.cost.energy),
      metalCost: scaledCostPart(bp.cost.metal),
      locomotion: bp.unitLocomotion.type,
    };
  }
  return display;
}

export const unitRosterDisplay: UnitRosterDisplay[] = buildUnitRosterDisplay();

function buildUnitRosterDisplayById(display: readonly UnitRosterDisplay[]): Map<string, UnitRosterDisplay> {
  const byId = new Map<string, UnitRosterDisplay>();
  for (let i = 0; i < display.length; i++) {
    const unit = display[i];
    byId.set(unit.unitBlueprintId, unit);
  }
  return byId;
}

const unitRosterDisplayById = buildUnitRosterDisplayById(unitRosterDisplay);

export function getUnitDisplayShortName(unitBlueprintId: string): string {
  const display = unitRosterDisplayById.get(unitBlueprintId);
  return display !== undefined ? display.shortName : fallbackShortName(unitBlueprintId);
}

export function getUnitRosterDisplay(unitBlueprintId: string): UnitRosterDisplay | null {
  return unitRosterDisplayById.get(unitBlueprintId) ?? null;
}

function buildStructureRosterDisplay(
  configs: readonly {
    buildingBlueprintId: BuildingBlueprintId;
    name: string;
    shortName: string;
    tinyName: string;
    cost: ResourceCost;
  }[],
  keyOffset: number,
): BuildingRosterDisplay[] {
  const display = new Array<BuildingRosterDisplay>(configs.length);
  for (let i = 0; i < configs.length; i++) {
    const bp = configs[i];
    display[i] = {
      buildingBlueprintId: bp.buildingBlueprintId,
      label: bp.name,
      shortName: bp.shortName,
      tinyName: bp.tinyName,
      key: `${keyOffset + i + 1}`,
      cost: scaledTotalCost(bp.cost),
      energyCost: scaledCostPart(bp.cost.energy),
      metalCost: scaledCostPart(bp.cost.metal),
      category: structureBuildCategory(bp.buildingBlueprintId),
    };
  }
  return display;
}

export function structureBuildCategory(buildingBlueprintId: BuildingBlueprintId): BuildMenuCategory {
  switch (buildingBlueprintId) {
    case 'buildingRadar':
    case 'buildingSonar':
    case 'buildingRadarJammer':
    case 'buildingSonarJammer':
    case 'buildingShieldTargetingTech':
    case 'buildingShieldTech':
    case 'buildingPrecisionTargetingTech':
      return 'Intel';
    case 'towerFabricator':
      return 'Production';
    case 'towerBeamLight':
    case 'towerBeamMega':
    case 'towerCannon':
    case 'towerHelios':
    case 'towerAntiAir':
    case 'towerTorpedo':
      return 'Defense';
    default:
      return 'Economy';
  }
}

const buildingRosterDisplay: BuildingRosterDisplay[] = buildStructureRosterDisplay(
  getAllBuildings(),
  0,
);

// Builder-authored allowed rosters filter this surface before display.
export const structureRosterDisplay: BuildingRosterDisplay[] = buildingRosterDisplay;

// Short button labels for the BUILDINGS battle-bar toggle group — the
// structure analogue of getUnitDisplayShortName. Buildings carry no authored
// shortName, so we derive a compact label
// from the display name (dropping a trailing " Tower"): Solar -> SOLAR,
// "Beam Tower" -> BEAM, "Anti-Air Tower" -> ANTI-AIR.
function buildStructureRosterDisplayById(
  display: readonly BuildingRosterDisplay[],
): Map<string, BuildingRosterDisplay> {
  const byId = new Map<string, BuildingRosterDisplay>();
  for (let i = 0; i < display.length; i++) {
    byId.set(display[i].buildingBlueprintId, display[i]);
  }
  return byId;
}

const buildingRosterDisplayById = buildStructureRosterDisplayById(buildingRosterDisplay);

/** The authored abbreviation. Deriving one by stripping words off the label
 *  produced "SHIELD DETECTION LAB" for a slot sized for six characters, so the
 *  blueprint names its own short form the way units already do. */
export function getBuildingDisplayShortName(buildingBlueprintId: string): string {
  const row = buildingRosterDisplayById.get(buildingBlueprintId);
  return row !== undefined ? row.shortName : fallbackShortName(buildingBlueprintId);
}

/** The authored three-letter code. Unlike `shortName`, its width is fixed and
 *  guaranteed, so a slot sized for exactly three characters — a portrait
 *  fallback, an icon badge — can use it without measuring anything. Codes are
 *  unique across units and buildings together, so one is never ambiguous in a
 *  list that mixes them. */
export function getBuildingDisplayTinyName(buildingBlueprintId: string): string {
  const row = buildingRosterDisplayById.get(buildingBlueprintId);
  return row !== undefined ? row.tinyName : fallbackShortName(buildingBlueprintId).slice(0, 3);
}

export function getUnitDisplayTinyName(unitBlueprintId: string): string {
  const display = unitRosterDisplayById.get(unitBlueprintId);
  return display !== undefined
    ? display.tinyName
    : fallbackShortName(unitBlueprintId).slice(0, 3);
}
