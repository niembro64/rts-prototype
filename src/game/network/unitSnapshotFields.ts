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
    unitType: null,
    hp: { curr: 0, max: 0 },
    radius: null,
    bodyCenterHeight: null,
    mass: null,
    velocity: { x: 0, y: 0, z: 0 },
    surfaceNormal: null,
    orientation: null,
    angularVelocity3: null,
    fireEnabled: null,
    isCommander: null,
    buildTargetId: null,
    buildTargetIdPresent: false,
    actions: null,
    turrets: null,
    build: null,
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
    z: action.posZ ?? undefined,
    isPathExpansion: action.pathExp ?? undefined,
    targetId: action.targetId ?? undefined,
    buildingType: (action.buildingType ?? undefined) as BuildingType | undefined,
    gridX: action.grid?.x,
    gridY: action.grid?.y,
    buildingId: action.buildingId ?? undefined,
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
  src: NetworkUnitSnapshot | undefined | null,
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
  src: NetworkUnitSnapshot | undefined | null,
  fallback: number,
): number {
  return finiteOr(src?.bodyCenterHeight, finiteOr(src?.radius?.push, fallback));
}

export function readNetworkUnitMass(
  src: NetworkUnitSnapshot | undefined | null,
  fallback: number,
): number {
  return finiteOr(src?.mass, fallback);
}

export function readNetworkUnitVelocity(src: NetworkUnitSnapshot | undefined | null): Vec3 {
  return {
    x: deqVel(finiteOr(src?.velocity?.x, 0)),
    y: deqVel(finiteOr(src?.velocity?.y, 0)),
    z: deqVel(finiteOr(src?.velocity?.z, 0)),
  };
}

export function readNetworkUnitSurfaceNormal(
  src: NetworkUnitSnapshot | undefined | null,
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
  dst.radius = null;
  dst.bodyCenterHeight = null;
  dst.mass = null;
  dst.isCommander = unitIsCommander ? true : null;
}

export function clearNetworkUnitStaticFields(dst: NetworkUnitSnapshot): void {
  dst.unitType = null;
  dst.radius = null;
  dst.bodyCenterHeight = null;
  dst.mass = null;
  dst.isCommander = null;
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
  dst.surfaceNormal = null;
}

export function writeNetworkUnitCombatMode(
  dst: NetworkUnitSnapshot,
  entity: Entity,
): void {
  const combat = entity.combat;
  dst.fireEnabled = combat !== null && combat.fireEnabled === false ? false : null;
}

export function clearNetworkUnitCombatMode(dst: NetworkUnitSnapshot): void {
  dst.fireEnabled = null;
}

export function writeNetworkUnitActions(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  actionPool: NetworkServerSnapshotAction[],
  canReferenceEntityId: ((id: number | undefined) => boolean) | undefined = undefined,
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
      action.pos = null;
    }
    action.posZ = src.z ?? null;
    action.pathExp = src.isPathExpansion ? true : null;
    action.targetId = canReferenceEntityId !== undefined && canReferenceEntityId(src.targetId) === false
      ? null
      : src.targetId ?? null;
    action.buildingType = src.buildingType ?? null;
    if (src.gridX !== undefined) {
      if (!action.grid) action.grid = { x: 0, y: 0 };
      action.grid.x = src.gridX;
      action.grid.y = src.gridY!;
    } else {
      action.grid = null;
    }
    action.buildingId = canReferenceEntityId !== undefined && canReferenceEntityId(src.buildingId) === false
      ? null
      : src.buildingId ?? null;
  }
  dst.actions = actionPool;
}

export function clearNetworkUnitActions(dst: NetworkUnitSnapshot): void {
  dst.actions = null;
}

