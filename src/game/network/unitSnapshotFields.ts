import type { BuildingType, Entity, Unit, UnitAction } from '../sim/types';
import type {
  NetworkServerSnapshotAction,
  NetworkServerSnapshotEntity,
} from './NetworkTypes';
import type { ServerTarget } from './ClientPredictionTargets';
import {
  ENTITY_CHANGED_MOVEMENT_ACCEL,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  actionTypeToCode,
  codeToActionType,
  codeToUnitType,
  unitTypeToCode,
} from '../../types/network';
import { isFiniteNumber } from '../math';
import { getUnitLocomotion } from '../sim/blueprints';
import { refreshUnitActionHash } from '../sim/unitActions';
import {
  copyActionInto,
  copyTurretInto,
  createActionDto,
  createTurretDto,
} from './snapshotDtoCopy';

export type NetworkUnitSnapshot = NonNullable<NetworkServerSnapshotEntity['unit']>;
export type NetworkUnitRadius = NonNullable<NetworkUnitSnapshot['radius']>;
export type NetworkUnitSuspension = NonNullable<NetworkUnitSnapshot['suspension']>;
export type NetworkUnitJump = NonNullable<NetworkUnitSnapshot['jump']>;

type Vec3 = { x: number; y: number; z: number };
type Quantize = (n: number) => number;

