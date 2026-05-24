import { BATTLE_CONFIG, getDefaultDemoUnits } from '../battleBarConfig';
import { persist, readPersisted } from '../persistence';
import type { TerrainMapShape } from '../types/terrain';

export type BattlePreset = {
  readonly name: string;
  readonly units: readonly string[];
  readonly cap: number;
  readonly forceFieldsObstructSight: boolean;
  readonly fogOfWarEnabled: boolean;
  readonly converterTax: number;
  readonly centerMagnitude: number;
  readonly dividersMagnitude: number;
  readonly terrainMapShape: TerrainMapShape;
  readonly terrainDTerrain: number;
  readonly metalDepositStep: number;
  readonly mapWidthLandCells: number;
  readonly mapLengthLandCells: number;
};

export type BattlePresetSnapshot = Omit<BattlePreset, 'name'>;

function allUnits(): readonly string[] {
  return Object.keys(BATTLE_CONFIG.units);
}

function buildPresets(): readonly BattlePreset[] {
  const defaults = getDefaultDemoUnits();
  return [
    {
      name: 'Lictor Mandate',
      units: allUnits(),
      cap: 243,
      forceFieldsObstructSight: true,
      fogOfWarEnabled: false,
      converterTax: 0.0,
      centerMagnitude: 400,
      dividersMagnitude: 400,
      terrainMapShape: 'circle',
      terrainDTerrain: 0,
      metalDepositStep: 200,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
    },
    {
      name: 'Hoplon Phalanx',
      units: allUnits(),
      cap: 729,
      forceFieldsObstructSight: false,
      fogOfWarEnabled: false,
      converterTax: 0.1,
      centerMagnitude: 1600,
      dividersMagnitude: 800,
      terrainMapShape: 'circle',
      terrainDTerrain: 400,
      metalDepositStep: 400,
      mapWidthLandCells: 79,
      mapLengthLandCells: 53,
    },
    {
      name: 'Domovoi Tempest',
      units: allUnits(),
      cap: 2187,
      forceFieldsObstructSight: true,
      fogOfWarEnabled: false,
      converterTax: 0.0,
      centerMagnitude: 0,
      dividersMagnitude: 200,
      terrainMapShape: 'circle',
      terrainDTerrain: 0,
      metalDepositStep: 100,
      mapWidthLandCells: 119,
      mapLengthLandCells: 119,
    },
    {
      name: 'Tuatha Vanguard',
      units: allUnits(),
      cap: 81,
      forceFieldsObstructSight: true,
      fogOfWarEnabled: false,
      converterTax: 0.5,
      centerMagnitude: 200,
      dividersMagnitude: -200,
      terrainMapShape: 'circle',
      terrainDTerrain: 200,
      metalDepositStep: 200,
      mapWidthLandCells: 23,
      mapLengthLandCells: 35,
    },
    {
      name: 'Jötunn Crucible',
      units: allUnits(),
      cap: 1262,
      forceFieldsObstructSight: false,
      fogOfWarEnabled: false,
      converterTax: 0.1,
      centerMagnitude: -800,
      dividersMagnitude: 3200,
      terrainMapShape: 'circle',
      terrainDTerrain: 800,
      metalDepositStep: 800,
      mapWidthLandCells: 53,
      mapLengthLandCells: 79,
    },
  ];
}

export const BATTLE_PRESETS: readonly BattlePreset[] = buildPresets();
export const DEFAULT_PRESET_NAME: string = BATTLE_PRESETS[0].name;

const STORAGE_SELECTED_PRESET = 'battle-selected-preset';

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
  return (
    sameUnits(p.units, c.units) &&
    p.cap === c.cap &&
    p.forceFieldsObstructSight === c.forceFieldsObstructSight &&
    p.fogOfWarEnabled === c.fogOfWarEnabled &&
    Math.abs(p.converterTax - c.converterTax) < 1e-6 &&
    p.centerMagnitude === c.centerMagnitude &&
    p.dividersMagnitude === c.dividersMagnitude &&
    p.terrainMapShape === c.terrainMapShape &&
    p.terrainDTerrain === c.terrainDTerrain &&
    p.metalDepositStep === c.metalDepositStep &&
    p.mapWidthLandCells === c.mapWidthLandCells &&
    p.mapLengthLandCells === c.mapLengthLandCells
  );
}

export function findMatchingPresetName(
  c: BattlePresetSnapshot,
): string | null {
  for (const p of BATTLE_PRESETS) {
    if (presetMatchesCurrent(p, c)) return p.name;
  }
  return null;
}
