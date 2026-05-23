import type { BuildingType, Entity, Unit, UnitAction } from '../sim/types';
import type {
  NetworkServerSnapshotAction,
  NetworkServerSnapshotEntity,
} from './NetworkTypes';
import type { ServerTarget } from './ClientPredictionTargets';
import {
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
  dequantizeEntityPosition as deqEntityPos,
  dequantizeNormal as deqNormal,
  dequantizeRotation as deqRot,
  dequantizeVelocity as deqVel,
} from './snapshotQuantization';
import {
  copyActionInto,
  copyTurretInto,
  createActionDto,
  createTurretDto,
} from './snapshotDtoCopy';

export type NetworkUnitSnapshot = NonNullable<NetworkServerSnapshotEntity['unit']>;
export type NetworkUnitRadius = NonNullable<NetworkUnitSnapshot['radius']>;

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

export function applyNetworkUnitCombatMode(
  entity: Entity,
  src: NetworkUnitSnapshot,
): void {
  if (!entity.combat) return;
  entity.combat.fireEnabled = src.fireEnabled !== false;
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

export function readNetworkUnitRadius(
  src: NetworkUnitSnapshot | undefined,
  fallback: number | NetworkUnitRadius,
): { body: number; shot: number; push: number } {
  return {
    body: finiteOr(src?.radius?.body, radiusFallback(fallback, 'body')),
    shot: finiteOr(src?.radius?.shot, radiusFallback(fallback, 'shot')),
    push: finiteOr(src?.radius?.push, radiusFallback(fallback, 'push')),
  };
}

function radiusFallback(fallback: number | NetworkUnitRadius, key: keyof NetworkUnitRadius): number {
  return typeof fallback === 'number' ? fallback : finiteOr(fallback[key], 15);
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
    x: deqVel(finiteOr(src?.velocity?.x, 0)),
    y: deqVel(finiteOr(src?.velocity?.y, 0)),
    z: deqVel(finiteOr(src?.velocity?.z, 0)),
  };
}

export function readNetworkUnitSurfaceNormal(
  src: NetworkUnitSnapshot | undefined,
): { nx: number; ny: number; nz: number } {
  return src?.surfaceNormal
    ? {
        nx: deqNormal(finiteOr(src.surfaceNormal.nx, 0)),
        ny: deqNormal(finiteOr(src.surfaceNormal.ny, 0)),
        nz: deqNormal(finiteOr(src.surfaceNormal.nz, 1000)),
      }
    : { nx: 0, ny: 0, nz: 1 };
}

export function writeNetworkUnitStaticFields(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  unitIsCommander: boolean,
): void {
  dst.unitType = unitTypeToCode(unit.unitType);
  dst.radius = undefined;
  dst.bodyCenterHeight = undefined;
  dst.mass = undefined;
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
  const velocity = dst.velocity ?? (dst.velocity = { x: 0, y: 0, z: 0 });
  velocity.x = qVel(unit.velocityX ?? 0);
  velocity.y = qVel(unit.velocityY ?? 0);
  velocity.z = qVel(unit.velocityZ ?? 0);
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

export function writeNetworkUnitCombatMode(
  dst: NetworkUnitSnapshot,
  entity: Entity,
): void {
  dst.fireEnabled = entity.combat?.fireEnabled === false ? false : undefined;
}

export function clearNetworkUnitCombatMode(dst: NetworkUnitSnapshot): void {
  dst.fireEnabled = undefined;
}

export function writeNetworkUnitActions(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  actionPool: NetworkServerSnapshotAction[],
  canReferenceEntityId?: (id: number | undefined) => boolean,
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
    action.targetId = canReferenceEntityId?.(src.targetId) === false
      ? undefined
      : src.targetId;
    action.buildingType = src.buildingType;
    if (src.gridX !== undefined) {
      if (!action.grid) action.grid = { x: 0, y: 0 };
      action.grid.x = src.gridX;
      action.grid.y = src.gridY!;
    } else {
      action.grid = undefined;
    }
    action.buildingId = canReferenceEntityId?.(src.buildingId) === false
      ? undefined
      : src.buildingId;
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
    paid: { energy: 0, metal: 0 },
  };
}

