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
import { FIRST_ALLY_TEAM_ID, MAX_ALLY_TEAM_COUNT } from '../sim/teamRoster';
import type { LobbySettings } from '@/types/network';
import {
  isLiquidSurfaceMode,
  isMetalCoverage,
  type LiquidSurfaceMode,
  type MetalCoverage,
} from '@/types/worldSurfaceMode';
import {
  isTerrainPrecedence,
  type TerrainPrecedence,
} from '@/types/terrainPrecedence';
import {
  normalizeSimulationTickRateHz,
  simulationTicksForDefaultTicks,
} from '@/types/simulationTickRate';

// Turbine animation and wind particles are presentation-only. Keep them out
// of the deterministic content hash so visual tuning cannot split lockstep.
const {
  turbine: _windTurbinePresentation,
  particles: _windParticlePresentation,
  ...canonicalWindConfigJson
} = windConfigJson;

// There is deliberately no schema-version tag in the initialization: one
// build everywhere (budget_design_philosophy.html, "One build, everywhere"),
// and `content.buildFingerprint` below already makes any two builds hash
// differently, so a hand-bumped schema number on top carried no information.
const APP_SOURCE_VERSION = '0.0.1';
export const SIM_WASM_EXPECTED_VERSION = 'rts-sim-wasm 0.0.1';
const BUILD_FINGERPRINT = __BA_BUILD_FINGERPRINT__;

