import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { ENTITY_CHANGED_ACTIONS } from '@/types/network';
import type { SprayTarget } from '@/types/ui';
import { GRAVITY } from '../../config';
import type { Entity, EntityId, Transport } from './types';
import { NO_ENTITY_ID } from './types';
import type { WorldState } from './WorldState';
import type { ForceAccumulator } from './ForceAccumulator';
import { getEntityTargetPoint } from './buildingAnchors';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { getUnitBlueprint } from './blueprints';
import { writeHitVolume, type EntityVolume } from './entityVolumes';
import { shiftUnitAction, setUnitActions } from './unitActions';

const TRANSPORT_UNIT_BLUEPRINT_ID = 'unitTransport';

// ONE passenger: the transport is an open-centered ring that expands to
// fit whatever it carries, so cargo is a single held unit rather than a
// hidden six-pack.
const TRANSPORT_CAPACITY = 1;
const TRANSPORT_LOAD_RANGE_PADDING = 24;
const TRANSPORT_UNLOAD_ARRIVAL_RADIUS = 15;

// ── Attraction beam ────────────────────────────────────────────────────
// The carried unit STAYS IN THE WORLD as a physical body. A critically
// damped spring (natural frequency OMEGA, damping 2*OMEGA against the
// velocity error toward the transport's own velocity) pulls it to the
// ring's center point and holds it there; gravity is fed forward after
// the clamp so the hold point never sags. The unit's own propulsion,
// medium lift, and cruise are off while carried (see UnitForceSystem's
// transported gate); drag and every other world force still apply.
const TRANSPORT_BEAM_OMEGA_RAD_PER_SEC = 3.0;
const TRANSPORT_BEAM_MAX_ACCEL = 600;
// The force kernel converts an external force F to acceleration as
// F / 3600 * 1e6 / mass (see unit_kinetics.rs), so a commanded
// acceleration `a` on mass `m` is authored as a * m * 3600 / 1e6.
const TRANSPORT_BEAM_FORCE_PER_MASS_ACCEL = 3600 / 1_000_000;

type TransportActionUpdateResult = {
  unloadedUnits: Entity[];
  /** One 'build'-typed nano stream per carried unit — the visible
   *  attraction beam. Clients also derive the ring's carry-expansion
   *  from these (a spray SOURCED from a transport is always the beam,
   *  because transports own no build power). */
  sprayTargets: SprayTarget[];
};

export function createTransportComponentForUnitBlueprint(unitBlueprintId: string): Transport | null {
  return unitBlueprintId === TRANSPORT_UNIT_BLUEPRINT_ID
    ? { capacity: TRANSPORT_CAPACITY, loadedUnits: [] }
    : null;
}

export function isTransportUnit(entity: Entity | null | undefined): entity is Entity {
  return !!(
    entity !== null &&
    entity !== undefined &&
    entity.type === 'unit' &&
    entity.unit !== null &&
    entity.transport !== null &&
    entity.unit.hp > 0
  );
}

export function isClientTransportUnit(entity: Entity | null | undefined): entity is Entity {
  return !!(
    entity !== null &&
    entity !== undefined &&
    entity.type === 'unit' &&
    entity.unit !== null &&
    entity.unit.unitBlueprintId === TRANSPORT_UNIT_BLUEPRINT_ID &&
    entity.unit.hp > 0
  );
}

function isTransportableUnit(target: Entity | null | undefined, playerId: number): target is Entity {
  return !!(
    target !== null &&
    target !== undefined &&
    target.type === 'unit' &&
    target.unit !== null &&
    target.unit.hp > 0 &&
    target.ownership !== null &&
    target.ownership.playerId === playerId &&
    target.commander === null &&
    target.transport === null &&
    target.transported === null &&
    target.heldBy === null &&
    target.buildable === null
  );
}

export function canLoadTransport(transport: Entity | null | undefined, target: Entity | null | undefined): boolean {
  if (!isTransportUnit(transport) || transport.ownership === null) return false;
  if (!isTransportableUnit(target, transport.ownership.playerId)) return false;
  if (target.id === transport.id) return false;
  const transportComponent = transport.transport;
  return transportComponent !== null &&
    transportComponent.loadedUnits.length < transportComponent.capacity;
}

function isTransportLoadInRange(transport: Entity, target: Entity): boolean {
  const transportRadius = transport.unit?.radius.collision ?? 0;
  const targetRadius = target.unit?.radius.collision ?? 0;
  const targetPoint = getEntityTargetPoint(target);
  const dx = targetPoint.x - transport.transform.x;
  const dy = targetPoint.y - transport.transform.y;
  const range = transportRadius + targetRadius + TRANSPORT_LOAD_RANGE_PADDING;
  return dx * dx + dy * dy <= range * range;
}

/** Switch the beam on. The passenger keeps its body, its position, and
 *  its place in the world — from here the per-tick beam pass pulls it
 *  to the ring center and holds it. */
