import { economyManager } from '../sim/economy';
import { getUnitGroundNormalEmaMode } from '../sim/unitGroundNormal';
import type { Entity, PlayerId } from '../sim/types';
import type { Body3D } from '../server/PhysicsEngine3D';
import type { ServerSimulationCore } from '../server/ServerSimulationCore';
import { hashCanonicalValue } from './CanonicalMatchInitialization';

type CanonicalPrimitive = string | number | boolean | null;
type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export type CanonicalServerStateHash = {
  readonly hash: string;
  readonly sections: {
    readonly world: string;
    readonly simulation: string;
    readonly economy: string;
    readonly commands: string;
    readonly entities: string;
  };
};

export type CanonicalServerState = {
  readonly schema: string;
  readonly world: CanonicalValue;
  readonly simulation: CanonicalValue;
  readonly economy: CanonicalValue;
  readonly commands: CanonicalValue;
  readonly entities: CanonicalValue;
};

export function hashCanonicalServerState(core: ServerSimulationCore): CanonicalServerStateHash {
  const state = buildCanonicalServerState(core);
  return {
    hash: hashCanonicalValue(state),
    sections: {
      world: hashCanonicalValue(state.world),
      simulation: hashCanonicalValue(state.simulation),
      economy: hashCanonicalValue(state.economy),
      commands: hashCanonicalValue(state.commands),
      entities: hashCanonicalValue(state.entities),
    },
  };
}

export function buildCanonicalServerState(core: ServerSimulationCore): CanonicalServerState {
  const world = core.world;
  const simulation = core.simulation;
  const entities = world
    .getAllEntities()
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((entity) => serializeEntity(entity));
  const playerIds = core.playerIds.slice().sort((a, b) => a - b);

  return {
    schema: 'budget-annihilation.server-state.v1',
    world: {
      tick: world.getTick(),
      nextEntityId: world.getNextEntityId(),
      rngSeed: world.rng.getSeed(),
      activePlayerId: world.activePlayerId,
      playerCount: world.playerCount,
      playerIds,
      mapWidth: world.mapWidth,
      mapHeight: world.mapHeight,
      thrustMultiplier: world.thrustMultiplier,
      maxTotalUnits: world.maxTotalUnits,
      turretShieldPanelsEnabled: world.turretShieldPanelsEnabled,
      turretShieldSpheresEnabled: world.turretShieldSpheresEnabled,
      shieldsObstructSight: world.shieldsObstructSight,
      shieldReflectionMode: world.shieldReflectionMode,
      fogOfWarEnabled: world.fogOfWarEnabled,
      converterTax: world.converterTax,
      unitGroundNormalEmaMode: getUnitGroundNormalEmaMode(),
      buildingVersion: world.getBuildingVersion(),
      unitSetVersion: world.getUnitSetVersion(),
      maxTargetableRadius: world.getMaxTargetableRadius(),
      maxVisibilityPadding: world.getMaxVisibilityPadding(),
      alliesByPlayer: serializeAllies(world.alliesByPlayer),
      scanPulses: toCanonicalValue(world.scanPulses),
      metalDeposits: toCanonicalValue(world.metalDeposits),
      resourceMovements: toCanonicalValue(world.resourceMovements),
    },
    simulation: {
      gamePhase: simulation.getGamePhase(),
      winnerId: simulation.getWinnerId(),
      simElapsedMs: simulation.getSimElapsedMs(),
      windState: toCanonicalValue(simulation.getWindState()),
    },
    economy: playerIds.map((playerId) => ({
      playerId,
      state: toCanonicalValue(economyManager.getEconomy(playerId)),
    })),
    commands: toCanonicalValue(core.commandQueue.getAll()),
    entities,
  };
}

function serializeAllies(
  alliesByPlayer: ReadonlyMap<PlayerId, ReadonlySet<PlayerId>>,
): CanonicalValue {
  return [...alliesByPlayer.entries()]
    .sort(([a], [b]) => a - b)
    .map(([playerId, allies]) => ({
      playerId,
      allies: [...allies].sort((a, b) => a - b),
    }));
}