function copyNetworkUnitBuildState(
  src: NonNullable<NetworkUnitSnapshot['build']>,
  dst: NonNullable<NetworkUnitSnapshot['build']>,
): NonNullable<NetworkUnitSnapshot['build']> {
  dst.complete = src.complete;
  dst.paid.energy = src.paid.energy;
  dst.paid.metal = src.paid.metal;
  return dst;
}

export function copyNetworkUnitSnapshotInto(
  src: NetworkUnitSnapshot,
  dst: NetworkUnitSnapshot,
): NetworkUnitSnapshot {
  dst.unitType = src.unitType;
  if (src.hp) {
    const hp = dst.hp ?? (dst.hp = { curr: 0, max: 0 });
    hp.curr = src.hp.curr;
    hp.max = src.hp.max;
  } else {
    dst.hp = undefined;
  }
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
  if (src.velocity) {
    const velocity = dst.velocity ?? (dst.velocity = { x: 0, y: 0, z: 0 });
    velocity.x = src.velocity.x;
    velocity.y = src.velocity.y;
    velocity.z = src.velocity.z;
  } else {
    dst.velocity = undefined;
  }
  if (src.surfaceNormal) {
    const sn = dst.surfaceNormal ?? (dst.surfaceNormal = { nx: 0, ny: 0, nz: 1 });
    sn.nx = src.surfaceNormal.nx;
    sn.ny = src.surfaceNormal.ny;
    sn.nz = src.surfaceNormal.nz;
  } else {
    dst.surfaceNormal = undefined;
  }
  dst.suspension = undefined;
  if (src.orientation) {
    const o = dst.orientation ?? (dst.orientation = { x: 0, y: 0, z: 0, w: 1 });
    o.x = src.orientation.x;
    o.y = src.orientation.y;
    o.z = src.orientation.z;
    o.w = src.orientation.w;
  } else {
    dst.orientation = undefined;
  }
  dst.angularVelocity3 = copyVec3OptionalInto(src.angularVelocity3, dst.angularVelocity3);
  dst.fireEnabled = src.fireEnabled;
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
  if ((isFull || (cf & ENTITY_CHANGED_POS)) && src.pos) {
    target.x = deqEntityPos(src.pos.x);
    target.y = deqEntityPos(src.pos.y);
    target.z = deqEntityPos(src.pos.z);
  }
  if (isFull && isFiniteNumber(src.unit?.bodyCenterHeight)) {
    target.bodyCenterHeight = src.unit.bodyCenterHeight;
  }
  if (isFull || (cf & ENTITY_CHANGED_NORMAL)) {
    const sn = src.unit?.surfaceNormal;
    if (sn) {
      target.surfaceNormalX = deqNormal(sn.nx);
      target.surfaceNormalY = deqNormal(sn.ny);
      target.surfaceNormalZ = deqNormal(sn.nz);
    }
  }
  if ((isFull || (cf & ENTITY_CHANGED_ROT)) && isFiniteNumber(src.rotation)) {
    target.rotation = deqRot(src.rotation);
  }
  if (isFull || (cf & ENTITY_CHANGED_VEL)) {
    const v = src.unit?.velocity;
    if (v !== undefined) {
      target.velocityX = deqVel(v.x);
      target.velocityY = deqVel(v.y);
      target.velocityZ = deqVel(v.z);
    }
  }
  // Full 3-DOF orientation triad for hover-style entities. The
  // wire field is gated on the entity having one server-side, so
  // ground units never produce these and we leave the cached
  // target fields undefined.
  const o = src.unit?.orientation;
  if (o) {
    const t = target.orientation ?? (target.orientation = { x: 0, y: 0, z: 0, w: 1 });
    t.x = o.x;
    t.y = o.y;
    t.z = o.z;
    t.w = o.w;
  } else if (isFull) {
    target.orientation = undefined;
  }
  const av = src.unit?.angularVelocity3;
  if (av) {
    target.angularVelocityX = av.x;
    target.angularVelocityY = av.y;
    target.angularVelocityZ = av.z;
  } else if (isFull || (cf & ENTITY_CHANGED_VEL)) {
    target.angularVelocityX = undefined;
    target.angularVelocityY = undefined;
    target.angularVelocityZ = undefined;
  }
}
