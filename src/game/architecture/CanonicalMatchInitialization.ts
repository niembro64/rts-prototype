import {
  ARCHITECTURE_CONFIG,
  type LockstepArchitectureConfig,
} from '../../architectureConfig';
import buildConfigJson from '../../buildConfig.json';
import combatConfigJson from '../../combatConfig.json';
import economyConfigJson from '../../economyConfig.json';
import fogConfigJson from '../../fogConfig.json';
import metalDepositConfigJson from '../../metalDepositConfig.json';
import physicsTuningConfigJson from '../../physicsTuningConfig.json';
import realBattleConfigJson from '../../realBattleConfig.json';
import sharedSimConstantsJson from '../../sharedSimConstants.json';
import visionConfigJson from '../../visionConfig.json';
import windConfigJson from '../../windConfig.json';
import buildingsJson from '../sim/blueprints/buildings.json';
import fallbackJson from '../sim/blueprints/fallbacks.json';
import inclusionLockOnConfigJson from '../sim/blueprints/inclusionLockOnConfig.json';
import pathfindingConfigJson from '../sim/blueprints/pathfindingConfig.json';
import raysJson from '../sim/blueprints/rays.json';
import shieldMaterialsJson from '../sim/blueprints/shieldMaterials.json';
import shieldsJson from '../sim/blueprints/shields.json';
import shotsJson from '../sim/blueprints/shots.json';
import towersJson from '../sim/blueprints/towers.json';
import turretsJson from '../sim/blueprints/turrets.json';
import unitRosterJson from '../sim/blueprints/unitRoster.json';
import unitsJson from '../sim/blueprints/units.json';
import shotProfileConfigJson from '../sim/shotProfileConfig.json';
import { SERVER_WORLD_SEED } from '../server/ServerBootstrap';
import type { PlayerId } from '../sim/types';
import type { LobbySettings } from '@/types/network';

const CANONICAL_MATCH_INITIALIZATION_SCHEMA = 'budget-annihilation.match-init.v2';
const APP_SOURCE_VERSION = '0.0.1';
export const SIM_WASM_EXPECTED_VERSION = 'rts-sim-wasm 0.0.1';

export type CanonicalMatchInitialization = {
  readonly schema: typeof CANONICAL_MATCH_INITIALIZATION_SCHEMA;
  readonly lockstep: LockstepArchitectureConfig;
  readonly gameId: string;
  readonly roomCode: string;
  readonly hostPlayerId: PlayerId;
  readonly playerIds: readonly PlayerId[];
  readonly aiPlayerIds: readonly PlayerId[];
  readonly seed: number;
  readonly map: {
    readonly centerMagnitude: number | null;
    readonly dividersMagnitude: number | null;
    readonly terrainMapShape: string | null;
    readonly terrainDTerrain: number | null;
    readonly metalDepositStep: number | null;
    readonly terrainDetail: number | null;
    readonly mapWidthLandCells: number | null;
    readonly mapLengthLandCells: number | null;
  };
  readonly gameplay: {
    readonly maxTotalUnits: number | null;
    readonly converterTax: number | null;
    readonly fogOfWarEnabled: true;
  };
  readonly content: {
    readonly appSourceVersion: string;
    readonly buildMode: string;
    readonly simWasmExpectedVersion: string;
    readonly blueprintHash: string;
    readonly gameplayConfigHash: string;
  };
};

export type BuildCanonicalMatchInitializationOptions = {
  gameId: string;
  roomCode: string;
  hostPlayerId: PlayerId;
  playerIds: Iterable<PlayerId>;
  aiPlayerIds?: Iterable<PlayerId> | undefined;
  settings: LobbySettings | undefined;
};

const BLUEPRINT_CONTENT = {
  buildings: buildingsJson,
  fallbacks: fallbackJson,
  inclusionLockOnConfig: inclusionLockOnConfigJson,
  pathfindingConfig: pathfindingConfigJson,
  rays: raysJson,
  shieldMaterials: shieldMaterialsJson,
  shields: shieldsJson,
  shots: shotsJson,
  towers: towersJson,
  turrets: turretsJson,
  unitRoster: unitRosterJson,
  units: unitsJson,
  shotProfileConfig: shotProfileConfigJson,
} as const;

const GAMEPLAY_CONFIG_CONTENT = {
  buildConfig: buildConfigJson,
  combatConfig: combatConfigJson,
  economyConfig: economyConfigJson,
  fogConfig: fogConfigJson,
  metalDepositConfig: metalDepositConfigJson,
  physicsTuningConfig: physicsTuningConfigJson,
  realBattleConfig: realBattleConfigJson,
  sharedSimConstants: sharedSimConstantsJson,
  visionConfig: visionConfigJson,
  windConfig: windConfigJson,
} as const;

export function buildCanonicalMatchInitialization({
  gameId,
  roomCode,
  hostPlayerId,
  playerIds,
  aiPlayerIds,
  settings,
}: BuildCanonicalMatchInitializationOptions): CanonicalMatchInitialization {
  return {
    schema: CANONICAL_MATCH_INITIALIZATION_SCHEMA,
    lockstep: ARCHITECTURE_CONFIG.lockstep,
    gameId,
    roomCode,
    hostPlayerId,
    playerIds: normalizePlayerIds(playerIds),
    aiPlayerIds: normalizePlayerIds(aiPlayerIds ?? []),
    seed: SERVER_WORLD_SEED,
    map: {
      centerMagnitude: finiteOrNull(settings?.centerMagnitude),
      dividersMagnitude: finiteOrNull(settings?.dividersMagnitude),
      terrainMapShape: settings?.terrainMapShape ?? null,
      terrainDTerrain: finiteOrNull(settings?.terrainDTerrain),
      metalDepositStep: finiteOrNull(settings?.metalDepositStep),
      terrainDetail: finiteOrNull(settings?.terrainDetail),
      mapWidthLandCells: finiteOrNull(settings?.mapWidthLandCells),
      mapLengthLandCells: finiteOrNull(settings?.mapLengthLandCells),
    },
    gameplay: {
      maxTotalUnits: finiteOrNull(settings?.maxTotalUnits),
      converterTax: finiteOrNull(settings?.converterTax),
      fogOfWarEnabled: true,
    },
    content: {
      appSourceVersion: APP_SOURCE_VERSION,
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

export function canonicalStringify(value: unknown): string {
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

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