function copyVec3OptionalInto(
  src: Vec3 | null,
  dst: Vec3 | null,
): Vec3 | null {
  if (!src) return null;
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
  if (src.hp !== null) {
    const hp = dst.hp ?? (dst.hp = { curr: 0, max: 0 });
    hp.curr = src.hp.curr;
    hp.max = src.hp.max;
  } else {
    dst.hp = null;
  }
  if (src.radius !== null) {
    const radius = dst.radius ?? (dst.radius = { body: 0, shot: 0, push: 0 });
    radius.body = src.radius.body;
    radius.shot = src.radius.shot;
    radius.push = src.radius.push;
  } else {
    dst.radius = null;
  }
  dst.bodyCenterHeight = src.bodyCenterHeight;
  dst.mass = src.mass;
  if (src.velocity !== null) {
    const velocity = dst.velocity ?? (dst.velocity = { x: 0, y: 0, z: 0 });
    velocity.x = src.velocity.x;
    velocity.y = src.velocity.y;
    velocity.z = src.velocity.z;
  } else {
    dst.velocity = null;
  }
  if (src.surfaceNormal !== null) {
    const sn = dst.surfaceNormal ?? (dst.surfaceNormal = { nx: 0, ny: 0, nz: 1 });
    sn.nx = src.surfaceNormal.nx;
    sn.ny = src.surfaceNormal.ny;
    sn.nz = src.surfaceNormal.nz;
  } else {
    dst.surfaceNormal = null;
  }
  if (src.orientation !== null) {
    const o = dst.orientation ?? (dst.orientation = { x: 0, y: 0, z: 0, w: 1 });
    o.x = src.orientation.x;
    o.y = src.orientation.y;
    o.z = src.orientation.z;
    o.w = src.orientation.w;
  } else {
    dst.orientation = null;
  }
  dst.angularVelocity3 = copyVec3OptionalInto(src.angularVelocity3, dst.angularVelocity3);
  dst.fireEnabled = src.fireEnabled;
  dst.isCommander = src.isCommander;
  dst.buildTargetId = src.buildTargetId;
  dst.buildTargetIdPresent = src.buildTargetIdPresent;
  dst.build = src.build
    ? copyNetworkUnitBuildState(src.build, dst.build ?? createNetworkUnitBuildState())
    : null;

  if (src.actions !== null) {
    const actions = dst.actions ?? (dst.actions = []);
    actions.length = src.actions.length;
    for (let i = 0; i < src.actions.length; i++) {
      actions[i] = copyActionInto(src.actions[i], actions[i] ?? createActionDto());
    }
  } else {
    dst.actions = null;
  }

  if (src.turrets !== null) {
    const turrets = dst.turrets ?? (dst.turrets = []);
    turrets.length = src.turrets.length;
    for (let i = 0; i < src.turrets.length; i++) {
      turrets[i] = copyTurretInto(
        src.turrets[i],
        turrets[i] ?? createTurretDto(),
      );
    }
  } else {
    dst.turrets = null;
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
    if (v !== null && v !== undefined) {
      target.velocityX = deqVel(v.x);
      target.velocityY = deqVel(v.y);
      target.velocityZ = deqVel(v.z);
    }
  }
  // Full 3-DOF orientation triad for hover-style entities. The
  // wire field is gated on the entity having one server-side, so
  // ground units never produce these and we leave the cached
  // target fields null.
  const unit = src.unit;
  const o = unit !== null ? unit.orientation : null;
  if (o !== null) {
    let t = target.orientation;
    if (t === null) {
      t = { x: 0, y: 0, z: 0, w: 1 };
      target.orientation = t;
    }
    t.x = o.x;
    t.y = o.y;
    t.z = o.z;
    t.w = o.w;
  } else if (isFull) {
    target.orientation = null;
  }
  const av = unit !== null ? unit.angularVelocity3 : null;
  if (av !== null) {
    target.angularVelocityX = av.x;
    target.angularVelocityY = av.y;
    target.angularVelocityZ = av.z;
  } else if (isFull || (cf & ENTITY_CHANGED_VEL)) {
    target.angularVelocityX = null;
    target.angularVelocityY = null;
    target.angularVelocityZ = null;
  }
}
