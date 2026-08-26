import type { BattleMode } from '../battleBarConfig';
import {
  isShieldReflectionMode,
  type ShieldReflectionMode,
} from '../types/shotTypes';
import {
  isSlopePathMode,
  type SlopePathMode,
} from '../types/slopePathMode';
import {
  isTerrainPrecedence,
  type TerrainPrecedence,
} from '../types/terrainPrecedence';
import {
  isLiquidSurfaceMode,
  isMetalCoverage,
  METAL_COVERAGE_LABEL,
  type LiquidSurfaceMode,
  type MetalCoverage,
} from '../types/worldSurfaceMode';
import { LAND_CELL_SIZE } from '../mapSizeConfig';
import { AUTHOR_BYLINE } from '../authorBylineConfig';
import type { MapPresetLabelCaption } from '../game/render3d/presetMapLabel';
import rawBattlePresetConfig from '../battlePresets.json';

export type BattlePreset = {
  /** Stable config identity. Mode defaults point here so renaming the visible
   *  map label cannot invalidate startup configuration. */
  readonly id: string;
  readonly name: string;
  /** Generated four-layer panorama set for this authored map. Keeping it on
   *  the preset removes the second name-to-background registry. */
  readonly backdropSlug: string;
  readonly turretShieldPanelsEnabled: boolean;
  readonly turretShieldSpheresEnabled: boolean;
  readonly forceFieldsVisible: boolean;
  readonly shieldReflectionMode: ShieldReflectionMode;
  readonly fogOfWarEnabled: boolean;
  /** Apply velocity-aware braking near the last point of the last action. */
  readonly slowDownAtFinalWaypoint: boolean;
  /** Whether pathfinding treats other units as obstacles (BATTLE bar toggle). */
  readonly pathfindingConsidersUnits: boolean;
  /** Ground pathfinding slope policy (SLOPE LIMIT bar toggle). */
  readonly slopePathMode: SlopePathMode;
  /** Ground material policy (WORLD bar group). `metal` makes the whole map
   *  one ore body — see types/worldSurfaceMode. */
  readonly metalCoverage: MetalCoverage;
  /** What fills the map below the water level (WORLD bar group). */
  readonly liquidSurfaceMode: LiquidSurfaceMode;
  readonly converterTax: number;
  /** Signed CENTER dome/dish altitude at the exact map centre. */
  readonly centerMagnitude: number;
  /** Signed RING annulus crest altitude (0 = no ring). */
  readonly ringMagnitude: number;
  readonly dividersMagnitude: number;
  /** Signed PERIMETER ring altitude: negative sinks the outer ring below
   *  water (round-island), positive raises a rim, 0 flattens it to ground
   *  level. */
  readonly perimeterMagnitude: number;
  /** Which of DIVIDERS/PERIMETER applies last in terrain generation
   *  (PRECEDENCE bar) — last wins where they overlap. */
  readonly terrainPrecedence: TerrainPrecedence;
  readonly terrainDTerrain: number;
  readonly plateauWallSlopeDegrees: number;
  readonly metalDepositStep: number;
  /** Fine-triangle subdivisions per land cell. 0 = off, which the
   *  terrain baker clamps to one triangle edge subdivision per cell.
   *  Drives `TERRAIN_FINE_TRIANGLE_SUBDIV`. */
  readonly terrainDetail: number;
  readonly mapWidthLandCells: number;
  readonly mapLengthLandCells: number;
};

/** The MAP a preset names: terrain shape and size, ground and liquid. The
 *  gameplay defaults a preset also carries (final-waypoint slowdown,
 *  unit-aware pathfinding, slope policy, converter tax) are the same on
 *  every stock preset and are not part of the map, so they are neither
 *  compared nor needed here — a BATTLE-bar toggle must not rename the map
 *  CUSTOM or swap its sky. */
export type BattlePresetSnapshot = Omit<
  BattlePreset,
  | 'id'
  | 'name'
  | 'backdropSlug'
  | 'turretShieldPanelsEnabled'
  | 'turretShieldSpheresEnabled'
  | 'forceFieldsVisible'
  | 'shieldReflectionMode'
  | 'fogOfWarEnabled'
  | 'slowDownAtFinalWaypoint'
  | 'pathfindingConsidersUnits'
  | 'slopePathMode'
  | 'converterTax'
