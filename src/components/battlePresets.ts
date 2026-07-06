import { BUILDABLE_UNIT_BLUEPRINT_IDS } from '../game/sim/blueprints/unitRoster';
import { BUILDING_BLUEPRINT_IDS, TOWER_BLUEPRINT_IDS } from '../types/blueprintIds';
import type { BattleMode } from '../battleBarConfig';
import { persist } from '../persistence';
import type { ShieldReflectionMode } from '../types/shotTypes';
import type { SlopePathMode } from '../types/slopePathMode';

export type BattlePreset = {
  readonly name: string;
  readonly units: readonly string[];
  /** Enabled building blueprints (BUILDINGS bar group). Every preset
   *  ships with all buildings on; the field exists so DEFAULTS / preset
   *  selection resets structure toggles and the active-preset highlight
   *  accounts for them, mirroring `units`. */
  readonly buildings: readonly string[];
  /** Enabled tower blueprints (TOWERS bar group). */
  readonly towers: readonly string[];
  readonly cap: number;
  readonly turretShieldPanelsEnabled: boolean;
  readonly turretShieldSpheresEnabled: boolean;
  readonly forceFieldsVisible: boolean;
  readonly shieldsObstructSight: boolean;
  readonly shieldReflectionMode: ShieldReflectionMode;
  readonly fogOfWarEnabled: boolean;
  /** Ground pathfinding slope policy (SLOPE PATH bar toggle). */
  readonly slopePathMode: SlopePathMode;
  readonly converterTax: number;
  readonly centerMagnitude: number;
  readonly dividersMagnitude: number;
  /** Signed PERIMETER ring altitude. 0 = flat square; negative sinks the
   *  outer ring below water (round-island); positive raises a rim. */
  readonly perimeterMagnitude: number;
  readonly terrainDTerrain: number;
  readonly plateauWallSlopeDegrees: number;
  readonly metalDepositStep: number;
  /** Fine-triangle subdivisions per land cell. 0 = off, which the
   *  terrain baker clamps to one triangle edge subdivision per cell.
   *  Drives `TERRAIN_FINE_TRIANGLE_SUBDIV`. */
  readonly terrainDetail: number;
  readonly terrainTextureSmoothing: number;
  readonly terrainLightSmoothing: number;
  readonly mapWidthLandCells: number;
  readonly mapLengthLandCells: number;
  /** Whether the host's grid-debug overlay is on by default. */
  readonly grid: boolean;
  /** Whether the bottom control bars are collapsed by default. */
  readonly barsCollapsed: boolean;
};

type BattlePresetSnapshot = Omit<BattlePreset, 'name'>;

// Stable identifiers for the two presets that supply DEMO BATTLE and
// REAL BATTLE bar defaults. The bars never carry their own defaults;
// every fallback flows through one of these presets.
const DEMO_BATTLE_DEFAULT_PRESET_NAME = 'DEMO BATTLE DEFAULT';
const REAL_BATTLE_DEFAULT_PRESET_NAME = 'REAL BATTLE DEFAULT';

const MODE_DEFAULT_PRESET_NAMES: Record<BattleMode, string> = {
  demo: DEMO_BATTLE_DEFAULT_PRESET_NAME,
  real: REAL_BATTLE_DEFAULT_PRESET_NAME,
};

function allUnits(): readonly string[] {
  return BUILDABLE_UNIT_BLUEPRINT_IDS;
}
function allBuildings(): readonly string[] {
  return BUILDING_BLUEPRINT_IDS;
}
function allTowers(): readonly string[] {
  return TOWER_BLUEPRINT_IDS;
}
function demoUnits(): readonly string[] {
  return [
    'unitLynx',
    'unitBadger',
    'unitTick',
    'unitLoris',
    'unitWidow',
    'unitHippo',
    'unitSeaTurtle',
    'unitBee',
    'unitDragonfly',
    'unitEagle',
    'unitAlbatros',
  ];
}

// Shared subsystem toggles that historically lived as inline
// BATTLE_CONFIG defaults. Folding them into the presets means every
// battle bar fallback flows through a preset — the JSON has zero
// inline defaults.
const SUBSYSTEM_DEFAULTS = {
  turretShieldPanelsEnabled: true,
  turretShieldSpheresEnabled: true,
  forceFieldsVisible: true,
  shieldReflectionMode: 'both' as ShieldReflectionMode,
  slopePathMode: 'directional' as SlopePathMode,
};

// Every preset enables all buildings and towers — there is no preset
// that ships with structures disabled. Spread into each literal so the
// structure fields stay in one place (mirrors SUBSYSTEM_DEFAULTS).
const STRUCTURE_DEFAULTS = {
  buildings: allBuildings(),
  towers: allTowers(),
};

const TERRAIN_RENDER_DEFAULTS = {
  terrainTextureSmoothing: 2,
  terrainLightSmoothing: 2,
};

