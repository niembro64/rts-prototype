import type { BuildingBlueprintId, CombatFireState, Entity, Unit, UnitAction, UnitMoveState, UnitPathPoint } from '../sim/types';
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
  codeToUnitBlueprintId,
  unitBlueprintIdToCode,
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

type NetworkUnitSnapshot = NonNullable<NetworkServerSnapshotEntity['unit']>;
type NetworkUnitRadius = NonNullable<NetworkUnitSnapshot['radius']>;

type Vec3 = { x: number; y: number; z: number };
type Quantize = (n: number) => number;

function isNetworkUnitMoveState(value: unknown): value is UnitMoveState {
  return value === 'maneuver' || value === 'holdPosition' || value === 'roam';
}

function isNetworkCombatFireState(value: unknown): value is CombatFireState {
  return value === 'fireAtWill' || value === 'returnFire' || value === 'holdFire';
}

export function readNetworkCombatFireState(src: NetworkUnitSnapshot | undefined | null): CombatFireState {
  if (isNetworkCombatFireState(src?.fireState)) return src.fireState;
  return src?.fireEnabled === false ? 'holdFire' : 'fireAtWill';
}

export function readNetworkUnitMoveState(src: NetworkUnitSnapshot | undefined | null): UnitMoveState {
  if (isNetworkUnitMoveState(src?.moveState)) return src.moveState;
  return src?.holdPosition === true ? 'holdPosition' : 'maneuver';
}

export function createNetworkUnitSnapshot(): NetworkUnitSnapshot {
  return {
    unitBlueprintCode: null,
    hp: { curr: 0, max: 0 },
    radius: null,
    bodyCenterHeight: null,
    mass: null,
    velocity: { x: 0, y: 0, z: 0 },
    surfaceNormal: null,
    orientation: null,
    angularVelocity3: null,
    fireEnabled: null,
    fireState: null,
    trajectoryMode: null,
    repeatQueue: null,
    moveState: null,
    holdPosition: null,
    wantCloak: null,
    cloaked: null,
    isCommander: null,
    buildTargetId: null,
    buildTargetIdPresent: false,
    actions: null,
    turrets: null,
    build: null,
  };
}

export function decodeNetworkUnitBlueprintId(unitBlueprintCode: unknown): string | null {
  return isFiniteNumber(unitBlueprintCode) ? codeToUnitBlueprintId(unitBlueprintCode) : null;
}

function decodeNetworkUnitAction(action: NetworkServerSnapshotAction): UnitAction | null {
  const pos = action.pos;
  if (pos === null) return null;
  const grid = action.grid;
  return {
    type: codeToActionType(action.type) as UnitAction['type'],
    x: pos.x,
    y: pos.y,
    z: action.posZ ?? undefined,
    isPathExpansion: action.pathExp ?? undefined,
    targetId: action.targetId ?? undefined,
    buildingBlueprintId: (action.buildingBlueprintId ?? undefined) as BuildingBlueprintId | undefined,
    gridX: grid !== null && grid !== undefined ? grid.x : undefined,
    gridY: grid !== null && grid !== undefined ? grid.y : undefined,
    buildingId: action.buildingId ?? undefined,
    waitGather: action.waitGather === true ? true : undefined,
    waitGroupId: action.waitGroupId ?? undefined,
  };
}

export type DecodedNetworkUnitActions = {
  /** Durable authored waypoints — a pure mirror of the sim action queue,
   *  with no pathfinder intermediates mixed in (queue indices, order
   *  counts, and insert positions therefore line up with the host). */
  actions: UnitAction[];
  /** Active-leg pathfinder route preview for presentation, or null when
   *  the unit has no multi-point plan. Reconstructed as an activePath so
   *  Waypoint3D can trace the smoothed route the unit actually walks. */
  routePreview: Unit['activePath'];
};

/** Rebuild a client-side activePath from decoded route-preview points.
 *  This is presentation state: only `points` is ever read (by Waypoint3D).
 *  The plan-cache metadata is filled with inert values because the client
 *  view never re-plans against it — the local server simulation owns the
 *  authoritative plan and regenerates it from the durable waypoints. */