> & {
  /** DISPLAY ONLY. The entity count cap is a standalone global setting, not
   *  a map property: presets never carry one, applying a preset never
   *  changes it, and it takes no part in preset matching. The map caption
   *  prints it as live battle info. */
  readonly cap: number;
};

type BattlePresetFile = {
  readonly modeDefaults: Record<BattleMode, string>;
  readonly presets: readonly BattlePreset[];
};

const BATTLE_PRESET_KEYS = [
  'id',
  'name',
  'backdropSlug',
  'turretShieldPanelsEnabled',
  'turretShieldSpheresEnabled',
  'forceFieldsVisible',
  'shieldReflectionMode',
  'fogOfWarEnabled',
  'slowDownAtFinalWaypoint',
  'pathfindingConsidersUnits',
  'slopePathMode',
  'metalCoverage',
  'liquidSurfaceMode',
  'converterTax',
  'centerMagnitude',
  'ringMagnitude',
  'dividersMagnitude',
  'perimeterMagnitude',
  'terrainPrecedence',
  'terrainDTerrain',
  'plateauWallSlopeDegrees',
  'metalDepositStep',
  'terrainDetail',
  'mapWidthLandCells',
  'mapLengthLandCells',
] as const satisfies readonly (keyof BattlePreset)[];

const BOOLEAN_PRESET_KEYS = [
  'turretShieldPanelsEnabled',
  'turretShieldSpheresEnabled',
  'forceFieldsVisible',
  'fogOfWarEnabled',
  'slowDownAtFinalWaypoint',
  'pathfindingConsidersUnits',
] as const satisfies readonly (keyof BattlePreset)[];

const INTEGER_PRESET_KEYS = [
  'centerMagnitude',
  'ringMagnitude',
  'dividersMagnitude',
  'perimeterMagnitude',
  'terrainDTerrain',
  'plateauWallSlopeDegrees',
  'metalDepositStep',
  'terrainDetail',
  'mapWidthLandCells',
  'mapLengthLandCells',
] as const satisfies readonly (keyof BattlePreset)[];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireConfigObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactConfigKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      extra.length > 0 ? `unknown ${extra.join(', ')}` : '',
    ].filter((part) => part.length > 0).join('; ');
    throw new Error(`${path} has invalid fields: ${details}`);
  }
}

function requireConfigString(
  value: unknown,
  path: string,
): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${path} must be a non-empty string without outer whitespace`);
  }
  return value;
}

function requireConfigInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${path} must be a finite integer`);
  }
  return value as number;
}

function validateBattlePreset(value: unknown, index: number): BattlePreset {
  const path = `battlePresets.json presets[${index}]`;
  const preset = requireConfigObject(value, path);
  requireExactConfigKeys(preset, BATTLE_PRESET_KEYS, path);

  const id = requireConfigString(preset.id, `${path}.id`);
  if (!SLUG_PATTERN.test(id)) {
    throw new Error(`${path}.id must be a lowercase kebab-case identifier`);
  }
  requireConfigString(preset.name, `${path}.name`);
  const backdropSlug = requireConfigString(
    preset.backdropSlug,
    `${path}.backdropSlug`,
  );
  if (!SLUG_PATTERN.test(backdropSlug)) {
    throw new Error(`${path}.backdropSlug must be a lowercase kebab-case slug`);
  }

  for (const key of BOOLEAN_PRESET_KEYS) {
    if (typeof preset[key] !== 'boolean') {
      throw new Error(`${path}.${key} must be a boolean`);
    }
  }
  if (!isShieldReflectionMode(preset.shieldReflectionMode)) {
    throw new Error(`${path}.shieldReflectionMode is invalid`);
  }
  if (!isSlopePathMode(preset.slopePathMode)) {
    throw new Error(`${path}.slopePathMode is invalid`);
  }
  if (!isMetalCoverage(preset.metalCoverage)) {
    throw new Error(`${path}.metalCoverage is invalid`);
  }
  if (!isLiquidSurfaceMode(preset.liquidSurfaceMode)) {
    throw new Error(`${path}.liquidSurfaceMode is invalid`);
  }
  if (!isTerrainPrecedence(preset.terrainPrecedence)) {
    throw new Error(`${path}.terrainPrecedence is invalid`);
  }

  if (
    typeof preset.converterTax !== 'number' ||
    !Number.isFinite(preset.converterTax) ||
    preset.converterTax < 0 ||
    preset.converterTax >= 1
  ) {
    throw new Error(`${path}.converterTax must be a finite number in [0, 1)`);
  }
  for (const key of INTEGER_PRESET_KEYS) {
    requireConfigInteger(preset[key], `${path}.${key}`);
  }
  if ((preset.terrainDTerrain as number) < 0) {
    throw new Error(`${path}.terrainDTerrain must be non-negative`);
  }
  const wallSlope = preset.plateauWallSlopeDegrees as number;
  if (wallSlope <= 0 || wallSlope >= 90) {
    throw new Error(`${path}.plateauWallSlopeDegrees must be between 1 and 89`);
  }
  if ((preset.terrainDetail as number) < 0) {
    throw new Error(`${path}.terrainDetail must be non-negative`);
  }
  for (const key of ['mapWidthLandCells', 'mapLengthLandCells'] as const) {
    const landCells = preset[key] as number;
    if (landCells <= 0 || landCells % 2 !== 1) {
      throw new Error(`${path}.${key} must be a positive odd integer`);
    }
  }

  return preset as unknown as BattlePreset;
}

