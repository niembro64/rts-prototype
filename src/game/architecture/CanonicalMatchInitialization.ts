import {
  ARCHITECTURE_CONFIG,
  type LockstepArchitectureConfig,
} from '../../architectureConfig';
import buildConfigJson from '../../buildConfig.json';
import combatConfigJson from '../../combatConfig.json';
import economyConfigJson from '../../economyConfig.json';
import metalDepositConfigJson from '../../metalDepositConfig.json';
import physicsTuningConfigJson from '../../physicsTuningConfig.json';
import pathfindingTuningConfigJson from '../sim/pathfindingTuningConfig.json';
import realBattleConfigJson from '../../realBattleConfig.json';
import sharedSimConstantsJson from '../../sharedSimConstants.json';
import visionConfigJson from '../../visionConfig.json';
import windConfigJson from '../../windConfig.json';
import buildingsJson from '../sim/blueprints/buildings.json';
import fallbackJson from '../sim/blueprints/fallbacks.json';
import inclusionLockOnConfigJson from '../sim/blueprints/inclusionLockOnConfig.json';
import raysJson from '../sim/blueprints/rays.json';
import shieldMaterialsJson from '../sim/blueprints/shieldMaterials.json';
import shieldsJson from '../sim/blueprints/shields.json';
import shotsJson from '../sim/blueprints/shots.json';
import turretsJson from '../sim/blueprints/turrets.json';
import unitRosterJson from '../sim/blueprints/unitRoster.json';
import unitsJson from '../sim/blueprints/units.json';
import unitLocomotionConfigJson from '../sim/unitLocomotionConfig.json';
import shotLocomotionConfigJson from '../sim/shotLocomotionConfig.json';
import shotProfileConfigJson from '../sim/shotProfileConfig.json';
import surfaceProbeConfigJson from '../sim/surfaceProbeConfig.json';
import {
  DEFAULT_GAME_GENERATION_SEED,
  normalizeGameGenerationSeed,
} from '../network/gameGenerationSeed';
import type { PlayerId } from '../sim/types';
import type { LobbySettings } from '@/types/network';
import {
  isLiquidSurfaceMode,
  isTerrainSurfaceMode,
  type LiquidSurfaceMode,
  type TerrainSurfaceMode,
} from '@/types/worldSurfaceMode';
import { isPathfindingCellConsolidationMultiplier } from '@/types/pathfinding';

// Turbine animation and wind particles are presentation-only. Keep them out
// of the deterministic content hash so visual tuning cannot split lockstep.
const {
  turbine: _windTurbinePresentation,
  particles: _windParticlePresentation,
  ...canonicalWindConfigJson
} = windConfigJson;

const CANONICAL_MATCH_INITIALIZATION_SCHEMA = 'budget-annihilation.match-init.v10';
const APP_SOURCE_VERSION = '0.0.1';
export const SIM_WASM_EXPECTED_VERSION = 'rts-sim-wasm 0.0.1';
export const BUILD_FINGERPRINT = __BA_BUILD_FINGERPRINT__;

export type CanonicalMatchInitialization = {
  readonly schema: typeof CANONICAL_MATCH_INITIALIZATION_SCHEMA;
  readonly lockstep: LockstepArchitectureConfig;
  readonly gameId: string;
  readonly roomCode: string;
  readonly hostPlayerId: PlayerId;
  readonly playerIds: readonly PlayerId[];
  /** SIDE per seat, index-aligned with `playerIds` — BAR's ally team, the
   *  lobby's TEAM N. Part of the hashed initialization because it decides
   *  terrain slices, spawn angles, and who can shoot whom: two peers that
   *  disagreed here would diverge on frame one. */
  readonly allyTeamIds: readonly number[];
  readonly aiPlayerIds: readonly PlayerId[];
  readonly gameGenerationSeed: number;
  readonly map: {
    readonly centerMagnitude: number | null;
    readonly dividersMagnitude: number | null;
    readonly perimeterMagnitude: number | null;
    readonly terrainDTerrain: number | null;
    readonly plateauWallSlopeDegrees: number | null;
    readonly metalDepositStep: number | null;
    readonly terrainDetail: number | null;
    readonly mapWidthLandCells: number | null;
    readonly mapLengthLandCells: number | null;
    readonly terrainSurfaceMode: TerrainSurfaceMode | null;
    readonly liquidSurfaceMode: LiquidSurfaceMode | null;
  };
  readonly gameplay: {
    readonly entityCountCap: number | null;
    readonly pathfindingCellConsolidationMultiplier: number | null;
    readonly converterTax: number | null;
    readonly fogOfWarEnabled: true;
    readonly slowDownAtFinalWaypoint: boolean;
  };
  readonly content: {
    readonly appSourceVersion: string;
    readonly buildFingerprint: string;
    readonly buildMode: string;
    readonly simWasmExpectedVersion: string;
    readonly blueprintHash: string;
    readonly gameplayConfigHash: string;
  };
};

type BuildCanonicalMatchInitializationOptions = {
  gameId: string;
  roomCode: string;
  hostPlayerId: PlayerId;
  playerIds: Iterable<PlayerId>;
  /** Seat -> side. Seats missing from the map become their own side, so an
   *  omitted assignment is exactly free-for-all. */
  allyTeamByPlayerId?: Readonly<Record<number, number>> | undefined;
  aiPlayerIds?: Iterable<PlayerId> | undefined;
  settings: LobbySettings | undefined;
  gameGenerationSeed?: number;
};

const BLUEPRINT_CONTENT = {
  buildings: buildingsJson,
  fallbacks: fallbackJson,
  inclusionLockOnConfig: inclusionLockOnConfigJson,
  rays: raysJson,
  shieldMaterials: shieldMaterialsJson,
  shields: shieldsJson,
  shots: shotsJson,
  turrets: turretsJson,
  unitRoster: unitRosterJson,
  units: unitsJson,
  shotProfileConfig: shotProfileConfigJson,
} as const;