function buildClientRoutePreview(
  points: UnitPathPoint[] | null,
  actions: readonly UnitAction[],
): Unit['activePath'] {
  if (points === null || points.length === 0) return null;
  const goal = actions.length > 0 ? actions[0] : undefined;
  const fallback = points[points.length - 1];
  return {
    points,
    index: 0,
    actionHash: 0,
    terrainVersion: 0,
    buildingGridVersion: 0,
    goalX: goal?.x ?? fallback.x,
    goalY: goal?.y ?? fallback.y,
    goalZ: goal?.z,
    actionType: goal?.type ?? 'move',
    targetId: goal?.targetId,
    buildingId: goal?.buildingId,
  };
}

/** Decode the wire action list, splitting the planner's pathfinding
 *  intermediates (pathExp entries) out of the durable waypoints. The
 *  intermediates ride the same wire framing as a transport detail, but
 *  are immediately separated so neither array on the client mixes
 *  authored intent with disposable path points. */
export function decodeNetworkUnitActions(
  actions: NetworkUnitSnapshot['actions'] | undefined | null,
): DecodedNetworkUnitActions {
  const decoded: UnitAction[] = [];
  let previewPoints: UnitPathPoint[] | null = null;
  if (actions) {
    for (let i = 0; i < actions.length; i++) {
      const action = decodeNetworkUnitAction(actions[i]);
      if (!action) continue;
      if (action.isPathExpansion === true) {
        (previewPoints ??= []).push({ x: action.x, y: action.y, z: action.z });
      } else {
        decoded.push(action);
      }
    }
  }
  return { actions: decoded, routePreview: buildClientRoutePreview(previewPoints, decoded) };
}

export function applyNetworkUnitActions(
  unit: Unit,
  actions: NetworkUnitSnapshot['actions'] | undefined | null,
): void {
  const decoded = decodeNetworkUnitActions(actions);
  const dst = unit.actions;
  dst.length = 0;
  for (let i = 0; i < decoded.actions.length; i++) dst.push(decoded.actions[i]);
  // refreshUnitActionHash clears activePath (it treats it as stale sim-cache
  // state), so assign the decoded presentation preview AFTERWARD — otherwise
  // it would be wiped before Waypoint3D ever reads it on the render frame.
  refreshUnitActionHash(unit);
  unit.activePath = decoded.routePreview;
}

export function applyNetworkUnitStaticFields(unit: Unit, src: NetworkUnitSnapshot): void {
  const radius = src.radius;
  if (radius) {
    if (isFiniteNumber(radius.other)) unit.radius.other = radius.other;
    if (isFiniteNumber(radius.hitbox)) unit.radius.hitbox = radius.hitbox;
    if (isFiniteNumber(radius.collision)) unit.radius.collision = radius.collision;
  }
  if (isFiniteNumber(src.bodyCenterHeight)) {
    unit.bodyCenterHeight = src.bodyCenterHeight;
  }
  const unitBlueprintId = decodeNetworkUnitBlueprintId(src.unitBlueprintCode);
  if (unitBlueprintId) {
    unit.unitBlueprintId = unitBlueprintId;
    unit.locomotion = getUnitLocomotion(unitBlueprintId);
  }
  if (isFiniteNumber(src.mass)) unit.mass = src.mass;
}

export function applyNetworkUnitCombatMode(
  entity: Entity,
  src: NetworkUnitSnapshot,
  isFull: boolean,
): void {
  if (!entity.combat) return;
  entity.combat.fireState = readNetworkCombatFireState(src);
  entity.combat.fireEnabled = entity.combat.fireState !== 'holdFire';
  if (src.trajectoryMode !== null && src.trajectoryMode !== undefined) {
    entity.combat.trajectoryMode = src.trajectoryMode;
  } else if (isFull) {
    entity.combat.trajectoryMode = 'auto';
  }
}