function validateBattlePresetFile(value: unknown): BattlePresetFile {
  const rootPath = 'battlePresets.json';
  const root = requireConfigObject(value, rootPath);
  requireExactConfigKeys(root, ['modeDefaults', 'presets'], rootPath);
  const modeDefaults = requireConfigObject(
    root.modeDefaults,
    `${rootPath}.modeDefaults`,
  );
  requireExactConfigKeys(
    modeDefaults,
    ['demo', 'real'],
    `${rootPath}.modeDefaults`,
  );
  const demoDefault = requireConfigString(
    modeDefaults.demo,
    `${rootPath}.modeDefaults.demo`,
  );
  const realDefault = requireConfigString(
    modeDefaults.real,
    `${rootPath}.modeDefaults.real`,
  );
  if (!Array.isArray(root.presets) || root.presets.length === 0) {
    throw new Error(`${rootPath}.presets must be a non-empty array`);
  }
  const presets = root.presets.map(validateBattlePreset);
  const ids = new Set<string>();
  const names = new Set<string>();
  const backdropSlugs = new Set<string>();
  for (const preset of presets) {
    if (ids.has(preset.id)) {
      throw new Error(`${rootPath} has duplicate preset id: ${preset.id}`);
    }
    if (names.has(preset.name)) {
      throw new Error(`${rootPath} has duplicate preset name: ${preset.name}`);
    }
    if (backdropSlugs.has(preset.backdropSlug)) {
      throw new Error(
        `${rootPath} has duplicate backdropSlug: ${preset.backdropSlug}`,
      );
    }
    ids.add(preset.id);
    names.add(preset.name);
    backdropSlugs.add(preset.backdropSlug);
  }
  for (const [mode, defaultId] of [
    ['demo', demoDefault],
    ['real', realDefault],
  ] as const) {
    if (!ids.has(defaultId)) {
      throw new Error(
        `${rootPath}.modeDefaults.${mode} references unknown preset id: ${defaultId}`,
      );
    }
  }
  return {
    modeDefaults: { demo: demoDefault, real: realDefault },
    presets,
  };
}

const BATTLE_PRESET_FILE = validateBattlePresetFile(rawBattlePresetConfig);
export const BATTLE_PRESETS: readonly BattlePreset[] =
  BATTLE_PRESET_FILE.presets;
const BATTLE_PRESETS_BY_ID = new Map(
  BATTLE_PRESETS.map((preset) => [preset.id, preset]),
);

/** The authored map a battle mode starts on. Demo and real intentionally
 *  share it; they differ only in the entity count cap, which is a standalone
 *  setting (getModeDefaultEntityCountCap) rather than a preset field. */
export function getModeDefaultPreset(mode: BattleMode): BattlePreset {
  const id = BATTLE_PRESET_FILE.modeDefaults[mode];
  const found = BATTLE_PRESETS_BY_ID.get(id);
  if (!found) {
    throw new Error(`Missing battle mode default preset id: ${id}`);
  }
  return found;
}