function serializeEntity(entity: Entity): CanonicalValue {
  return {
    id: entity.id,
    type: entity.type,
    transform: {
      x: entity.transform.x,
      y: entity.transform.y,
      z: entity.transform.z,
      rotation: entity.transform.rotation,
    },
    body: serializePhysicsBody(entity.body?.physicsBody ?? null),
    selectable: toCanonicalValue(entity.selectable),
    ownership: toCanonicalValue(entity.ownership),
    unit: toCanonicalValue(entity.unit),
    building: toCanonicalValue(entity.building),
    combat: toCanonicalValue(entity.combat),
    projectile: toCanonicalValue(entity.projectile),
    buildable: toCanonicalValue(entity.buildable),
    builder: toCanonicalValue(entity.builder),
    factory: toCanonicalValue(entity.factory),
    commander: toCanonicalValue(entity.commander),
    dgunProjectile: toCanonicalValue(entity.dgunProjectile),
    wreck: toCanonicalValue(entity.wreck),
    transport: serializeTransport(entity.transport),
    transported: toCanonicalValue(entity.transported),
    buildingBlueprintId: toCanonicalValue(entity.buildingBlueprintId),
    coveredDepositIds: toCanonicalValue(entity.coveredDepositIds),
    metalExtractionRate: toCanonicalValue(entity.metalExtractionRate),
    cachedFullVisionRadius: entity._cachedFullVisionRadius,
  };
}

function serializeTransport(value: Entity['transport']): CanonicalValue {
  if (value === null) return null;
  return {
    capacity: value.capacity,
    loadedUnitIds: value.loadedUnits
      .map((unit) => unit.id)
      .sort((a, b) => a - b),
  };
}

function serializePhysicsBody(body: Body3D | null): CanonicalValue {
  if (body === null) return null;
  return {
    shape: body.shape,
    mass: body.mass,
    isStatic: body.isStatic,
    label: body.label,
    entityId: body.entityId ?? null,
    x: body.x,
    y: body.y,
    z: body.z,
    vx: body.vx,
    vy: body.vy,
    vz: body.vz,
    ax: body.ax,
    ay: body.ay,
    az: body.az,
    groundLaunchAx: body.groundLaunchAx,
    groundLaunchAy: body.groundLaunchAy,
    groundLaunchAz: body.groundLaunchAz,
    surfaceNormalX: body.surfaceNormalX,
    surfaceNormalY: body.surfaceNormalY,
    surfaceNormalZ: body.surfaceNormalZ,
    radius: body.radius,
    halfX: body.halfX,
    halfY: body.halfY,
    halfZ: body.halfZ,
    invMass: body.invMass,
    restitution: body.restitution,
    groundOffset: body.groundOffset,
    groundFrictionScale: body.groundFrictionScale,
    sleepTicks: body.sleepTicks,
    sleeping: body.sleeping,
    upwardSurfaceContact: body.upwardSurfaceContact,
    supportTopZ: body.supportTopZ,
    supportHalfX: body.supportHalfX,
    supportHalfY: body.supportHalfY,
    unitSupportTopOffsetZ: body.unitSupportTopOffsetZ,
    unitSupportRadius: body.unitSupportRadius,
  };
}

function toCanonicalValue(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return canonicalNumber(value);
  if (Array.isArray(value)) return value.map((item) => toCanonicalValue(item));
  if (value instanceof Set) {
    return [...value].map((item) => toCanonicalValue(item)).sort(compareCanonicalValues);
  }
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, mapValue]) => ({
        key: toCanonicalValue(key),
        value: toCanonicalValue(mapValue),
      }))
      .sort((a, b) => compareCanonicalValues(a.key, b.key));
  }
  if (typeof value === 'object') {
    const output: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (typeof child === 'function') continue;
      output[key] = toCanonicalValue(child);
    }
    return output;
  }
  return String(value);
}

function canonicalNumber(value: number): CanonicalValue {
  if (Number.isFinite(value)) return value;
  if (Number.isNaN(value)) return { specialNumber: 'NaN' };
  return { specialNumber: value > 0 ? 'Infinity' : '-Infinity' };
}

function compareCanonicalValues(a: CanonicalValue, b: CanonicalValue): number {
  const aHash = hashCanonicalValue(a);
  const bHash = hashCanonicalValue(b);
  return aHash < bHash ? -1 : aHash > bHash ? 1 : 0;
}
