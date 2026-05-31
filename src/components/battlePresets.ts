import { BUILDABLE_UNIT_BLUEPRINT_IDS } from '../game/sim/blueprints/unitRoster';
import type { BattleMode } from '../battleBarConfig';
import { persist, readPersisted } from '../persistence';
import type { TerrainMapShape } from '../types/terrain';
import type { ShieldReflectionMode } from '../types/shotTypes';

export type BattlePreset = {
  readonly name: string;
  readonly units: readonly string[];
  readonly cap: number;
  readonly turretShieldPanelsEnabled: boolean;
  readonly turretShieldSpheresEnabled: boolean;
  readonly shieldsObstructSight: boolean;
  readonly shieldReflectionMode: ShieldReflectionMode;
  readonly fogOfWarEnabled: boolean;
  readonly converterTax: number;
  readonly centerMagnitude: number;
  readonly dividersMagnitude: number;
  readonly terrainMapShape: TerrainMapShape;
  readonly terrainDTerrain: number;
  readonly metalDepositStep: number;
  /** Fine-triangle subdivisions per land cell. 0 = off (one triangle
   *  per cell, current default); 5/10/15/20 = progressively finer mesh
   *  detail. Drives `TERRAIN_FINE_TRIANGLE_SUBDIV`. */
  readonly terrainDetail: number;
  readonly mapWidthLandCells: number;
  readonly mapLengthLandCells: number;
  /** Whether the host's grid-debug overlay is on by default. */
  readonly grid: boolean;
  /** Whether the bottom control bars are collapsed by default. */
  readonly barsCollapsed: boolean;
};

export type BattlePresetSnapshot = Omit<BattlePreset, 'name'>;

// Stable identifiers for the two presets that supply DEMO BATTLE and
// REAL BATTLE bar defaults. The bars never carry their own defaults;
// every fallback flows through one of these presets.
export const DEMO_BATTLE_DEFAULT_PRESET_NAME = 'DEMO BATTLE DEFAULT';
export const REAL_BATTLE_DEFAULT_PRESET_NAME = 'REAL BATTLE DEFAULT';

const MODE_DEFAULT_PRESET_NAMES: Record<BattleMode, string> = {
  demo: DEMO_BATTLE_DEFAULT_PRESET_NAME,
  real: REAL_BATTLE_DEFAULT_PRESET_NAME,
};

function allUnits(): readonly string[] {
  return BUILDABLE_UNIT_BLUEPRINT_IDS;
}
function demoUnits(): readonly string[] {
  return [
    'unitLynx',
    'unitBadger',
    'unitTick',
    'unitLoris',
    'unitWidow',
    'unitHippo',
    'unitBee',
    'unitDragonfly',
    'unitEagle',
  ];
}

// Shared subsystem toggles that historically lived as inline
// BATTLE_CONFIG defaults. Folding them into the presets means every
// battle bar fallback flows through a preset — the JSON has zero
// inline defaults.
const SUBSYSTEM_DEFAULTS = {
  turretShieldPanelsEnabled: true,
  turretShieldSpheresEnabled: true,
  shieldReflectionMode: 'both' as ShieldReflectionMode,
};

function buildPresets(): readonly BattlePreset[] {
  return [
    {
      name: DEMO_BATTLE_DEFAULT_PRESET_NAME,
      units: demoUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: false,
      converterTax: 0.0,
      centerMagnitude: 0,
      dividersMagnitude: 0,
      terrainMapShape: 'square',
      terrainDTerrain: 0,
      metalDepositStep: 0,
      terrainDetail: 0,
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
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.1,
      centerMagnitude: 400,
      dividersMagnitude: 400,
      terrainMapShape: 'circle',
      terrainDTerrain: 1,
      metalDepositStep: 200,
      terrainDetail: 0,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
      grid: false,
      barsCollapsed: false,
    },
    {
      name: 'Boulder Mountain',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.1,
      centerMagnitude: 1600,
      dividersMagnitude: 800,
      terrainMapShape: 'circle',
      terrainDTerrain: 400,
      metalDepositStep: 400,
      terrainDetail: 0,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
      grid: false,
      barsCollapsed: false,
    },
    {
      name: 'Spikey Lake',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.1,
      centerMagnitude: -800,
      dividersMagnitude: 3200,
      terrainMapShape: 'circle',
      terrainDTerrain: 800,
      metalDepositStep: 800,
      terrainDetail: 5,
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
      shieldsObstructSight: false,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 6400,
      dividersMagnitude: 12800,
      terrainMapShape: 'circle',
      terrainDTerrain: 400,
      metalDepositStep: 400,
      terrainDetail: 15,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
      grid: false,
      barsCollapsed: false,
    },
  ];
}

export const BATTLE_PRESETS: readonly BattlePreset[] = buildPresets();
export const DEFAULT_PRESET_NAME: string = BATTLE_PRESETS[0].name;

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

export function getDefaultPreset(): BattlePreset {
  const name = loadDefaultPresetName();
  return BATTLE_PRESETS.find((p) => p.name === name) ?? BATTLE_PRESETS[0];
}

export function loadDefaultPresetName(): string {
  const raw = readPersisted(STORAGE_SELECTED_PRESET);
  if (raw && BATTLE_PRESETS.some((p) => p.name === raw)) return raw;
  return DEFAULT_PRESET_NAME;
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

export function presetMatchesCurrent(
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
    p.cap === c.cap &&
    p.shieldsObstructSight === c.shieldsObstructSight &&
    Math.abs(p.converterTax - c.converterTax) < 1e-6 &&
    p.centerMagnitude === c.centerMagnitude &&
    p.dividersMagnitude === c.dividersMagnitude &&
    p.terrainMapShape === c.terrainMapShape &&
    p.terrainDTerrain === c.terrainDTerrain &&
    p.metalDepositStep === c.metalDepositStep &&
    p.terrainDetail === c.terrainDetail &&
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
