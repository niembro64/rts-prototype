import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { getBuildFraction } from '../sim/buildableHelpers';
import { isCommander } from '../sim/combat/combatUtils';
import type {
  NetworkServerSnapshotAction,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotTurret,
} from './NetworkManager';
import type { Vec3 } from '../../types/vec2';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_JUMP,
  ENTITY_CHANGED_MOVEMENT_ACCEL,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_SUSPENSION,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
  buildingTypeToCode,
  turretIdToCode,
  turretStateToCode,
  unitTypeToCode,
} from '../../types/network';
import {
  createActionDto,
  createTurretDto,
  createWaypointDto,
  type WaypointDto,
} from './snapshotDtoCopy';
import {
  clearNetworkUnitActions,
  clearNetworkUnitCombatMode,
  clearNetworkUnitJump,
  clearNetworkUnitMovementAccel,
  clearNetworkUnitStaticFields,
  clearNetworkUnitSurfaceNormal,
  clearNetworkUnitSuspension,
  createNetworkUnitSnapshot,
  writeNetworkUnitActions,
  writeNetworkUnitCombatMode,
  writeNetworkUnitJump,
  writeNetworkUnitMovementAccel,
  writeNetworkUnitStaticFields,
  writeNetworkUnitSurfaceNormal,
  writeNetworkUnitSuspension,
  writeNetworkUnitVelocity,
} from './unitSnapshotFields';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import type { PredictionMode } from '@/types/client';

const INITIAL_ENTITY_POOL = 200;
const MAX_WEAPONS_PER_ENTITY = 8;
const MAX_ACTIONS_PER_ENTITY = 16;
const MAX_WAYPOINTS_PER_ENTITY = 16;

type UnitSub = NonNullable<NetworkServerSnapshotEntity['unit']>;
type BuildingSub = NonNullable<NetworkServerSnapshotEntity['building']>;
type FactorySub = NonNullable<BuildingSub['factory']>;

type PooledEntry = {
  entity: NetworkServerSnapshotEntity;
  unitSub: UnitSub;
  unitMovementAccel: Vec3;
  unitSuspension: NonNullable<UnitSub['suspension']>;
  unitJump: NonNullable<UnitSub['jump']>;
  unitRadius: { body: number; shot: number; push: number };
  buildingDim: { x: number; y: number };
  solarSub: { open: boolean };
  buildingSub: BuildingSub;
  factorySub: FactorySub;
  turrets: NetworkServerSnapshotTurret[];
  actions: NetworkServerSnapshotAction[];
  waypoints: WaypointDto[];
  buildQueue: number[];
};

// Keep more precision than the delta threshold so snapshots don't
// round away the small separations produced by unit contact resolution.
const POSITION_WIRE_PRECISION = 100;

function qPos(n: number): number {
  return Math.round(n * POSITION_WIRE_PRECISION) / POSITION_WIRE_PRECISION;
}

function qVel(n: number): number {
  return Math.round(n * 10) / 10;
}

