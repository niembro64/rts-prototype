import { ENTITY_CHANGED_ACTIONS } from '@/types/network';
import type { SprayTarget } from '@/types/ui';
import type { Entity, EntityId, Transport } from './types';
import { NO_ENTITY_ID } from './types';
import type { WorldState } from './WorldState';
import { getEntityTargetPoint } from './buildingAnchors';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { holdEntity, releaseEntityHold } from './entityHolds';
import { getUnitGroundZ, getUnitSupportPointOffsetZ } from './unitGeometry';
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
// The carried unit STAYS IN THE WORLD, fully visible and targetable. It
// rides the generic hold-pose channel (the same machinery that floats
// forming units at the fabricator's torus center) because ground units
// are terrain-following — no external force can lift them — so the beam
// drives the HOLD OFFSET instead: a critically damped spring pulls the
// passenger's offset from the ring center to zero and holds it there,
// while the hold pose tracks the transport's live position, altitude,
// and velocity. The passenger's own propulsion and actions are dark
// while carried (updateUnits transported skip + the force system's
// heldBy velocity pin).
const TRANSPORT_BEAM_OMEGA_RAD_PER_SEC = 3.0;
const TRANSPORT_BEAM_SNAP_EPSILON = 0.5;

type BeamSpringState = { vx: number; vy: number; vz: number };
const _beamSpringByEntityId = new Map<EntityId, BeamSpringState>();

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
  // World-frame hold seeded at the passenger's CURRENT pose, so the
  // beam pass's spring visibly reels it in from where it stood.
  holdEntity(transport, target, {
    kind: 'transportCargo',
    slotIndex,
    localOffsetX: target.transform.x - transport.transform.x,
    localOffsetY: target.transform.y - transport.transform.y,
    localBaseZ:
      target.transform.z -
      getUnitGroundZ(transport) -
      getUnitSupportPointOffsetZ(target.unit),
    rotateWithHolder: false,
    inheritHolderRotation: false,
    inheritHolderVelocity: true,
  });
  _beamSpringByEntityId.set(target.id, { vx: 0, vy: 0, vz: 0 });

  transport.transport.loadedUnits.push(target);
  return true;
}

/** Switch the beam off. The passenger simply becomes an ordinary unit
 *  again wherever the beam last held it — it falls and settles under
 *  its own physics; nothing teleports. */
function releaseTransportPassenger(passenger: Entity): void {
  passenger.transported = null;
  releaseEntityHold(passenger);
  _beamSpringByEntityId.delete(passenger.id);
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
 *  that died, keep the survivors' own propulsion dark, ease the hold
 *  offset to the ring center with the critically damped spring, and
 *  publish the visible nano stream onto the passenger's volume. */
function updateTransportBeam(
  world: WorldState,
  transport: Entity,
  dtSec: number,
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
      } else {
        _beamSpringByEntityId.delete(passenger.id);
      }
      cargo.splice(i, 1);
      continue;
    }

    // Orders issued to a carried unit may have re-armed its drive this
    // tick; the beam owns the passenger while it is on.
    entitySlotRegistry.setUnitDriveInput(passenger, 0, 0, 0, 0, passenger.entitySlotId);

    // Critically damped spring on the hold offset: the passenger's
    // world-frame displacement from the ring center eases to zero and
    // stays there, riding the transport's own motion for free because
    // the hold pose is anchored to the carrier.
    const hold = passenger.heldBy;
    const spring = _beamSpringByEntityId.get(passenger.id);
    if (hold !== null && hold.kind === 'transportCargo' && spring !== undefined) {
      const omega = TRANSPORT_BEAM_OMEGA_RAD_PER_SEC;
      const damp = 2 * omega;
      spring.vx += (-omega * omega * hold.localOffsetX - damp * spring.vx) * dtSec;
      spring.vy += (-omega * omega * hold.localOffsetY - damp * spring.vy) * dtSec;
      spring.vz += (-omega * omega * hold.localBaseZ - damp * spring.vz) * dtSec;
      hold.localOffsetX += spring.vx * dtSec;
      hold.localOffsetY += spring.vy * dtSec;
      hold.localBaseZ += spring.vz * dtSec;
      const settled =
        hold.localOffsetX * hold.localOffsetX +
          hold.localOffsetY * hold.localOffsetY +
          hold.localBaseZ * hold.localBaseZ <
          TRANSPORT_BEAM_SNAP_EPSILON * TRANSPORT_BEAM_SNAP_EPSILON &&
        spring.vx * spring.vx + spring.vy * spring.vy + spring.vz * spring.vz <
          TRANSPORT_BEAM_SNAP_EPSILON * TRANSPORT_BEAM_SNAP_EPSILON;
      if (settled) {
        hold.localOffsetX = 0;
        hold.localOffsetY = 0;
        hold.localBaseZ = 0;
        spring.vx = 0;
        spring.vy = 0;
        spring.vz = 0;
      }
    }

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
  dtMs: number,
): TransportActionUpdateResult {
  const dtSec = dtMs / 1000;
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

    updateTransportBeam(world, transport, dtSec);
  }

  return { unloadedUnits, sprayTargets: _beamSprayTargets };
}