function loadUnitIntoTransport(
  transport: Entity,
  target: Entity,
): boolean {
  if (!canLoadTransport(transport, target) || !isTransportLoadInRange(transport, target)) return false;
  if (target.unit === null || transport.transport === null) return false;

  const slotIndex = transport.transport.loadedUnits.length;
  setUnitActions(target.unit, []);
  target.unit.patrolStartIndex = null;
  target.unit.stuckTicks = 0;
  target.unit.activePath = null;
  entitySlotRegistry.setUnitDriveInput(target, 0, 0, 0, 0, target.entitySlotId);
  target.selectable = { selected: false };
  target.transported = {
    transportId: transport.id,
    slotIndex,
  };

  transport.transport.loadedUnits.push(target);
  return true;
}

/** Switch the beam off. The passenger simply becomes an ordinary unit
 *  again wherever the beam last held it — it falls and settles under
 *  its own physics; nothing teleports. */
function releaseTransportPassenger(passenger: Entity): void {
  passenger.transported = null;
  const unit = passenger.unit;
  if (unit === null) return;
  entitySlotRegistry.setUnitDriveInput(passenger, 0, 0, 0, 0, passenger.entitySlotId);
  unit.activePath = null;
  unit.stuckTicks = 0;
}

function unloadTransportCargo(transport: Entity): Entity[] {
  if (!isTransportUnit(transport)) return [];
  const transportComponent = transport.transport;
  if (transportComponent === null) return [];
  const cargo = transportComponent.loadedUnits;
  if (cargo.length === 0) return [];

  const released: Entity[] = [];
  for (let i = 0; i < cargo.length; i++) {
    const passenger = cargo[i];
    if (passenger.unit === null) continue;
    releaseTransportPassenger(passenger);
    released.push(passenger);
  }
  cargo.length = 0;
  return released;
}

/** Beam-carried units must never collide while inside the carrier's
 *  ring — the spring holds them overlapping the transport's own
 *  collision sphere, and contact resolution would fight it violently.
 *  The physics engine excludes these ids from its contact passes. */
export function collectBeamCarriedEntityIds(
  world: WorldState,
  out: Set<EntityId>,
): Set<EntityId> {
  out.clear();
  const transports = world.getTransportUnits();
  for (let i = 0; i < transports.length; i++) {
    const cargo = transports[i].transport?.loadedUnits;
    if (cargo === undefined) continue;
    for (let j = 0; j < cargo.length; j++) out.add(cargo[j].id);
  }
  return out;
}

/** Release every passenger a dying/removed transport still holds, so no
 *  unit is left `transported` forever. Wired into the world's
 *  entity-removal hook by the server core. */
export function releaseAllTransportCargo(entity: Entity): void {
  const cargo = entity.transport?.loadedUnits;
  if (cargo === undefined || cargo.length === 0) return;
  for (let i = 0; i < cargo.length; i++) {
    releaseTransportPassenger(cargo[i]);
  }
  cargo.length = 0;
}

const _beamSprayPool: SprayTarget[] = [];
const _beamSprayTargets: SprayTarget[] = [];
const _beamVolume: EntityVolume = {
  shape: 'sphere',
  x: 0,
  y: 0,
  z: 0,
  halfX: 0,
  halfY: 0,
  halfZ: 0,
  innerRadius: 0,
};