function presetMatchesCurrent(
  p: BattlePreset,
  c: BattlePresetSnapshot,
): boolean {
  // A preset NAMES A MAP, so only map fields decide identity: terrain
  // magnitudes, precedence, D-terrain, wall slope, deposit step, detail,
  // land cells, ground material and liquid. Everything else a preset record
  // carries is a default that rides along when the preset is applied — fog
  // (lobby off / real on), the shield defaults, the gameplay toggles every
  // stock preset shares — and the entity count cap is not a preset field at
  // all. None of those may flip the caption to CUSTOM: the same ground under
  // a different converter tax is still the same authored map and sky.
  return (
    p.metalCoverage === c.metalCoverage &&
    p.liquidSurfaceMode === c.liquidSurfaceMode &&
    p.centerMagnitude === c.centerMagnitude &&
    p.ringMagnitude === c.ringMagnitude &&
    p.dividersMagnitude === c.dividersMagnitude &&
    p.perimeterMagnitude === c.perimeterMagnitude &&
    p.terrainPrecedence === c.terrainPrecedence &&
    p.terrainDTerrain === c.terrainDTerrain &&
    p.plateauWallSlopeDegrees === c.plateauWallSlopeDegrees &&
    p.metalDepositStep === c.metalDepositStep &&
    p.terrainDetail === c.terrainDetail &&
    p.mapWidthLandCells === c.mapWidthLandCells &&
    p.mapLengthLandCells === c.mapLengthLandCells
  );
}

type BattleMapPresentation = {
  /** Exact stock match, or null when any map/gameplay setting is custom. */
  readonly presetName: string | null;
  /** Only exact stock matches receive the preset's special panorama. */
  readonly backdropPresetName: string | null;
  /** The ground sign is always present and always describes current values. */
  readonly labelCaption: NonNullable<MapPresetLabelCaption>;
};

function formatTerrainMagnitude(value: number): string {
  return value === 0 ? 'NONE' : String(value);
}

/** PERIMETER prints 0 as 0 rather than NONE because a ground-level ring is
 *  a real (and visibly different) map shape. */
function formatPerimeterMagnitude(value: number): string {
  return String(value);
}

/** Resolve the complete map presentation once from the current settings.
 *  Custom maps retain the useful sign but use the neutral default backdrop. */
export function resolveBattleMapPresentation(
  current: BattlePresetSnapshot,
): BattleMapPresentation {
  const presetName = findMatchingPresetName(current);
  const terrain = `${METAL_COVERAGE_LABEL[current.metalCoverage]} METAL`;
  const liquid = current.liquidSurfaceMode === 'lava' ? 'LAVA' : 'WATER';
  const worldWidth = current.mapWidthLandCells * LAND_CELL_SIZE;
  const worldLength = current.mapLengthLandCells * LAND_CELL_SIZE;
  // ONE FIELD PER ENTRY, not one row. How many share a row is a typographic
  // decision about the headland the sign has to fill, and the painter makes
  // it: fixing the rows here fixes the block's shape, and a block whose shape
  // does not match the table cannot be inset by the same gap on all four
  // sides at any size — see resolveMapPresetLabelPlacement.
  const labelCaption = {
    title: presetName?.toUpperCase() ?? 'CUSTOM',
    info: [
      `${current.mapWidthLandCells} × ${current.mapLengthLandCells} LAND CELLS`,
      `${worldWidth} × ${worldLength} WORLD`,
      `${current.cap} ENTITY CAP`,
      terrain,
      liquid,
      `CENTER ${formatTerrainMagnitude(current.centerMagnitude)}`,
      `RING ${formatTerrainMagnitude(current.ringMagnitude)}`,
      `DIVIDERS ${formatTerrainMagnitude(current.dividersMagnitude)}`,
      `PERIMETER ${formatPerimeterMagnitude(current.perimeterMagnitude)}`,
      `PRECEDENCE ${current.terrainPrecedence === 'dividers-precedence' ? 'DIVIDERS' : 'PERIMETER'}`,
      `D-TERRAIN ${formatTerrainMagnitude(current.terrainDTerrain)}`,
      `METAL STEP ${formatTerrainMagnitude(current.metalDepositStep)}`,
      `DETAIL ${current.terrainDetail}`,
    ],
    byline: [AUTHOR_BYLINE.siteUrl, AUTHOR_BYLINE.email],
  };
  return {
    presetName,
    backdropPresetName: presetName,
    labelCaption,
  };
}

function findMatchingPresetName(c: BattlePresetSnapshot): string | null {
  for (const mode of ['demo', 'real'] as const) {
    const preset = getModeDefaultPreset(mode);
    if (presetMatchesCurrent(preset, c)) return preset.name;
  }
  for (const p of BATTLE_PRESETS) {
    if (presetMatchesCurrent(p, c)) return p.name;
  }
  return null;
}