export type CanonicalMatchInitialization = {
  readonly lockstep: LockstepArchitectureConfig;
  readonly gameId: string;
  readonly roomCode: string;
  readonly hostPlayerId: PlayerId;
  readonly playerIds: readonly PlayerId[];
  /** How many SIDES the lobby declared. Hashed separately from the per-seat
   *  list because a declared side the host left empty is still a side: it
   *  takes a terrain slice, deposits and a spawn arc, and simply has no
   *  commander on it. Deriving the count from the occupied sides instead
   *  would silently delete that slice. */
  readonly allyTeamCount: number;
  /** SIDE per seat, index-aligned with `playerIds` — BAR's ally team, the
   *  lobby's TEAM N. Part of the hashed initialization because it decides
   *  terrain slices, spawn angles, and who can shoot whom: two peers that
   *  disagreed here would diverge on frame one. */
  readonly allyTeamIds: readonly number[];
  /** Seats with AGENT TYPE 'bot' — driven by the deterministic in-sim
   *  policy, no connection, no commands. */
  readonly aiPlayerIds: readonly PlayerId[];
  /** Seats with INITIAL STATE 'base' — the authored full base instead of a
   *  lone commander. Orthogonal to aiPlayerIds; the axes mix freely. */
  readonly baseSeatPlayerIds: readonly PlayerId[];
  readonly gameGenerationSeed: number;
  readonly map: {
    readonly centerMagnitude: number | null;
    readonly ringMagnitude: number | null;
    readonly dividersMagnitude: number | null;
    readonly perimeterMagnitude: number | null;
    readonly terrainPrecedence: TerrainPrecedence | null;
    readonly terrainDTerrain: number | null;
    readonly plateauWallSlopeDegrees: number | null;
    readonly metalDepositStep: number | null;
    readonly terrainDetail: number | null;
    readonly mapWidthLandCells: number | null;
    readonly mapLengthLandCells: number | null;
    readonly metalCoverage: MetalCoverage | null;
    readonly liquidSurfaceMode: LiquidSurfaceMode | null;
  };
  readonly gameplay: {
    readonly entityCountCap: number | null;
    readonly converterTax: number | null;
    readonly fogOfWarEnabled: true;
    readonly slowDownAtFinalWaypoint: boolean;
    readonly pathfindingConsidersUnits: boolean;
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
  /** Sides the lobby declared, empty ones included. Omitted means "however
   *  many the assignment mentions", which is what an offline start or a test
   *  fixture means. */
  allyTeamCount?: number | undefined;
  aiPlayerIds?: Iterable<PlayerId> | undefined;
  baseSeatPlayerIds?: Iterable<PlayerId> | undefined;
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
  allyTeamCount,
  aiPlayerIds,
  baseSeatPlayerIds,
  settings,
  gameGenerationSeed = DEFAULT_GAME_GENERATION_SEED,
}: BuildCanonicalMatchInitializationOptions): CanonicalMatchInitialization {
  const seats = normalizePlayerIds(playerIds);
  const sides = canonicalAllyTeamIds(seats, allyTeamByPlayerId, allyTeamCount);
  const simulationTickRateHz = normalizeSimulationTickRateHz(
    settings?.simulationTickRateHz,
  );
  return {
    lockstep: {
      ...ARCHITECTURE_CONFIG.lockstep,
      fixedStepHz: simulationTickRateHz,
      inputDelayTicks: simulationTicksForDefaultTicks(
        simulationTickRateHz,
        ARCHITECTURE_CONFIG.lockstep.inputDelayTicks,
      ),
      checksumIntervalTicks: simulationTicksForDefaultTicks(
        simulationTickRateHz,
        ARCHITECTURE_CONFIG.lockstep.checksumIntervalTicks,
      ),
    },
    gameId,
    roomCode,
    hostPlayerId,
    playerIds: seats,
    allyTeamCount: canonicalAllyTeamCount(sides, allyTeamCount),
    allyTeamIds: sides,
    aiPlayerIds: normalizePlayerIds(aiPlayerIds ?? []),
    baseSeatPlayerIds: normalizePlayerIds(baseSeatPlayerIds ?? []),
    gameGenerationSeed: normalizeGameGenerationSeed(gameGenerationSeed),
    map: {
      centerMagnitude: finiteOrNull(settings?.centerMagnitude),
      ringMagnitude: finiteOrNull(settings?.ringMagnitude),
      dividersMagnitude: finiteOrNull(settings?.dividersMagnitude),
      perimeterMagnitude: finiteOrNull(settings?.perimeterMagnitude),
      terrainPrecedence: isTerrainPrecedence(settings?.terrainPrecedence)
        ? settings.terrainPrecedence
        : null,
      terrainDTerrain: finiteOrNull(settings?.terrainDTerrain),
      plateauWallSlopeDegrees: finiteOrNull(settings?.plateauWallSlopeDegrees),
      metalDepositStep: finiteOrNull(settings?.metalDepositStep),
      terrainDetail: finiteOrNull(settings?.terrainDetail),
      mapWidthLandCells: finiteOrNull(settings?.mapWidthLandCells),
      mapLengthLandCells: finiteOrNull(settings?.mapLengthLandCells),
      metalCoverage: isMetalCoverage(settings?.metalCoverage)
        ? settings.metalCoverage
        : null,
      liquidSurfaceMode: isLiquidSurfaceMode(settings?.liquidSurfaceMode)
        ? settings.liquidSurfaceMode
        : null,
    },
    gameplay: {
      entityCountCap: finiteOrNull(settings?.entityCountCap),
      converterTax: finiteOrNull(settings?.converterTax),
      fogOfWarEnabled: true,
      slowDownAtFinalWaypoint: settings?.slowDownAtFinalWaypoint === true,
      pathfindingConsidersUnits: settings?.pathfindingConsidersUnits === true,
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

/** Re-read a canonical initialization's index-aligned side list as the seat ->
 *  side map every builder and the sim take. One reader so the roster the sim
 *  builds and the roster the renderer builds cannot drift. */
export function allyTeamByPlayerIdFromInitialization(
  initialization: Pick<CanonicalMatchInitialization, 'playerIds' | 'allyTeamIds'>,
): Record<number, number> | undefined {
  const sides = initialization.allyTeamIds;
  if (sides === undefined || sides.length !== initialization.playerIds.length) return undefined;
  const out: Record<number, number> = {};
  for (let i = 0; i < initialization.playerIds.length; i++) {
    out[initialization.playerIds[i]] = sides[i];
  }
  return out;
}

export function hashCanonicalMatchInitialization(
  initialization: CanonicalMatchInitialization,
): string {
  return hashCanonicalValue(initialization);
}

export function hashCanonicalValue(value: unknown): string {
  const hash = hashCanonicalValueInto(FNV1A32_OFFSET_BASIS, value);
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

const FNV1A32_OFFSET_BASIS = 0x811c9dc5;
const FNV1A32_PRIME = 0x01000193;
const CANONICAL_NULL = 'null';
const CANONICAL_UNDEFINED = '{"$undefined":true}';
const CHAR_COMMA = 0x2c;
const CHAR_COLON = 0x3a;
const CHAR_LBRACKET = 0x5b;
const CHAR_RBRACKET = 0x5d;
const CHAR_LBRACE = 0x7b;
const CHAR_RBRACE = 0x7d;

/**
 * FNV-1a over the canonical text of `value`, streamed: this feeds the hash
 * exactly the character sequence the canonical stringifier would produce
 * (sorted object keys, JSON primitives, `,`/`:` separators, `{"$undefined":true}`
 * for undefined) without ever materializing that text. The old path built a
 * multi-megabyte string per checksum through repeated concatenation and then
 * walked it with charCodeAt; the hash value is byte-for-byte the same.
 */
function hashCanonicalValueInto(hash: number, value: unknown): number {
  if (value === null) return hashStringInto(hash, CANONICAL_NULL);
  if (value === undefined) return hashStringInto(hash, CANONICAL_UNDEFINED);
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${String(value)}`);
    }
    return hashStringInto(hash, JSON.stringify(value));
  }
  if (type === 'string' || type === 'boolean') {
    return hashStringInto(hash, JSON.stringify(value));
  }
  if (Array.isArray(value)) {
    hash = hashCharInto(hash, CHAR_LBRACKET);
    for (let i = 0; i < value.length; i++) {
      if (i > 0) hash = hashCharInto(hash, CHAR_COMMA);
      hash = hashCanonicalValueInto(hash, value[i]);
    }
    return hashCharInto(hash, CHAR_RBRACKET);
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    hash = hashCharInto(hash, CHAR_LBRACE);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (i > 0) hash = hashCharInto(hash, CHAR_COMMA);
      hash = hashStringInto(hash, JSON.stringify(key));
      hash = hashCharInto(hash, CHAR_COLON);
      hash = hashCanonicalValueInto(hash, record[key]);
    }
    return hashCharInto(hash, CHAR_RBRACE);
  }
  throw new Error(`Cannot canonicalize value of type ${type}`);
}

function hashCharInto(hash: number, charCode: number): number {
  return Math.imul(hash ^ charCode, FNV1A32_PRIME) >>> 0;
}

function hashStringInto(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), FNV1A32_PRIME) >>> 0;
  }
  return hash;
}

function normalizePlayerIds(playerIds: Iterable<PlayerId>): PlayerId[] {
  return [...new Set(playerIds)].sort((a, b) => a - b);
}

/**
 * Sides for the canonical roster, index-aligned with `seats`.
 *
 * When the lobby declared a side count, seats keep the side the host put them
 * on, clamped into 1..count. Nothing is renumbered, because a side the host
 * created and left empty must still exist at frame 0 — it owns a terrain
 * slice, deposits and a spawn arc, and only lacks a commander.
 *
 * With no declared count there is no authored shape to preserve, so sides are
 * renumbered densely in seat order: two hosts that reached the same grouping
 * by different routes then produce the same canonical value and the same
 * initialization hash. A seat with no assignment is its own side.
 */
function canonicalAllyTeamIds(
  seats: readonly PlayerId[],
  assignment: Readonly<Record<number, number>> | undefined,
  declaredAllyTeamCount: number | undefined,
): number[] {
  if (declaredAllyTeamCount !== undefined) {
    const sides = clampAllyTeamCount(declaredAllyTeamCount);
    const out: number[] = [];
    for (const seat of seats) {
      const raw = assignment?.[seat];
      const id = typeof raw === 'number' && Number.isFinite(raw)
        ? Math.floor(raw)
        : FIRST_ALLY_TEAM_ID;
      out.push(id >= FIRST_ALLY_TEAM_ID && id < FIRST_ALLY_TEAM_ID + sides
        ? id
        : FIRST_ALLY_TEAM_ID);
    }
    return out;
  }

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

/** The declared side count that goes into the hash: the lobby's number when
 *  it gave one, otherwise the number the derived per-seat list implies. */
function canonicalAllyTeamCount(
  sides: readonly number[],
  declaredAllyTeamCount: number | undefined,
): number {
  if (declaredAllyTeamCount !== undefined) return clampAllyTeamCount(declaredAllyTeamCount);
  let highest = FIRST_ALLY_TEAM_ID;
  for (const id of sides) {
    if (id > highest) highest = id;
  }
  return highest - FIRST_ALLY_TEAM_ID + 1;
}

function clampAllyTeamCount(value: number): number {
  return Math.max(1, Math.min(MAX_ALLY_TEAM_COUNT, Math.floor(value) || 1));
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
