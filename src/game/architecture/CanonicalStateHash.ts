import { economyManager } from '../sim/economy';
import { getVegetationStateHash } from '../sim/vegetation';
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
  readonly entityHashes?: readonly CanonicalEntityStateHash[];
};

type CanonicalEntityStateHash = {
  readonly id: number;
  readonly type: string;
  readonly hash: string;
  readonly components: { readonly [component: string]: string };
  readonly componentFields?: {
    readonly [component: string]: { readonly [field: string]: string };
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

/**
 * Two hashes over ONE canonical truth (budget_design_philosophy.html,
 * "Two state hashes over one truth"):
 *
 *   LIGHT  what the living match runs on. Covers EVERYTHING the full hash
 *          covers — every entity, every field — because the sections hash
 *          the complete canonical state. What it skips is the per-entity /
 *          per-component / per-field DIAGNOSTIC breakdown, which is the
 *          overwhelming majority of the cost (~120 separate stringify+hash
 *          passes per entity) and of the wire weight (megabytes per
 *          checksum at high entity counts), and which nothing reads until
 *          something has already gone wrong.
 *   FULL   the same light hash plus that breakdown. Computed on demand at
 *          the moments that justify it: a desync being reported, an
 *          initialization mismatch, a diagnostics export. Its `hash` and
 *          `sections` are byte-identical to light's, so a full hash can
 *          always be compared against a light one.
 *
 * The root hash is composed from the section hashes rather than from a
 * second stringify of the whole state — one pass over the state instead of
 * two, and the same answer on every peer running the same build. That
 * composition (and any change to what the sections cover) shifts every hash
 * value, which is why LOCKSTEP_PROTOCOL_VERSION must be bumped alongside:
 * two builds that hash differently must be refused at the door, not
 * discovered as a phantom desync 180 ticks in.
 */
export function hashCanonicalServerStateLight(core: ServerSimulationCore): CanonicalServerStateHash {
  return finishLightHash(buildCanonicalServerState(core));
}

export function hashCanonicalServerStateFull(core: ServerSimulationCore): CanonicalServerStateHash {
  const state = buildCanonicalServerState(core);
  return {
    ...finishLightHash(state),
    entityHashes: buildEntityHashes(state.entities),
  };
}

function finishLightHash(state: CanonicalServerState): CanonicalServerStateHash {
  const sections = {
    world: hashCanonicalValue(state.world),
    simulation: hashCanonicalValue(state.simulation),
    economy: hashCanonicalValue(state.economy),
    commands: hashCanonicalValue(state.commands),
    entities: hashCanonicalValue(state.entities),
  };
  return {
    hash: hashCanonicalValue({ schema: state.schema, ...sections }),
    sections,
  };
}

export function buildCanonicalServerState(core: ServerSimulationCore): CanonicalServerState {
  const world = core.world;
  const simulation = core.simulation;
  const sortedEntities = world.getAllEntities().slice().sort((a, b) => a.id - b.id);
  const entities = new Array<CanonicalValue>(sortedEntities.length);
  for (let i = 0; i < sortedEntities.length; i++) {
    entities[i] = serializeEntity(sortedEntities[i]);
  }
  const playerIds = core.playerIds.slice().sort((a, b) => a - b);
  const economyStates = new Array<CanonicalValue>(playerIds.length);
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    economyStates[i] = {
      playerId,
      state: toCanonicalValue(economyManager.getEconomy(playerId)),
    };
  }

  return {
    schema: 'budget-annihilation.server-state.v1',
    world: {
      tick: world.getTick(),
      nextEntityId: world.getNextEntityId(),
      gameGenerationSeed: world.getGameGenerationSeed(),
      rngSeed: world.getRandomStreamState(),
      activePlayerId: world.activePlayerId,
      playerCount: world.playerCount,
      simulationTickRateHz: world.simulationTickRateHz,
      playerIds,
      mapWidth: world.mapWidth,
      mapHeight: world.mapHeight,
      entityCountCap: world.entityCountCap,
      turretShieldPanelsEnabled: world.turretShieldPanelsEnabled,
      turretShieldSpheresEnabled: world.turretShieldSpheresEnabled,
      // Shield-aware targeting is derived per player from building
      // ownership; the buildings themselves are already hashed.
      shieldReflectionMode: world.shieldReflectionMode,
      fogOfWarEnabled: world.fogOfWarEnabled,
      slowDownAtFinalWaypoint: world.slowDownAtFinalWaypoint,
      slopePathMode: world.slopePathMode,
      pathfindingCellConsolidationMultiplier:
        world.pathfindingCellConsolidationMultiplier,
      metalCoverage: world.metalCoverage,
      liquidSurfaceMode: world.liquidSurfaceMode,
      converterTax: world.converterTax,
      unitGroundNormalEmaMode: getUnitGroundNormalEmaMode(),
      buildingVersion: world.getBuildingVersion(),
      unitSetVersion: world.getUnitSetVersion(),
      maxTargetableRadius: world.getMaxTargetableRadius(),
      maxVisibilityPadding: world.getMaxVisibilityPadding(),
      alliesByPlayer: serializeAllies(world.alliesByPlayer),
      scanPulses: toCanonicalValue(world.scanPulses),
      metalDeposits: toCanonicalValue(world.metalDeposits),
      // Trees, grass, and seaweed are a contested energy supply now, so a
      // peer whose forest diverged has desynced. The kernel hashes live
      // props (index + quantized remaining work) rather than the whole
      // immutable layout, which is already implied by the map inputs.
      vegetation: getVegetationStateHash(),
      resourceMovements: toCanonicalValue(world.resourceMovements),
    },
    simulation: {
      gamePhase: simulation.getGamePhase(),
      winnerId: simulation.getWinnerId(),
      simElapsedMs: simulation.getSimElapsedMs(),
      windState: toCanonicalValue(simulation.getWindState()),
    },
    economy: economyStates,
    commands: toCanonicalValue(core.commandQueue.getAll()),
    entities,
  };
}

function serializeAllies(
  alliesByPlayer: ReadonlyMap<PlayerId, ReadonlySet<PlayerId>>,
): CanonicalValue {
  const entries = [...alliesByPlayer.entries()].sort(([a], [b]) => a - b);
  const output = new Array<CanonicalValue>(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const [playerId, allies] = entries[i];
    output[i] = {
      playerId,
      allies: [...allies].sort((a, b) => a - b),
    };
  }
  return output;
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
    selectable: serializeSelectable(entity.selectable),
    ownership: toCanonicalValue(entity.ownership),
    unit: serializeUnit(entity.unit),
    building: toCanonicalValue(entity.building),
    combat: toCanonicalValue(entity.combat),
    projectile: serializeProjectile(entity.projectile),
    buildable: toCanonicalValue(entity.buildable),
    builder: toCanonicalValue(entity.builder),
    factory: toCanonicalValue(entity.factory),
    commander: toCanonicalValue(entity.commander),
    dgunProjectile: toCanonicalValue(entity.dgunProjectile),
    wreck: toCanonicalValue(entity.wreck),
    transport: serializeTransport(entity.transport),
    transported: toCanonicalValue(entity.transported),
    heldBy: toCanonicalValue(entity.heldBy),
    buildingBlueprintId: toCanonicalValue(entity.buildingBlueprintId),
    coveredDepositIds: toCanonicalValue(entity.coveredDepositIds),
    metalExtractionRate: toCanonicalValue(entity.metalExtractionRate),
  };
}