const GAMEPLAY_CONFIG_CONTENT = {
  buildConfig: buildConfigJson,
  combatConfig: combatConfigJson,
  economyConfig: economyConfigJson,
  unitLocomotionConfig: unitLocomotionConfigJson,
  shotLocomotionConfig: shotLocomotionConfigJson,
  metalDepositConfig: metalDepositConfigJson,
  physicsTuningConfig: physicsTuningConfigJson,
  pathfindingTuningConfig: pathfindingTuningConfigJson,
  realBattleConfig: realBattleConfigJson,
  sharedSimConstants: sharedSimConstantsJson,
  surfaceProbeConfig: surfaceProbeConfigJson,
  visionConfig: visionConfigJson,
  windConfig: canonicalWindConfigJson,
} as const;

export function buildCanonicalMatchInitialization({
  gameId,
  roomCode,
  hostPlayerId,
  playerIds,
  allyTeamByPlayerId,
  aiPlayerIds,
  settings,
  gameGenerationSeed = DEFAULT_GAME_GENERATION_SEED,
}: BuildCanonicalMatchInitializationOptions): CanonicalMatchInitialization {
  const seats = normalizePlayerIds(playerIds);
  return {
    schema: CANONICAL_MATCH_INITIALIZATION_SCHEMA,
    lockstep: ARCHITECTURE_CONFIG.lockstep,
    gameId,
    roomCode,
    hostPlayerId,
    playerIds: seats,
    allyTeamIds: canonicalAllyTeamIds(seats, allyTeamByPlayerId),
    aiPlayerIds: normalizePlayerIds(aiPlayerIds ?? []),
    gameGenerationSeed: normalizeGameGenerationSeed(gameGenerationSeed),
    map: {
      centerMagnitude: finiteOrNull(settings?.centerMagnitude),
      dividersMagnitude: finiteOrNull(settings?.dividersMagnitude),
      perimeterMagnitude: finiteOrNull(settings?.perimeterMagnitude),
      terrainDTerrain: finiteOrNull(settings?.terrainDTerrain),
      plateauWallSlopeDegrees: finiteOrNull(settings?.plateauWallSlopeDegrees),
      metalDepositStep: finiteOrNull(settings?.metalDepositStep),
      terrainDetail: finiteOrNull(settings?.terrainDetail),
      mapWidthLandCells: finiteOrNull(settings?.mapWidthLandCells),
      mapLengthLandCells: finiteOrNull(settings?.mapLengthLandCells),
      terrainSurfaceMode: isTerrainSurfaceMode(settings?.terrainSurfaceMode)
        ? settings.terrainSurfaceMode
        : null,
      liquidSurfaceMode: isLiquidSurfaceMode(settings?.liquidSurfaceMode)
        ? settings.liquidSurfaceMode
        : null,
    },
    gameplay: {
      entityCountCap: finiteOrNull(settings?.entityCountCap),
      pathfindingCellConsolidationMultiplier:
        isPathfindingCellConsolidationMultiplier(
          settings?.pathfindingCellConsolidationMultiplier,
        )
          ? settings.pathfindingCellConsolidationMultiplier
          : null,
      converterTax: finiteOrNull(settings?.converterTax),
      fogOfWarEnabled: true,
      slowDownAtFinalWaypoint: settings?.slowDownAtFinalWaypoint === true,
    },
    content: {
      appSourceVersion: APP_SOURCE_VERSION,
      buildFingerprint: BUILD_FINGERPRINT,
      buildMode: import.meta.env.MODE,
      simWasmExpectedVersion: SIM_WASM_EXPECTED_VERSION,
      blueprintHash: hashCanonicalValue(BLUEPRINT_CONTENT),
      gameplayConfigHash: hashCanonicalValue(GAMEPLAY_CONFIG_CONTENT),
    },
  };
}

export function hashCanonicalMatchInitialization(
  initialization: CanonicalMatchInitialization,
): string {
  return hashCanonicalValue(initialization);
}

export function hashCanonicalValue(value: unknown): string {
  const text = canonicalStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '{"$undefined":true}';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    let text = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) text += ',';
      text += canonicalStringify(value[i]);
    }
    return `${text}]`;
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    let text = '{';
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (i > 0) text += ',';
      text += `${JSON.stringify(key)}:${canonicalStringify(record[key])}`;
    }
    return `${text}}`;
  }
  throw new Error(`Cannot canonicalize value of type ${type}`);
}

function normalizePlayerIds(playerIds: Iterable<PlayerId>): PlayerId[] {
  return [...new Set(playerIds)].sort((a, b) => a - b);
}

/**
 * Sides for the canonical roster, index-aligned with `seats`.
 *
 * Renumbered densely in seat order so two hosts that reached the same
 * grouping by different lobby routes (one emptied TEAM 2, the other never
 * created it) produce the SAME canonical value and therefore the same
 * initialization hash. A seat with no assignment is its own side.
 */
function canonicalAllyTeamIds(
  seats: readonly PlayerId[],
  assignment: Readonly<Record<number, number>> | undefined,
): number[] {
  const dense = new Map<number, number>();
  const out: number[] = [];
  for (const seat of seats) {
    const raw = assignment?.[seat];
    // Unassigned seats key off their own id, namespaced away from real
    // side ids so they can never collide with one.
    const source = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : -seat;
    let id = dense.get(source);
    if (id === undefined) {
      id = dense.size + 1;
      dense.set(source, id);
    }
    out.push(id);
  }
  return out;
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