export function applyNetworkUnitCommandState(
  unit: Unit,
  src: NetworkUnitSnapshot,
  isFull: boolean,
): void {
  if (src.repeatQueue !== null && src.repeatQueue !== undefined) {
    unit.repeatQueue = src.repeatQueue === true;
  } else if (isFull) {
    unit.repeatQueue = false;
  }
  if (src.moveState !== null && src.moveState !== undefined) {
    unit.moveState = readNetworkUnitMoveState(src);
  } else if (src.holdPosition !== null && src.holdPosition !== undefined) {
    unit.moveState = src.holdPosition === true ? 'holdPosition' : 'maneuver';
  } else if (isFull) {
    unit.moveState = 'maneuver';
  }
  if (src.wantCloak !== null && src.wantCloak !== undefined) {
    unit.wantCloak = src.wantCloak === true;
  } else if (isFull) {
    unit.wantCloak = false;
  }
  if (src.cloaked !== null && src.cloaked !== undefined) {
    unit.cloaked = src.cloaked === true;
  } else if (isFull) {
    unit.cloaked = false;
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

export function readNetworkUnitRadius(
  src: NetworkUnitSnapshot | undefined | null,
  fallback: number | NetworkUnitRadius,
): { other: number; hitbox: number; collision: number } {
  const radius = src !== null && src !== undefined ? src.radius : null;
  return {
    other: finiteOr(
      radius !== null && radius !== undefined ? radius.other : undefined,
      radiusFallback(fallback, 'other'),
    ),
    hitbox: finiteOr(
      radius !== null && radius !== undefined ? radius.hitbox : undefined,
      radiusFallback(fallback, 'hitbox'),
    ),
    collision: finiteOr(
      radius !== null && radius !== undefined ? radius.collision : undefined,
      radiusFallback(fallback, 'collision'),
    ),
  };
}

function radiusFallback(fallback: number | NetworkUnitRadius, key: keyof NetworkUnitRadius): number {
  return typeof fallback === 'number' ? fallback : finiteOr(fallback[key], 15);
}

export function readNetworkUnitBodyCenterHeight(
  src: NetworkUnitSnapshot | undefined | null,
  fallback: number,
): number {
  if (src === null || src === undefined) return fallback;
  const radius = src.radius;
  return finiteOr(
    src.bodyCenterHeight,
    finiteOr(radius !== null && radius !== undefined ? radius.collision : undefined, fallback),
  );
}

export function readNetworkUnitMass(
  src: NetworkUnitSnapshot | undefined | null,
  fallback: number,
): number {
  return src !== null && src !== undefined ? finiteOr(src.mass, fallback) : fallback;
}

export function readNetworkUnitVelocity(src: NetworkUnitSnapshot | undefined | null): Vec3 {
  const velocity = src !== null && src !== undefined ? src.velocity : null;
  return {
    x: deqVel(finiteOr(velocity !== null && velocity !== undefined ? velocity.x : undefined, 0)),
    y: deqVel(finiteOr(velocity !== null && velocity !== undefined ? velocity.y : undefined, 0)),
    z: deqVel(finiteOr(velocity !== null && velocity !== undefined ? velocity.z : undefined, 0)),
  };
}

export function readNetworkUnitSurfaceNormal(
  src: NetworkUnitSnapshot | undefined | null,
): { nx: number; ny: number; nz: number } {
  const surfaceNormal = src !== null && src !== undefined ? src.surfaceNormal : null;
  if (surfaceNormal === null || surfaceNormal === undefined) return { nx: 0, ny: 0, nz: 1 };
  return {
    nx: deqNormal(finiteOr(surfaceNormal.nx, 0)),
    ny: deqNormal(finiteOr(surfaceNormal.ny, 0)),
    nz: deqNormal(finiteOr(surfaceNormal.nz, 1000)),
  };
}

export function writeNetworkUnitStaticFields(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  unitIsCommander: boolean,
): void {
  dst.unitBlueprintCode = unitBlueprintIdToCode(unit.unitBlueprintId);
  dst.radius = null;
  dst.bodyCenterHeight = null;
  dst.mass = null;
  dst.isCommander = unitIsCommander ? true : null;
}

export function clearNetworkUnitStaticFields(dst: NetworkUnitSnapshot): void {
  dst.unitBlueprintCode = null;
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
  const fireState = combat?.fireState ?? (combat?.fireEnabled === false ? 'holdFire' : 'fireAtWill');
  dst.fireState = combat !== null && fireState !== 'fireAtWill' ? fireState : null;
  dst.fireEnabled = combat !== null && fireState === 'holdFire' ? false : null;
  dst.trajectoryMode = combat !== null && combat.trajectoryMode !== 'auto'
    ? combat.trajectoryMode
    : null;
}

export function clearNetworkUnitCombatMode(dst: NetworkUnitSnapshot): void {
  dst.fireEnabled = null;
  dst.fireState = null;
  dst.trajectoryMode = null;
}

/** Cap on smoothed pathfinder intermediates serialized per unit as a
 *  presentation-only route preview. Smoothed paths are short (corner nodes
 *  only); the cap is a guard against a pathological plan, not a normal limit. */
const MAX_ROUTE_PREVIEW_POINTS = 64;

export function writeNetworkUnitActions(
  dst: NetworkUnitSnapshot,
  unit: Unit,
  actionPool: NetworkServerSnapshotAction[],
  canReferenceEntityId: ((id: number | undefined) => boolean) | undefined = undefined,
): void {
  const actions = unit.actions ?? [];
  const realCount = actions.length;

  // Active-leg pathfinding route preview (presentation only). The planner
  // keeps its smoothed intermediate points in unit.activePath, deliberately
  // OUT of the durable action queue — waypoints are intent, pathfinding
  // points are disposable. For visualization we ship the remaining
  // intermediates as leading pathExp entries; the client splits them back
  // out into activePath (see decodeNetworkUnitActions), so the action queue
  // every client sees stays a pure mirror of authored intent.
  let previewStart = 0;
  let previewEnd = 0;
  const plan = unit.activePath;
  if (
    plan !== null &&
    realCount > 0 &&
    plan.goalX === actions[0].x &&
    plan.goalY === actions[0].y &&
    plan.goalZ === actions[0].z
  ) {
    // Skip points already passed (index) and the final point, which
    // coincides with actions[0] (the leg goal carries its own marker).
    previewStart = plan.index > 0 ? plan.index : 0;
    previewEnd = plan.points.length - 1;
    if (previewEnd - previewStart > MAX_ROUTE_PREVIEW_POINTS) {
      previewEnd = previewStart + MAX_ROUTE_PREVIEW_POINTS;
    }
    if (previewEnd < previewStart) previewEnd = previewStart;
  }
  const previewCount = previewEnd - previewStart;
  const total = previewCount + realCount;

  while (actionPool.length < total) actionPool.push(createActionDto());
  actionPool.length = total;

  let w = 0;
  if (previewCount > 0) {
    const moveCode = actionTypeToCode('move');
    const points = plan!.points;
    for (let k = previewStart; k < previewEnd; k++) {
      const pt = points[k];
      const action = actionPool[w++];
      action.type = moveCode;
      if (!action.pos) action.pos = { x: 0, y: 0 };
      action.pos.x = pt.x;
      action.pos.y = pt.y;
      action.posZ = pt.z ?? null;
      action.pathExp = true;
      action.targetId = null;
      action.buildingBlueprintId = null;
      action.grid = null;
      action.buildingId = null;
      action.waitGather = null;
      action.waitGroupId = null;
    }
  }

  for (let i = 0; i < realCount; i++) {
    const src = actions[i];
    const action = actionPool[w++];
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
    action.buildingBlueprintId = src.buildingBlueprintId ?? null;
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
    action.waitGather = src.waitGather === true ? true : null;
    action.waitGroupId = src.waitGroupId ?? null;
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
    interrupted: false,
    paid: { energy: 0, metal: 0 },
  };
}

function copyNetworkUnitBuildState(
  src: NonNullable<NetworkUnitSnapshot['build']>,
  dst: NonNullable<NetworkUnitSnapshot['build']>,
): NonNullable<NetworkUnitSnapshot['build']> {
  dst.complete = src.complete;
  dst.interrupted = src.interrupted === true;
  dst.paid.energy = src.paid.energy;
  dst.paid.metal = src.paid.metal;
  return dst;
}

export function copyNetworkUnitSnapshotInto(
  src: NetworkUnitSnapshot,
  dst: NetworkUnitSnapshot,
): NetworkUnitSnapshot {
  dst.unitBlueprintCode = src.unitBlueprintCode ?? null;
  if (src.hp != null) {
    const hp = dst.hp ?? (dst.hp = { curr: 0, max: 0 });
    hp.curr = src.hp.curr;
    hp.max = src.hp.max;
  } else {
    dst.hp = null;
  }
  if (src.radius != null) {
    const radius = dst.radius ?? (dst.radius = { other: 0, hitbox: 0, collision: 0 });
    radius.other = src.radius.other;
    radius.hitbox = src.radius.hitbox;
    radius.collision = src.radius.collision;
  } else {
    dst.radius = null;
  }
  dst.bodyCenterHeight = src.bodyCenterHeight ?? null;
  dst.mass = src.mass ?? null;
  if (src.velocity != null) {
    const velocity = dst.velocity ?? (dst.velocity = { x: 0, y: 0, z: 0 });
    velocity.x = src.velocity.x;
    velocity.y = src.velocity.y;
    velocity.z = src.velocity.z;
  } else {
    dst.velocity = null;
  }
  if (src.surfaceNormal != null) {
    const sn = dst.surfaceNormal ?? (dst.surfaceNormal = { nx: 0, ny: 0, nz: 1 });
    sn.nx = src.surfaceNormal.nx;
    sn.ny = src.surfaceNormal.ny;
    sn.nz = src.surfaceNormal.nz;
  } else {
    dst.surfaceNormal = null;
  }
  if (src.orientation != null) {
    const o = dst.orientation ?? (dst.orientation = { x: 0, y: 0, z: 0, w: 1 });
    o.x = src.orientation.x;
    o.y = src.orientation.y;
    o.z = src.orientation.z;
    o.w = src.orientation.w;
  } else {
    dst.orientation = null;
  }
  dst.angularVelocity3 = copyVec3OptionalInto(src.angularVelocity3, dst.angularVelocity3);
  dst.fireEnabled = src.fireEnabled ?? null;
  dst.fireState = src.fireState ?? null;
  dst.trajectoryMode = src.trajectoryMode ?? null;
  dst.repeatQueue = src.repeatQueue ?? null;
  dst.moveState = src.moveState ?? null;
  dst.holdPosition = src.holdPosition ?? null;
  dst.wantCloak = src.wantCloak ?? null;
  dst.cloaked = src.cloaked ?? null;
  dst.isCommander = src.isCommander ?? null;
  dst.buildTargetId = src.buildTargetId ?? null;
  dst.buildTargetIdPresent = src.buildTargetIdPresent === true;
  dst.build = src.build
    ? copyNetworkUnitBuildState(src.build, dst.build ?? createNetworkUnitBuildState())
    : null;

  if (src.actions != null) {
    const actions = dst.actions ?? (dst.actions = []);
    actions.length = src.actions.length;
    for (let i = 0; i < src.actions.length; i++) {
      actions[i] = copyActionInto(src.actions[i], actions[i] ?? createActionDto());
    }
  } else {
    dst.actions = null;
  }

  if (src.turrets != null) {
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
  const unit = src.unit;
  if (isFull && unit !== null && unit !== undefined && isFiniteNumber(unit.bodyCenterHeight)) {
    target.bodyCenterHeight = unit.bodyCenterHeight;
  }
  if (isFull || (cf & ENTITY_CHANGED_NORMAL)) {
    const sn = unit !== null && unit !== undefined ? unit.surfaceNormal : null;
    if (sn !== null && sn !== undefined) {
      target.surfaceNormalX = deqNormal(sn.nx);
      target.surfaceNormalY = deqNormal(sn.ny);
      target.surfaceNormalZ = deqNormal(sn.nz);
    }
  }
  if ((isFull || (cf & ENTITY_CHANGED_ROT)) && isFiniteNumber(src.rotation)) {
    target.rotation = deqRot(src.rotation);
  }
  if (isFull || (cf & ENTITY_CHANGED_VEL)) {
    const v = unit !== null && unit !== undefined ? unit.velocity : null;
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
  const o = unit !== null && unit !== undefined ? unit.orientation : null;
  if (o !== null && o !== undefined) {
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
  const av = unit !== null && unit !== undefined ? unit.angularVelocity3 : null;
  if (av !== null && av !== undefined) {
    target.angularVelocityX = av.x;
    target.angularVelocityY = av.y;
    target.angularVelocityZ = av.z;
  } else if (isFull || (cf & ENTITY_CHANGED_VEL)) {
    target.angularVelocityX = null;
    target.angularVelocityY = null;
    target.angularVelocityZ = null;
  }
}