export function createNetworkUnitSnapshot(): NetworkUnitSnapshot {
  return {
    hp: { curr: 0, max: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

export function decodeNetworkUnitType(unitType: unknown): string | null {
  return isFiniteNumber(unitType) ? codeToUnitType(unitType) : null;
}

function decodeNetworkUnitAction(action: NetworkServerSnapshotAction): UnitAction | null {
  if (!action.pos) return null;
  return {
    type: codeToActionType(action.type) as UnitAction['type'],
    x: action.pos.x,
    y: action.pos.y,
    z: action.posZ,
    isPathExpansion: action.pathExp,
    targetId: action.targetId,
    buildingType: action.buildingType as BuildingType | undefined,
    gridX: action.grid?.x,
    gridY: action.grid?.y,
    buildingId: action.buildingId,
  };
}

export function decodeNetworkUnitActions(
  actions: NetworkUnitSnapshot['actions'] | undefined | null,
): UnitAction[] {
  const decoded: UnitAction[] = [];
  if (!actions) return decoded;
  for (let i = 0; i < actions.length; i++) {
    const action = decodeNetworkUnitAction(actions[i]);
    if (action) decoded.push(action);
  }
  return decoded;
}

export function applyNetworkUnitActions(
  unit: Unit,
  actions: NetworkUnitSnapshot['actions'] | undefined | null,
): void {
  const dst = unit.actions;
  dst.length = 0;
  if (actions) {
    for (let i = 0; i < actions.length; i++) {
      const action = decodeNetworkUnitAction(actions[i]);
      if (action) dst.push(action);
    }
  }
  refreshUnitActionHash(unit);
}

export function applyNetworkUnitStaticFields(unit: Unit, src: NetworkUnitSnapshot): void {
  const radius = src.radius;
  if (radius) {
    if (isFiniteNumber(radius.body)) unit.radius.body = radius.body;
    if (isFiniteNumber(radius.shot)) unit.radius.shot = radius.shot;
    if (isFiniteNumber(radius.push)) unit.radius.push = radius.push;
  }
  if (isFiniteNumber(src.bodyCenterHeight)) {
    unit.bodyCenterHeight = src.bodyCenterHeight;
  }
  const unitType = decodeNetworkUnitType(src.unitType);
  if (unitType) {
    unit.unitType = unitType;
    unit.locomotion = getUnitLocomotion(unitType);
  }
  if (isFiniteNumber(src.mass)) unit.mass = src.mass;
}

export function applyNetworkUnitMovementAccel(unit: Unit, src: NetworkUnitSnapshot): void {
  const accel = src.movementAccel;
  unit.movementAccelX = accel?.x ?? 0;
  unit.movementAccelY = accel?.y ?? 0;
  unit.movementAccelZ = accel?.z ?? 0;
}

export function applyNetworkSuspensionState(
  entity: Entity,
  suspension: NetworkUnitSnapshot['suspension'] | undefined | null,
): void {
  const state = entity.unit?.suspension;
  if (!state || !suspension) return;
  state.offsetX = suspension.offset.x;
  state.offsetY = suspension.offset.y;
  state.offsetZ = suspension.offset.z;
  state.velocityX = suspension.velocity.x;
  state.velocityY = suspension.velocity.y;
  state.velocityZ = suspension.velocity.z;
  state.legContact = suspension.legContact === true;
}

export function applyNetworkJumpState(
  entity: Entity,
  jump: NetworkUnitSnapshot['jump'] | undefined | null,
): boolean {
  const state = entity.unit?.jump;
  if (!state || !jump) return false;
  const prevLaunchSeq = state.launchSeq;
  state.active = jump.active === true;
  if (isFiniteNumber(jump.launchSeq)) {
    state.launchSeq = jump.launchSeq;
  }
  return state.launchSeq !== prevLaunchSeq;
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

export function readNetworkUnitRadius(
  src: NetworkUnitSnapshot | undefined,
  fallback: number,
): { body: number; shot: number; push: number } {
  return {
    body: finiteOr(src?.radius?.body, fallback),
    shot: finiteOr(src?.radius?.shot, fallback),
    push: finiteOr(src?.radius?.push, fallback),
  };
}

export function readNetworkUnitBodyCenterHeight(
  src: NetworkUnitSnapshot | undefined,
  fallback: number,
): number {
  return finiteOr(src?.bodyCenterHeight, finiteOr(src?.radius?.push, fallback));
}

export function readNetworkUnitMass(
  src: NetworkUnitSnapshot | undefined,
  fallback: number,
): number {
  return finiteOr(src?.mass, fallback);
}

export function readNetworkUnitVelocity(src: NetworkUnitSnapshot | undefined): Vec3 {
  return {
    x: finiteOr(src?.velocity?.x, 0),
    y: finiteOr(src?.velocity?.y, 0),
    z: finiteOr(src?.velocity?.z, 0),
  };
}

export function readNetworkUnitMovementAccel(src: NetworkUnitSnapshot | undefined): Vec3 {
  return {
    x: finiteOr(src?.movementAccel?.x, 0),
    y: finiteOr(src?.movementAccel?.y, 0),
    z: finiteOr(src?.movementAccel?.z, 0),
  };
}

export function readNetworkUnitSurfaceNormal(
  src: NetworkUnitSnapshot | undefined,
): { nx: number; ny: number; nz: number } {
  return src?.surfaceNormal
    ? {
        nx: finiteOr(src.surfaceNormal.nx, 0),
        ny: finiteOr(src.surfaceNormal.ny, 0),
        nz: finiteOr(src.surfaceNormal.nz, 1),
      }
    : { nx: 0, ny: 0, nz: 1 };
}

export function writeNetworkUnitStaticFields(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  radius: NetworkUnitRadius,
  unitIsCommander: boolean,
): void {
  dst.unitType = unitTypeToCode(unit.unitType);
  dst.radius = radius;
  radius.body = unit.radius.body;
  radius.shot = unit.radius.shot;
  radius.push = unit.radius.push;
  dst.bodyCenterHeight = unit.bodyCenterHeight;
  dst.mass = unit.mass;
  dst.isCommander = unitIsCommander ? true : undefined;
}

export function clearNetworkUnitStaticFields(dst: NetworkUnitSnapshot): void {
  dst.unitType = undefined;
  dst.radius = undefined;
  dst.bodyCenterHeight = undefined;
  dst.mass = undefined;
  dst.isCommander = undefined;
}

export function writeNetworkUnitVelocity(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  qVel: Quantize,
): void {
  dst.velocity.x = qVel(unit.velocityX ?? 0);
  dst.velocity.y = qVel(unit.velocityY ?? 0);
  dst.velocity.z = qVel(unit.velocityZ ?? 0);
}

export function writeNetworkUnitMovementAccel(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  out: Vec3,
  qVel: Quantize,
): void {
  out.x = qVel(unit.movementAccelX ?? 0);
  out.y = qVel(unit.movementAccelY ?? 0);
  out.z = qVel(unit.movementAccelZ ?? 0);
  dst.movementAccel = out;
}

export function clearNetworkUnitMovementAccel(dst: NetworkUnitSnapshot): void {
  dst.movementAccel = undefined;
}

export function writeNetworkUnitSurfaceNormal(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  qNormal: Quantize,
): void {
  const sn = unit.surfaceNormal;
  const out = dst.surfaceNormal ?? (dst.surfaceNormal = { nx: 0, ny: 0, nz: 1 });
  out.nx = qNormal(sn.nx);
  out.ny = qNormal(sn.ny);
  out.nz = qNormal(sn.nz);
}

export function clearNetworkUnitSurfaceNormal(dst: NetworkUnitSnapshot): void {
  dst.surfaceNormal = undefined;
}

export function writeNetworkUnitSuspension(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  out: NetworkUnitSuspension,
  qSuspension: Quantize,
  qVel: Quantize,
): void {
  const suspension = unit.suspension;
  if (!suspension) {
    dst.suspension = undefined;
    return;
  }
  out.offset.x = qSuspension(suspension.offsetX);
  out.offset.y = qSuspension(suspension.offsetY);
  out.offset.z = qSuspension(suspension.offsetZ);
  out.velocity.x = qVel(suspension.velocityX);
  out.velocity.y = qVel(suspension.velocityY);
  out.velocity.z = qVel(suspension.velocityZ);
  out.legContact = suspension.legContact ? true : undefined;
  dst.suspension = out;
}

export function clearNetworkUnitSuspension(dst: NetworkUnitSnapshot): void {
  dst.suspension = undefined;
}

export function writeNetworkUnitJump(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  out: NetworkUnitJump,
): void {
  const jump = unit.jump;
  if (!jump) {
    dst.jump = undefined;
    return;
  }
  out.active = jump.active ? true : undefined;
  out.launchSeq = jump.launchSeq > 0 ? jump.launchSeq : undefined;
  dst.jump = out;
}

export function clearNetworkUnitJump(dst: NetworkUnitSnapshot): void {
  dst.jump = undefined;
}

export function writeNetworkUnitActions(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  actionPool: NetworkServerSnapshotAction[],
): void {
  const actions = unit.actions ?? [];
  const count = actions.length;
  while (actionPool.length < count) actionPool.push(createActionDto());
  actionPool.length = count;
  for (let i = 0; i < count; i++) {
    const src = actions[i];
    const action = actionPool[i];
    action.type = actionTypeToCode(src.type);
    if (src.x !== undefined) {
      if (!action.pos) action.pos = { x: 0, y: 0 };
      action.pos.x = src.x;
      action.pos.y = src.y;
    } else {
      action.pos = undefined;
    }
    action.posZ = src.z;
    action.pathExp = src.isPathExpansion ? true : undefined;
    action.targetId = src.targetId;
    action.buildingType = src.buildingType;
    if (src.gridX !== undefined) {
      if (!action.grid) action.grid = { x: 0, y: 0 };
      action.grid.x = src.gridX;
      action.grid.y = src.gridY!;
    } else {
      action.grid = undefined;
    }
    action.buildingId = src.buildingId;
  }
  dst.actions = actionPool;
}

export function clearNetworkUnitActions(dst: NetworkUnitSnapshot): void {
  dst.actions = undefined;
}

function copyVec3OptionalInto(
  src: Vec3 | undefined,
  dst: Vec3 | undefined,
): Vec3 | undefined {
  if (!src) return undefined;
  const out = dst ?? { x: 0, y: 0, z: 0 };
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  return out;
}

function createNetworkUnitBuildState(): NonNullable<NetworkUnitSnapshot['build']> {
  return {
    complete: false,
    paid: { energy: 0, mana: 0, metal: 0 },
  };
}

function copyNetworkUnitBuildState(
  src: NonNullable<NetworkUnitSnapshot['build']>,
  dst: NonNullable<NetworkUnitSnapshot['build']>,
): NonNullable<NetworkUnitSnapshot['build']> {
  dst.complete = src.complete;
  dst.paid.energy = src.paid.energy;
  dst.paid.mana = src.paid.mana;
  dst.paid.metal = src.paid.metal;
  return dst;
}

function createNetworkUnitSuspensionState(): NetworkUnitSuspension {
  return {
    offset: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

function createNetworkUnitJumpState(): NetworkUnitJump {
  return {};
}

export function copyNetworkUnitSnapshotInto(
  src: NetworkUnitSnapshot,
  dst: NetworkUnitSnapshot,
): NetworkUnitSnapshot {
  dst.unitType = src.unitType;
  dst.hp.curr = src.hp.curr;
  dst.hp.max = src.hp.max;
  if (src.radius) {
    const radius = dst.radius ?? (dst.radius = { body: 0, shot: 0, push: 0 });
    radius.body = src.radius.body;
    radius.shot = src.radius.shot;
    radius.push = src.radius.push;
  } else {
    dst.radius = undefined;
  }
  dst.bodyCenterHeight = src.bodyCenterHeight;
  dst.mass = src.mass;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.movementAccel = copyVec3OptionalInto(src.movementAccel, dst.movementAccel);
  if (src.surfaceNormal) {
    const sn = dst.surfaceNormal ?? (dst.surfaceNormal = { nx: 0, ny: 0, nz: 1 });
    sn.nx = src.surfaceNormal.nx;
    sn.ny = src.surfaceNormal.ny;
    sn.nz = src.surfaceNormal.nz;
  } else {
    dst.surfaceNormal = undefined;
  }
  if (src.suspension) {
    const suspension = dst.suspension ?? (dst.suspension = createNetworkUnitSuspensionState());
    suspension.offset.x = src.suspension.offset.x;
    suspension.offset.y = src.suspension.offset.y;
    suspension.offset.z = src.suspension.offset.z;
    suspension.velocity.x = src.suspension.velocity.x;
    suspension.velocity.y = src.suspension.velocity.y;
    suspension.velocity.z = src.suspension.velocity.z;
    suspension.legContact = src.suspension.legContact;
  } else {
    dst.suspension = undefined;
  }
  if (src.jump) {
    const jump = dst.jump ?? (dst.jump = createNetworkUnitJumpState());
    jump.active = src.jump.active;
    jump.launchSeq = src.jump.launchSeq;
  } else {
    dst.jump = undefined;
  }
  dst.isCommander = src.isCommander;
  dst.buildTargetId = src.buildTargetId;
  dst.build = src.build
    ? copyNetworkUnitBuildState(src.build, dst.build ?? createNetworkUnitBuildState())
    : undefined;

  if (src.actions) {
    const actions = dst.actions ?? (dst.actions = []);
    actions.length = src.actions.length;
    for (let i = 0; i < src.actions.length; i++) {
      actions[i] = copyActionInto(src.actions[i], actions[i] ?? createActionDto());
    }
  } else {
    dst.actions = undefined;
  }

  if (src.turrets) {
    const turrets = dst.turrets ?? (dst.turrets = []);
    turrets.length = src.turrets.length;
    for (let i = 0; i < src.turrets.length; i++) {
      turrets[i] = copyTurretInto(
        src.turrets[i],
        turrets[i] ?? createTurretDto(),
      );
    }
  } else {
    dst.turrets = undefined;
  }

  return dst;
}

export function applyNetworkUnitDriftFieldsToTarget(
  target: ServerTarget,
  src: NetworkServerSnapshotEntity,
  isFull: boolean,
  changedFields: number | null | undefined,
): void {
  const cf = changedFields ?? 0;
  if (isFull || (cf & ENTITY_CHANGED_POS)) {
    target.x = src.pos.x;
    target.y = src.pos.y;
    target.z = src.pos.z;
  }
  if (isFull || (cf & (ENTITY_CHANGED_POS | ENTITY_CHANGED_NORMAL))) {
    const sn = src.unit?.surfaceNormal;
    if (sn) {
      target.surfaceNormalX = sn.nx;
      target.surfaceNormalY = sn.ny;
      target.surfaceNormalZ = sn.nz;
    }
  }
  if (isFull || (cf & ENTITY_CHANGED_ROT)) {
    target.rotation = src.rotation;
  }
  if (isFull || (cf & ENTITY_CHANGED_VEL)) {
    const v = src.unit?.velocity;
    if (v !== undefined) {
      target.velocityX = v.x;
      target.velocityY = v.y;
      target.velocityZ = v.z;
    }
  }
  if (isFull || (cf & ENTITY_CHANGED_MOVEMENT_ACCEL)) {
    const accel = src.unit?.movementAccel;
    target.movementAccelX = accel?.x ?? 0;
    target.movementAccelY = accel?.y ?? 0;
    target.movementAccelZ = accel?.z ?? 0;
  }
}