function acquireBeamSpray(): SprayTarget {
  const index = _beamSprayTargets.length;
  let spray = _beamSprayPool[index];
  if (spray === undefined) {
    spray = {
      source: { id: NO_ENTITY_ID, pos: { x: 0, y: 0 }, z: 0, playerId: 0 },
      target: { id: NO_ENTITY_ID, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
      waypoint: undefined,
      waypoint2: undefined,
      type: 'build',
      intensity: 1,
      channel: 0,
      flow: 'direct',
      inverse: undefined,
      flowRadius: 0,
      coneAxis: undefined,
      coneAngle: undefined,
      speed: undefined,
      particleRadius: undefined,
      colorRGB: undefined,
      endColorRGB: undefined,
      endpointFade: undefined,
      pylonTubeHandoffKey: undefined,
      ballSpawnRate: undefined,
    };
    _beamSprayPool[index] = spray;
  }
  spray.target.dim = undefined;
  _beamSprayTargets.push(spray);
  return spray;
}

/** Per-tick beam pass for one carrying transport: sweep out passengers
 *  that died, keep the survivors' own propulsion dark, apply the
 *  critically damped spring toward the ring center, and publish the
 *  visible nano stream from the center onto the passenger's volume. */
function updateTransportBeam(
  world: WorldState,
  transport: Entity,
  forceAccumulator: ForceAccumulator,
): void {
  const transportComponent = transport.transport;
  const transportUnit = transport.unit;
  if (transportComponent === null || transportUnit === null) return;
  const cargo = transportComponent.loadedUnits;
  for (let i = cargo.length - 1; i >= 0; i--) {
    const passenger = cargo[i];
    const unit = passenger.unit;
    if (
      unit === null ||
      unit.hp <= 0 ||
      world.getEntity(passenger.id) === undefined ||
      passenger.transported?.transportId !== transport.id
    ) {
      if (passenger.transported?.transportId === transport.id) {
        releaseTransportPassenger(passenger);
      }
      cargo.splice(i, 1);
      continue;
    }

    // Orders issued to a carried unit may have re-armed its drive this
    // tick; the beam owns propulsion while it is on.
    entitySlotRegistry.setUnitDriveInput(passenger, 0, 0, 0, 0, passenger.entitySlotId);

    const omega = TRANSPORT_BEAM_OMEGA_RAD_PER_SEC;
    const dx = transport.transform.x - passenger.transform.x;
    const dy = transport.transform.y - passenger.transform.y;
    const dz = transport.transform.z - passenger.transform.z;
    const dvx = (transportUnit.velocityX ?? 0) - (unit.velocityX ?? 0);
    const dvy = (transportUnit.velocityY ?? 0) - (unit.velocityY ?? 0);
    const dvz = (transportUnit.velocityZ ?? 0) - (unit.velocityZ ?? 0);
    let ax = omega * omega * dx + 2 * omega * dvx;
    let ay = omega * omega * dy + 2 * omega * dvy;
    let az = omega * omega * dz + 2 * omega * dvz;
    const accelSq = ax * ax + ay * ay + az * az;
    if (accelSq > TRANSPORT_BEAM_MAX_ACCEL * TRANSPORT_BEAM_MAX_ACCEL) {
      const scale = TRANSPORT_BEAM_MAX_ACCEL / DMath.sqrt(accelSq);
      ax *= scale;
      ay *= scale;
      az *= scale;
    }
    // Gravity feedforward AFTER the clamp: the hold never sags, even
    // when the corrective spring itself is saturated.
    az += GRAVITY;

    const mass = Math.max(1, getUnitBlueprint(unit.unitBlueprintId).mass);
    const forceScale = mass * TRANSPORT_BEAM_FORCE_PER_MASS_ACCEL;
    forceAccumulator.addForce(
      passenger.id,
      ax * forceScale,
      ay * forceScale,
      'transportBeam',
      az * forceScale,
      passenger.entitySlotId,
    );

    const spray = acquireBeamSpray();
    spray.source.id = transport.id;
    spray.source.pos.x = transport.transform.x;
    spray.source.pos.y = transport.transform.y;
    spray.source.z = transport.transform.z;
    spray.source.playerId = transport.ownership?.playerId ?? 0;
    spray.target.id = passenger.id;
    if (writeHitVolume(passenger, _beamVolume)) {
      spray.target.pos.x = _beamVolume.x;
      spray.target.pos.y = _beamVolume.y;
      spray.target.z = _beamVolume.z;
      spray.target.radius = _beamVolume.halfX;
    } else {
      spray.target.pos.x = passenger.transform.x;
      spray.target.pos.y = passenger.transform.y;
      spray.target.z = passenger.transform.z;
      spray.target.radius = unit.radius.hitbox;
    }
    spray.type = 'build';
    spray.intensity = 1;
    spray.channel = 3;
    spray.flow = 'direct';
    spray.inverse = undefined;
    spray.flowRadius = 0;
    spray.ballSpawnRate = undefined;
  }
}

export function updateTransportActions(
  world: WorldState,
  forceAccumulator: ForceAccumulator,
): TransportActionUpdateResult {
  const unloadedUnits: Entity[] = [];
  _beamSprayTargets.length = 0;
  // Only transport-capable units (cached, id-sorted like getUnits was) —
  // the full-unit walk paid O(all units) per tick for a ~zero working set.
  const units = world.getTransportUnits();

  for (let i = 0; i < units.length; i++) {
    const transport = units[i];
    if (!isTransportUnit(transport) || transport.unit === null) continue;

    const action = transport.unit.actions[0];
    if (action !== undefined && action.type === 'loadTransport') {
      const targetId = action.targetId as EntityId | undefined;
      const target = targetId !== undefined ? world.getEntity(targetId) : undefined;
      if (target !== undefined && loadUnitIntoTransport(transport, target)) {
        shiftUnitAction(transport.unit);
        transport.unit.stuckTicks = 0;
        world.markSnapshotDirty(transport.id, ENTITY_CHANGED_ACTIONS);
      }
    } else if (action !== undefined && action.type === 'unloadTransport') {
      const dx = action.x - transport.transform.x;
      const dy = action.y - transport.transform.y;
      if (
        dx * dx + dy * dy <=
        TRANSPORT_UNLOAD_ARRIVAL_RADIUS * TRANSPORT_UNLOAD_ARRIVAL_RADIUS
      ) {
        const released = unloadTransportCargo(transport);
        if (released.length > 0) {
          for (let j = 0; j < released.length; j++) unloadedUnits.push(released[j]);
          shiftUnitAction(transport.unit);
          transport.unit.stuckTicks = 0;
          world.markSnapshotDirty(transport.id, ENTITY_CHANGED_ACTIONS);
        }
      }
    }

    updateTransportBeam(world, transport, forceAccumulator);
  }

  return { unloadedUnits, sprayTargets: _beamSprayTargets };
}