function qRot(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function qNormal(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function qSuspension(n: number): number {
  return Math.round(n * 100) / 100;
}

function writeTurretsToPool(
  pool: PooledEntry,
  weapons: NonNullable<Entity['combat']>['turrets'],
  canReferenceEntityId: ((id: number | undefined) => boolean) | undefined,
  predictionMode: PredictionMode,
): NetworkServerSnapshotTurret[] {
  const count = weapons.length;
  while (pool.turrets.length < count) pool.turrets.push(createTurretDto());
  pool.turrets.length = count;
  // PREDICT-aware bandwidth gate, mirrored from the unit-body path:
  // POS clients integrate nothing → zero both axes' velocity AND
  // acceleration. VEL clients integrate ω → keep velocities, zero
  // accelerations. ACC sends everything. Zeros encode in 1 byte each
  // via MessagePack's positive-fixint vs ~5 for a qRot float.
  const sendAngularVel = predictionMode !== 'pos';
  const sendAngularAcc = predictionMode === 'acc';
  for (let i = 0; i < count; i++) {
    const src = weapons[i];
    const dst = pool.turrets[i];
    const t = dst.turret;
    t.id = turretIdToCode(src.config.id);
    t.angular.rot = qRot(src.rotation);
    t.angular.vel = sendAngularVel ? qRot(src.angularVelocity) : 0;
    t.angular.acc = sendAngularAcc ? qRot(src.angularAcceleration) : 0;
    t.angular.pitch = qRot(src.pitch);
    t.angular.pitchVel = sendAngularVel ? qRot(src.pitchVelocity) : 0;
    t.angular.pitchAcc = sendAngularAcc ? qRot(src.pitchAcceleration) : 0;
    dst.targetId = canReferenceEntityId?.(src.target ?? undefined) === false
      ? undefined
      : src.target ?? undefined;
    dst.state = turretStateToCode(src.state);
    dst.currentForceFieldRange = src.forceField?.range;
  }
  return pool.turrets;
}

function createPooledEntry(): PooledEntry {
  const turrets: NetworkServerSnapshotTurret[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) turrets.push(createTurretDto());
  const actions: NetworkServerSnapshotAction[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_ENTITY; i++) actions.push(createActionDto());
  const waypoints: WaypointDto[] = [];
  for (let i = 0; i < MAX_WAYPOINTS_PER_ENTITY; i++) waypoints.push(createWaypointDto());
  return {
    entity: { id: 0, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1 as PlayerId },
    unitSub: createNetworkUnitSnapshot(),
    unitMovementAccel: { x: 0, y: 0, z: 0 },
    unitSuspension: {
      offset: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    },
    unitJump: {},
    unitRadius: { body: 0, shot: 0, push: 0 },
    buildingDim: { x: 0, y: 0 },
    solarSub: { open: false },
    buildingSub: {
      type: undefined, dim: undefined, hp: { curr: 0, max: 0 },
      build: {
        complete: false,
        paid: { energy: 0, mana: 0, metal: 0 },
      },
      metalExtractionRate: undefined,
    },
    factorySub: {
      queue: [], progress: 0, producing: false,
      energyRate: 0, manaRate: 0, metalRate: 0,
      waypoints: [],
    },
    turrets,
    actions,
    waypoints,
    buildQueue: [],
  };
}

const pool: PooledEntry[] = [];
let poolIndex = 0;

for (let i = 0; i < INITIAL_ENTITY_POOL; i++) {
  pool.push(createPooledEntry());
}

function getPooledEntry(): PooledEntry {
  if (poolIndex >= pool.length) {
    pool.push(createPooledEntry());
  }
  return pool[poolIndex++];
}

export function resetEntitySnapshotPool(): void {
  poolIndex = 0;
}

export function serializeEntitySnapshot(
  entity: Entity,
  changedFields: number | undefined,
  world: WorldState,
  visibility?: SnapshotVisibility,
  predictionMode: PredictionMode = 'acc',
): NetworkServerSnapshotEntity | null {
  const poolEntry = getPooledEntry();
  const ne = poolEntry.entity;
  const isFull = changedFields === undefined;
  const canSeePrivateDetails = visibility?.canSeePrivateEntityDetails(entity) ?? true;
  const canReferenceEntityId = (id: number | undefined): boolean =>
    id === undefined || (visibility?.canReferenceEntityId(world, id) ?? true);

  ne.id = entity.id;
  ne.type = entity.type;
  ne.playerId = entity.ownership?.playerId ?? 1 as PlayerId;
  if (isFull) {
    delete ne.changedFields;
  } else {
    ne.changedFields = changedFields;
  }

  if (isFull || (changedFields & ENTITY_CHANGED_POS)) {
    ne.pos.x = qPos(entity.transform.x);
    ne.pos.y = qPos(entity.transform.y);
    ne.pos.z = qPos(entity.transform.z);
  }
  if (isFull || (changedFields & ENTITY_CHANGED_ROT)) {
    ne.rotation = qRot(entity.transform.rotation);
  }

  ne.unit = undefined;
  ne.building = undefined;

  if (entity.type === 'unit' && entity.unit) {
    const unitFieldMask = ENTITY_CHANGED_VEL | ENTITY_CHANGED_HP |
      ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS |
      ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT |
      ENTITY_CHANGED_BUILDING |
      ENTITY_CHANGED_NORMAL |
      ENTITY_CHANGED_SUSPENSION |
      ENTITY_CHANGED_JUMP |
      ENTITY_CHANGED_MOVEMENT_ACCEL;
    const hasUnitFields = isFull || (changedFields! & unitFieldMask);

    if (hasUnitFields) {
      const u = poolEntry.unitSub;
      ne.unit = u;

      if (isFull) {
        writeNetworkUnitStaticFields(
          u,
          entity.unit,
          poolEntry.unitRadius,
          isCommander(entity),
        );
      } else {
        clearNetworkUnitStaticFields(u);
      }

      // PREDICT-aware bandwidth gate (per-recipient): a POS client
      // doesn't integrate velocity OR acceleration, so we zero the
      // velocity (MessagePack encodes the integer 0 in 1 byte vs ~5
      // for a quantized float) and drop movementAccel entirely. A
      // VEL client integrates velocity but not acceleration, so it
      // still wants velocity but not movementAccel. Writing zeros vs
      // omitting is cosmetic; what matters is the wire payload is
      // smaller and the client's local PREDICT integrator gate (the
      // authoritative one) treats them as 0.
      const sendVelocity = predictionMode !== 'pos';
      const sendMovementAccel = predictionMode === 'acc';
      if (isFull || (changedFields! & ENTITY_CHANGED_VEL)) {
        if (canSeePrivateDetails && sendVelocity) {
          writeNetworkUnitVelocity(u, entity.unit, qVel);
        } else {
          u.velocity.x = 0;
          u.velocity.y = 0;
          u.velocity.z = 0;
        }
      }

      if (
        sendMovementAccel &&
        (isFull || (changedFields! & ENTITY_CHANGED_MOVEMENT_ACCEL))
      ) {
        if (canSeePrivateDetails) {
          writeNetworkUnitMovementAccel(u, entity.unit, poolEntry.unitMovementAccel, qVel);
        } else {
          clearNetworkUnitMovementAccel(u);
        }
      } else {
        clearNetworkUnitMovementAccel(u);
      }

      if (
        isFull ||
        (changedFields! & (ENTITY_CHANGED_POS | ENTITY_CHANGED_NORMAL))
      ) {
        writeNetworkUnitSurfaceNormal(u, entity.unit, qNormal);
      } else {
        clearNetworkUnitSurfaceNormal(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_SUSPENSION)) {
        writeNetworkUnitSuspension(u, entity.unit, poolEntry.unitSuspension, qSuspension, qVel);
      } else {
        clearNetworkUnitSuspension(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_JUMP)) {
        writeNetworkUnitJump(u, entity.unit, poolEntry.unitJump);
      } else {
        clearNetworkUnitJump(u);
      }

      // Full orientation triad (quat + omega + alpha) for entities
      // that have one — currently hover units. Ground units have
      // these undefined on the entity and we omit them from the
      // wire entirely (MessagePack drops undefined fields), so this
      // adds zero overhead for the vast majority of snapshots.
      //
      // PREDICT serializer gate: under POS clients see no
      // extrapolatable angular state, so omega+alpha are dropped.
      // Under VEL only alpha is dropped. ACC ships the full triad.
      const orient = entity.unit.orientation;
      if (orient) {
        u.orientation = orient;
        const av = entity.unit.angularVelocity3;
        if (av && predictionMode !== 'pos') {
          u.angularVelocity3 = av;
        } else {
          u.angularVelocity3 = undefined;
        }
        const aa = entity.unit.angularAcceleration3;
        if (aa && predictionMode === 'acc') {
          u.angularAcceleration3 = aa;
        } else {
          u.angularAcceleration3 = undefined;
        }
      } else {
        u.orientation = undefined;
        u.angularVelocity3 = undefined;
        u.angularAcceleration3 = undefined;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_COMBAT_MODE)) {
        writeNetworkUnitCombatMode(u, entity);
      } else {
        clearNetworkUnitCombatMode(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        u.hp.curr = entity.unit.hp;
        u.hp.max = entity.unit.maxHp;
      }

      u.build = undefined;
      if ((isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) && entity.buildable) {
        u.build = {
          complete: entity.buildable.isComplete,
          paid: {
            energy: entity.buildable.paid.energy,
            mana: entity.buildable.paid.mana,
            metal: entity.buildable.paid.metal,
          },
        };
      }

      clearNetworkUnitActions(u);
      if (canSeePrivateDetails && (isFull || (changedFields! & ENTITY_CHANGED_ACTIONS))) {
        writeNetworkUnitActions(u, entity.unit, poolEntry.actions, canReferenceEntityId);
      }

      u.turrets = undefined;
      const weapons0 = entity.combat?.turrets;
      if (weapons0 && weapons0.length > 0 && (isFull || (changedFields! & ENTITY_CHANGED_TURRETS))) {
        u.turrets = writeTurretsToPool(
          poolEntry,
          weapons0,
          canSeePrivateDetails ? canReferenceEntityId : () => false,
          predictionMode,
        );
      }

      u.buildTargetId = undefined;
      if (canSeePrivateDetails && entity.builder) {
        const targetId = entity.builder.currentBuildTarget ?? undefined;
        u.buildTargetId = canReferenceEntityId(targetId) ? targetId ?? null : null;
      }
    }
  }

  if (entity.type === 'building' && entity.building) {
    const buildingFieldMask = ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING |
      ENTITY_CHANGED_FACTORY | ENTITY_CHANGED_TURRETS;
    const hasBuildingFields = isFull || (changedFields! & buildingFieldMask);

    if (hasBuildingFields) {
      const b = poolEntry.buildingSub;
      ne.building = b;
      b.solar = undefined;
      b.metalExtractionRate = undefined;
      b.turrets = undefined;

      if (isFull) {
        b.dim = poolEntry.buildingDim;
        b.dim.x = entity.building.width;
        b.dim.y = entity.building.height;
        b.type = entity.buildingType !== undefined
          ? buildingTypeToCode(entity.buildingType)
          : undefined;
        b.metalExtractionRate = entity.buildingType === 'extractor'
          ? entity.metalExtractionRate ?? 0
          : undefined;
      } else {
        b.dim = undefined;
        b.type = undefined;
        b.metalExtractionRate = (changedFields! & ENTITY_CHANGED_BUILDING) !== 0 &&
          entity.buildingType === 'extractor'
          ? entity.metalExtractionRate ?? 0
          : undefined;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        b.hp.curr = entity.building.hp;
        b.hp.max = entity.building.maxHp;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) {
        if (entity.buildable) {
          const buildable = entity.buildable;
          b.build.complete = buildable.isComplete;
          b.build.paid.energy = buildable.paid.energy;
          b.build.paid.mana = buildable.paid.mana;
          b.build.paid.metal = buildable.paid.metal;
        } else {
          b.build.complete = true;
          b.build.paid.energy = 0;
          b.build.paid.mana = 0;
          b.build.paid.metal = 0;
        }
        if (entity.building.solar) {
          const s = poolEntry.solarSub;
          s.open = entity.building.solar.open;
          b.solar = s;
        }
      }

      const weapons0 = entity.combat?.turrets;
      if (weapons0 && weapons0.length > 0 && (isFull || (changedFields! & ENTITY_CHANGED_TURRETS))) {
        b.turrets = writeTurretsToPool(
          poolEntry,
          weapons0,
          canSeePrivateDetails ? canReferenceEntityId : () => false,
          predictionMode,
        );
      }

      b.factory = undefined;
      if (canSeePrivateDetails && (isFull || (changedFields! & ENTITY_CHANGED_FACTORY))) {
        if (entity.factory) {
          const f = poolEntry.factorySub;
          b.factory = f;

          const srcQueue = entity.factory.buildQueue;
          poolEntry.buildQueue.length = srcQueue.length;
          for (let i = 0; i < srcQueue.length; i++) {
            poolEntry.buildQueue[i] = unitTypeToCode(srcQueue[i]);
          }
          f.queue = poolEntry.buildQueue;

          if (entity.factory.currentShellId != null) {
            const shell = world.getEntity(entity.factory.currentShellId);
            f.progress = shell?.buildable
              ? getBuildFraction(shell.buildable)
              : entity.factory.currentBuildProgress;
          } else {
            f.progress = 0;
          }
          f.producing = entity.factory.isProducing;
          f.energyRate = entity.factory.energyRateFraction;
          f.manaRate = entity.factory.manaRateFraction;
          f.metalRate = entity.factory.metalRateFraction;

          const wps = entity.factory.waypoints;
          const wpCount = 1 + wps.length;
          while (poolEntry.waypoints.length < wpCount) poolEntry.waypoints.push(createWaypointDto());
          poolEntry.waypoints.length = wpCount;
          poolEntry.waypoints[0].pos.x = entity.factory.rallyX;
          poolEntry.waypoints[0].pos.y = entity.factory.rallyY;
          poolEntry.waypoints[0].posZ = undefined;
          poolEntry.waypoints[0].type = 'move';
          for (let i = 0; i < wps.length; i++) {
            poolEntry.waypoints[i + 1].pos.x = wps[i].x;
            poolEntry.waypoints[i + 1].pos.y = wps[i].y;
            poolEntry.waypoints[i + 1].posZ = wps[i].z;
            poolEntry.waypoints[i + 1].type = wps[i].type;
          }
          f.waypoints = poolEntry.waypoints;
        }
      }
    }
  }

  return ne;
}