function serializeSelectable(value: Entity['selectable']): CanonicalValue {
  if (value === null) return null;
  return { enabled: true };
}

function serializeUnit(value: Entity['unit']): CanonicalValue {
  if (value === null) return null;
  const {
    activePath: _activePath,
    velocityX: _velocityX,
    velocityY: _velocityY,
    velocityZ: _velocityZ,
    thrustDirX: _thrustDirX,
    thrustDirY: _thrustDirY,
    headingDirX: _headingDirX,
    headingDirY: _headingDirY,
    surfaceNormal: _surfaceNormal,
    ...canonicalUnit
  } = value;
  return toCanonicalValue(canonicalUnit);
}

function serializeTransport(value: Entity['transport']): CanonicalValue {
  if (value === null) return null;
  const loadedUnitIds = new Array<number>(value.loadedUnits.length);
  for (let i = 0; i < value.loadedUnits.length; i++) loadedUnitIds[i] = value.loadedUnits[i].id;
  loadedUnitIds.sort((a, b) => a - b);
  return {
    capacity: value.capacity,
    loadedUnitIds,
  };
}

function serializeProjectile(value: Entity['projectile']): CanonicalValue {
  if (value === null) return null;
  const {
    prevStartX: _prevStartX,
    prevStartY: _prevStartY,
    prevStartZ: _prevStartZ,
    prevEndX: _prevEndX,
    prevEndY: _prevEndY,
    prevEndZ: _prevEndZ,
    prevEndTick: _prevEndTick,
    prevEndEntityId: _prevEndEntityId,
    prevReflectionPoints: _prevReflectionPoints,
    pendingReflectionX: _pendingReflectionX,
    pendingReflectionY: _pendingReflectionY,
    pendingReflectionZ: _pendingReflectionZ,
    ...canonicalProjectile
  } = value;
  return toCanonicalValue(canonicalProjectile);
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
    groundTangentialDampingRate: body.groundTangentialDampingRate,
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
  if (Array.isArray(value)) {
    const output = new Array<CanonicalValue>(value.length);
    for (let i = 0; i < value.length; i++) output[i] = toCanonicalValue(value[i]);
    return output;
  }
  if (value instanceof Set) {
    const output: CanonicalValue[] = [];
    for (const item of value) output.push(toCanonicalValue(item));
    output.sort(compareCanonicalValues);
    return output;
  }
  if (value instanceof Map) {
    const output: CanonicalValue[] = [];
    for (const [key, mapValue] of value) {
      output.push({
        key: toCanonicalValue(key),
        value: toCanonicalValue(mapValue),
      });
    }
    output.sort((a, b) => {
      if (!isCanonicalObject(a) || !isCanonicalObject(b)) return compareCanonicalValues(a, b);
      return compareCanonicalValues(a.key, b.key);
    });
    return output;
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

function buildEntityHashes(entities: CanonicalValue): readonly CanonicalEntityStateHash[] {
  if (!Array.isArray(entities)) return [];
  const hashes = new Array<CanonicalEntityStateHash>(entities.length);
  for (let i = 0; i < entities.length; i++) {
    const entityState = entities[i];
    if (!isCanonicalObject(entityState)) {
      hashes[i] = {
        id: -1,
        type: 'unknown',
        hash: hashCanonicalValue(entityState),
        components: {},
        componentFields: {},
      };
      continue;
    }

    const id = typeof entityState.id === 'number' ? entityState.id : -1;
    const type = typeof entityState.type === 'string' ? entityState.type : 'unknown';
    const components: Record<string, string> = {};
    const componentFields: Record<string, Record<string, string>> = {};
    for (const key of Object.keys(entityState).sort()) {
      if (key === 'id' || key === 'type') continue;
      const component = entityState[key];
      components[key] = hashCanonicalValue(component);
      if (isCanonicalObject(component)) {
        const fieldHashes: Record<string, string> = {};
        for (const field of Object.keys(component).sort()) {
          fieldHashes[field] = hashCanonicalValue(component[field]);
        }
        componentFields[key] = fieldHashes;
      }
    }
    hashes[i] = {
      id,
      type,
      // Composed from the component hashes already in hand rather than a
      // second full stringify of the entity — this value is diagnostic
      // (never compared across the wire for agreement), so its cheapness
      // matters more than its spelling.
      hash: hashCanonicalValue({ id, type, ...components }),
      components,
      componentFields,
    };
  }
  return hashes;
}

function isCanonicalObject(value: CanonicalValue): value is { readonly [key: string]: CanonicalValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCanonicalValues(a: CanonicalValue, b: CanonicalValue): number {
  const aHash = hashCanonicalValue(a);
  const bHash = hashCanonicalValue(b);
  return aHash < bHash ? -1 : aHash > bHash ? 1 : 0;
}