function buildPresets(): readonly BattlePreset[] {
  return [
    {
      name: DEMO_BATTLE_DEFAULT_PRESET_NAME,
      units: demoUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: false,
      converterTax: 0.0,
      centerMagnitude: 0,
      dividersMagnitude: 0,
      perimeterMagnitude: 0,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 0,
      terrainDetail: 0,
      ...TERRAIN_RENDER_DEFAULTS,
      mapWidthLandCells: 23,
      mapLengthLandCells: 23,
      grid: true,
      barsCollapsed: true,
    },
    {
      name: REAL_BATTLE_DEFAULT_PRESET_NAME,
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 0,
      dividersMagnitude: 400,
      perimeterMagnitude: -800,
      terrainDTerrain: 1,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 200,
      terrainDetail: 8,
      ...TERRAIN_RENDER_DEFAULTS,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
      grid: false,
      barsCollapsed: true,
    },
    {
      name: 'Large Circle',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 0,
      dividersMagnitude: 0,
      perimeterMagnitude: -800,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 0,
      terrainDetail: 16,
      ...TERRAIN_RENDER_DEFAULTS,
      mapWidthLandCells: 119,
      mapLengthLandCells: 119,
      grid: false,
      barsCollapsed: false,
    },
    {
      name: 'Angels Flat',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 0,
      dividersMagnitude: 1600,
      perimeterMagnitude: -800,
      terrainDTerrain: 400,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 0,
      terrainDetail: 16,
      ...TERRAIN_RENDER_DEFAULTS,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
      grid: false,
      barsCollapsed: false,
    },
    {
      name: 'Boulder Mountains',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 1600,
      dividersMagnitude: 800,
      perimeterMagnitude: -800,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 400,
      terrainDetail: 8,
      ...TERRAIN_RENDER_DEFAULTS,
      mapWidthLandCells: 119,
      mapLengthLandCells: 119,
      grid: false,
      barsCollapsed: false,
    },
    {
      name: 'Spikey Lake',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: -400,
      dividersMagnitude: 1600,
      perimeterMagnitude: -800,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 200,
      terrainDetail: 8,
      ...TERRAIN_RENDER_DEFAULTS,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
      grid: false,
      barsCollapsed: false,
    },
    {
      name: 'Niemo Islands',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 200,
      dividersMagnitude: -3200,
      perimeterMagnitude: -800,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 200,
      terrainDetail: 8,
      ...TERRAIN_RENDER_DEFAULTS,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
      grid: false,
      barsCollapsed: false,
    },
    {
      name: 'Angels Playhouse',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 6400,
      dividersMagnitude: 6400,
      perimeterMagnitude: -800,
      terrainDTerrain: 200,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 3200,
      terrainDetail: 16,
      ...TERRAIN_RENDER_DEFAULTS,
      mapWidthLandCells: 35,
      mapLengthLandCells: 35,
      grid: false,
      barsCollapsed: false,
    },
  ];
}

export const BATTLE_PRESETS: readonly BattlePreset[] = buildPresets();

const STORAGE_SELECTED_PRESET = 'battle-selected-preset';

/** Resolve the preset that supplies the default values for a given
 *  battle mode. Every DEMO BATTLE / REAL BATTLE bar default — cap,
 *  fog of war, terrain, grid overlay, bar collapse — flows through
 *  the preset returned here. The bars own no inline defaults. */
export function getModeDefaultPreset(mode: BattleMode): BattlePreset {
  const name = MODE_DEFAULT_PRESET_NAMES[mode];
  const found = BATTLE_PRESETS.find((p) => p.name === name);
  if (!found) {
    throw new Error(`Missing battle mode default preset: ${name}`);
  }
  return found;
}

export function saveSelectedPresetName(name: string): void {
  persist(STORAGE_SELECTED_PRESET, name);
}

function sameUnits(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const x of b) if (!setA.has(x)) return false;
  return true;
}

function presetMatchesCurrent(
  p: BattlePreset,
  c: BattlePresetSnapshot,
): boolean {
  // Fog of war is intentionally excluded from the match: it's hardcoded
  // in the lobby (off) and in the real battle (on), so comparing the
  // preset's stored fog value against the current state would always
  // mismatch in those contexts. The DEMO BATTLE bar still toggles fog
  // independently of presets.
  return (
    sameUnits(p.units, c.units) &&
    sameUnits(p.buildings, c.buildings) &&
    sameUnits(p.towers, c.towers) &&
    p.cap === c.cap &&
    p.forceFieldsVisible === c.forceFieldsVisible &&
    p.shieldsObstructSight === c.shieldsObstructSight &&
    Math.abs(p.converterTax - c.converterTax) < 1e-6 &&
    p.centerMagnitude === c.centerMagnitude &&
    p.dividersMagnitude === c.dividersMagnitude &&
    p.perimeterMagnitude === c.perimeterMagnitude &&
    p.terrainDTerrain === c.terrainDTerrain &&
    p.plateauWallSlopeDegrees === c.plateauWallSlopeDegrees &&
    p.metalDepositStep === c.metalDepositStep &&
    p.terrainDetail === c.terrainDetail &&
    p.terrainTextureSmoothing === c.terrainTextureSmoothing &&
    p.terrainLightSmoothing === c.terrainLightSmoothing &&
    p.mapWidthLandCells === c.mapWidthLandCells &&
    p.mapLengthLandCells === c.mapLengthLandCells
  );
}

export function findMatchingPresetName(c: BattlePresetSnapshot): string | null {
  for (const p of BATTLE_PRESETS) {
    if (presetMatchesCurrent(p, c)) return p.name;
  }
  return null;
}
