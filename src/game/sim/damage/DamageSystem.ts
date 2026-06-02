// Unified Damage System
// Handles all damage types consistently: line (beams), swept (projectiles), area (splash/shield)
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full entity scans

import type { WorldState } from '../WorldState';
import type { BeamReflectorKind, Entity, EntityId, RayType, PlayerId, Turret } from '../types';
import { isProjectileShot, NO_ENTITY_ID } from '../types';
import type {
  AnyDamageSource,
  LineDamageSource,
  SweptDamageSource,
  AreaDamageSource,
  DamageResult,
  HitInfo,
  DeathContext,
  KnockbackInfo,
} from './types';
import {
  BEAM_EXPLOSION_MAGNITUDE,
  KNOCKBACK,
  PROJECTILE_MASS_MULTIPLIER,
} from '../../../config';
import { spatialGrid } from '../SpatialGrid';
import { magnitude, lineCircleIntersectionT, lineSphereIntersectionT, lineRectIntersectionT, rayBoxIntersectionT, getTransformCosSin } from '../../math';
import { findClosestPanelHit } from '../combat/ShieldPanelHit';
import { findShieldSegmentIntersection } from '../combat/shieldTurret';
import { REFLECTIVE_SHIELD_MATERIAL } from '../blueprints/shieldMaterials';
import { getTargetRadius, resolveWeaponWorldMount } from '../combat/combatUtils';
import {
  distanceToRayConfigRangeCylinder,
  type RayConfigRangeCylinder,
} from '../combat/lineShotRange';
import { ENTITY_CHANGED_HP } from '../../../types/network';
import { getSimWasm } from '../../sim-wasm/init';
import {
  BUILDING_CLOSED_DAMAGE_MULTIPLIER,
  buildingBlueprintHasActiveState,
  isBuildingActiveStateFortified,
  notifyBuildingActiveStateDamaged,
} from '../buildingActiveState';
import { getUnitGroundZ } from '../unitGeometry';
import { isConstructionBodyMaterialized } from '../buildableHelpers';
import { getActiveShieldPanelTurret } from '../shieldPanelRuntime';


// Reusable DamageResult to avoid per-call allocations
const _reusableResult: DamageResult = {
  hitEntityIds: [],
  killedUnitIds: new Set(),
  killedBuildingIds: new Set(),
  killedProjectileIds: new Set(),
  killedTurretIds: new Set(),
  knockbacks: [],
  deathContexts: new Map(),
  killerPlayerIds: new Map(),
};
// Pool for KnockbackInfo + its inner Vec2. The result.knockbacks array
// itself is reused, but each entry pushed during an explosion was a
// fresh `{ entityId, force: { x, y } }` allocation — and big splashes
// drop these by the hundred per second. Pool both the outer entry
// AND the inner force vector; pushKnockback() rents an entry, fills
// it, and appends. resetResult() returns the previous tick's entries
// to the pool before clearing the result.
const _knockbackPool: KnockbackInfo[] = [];
function rentKnockback(): KnockbackInfo {
  return _knockbackPool.pop() ?? { entityId: 0, force: { x: 0, y: 0 } };
}
function pushKnockback(
  result: DamageResult,
  entityId: number,
  fx: number,
  fy: number,
  fz: number = 0,
): void {
  const k = rentKnockback();
  k.entityId = entityId;
  k.force.x = fx;
  k.force.y = fy;
  k.forceZ = fz;
  result.knockbacks.push(k);
}
function resetResult(): DamageResult {
  _reusableResult.hitEntityIds.length = 0;
  _reusableResult.killedUnitIds.clear();
  _reusableResult.killedBuildingIds.clear();
  _reusableResult.killedProjectileIds.clear();
  _reusableResult.killedTurretIds.clear();
  _reusableResult.truncationT = undefined;
  // Recycle prior tick's knockback entries before clearing the array.
  for (const k of _reusableResult.knockbacks) _knockbackPool.push(k);
  _reusableResult.knockbacks.length = 0;
  _reusableResult.recoil = undefined;
  _reusableResult.deathContexts.clear();
  _reusableResult.killerPlayerIds.clear();
  return _reusableResult;
}

// Reusable HitInfo array for line/swept damage sorting
const _reusableHits: HitInfo[] = [];

// Reset module-level reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetDamageBuffers(): void {
  _reusableResult.hitEntityIds.length = 0;
  _reusableResult.killedUnitIds.clear();
  _reusableResult.killedBuildingIds.clear();
  _reusableResult.killedProjectileIds.clear();
  _reusableResult.killedTurretIds.clear();
  for (const k of _reusableResult.knockbacks) _knockbackPool.push(k);
  _reusableResult.knockbacks.length = 0;
  _reusableResult.deathContexts.clear();
  _reusableResult.killerPlayerIds.clear();
  _reusableHits.length = 0;
  for (let i = 0; i < _damageBatchCount; i++) {
    _damageBatchEntities[i] = undefined;
    _damageBatchDeathContexts[i] = undefined;
  }
  _damageBatchCount = 0;
  _damageBatchEntityIds.clear();
  for (let i = 0; i < _areaDamageEntities.length; i++) {
    _areaDamageEntities[i] = undefined;
  }
}

type BeamReflectorPoint = {
  x: number;
  y: number;
  z: number;
  reflectorEntityId: EntityId;
  reflectorKind: BeamReflectorKind;
  reflectorPlayerId: PlayerId | undefined;
  normalX: number;
  normalY: number;
  normalZ: number;
};

// Reusable result for findBeamSegmentHit. `z` is the world altitude
// of the hit point; `normalX/Y/Z` is the reflector's outward-facing
// 3D normal. Mirrors use their panel normal, shields use the
// sphere surface normal.
const _segHit = {
  t: 0,
  x: 0,
  y: 0,
  z: 0,
  entityId: 0 as EntityId,
  isMirror: false,
  normalX: 0,
  normalY: 0,
  normalZ: 0,
  panelIndex: -1,
  reflectorKind: undefined as BeamReflectorKind | undefined,
  reflectorPlayerId: undefined as PlayerId | undefined,
};
const _shieldPanelPivot = { x: 0, y: 0, z: 0 };
const _subEntityPoint = { x: 0, y: 0, z: 0 };

const BEAM_GROUND_HIT_STEPS = 12;
const BEAM_GROUND_HIT_BISECT_STEPS = 6;
const BEAM_GROUND_EPSILON = 0.25;
const SWEPT_HITBOX_QUERY_EXTRA = 32;

const DAMAGE_TARGET_KIND_UNIT = 1;
const DAMAGE_TARGET_KIND_BUILDING = 2;
const DAMAGE_TARGET_KIND_PROJECTILE = 3;
const DAMAGE_APPLY_FLAG_APPLIED = 1 << 0;
const DAMAGE_APPLY_FLAG_KILLED = 1 << 1;
const DAMAGE_AREA_FLAG_SLICE_PASS = 1 << 0;
const DAMAGE_AREA_FLAG_OVERLAP = 1 << 1;
const DAMAGE_SEGMENT_HIT_FLAG_HIT = 1 << 0;

const _damageApplyEnabled = new Uint8Array(1);
const _damageApplyTargetKind = new Uint8Array(1);
const _damageApplyHp = new Float64Array(1);
const _damageApplyDamage = new Float64Array(1);
const _damageApplyBuildingFortified = new Uint8Array(1);
const _damageApplyOutHp = new Float64Array(1);
const _damageApplyOutEffectiveDamage = new Float64Array(1);
const _damageApplyOutFlags = new Uint8Array(1);
let _damageBatchCapacity = 0;
let _damageBatchCount = 0;
const _damageBatchEntityIds = new Set<EntityId>();
let _damageBatchEntities: Array<Entity | undefined> = [];
let _damageBatchDeathContexts: Array<DeathContext | undefined> = [];
let _damageBatchEnabled = new Uint8Array(0);
let _damageBatchTargetKind = new Uint8Array(0);
let _damageBatchHp = new Float64Array(0);
let _damageBatchDamage = new Float64Array(0);
let _damageBatchBuildingFortified = new Uint8Array(0);
let _damageBatchOutHp = new Float64Array(0);
let _damageBatchOutEffectiveDamage = new Float64Array(0);
let _damageBatchOutFlags = new Uint8Array(0);
let _areaDamageCapacity = 0;
let _areaDamageEntities: Array<Entity | undefined> = [];
let _areaDamageEnabled = new Uint8Array(0);
let _areaDamageTargetKind = new Uint8Array(0);
let _areaDamageTargetX = new Float64Array(0);
let _areaDamageTargetY = new Float64Array(0);
let _areaDamageTargetZ = new Float64Array(0);
let _areaDamageTargetRadius = new Float64Array(0);
let _areaDamageBoxHalfX = new Float64Array(0);
let _areaDamageBoxHalfY = new Float64Array(0);
let _areaDamageBoxHalfZ = new Float64Array(0);
let _areaDamageOutFlags = new Uint8Array(0);
let _areaDamageOutDirX = new Float64Array(0);
let _areaDamageOutDirY = new Float64Array(0);
let _areaDamageOutDirZ = new Float64Array(0);
let _areaDamageOutDistance = new Float64Array(0);
let _segmentDamageCapacity = 0;
let _segmentDamageEntityIds: EntityId[] = [];
let _segmentDamageHostEntityIds: EntityId[] = [];
let _segmentDamageIsUnit = new Uint8Array(0);
let _segmentDamageIsBuilding = new Uint8Array(0);
let _segmentDamageIsProjectile = new Uint8Array(0);
let _segmentDamageEnabled = new Uint8Array(0);
let _segmentDamageTargetKind = new Uint8Array(0);
let _segmentDamageTargetX = new Float64Array(0);
let _segmentDamageTargetY = new Float64Array(0);
let _segmentDamageTargetZ = new Float64Array(0);
let _segmentDamageTargetRadius = new Float64Array(0);
let _segmentDamageBoxHalfX = new Float64Array(0);
let _segmentDamageBoxHalfY = new Float64Array(0);
let _segmentDamageBoxHalfZ = new Float64Array(0);
let _segmentDamageOutFlags = new Uint8Array(0);
let _segmentDamageOutT = new Float64Array(0);

function isTurretDamageable(turret: Turret): boolean {
  return turret.id !== NO_ENTITY_ID && !turret.config.visualOnly;
}

function ensureDamageBatchCapacity(count: number): void {
  if (count <= _damageBatchCapacity) return;
  let next = Math.max(16, _damageBatchCapacity);
  while (next < count) next *= 2;
  const prevEnabled = _damageBatchEnabled;
  const prevTargetKind = _damageBatchTargetKind;
  const prevHp = _damageBatchHp;
  const prevDamage = _damageBatchDamage;
  const prevBuildingFortified = _damageBatchBuildingFortified;
  _damageBatchCapacity = next;
  _damageBatchEntities.length = next;
  _damageBatchDeathContexts.length = next;
  _damageBatchEnabled = new Uint8Array(next);
  _damageBatchTargetKind = new Uint8Array(next);
  _damageBatchHp = new Float64Array(next);
  _damageBatchDamage = new Float64Array(next);
  _damageBatchBuildingFortified = new Uint8Array(next);
  _damageBatchOutHp = new Float64Array(next);
  _damageBatchOutEffectiveDamage = new Float64Array(next);
  _damageBatchOutFlags = new Uint8Array(next);
  _damageBatchEnabled.set(prevEnabled);
  _damageBatchTargetKind.set(prevTargetKind);
  _damageBatchHp.set(prevHp);
  _damageBatchDamage.set(prevDamage);
  _damageBatchBuildingFortified.set(prevBuildingFortified);
}

function ensureAreaDamageCapacity(count: number): void {
  if (count <= _areaDamageCapacity) return;
  let next = Math.max(16, _areaDamageCapacity);
  while (next < count) next *= 2;
  _areaDamageCapacity = next;
  _areaDamageEntities.length = next;
  _areaDamageEnabled = new Uint8Array(next);
  _areaDamageTargetKind = new Uint8Array(next);
  _areaDamageTargetX = new Float64Array(next);
  _areaDamageTargetY = new Float64Array(next);
  _areaDamageTargetZ = new Float64Array(next);
  _areaDamageTargetRadius = new Float64Array(next);
  _areaDamageBoxHalfX = new Float64Array(next);
  _areaDamageBoxHalfY = new Float64Array(next);
  _areaDamageBoxHalfZ = new Float64Array(next);
  _areaDamageOutFlags = new Uint8Array(next);
  _areaDamageOutDirX = new Float64Array(next);
  _areaDamageOutDirY = new Float64Array(next);
  _areaDamageOutDirZ = new Float64Array(next);
  _areaDamageOutDistance = new Float64Array(next);
}

function clearAreaDamageEntities(count: number): void {
  for (let i = 0; i < count; i++) {
    _areaDamageEntities[i] = undefined;
  }
}

function classifyAreaDamageRows(
  source: AreaDamageSource,
  count: number,
  hasSlice: boolean,
  sliceHalfAngle: number,
): void {
  if (count === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Area damage overlap classification requires initialized sim-wasm');
  }
  const processed = sim.damageAreaOverlapBatch(
    count,
    _areaDamageEnabled.subarray(0, count),
    _areaDamageTargetKind.subarray(0, count),
    source.center.x,
    source.center.y,
    source.center.z,
    source.radius,
    hasSlice ? 1 : 0,
    source.sliceDirection ?? 0,
    sliceHalfAngle,
    _areaDamageTargetX.subarray(0, count),
    _areaDamageTargetY.subarray(0, count),
    _areaDamageTargetZ.subarray(0, count),
    _areaDamageTargetRadius.subarray(0, count),
    _areaDamageBoxHalfX.subarray(0, count),
    _areaDamageBoxHalfY.subarray(0, count),
    _areaDamageBoxHalfZ.subarray(0, count),
    _areaDamageOutFlags.subarray(0, count),
    _areaDamageOutDirX.subarray(0, count),
    _areaDamageOutDirY.subarray(0, count),
    _areaDamageOutDirZ.subarray(0, count),
    _areaDamageOutDistance.subarray(0, count),
  );
  if (processed !== count) {
    throw new Error(`Area damage overlap classification failed: ${processed}/${count}`);
  }
}

function ensureSegmentDamageCapacity(count: number): void {
  if (count <= _segmentDamageCapacity) return;
  let next = Math.max(16, _segmentDamageCapacity);
  while (next < count) next *= 2;
  _segmentDamageCapacity = next;
  _segmentDamageEntityIds.length = next;
  _segmentDamageHostEntityIds.length = next;
  _segmentDamageIsUnit = new Uint8Array(next);
  _segmentDamageIsBuilding = new Uint8Array(next);
  _segmentDamageIsProjectile = new Uint8Array(next);
  _segmentDamageEnabled = new Uint8Array(next);
  _segmentDamageTargetKind = new Uint8Array(next);
  _segmentDamageTargetX = new Float64Array(next);
  _segmentDamageTargetY = new Float64Array(next);
  _segmentDamageTargetZ = new Float64Array(next);
  _segmentDamageTargetRadius = new Float64Array(next);
  _segmentDamageBoxHalfX = new Float64Array(next);
  _segmentDamageBoxHalfY = new Float64Array(next);
  _segmentDamageBoxHalfZ = new Float64Array(next);
  _segmentDamageOutFlags = new Uint8Array(next);
  _segmentDamageOutT = new Float64Array(next);
}

function appendSegmentDamageSphereRow(
  row: number,
  entityId: EntityId,
  hostEntityId: EntityId,
  isUnit: boolean,
  isProjectile: boolean,
  x: number,
  y: number,
  z: number,
  radius: number,
): number {
  ensureSegmentDamageCapacity(row + 1);
  _segmentDamageEntityIds[row] = entityId;
  _segmentDamageHostEntityIds[row] = hostEntityId;
  _segmentDamageIsUnit[row] = isUnit ? 1 : 0;
  _segmentDamageIsBuilding[row] = 0;
  _segmentDamageIsProjectile[row] = isProjectile ? 1 : 0;
  _segmentDamageEnabled[row] = 1;
  _segmentDamageTargetKind[row] = isProjectile
    ? DAMAGE_TARGET_KIND_PROJECTILE
    : DAMAGE_TARGET_KIND_UNIT;
  _segmentDamageTargetX[row] = x;
  _segmentDamageTargetY[row] = y;
  _segmentDamageTargetZ[row] = z;
  _segmentDamageTargetRadius[row] = radius;
  _segmentDamageBoxHalfX[row] = 0;
  _segmentDamageBoxHalfY[row] = 0;
  _segmentDamageBoxHalfZ[row] = 0;
  return row + 1;
}

function appendSegmentDamageBoxRow(
  row: number,
  entityId: EntityId,
  x: number,
  y: number,
  z: number,
  halfX: number,
  halfY: number,
  halfZ: number,
): number {
  ensureSegmentDamageCapacity(row + 1);
  _segmentDamageEntityIds[row] = entityId;
  _segmentDamageHostEntityIds[row] = entityId;
  _segmentDamageIsUnit[row] = 0;
  _segmentDamageIsBuilding[row] = 1;
  _segmentDamageIsProjectile[row] = 0;
  _segmentDamageEnabled[row] = 1;
  _segmentDamageTargetKind[row] = DAMAGE_TARGET_KIND_BUILDING;
  _segmentDamageTargetX[row] = x;
  _segmentDamageTargetY[row] = y;
  _segmentDamageTargetZ[row] = z;
  _segmentDamageTargetRadius[row] = 0;
  _segmentDamageBoxHalfX[row] = halfX;
  _segmentDamageBoxHalfY[row] = halfY;
  _segmentDamageBoxHalfZ[row] = halfZ;
  return row + 1;
}

function classifySegmentDamageRows(
  count: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
): void {
  if (count === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Segment damage hit classification requires initialized sim-wasm');
  }
  const processed = sim.damageSegmentHitsBatch(
    count,
    _segmentDamageEnabled.subarray(0, count),
    _segmentDamageTargetKind.subarray(0, count),
    startX,
    startY,
    startZ,
    endX,
    endY,
    endZ,
    _segmentDamageTargetX.subarray(0, count),
    _segmentDamageTargetY.subarray(0, count),
    _segmentDamageTargetZ.subarray(0, count),
    _segmentDamageTargetRadius.subarray(0, count),
    _segmentDamageBoxHalfX.subarray(0, count),
    _segmentDamageBoxHalfY.subarray(0, count),
    _segmentDamageBoxHalfZ.subarray(0, count),
    _segmentDamageOutFlags.subarray(0, count),
    _segmentDamageOutT.subarray(0, count),
  );
  if (processed !== count) {
    throw new Error(`Segment damage hit classification failed: ${processed}/${count}`);
  }
}


export class DamageSystem {
  constructor(private world: WorldState) {}

  // Main entry point - apply any damage source
  applyDamage(source: AnyDamageSource): DamageResult {
    switch (source.type) {
      case 'line':
        return this.applyLineDamage(source);
      case 'swept':
        return this.applySweptDamage(source);
      case 'area':
        return this.applyAreaDamage(source);
    }
  }

  // Find first obstruction along a line (for beam truncation)
  // Returns the parametric T value (0-1) and entity ID of first hit
  // PERFORMANCE: Uses spatial grid line query for O(k) instead of O(n)
  findLineObstruction(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    sourceEntityId: EntityId,
    lineWidth: number
  ): { t: number; entityId: EntityId } | null {
    let closestT = Infinity;
    let closestEntityId: EntityId = NO_ENTITY_ID;

    // PERFORMANCE: Single line-cell sweep filling both arrays. Uses the
    // wider building pad (+100); the per-entity intersection check below
    // re-applies the precise width.
    const { units: nearbyUnits, buildings: nearbyBuildings } =
      spatialGrid.queryEntitiesAlongLine(startX, startY, startZ, endX, endY, endZ, lineWidth + 100);

    // Check units
    for (const unit of nearbyUnits) {
      if (unit.id === sourceEntityId) continue;
      if (
        !unit.unit ||
        unit.unit.hp <= 0
      ) continue;

      const t = lineCircleIntersectionT(
        startX, startY, endX, endY,
        unit.transform.x, unit.transform.y,
        unit.unit.radius.hitbox + lineWidth / 2
      );

      if (t !== null && t < closestT) {
        closestT = t;
        closestEntityId = unit.id;
      }
    }

    // Check buildings
    for (const building of nearbyBuildings) {
      // Skip the firing building — a tower-mounted turret must not
      // self-block on its own AABB (matches the unit-source guard
      // above).
      if (building.id === sourceEntityId) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const bWidth = building.building.width;
      const bHeight = building.building.height;
      const rectX = building.transform.x - bWidth / 2;
      const rectY = building.transform.y - bHeight / 2;

      const t = lineRectIntersectionT(
        startX, startY, endX, endY,
        rectX, rectY, bWidth, bHeight
      );

      if (t !== null && t < closestT) {
        closestT = t;
        closestEntityId = building.id;
      }
    }

    return closestEntityId !== NO_ENTITY_ID ? { t: closestT, entityId: closestEntityId } : null;
  }

  // Find beam path with reflections off mirror units and shield
  // spheres — full 3D.
  //
  // Damage is clipped at the first of: a unit hit, a building hit, a
  // ground hit, the firing turret's vertical range cylinder, or the
  // configured max segment count. Mirrors and shields bounce; reflected
  // segments are clipped against the same original cylinder. A range
  // cylinder endpoint is an open ray for visuals, not a physical impact
  // point.
  //
  // Force-field panels are tilted rectangles; shields are spherical
  // reflectors whose response comes from their shared material. Buildings
  // are 3D AABBs (x/y footprint × z depth), so a high-arc beam can pass
  // over a short building and hit the reflector behind it.
  findBeamPath(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    sourceEntityId: EntityId,
    lineWidth: number,
    lineShotType: RayType = 'beam',
    maxSegments: number = 4,
    rangeCylinder: RayConfigRangeCylinder | undefined = undefined,
  ): {
    endX: number; endY: number; endZ: number;
    obstructionT: number | undefined;
    reflections: BeamReflectorPoint[];
    terminalReflection: BeamReflectorPoint | undefined;
    endpointDamageable: boolean;
    segmentLimitReached: boolean;
  } {
    const reflections: BeamReflectorPoint[] = [];
    const segmentLimit = Math.max(1, Math.floor(maxSegments));
    let remainingRange = Math.hypot(endX - startX, endY - startY, endZ - startZ);
    let curSX = startX, curSY = startY, curSZ = startZ;
    let curEX = endX, curEY = endY, curEZ = endZ;
    let excludeEntityId = sourceEntityId;
    let excludePanelIndex = -1; // -1 = exclude entire entity (source), >= 0 = exclude only that panel

    for (let segmentIndex = 0; segmentIndex < segmentLimit; segmentIndex++) {
      if (rangeCylinder) {
        const segDx = curEX - curSX;
        const segDy = curEY - curSY;
        const segDz = curEZ - curSZ;
        const segLen = Math.hypot(segDx, segDy, segDz);
        if (segLen <= 1e-9) break;
        const invSegLen = 1 / segLen;
        const cylinderDistance = distanceToRayConfigRangeCylinder(
          curSX, curSY, curSZ,
          segDx * invSegLen, segDy * invSegLen, segDz * invSegLen,
          rangeCylinder,
        );
        if (cylinderDistance === null || cylinderDistance <= 1e-6) {
          curEX = curSX;
          curEY = curSY;
          curEZ = curSZ;
          break;
        }
        curEX = curSX + segDx * invSegLen * cylinderDistance;
        curEY = curSY + segDy * invSegLen * cylinderDistance;
        curEZ = curSZ + segDz * invSegLen * cylinderDistance;
      }

      const hit = this.findBeamSegmentHit(
        curSX, curSY, curSZ, curEX, curEY, curEZ,
        excludeEntityId, excludePanelIndex, lineWidth
      );

      if (!hit) {
        return {
          endX: curEX,
          endY: curEY,
          endZ: curEZ,
          obstructionT: undefined,
          reflections,
          terminalReflection: undefined,
          endpointDamageable: rangeCylinder === undefined,
          segmentLimitReached: false,
        };
      }

      if (!hit.isMirror) {
        if (segmentIndex === 0) {
          return {
            endX: hit.x,
            endY: hit.y,
            endZ: hit.z,
            obstructionT: hit.t,
            reflections,
            terminalReflection: undefined,
            endpointDamageable: true,
            segmentLimitReached: false,
          };
        }
        return {
          endX: hit.x,
          endY: hit.y,
          endZ: hit.z,
          obstructionT: undefined,
          reflections,
          terminalReflection: undefined,
          endpointDamageable: true,
          segmentLimitReached: false,
        };
      }

      const reflectorKind = hit.reflectorKind ?? 'shield';
      const reflection: BeamReflectorPoint = {
        x: hit.x,
        y: hit.y,
        z: hit.z,
        reflectorEntityId: hit.entityId,
        reflectorKind,
        reflectorPlayerId: hit.reflectorPlayerId,
        normalX: hit.normalX,
        normalY: hit.normalY,
        normalZ: hit.normalZ,
      };

      if (REFLECTIVE_SHIELD_MATERIAL.projectileResponse[lineShotType] !== 'reflect') {
        return {
          endX: hit.x,
          endY: hit.y,
          endZ: hit.z,
          obstructionT: undefined,
          reflections,
          terminalReflection: reflection,
          endpointDamageable: false,
          segmentLimitReached: false,
        };
      }

      if (segmentIndex === segmentLimit - 1) {
        return {
          endX: hit.x,
          endY: hit.y,
          endZ: hit.z,
          obstructionT: undefined,
          reflections,
          terminalReflection: reflection,
          endpointDamageable: false,
          segmentLimitReached: true,
        };
      }

      const segDx = curEX - curSX;
      const segDy = curEY - curSY;
      const segDz = curEZ - curSZ;
      const segLen = Math.hypot(segDx, segDy, segDz);
      if (segLen <= 1e-9) {
        return {
          endX: hit.x,
          endY: hit.y,
          endZ: hit.z,
          obstructionT: undefined,
          reflections,
          terminalReflection: reflection,
          endpointDamageable: false,
          segmentLimitReached: false,
        };
      }
      const beamDirX = segDx / segLen;
      const beamDirY = segDy / segLen;
      const beamDirZ = segDz / segLen;

      // Reflect around the reflector's full 3D normal. Mirrors provide
      // a panel normal; shields provide the sphere surface normal.
      const normalLen = Math.hypot(hit.normalX, hit.normalY, hit.normalZ);
      if (normalLen <= 1e-9) {
        return {
          endX: hit.x,
          endY: hit.y,
          endZ: hit.z,
          obstructionT: undefined,
          reflections,
          terminalReflection: reflection,
          endpointDamageable: false,
          segmentLimitReached: false,
        };
      }
      const nx = hit.normalX / normalLen;
      const ny = hit.normalY / normalLen;
      const nz = hit.normalZ / normalLen;
      const dotDN = beamDirX * nx + beamDirY * ny + beamDirZ * nz;
      let reflDirX = beamDirX - 2 * dotDN * nx;
      let reflDirY = beamDirY - 2 * dotDN * ny;
      let reflDirZ = beamDirZ - 2 * dotDN * nz;
      const reflLen = Math.hypot(reflDirX, reflDirY, reflDirZ);
      if (reflLen <= 1e-9) {
        return {
          endX: hit.x,
          endY: hit.y,
          endZ: hit.z,
          obstructionT: undefined,
          reflections,
          terminalReflection: reflection,
          endpointDamageable: false,
          segmentLimitReached: false,
        };
      }
      reflDirX /= reflLen;
      reflDirY /= reflLen;
      reflDirZ /= reflLen;

      reflections.push(reflection);
      curSX = hit.x;
      curSY = hit.y;
      curSZ = hit.z;
      if (rangeCylinder) {
        const cylinderDistance = distanceToRayConfigRangeCylinder(
          curSX, curSY, curSZ,
          reflDirX, reflDirY, reflDirZ,
          rangeCylinder,
        );
        if (cylinderDistance === null || cylinderDistance <= 1e-6) {
          curEX = hit.x;
          curEY = hit.y;
          curEZ = hit.z;
          break;
        }
        curEX = hit.x + reflDirX * cylinderDistance;
        curEY = hit.y + reflDirY * cylinderDistance;
        curEZ = hit.z + reflDirZ * cylinderDistance;
      } else {
        const travelled = Math.max(0, Math.min(segLen, segLen * hit.t));
        remainingRange = Math.max(0, remainingRange - travelled)
          * REFLECTIVE_SHIELD_MATERIAL.reflection.reflectivity;
        if (remainingRange <= 1e-6) {
          curEX = hit.x;
          curEY = hit.y;
          curEZ = hit.z;
          break;
        }
        curEX = hit.x + reflDirX * remainingRange;
        curEY = hit.y + reflDirY * remainingRange;
        curEZ = hit.z + reflDirZ * remainingRange;
      }
      excludeEntityId = hit.entityId;
      excludePanelIndex = hit.panelIndex;
    }

    return {
      endX: curEX,
      endY: curEY,
      endZ: curEZ,
      obstructionT: undefined,
      reflections,
      terminalReflection: undefined,
      endpointDamageable: rangeCylinder === undefined,
      segmentLimitReached: false,
    };
  }

  // Find closest beam hit — checks shield panel rectangles AND regular
  // entity colliders, all in 3D.
  //   excludeEntityId: on bounce 0 = source (don't hit self), on bounce N = last mirror hit
  //   excludePanelIndex: -1 = exclude entire entity, >= 0 = exclude only that panel
  private findGroundSegmentT(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
  ): number | null {
    const sampleClearance = (t: number): number => {
      const x = startX + (endX - startX) * t;
      const y = startY + (endY - startY) * t;
      const z = startZ + (endZ - startZ) * t;
      return z - this.world.getGroundZ(x, y);
    };

    let prevT = 0;
    let prevClear = sampleClearance(0);
    if (prevClear < -BEAM_GROUND_EPSILON) return 0;

    for (let i = 1; i <= BEAM_GROUND_HIT_STEPS; i++) {
      const t = i / BEAM_GROUND_HIT_STEPS;
      const clear = sampleClearance(t);
      if (clear <= BEAM_GROUND_EPSILON && prevClear > BEAM_GROUND_EPSILON) {
        let lo = prevT;
        let hi = t;
        for (let b = 0; b < BEAM_GROUND_HIT_BISECT_STEPS; b++) {
          const mid = (lo + hi) * 0.5;
          if (sampleClearance(mid) <= BEAM_GROUND_EPSILON) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prevT = t;
      prevClear = clear;
    }

    return null;
  }

  private findBeamSegmentHit(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    excludeEntityId: EntityId,
    excludePanelIndex: number,
    lineWidth: number
  ): typeof _segHit | null {
    let bestT = Infinity;
    let found = false;

    const dx = endX - startX;
    const dy = endY - startY;
    const dz = endZ - startZ;
    const segLenSq = dx * dx + dy * dy;

    const nearbyUnits = spatialGrid.queryUnitsAlongLine(startX, startY, startZ, endX, endY, endZ, lineWidth + 60);

    for (const unit of nearbyUnits) {
      const isExcludedEntity = unit.id === excludeEntityId;
      if (isExcludedEntity && excludePanelIndex < 0) continue;
      if (
        !unit.unit ||
        unit.unit.hp <= 0
      ) continue;

      // Horizontal-only early-out — the beam may arc vertically past
      // the unit, but we still require its XY projection to come near
      // the unit's bounding radius.
      const ux = unit.transform.x - startX, uy = unit.transform.y - startY;
      const crossSq = (ux * dy - uy * dx);
      const panels = unit.unit.shieldPanels;
      const activeShieldPanel = this.world.turretShieldPanelsEnabled
        ? getActiveShieldPanelTurret(unit)
        : null;
      const mirrorsActive = activeShieldPanel !== null && panels.length > 0;
      const boundR = mirrorsActive
        ? Math.max(unit.unit.shieldBoundRadius, unit.unit.radius.hitbox) + lineWidth
        : unit.unit.radius.hitbox + lineWidth / 2;
      if (crossSq * crossSq > boundR * boundR * segLenSq) continue;

      if (mirrorsActive) {
        // Mirror unit: 3D ray-vs-tilted-rectangle for each panel
        // (yaw + pitch from the turretShieldPanel rotation/pitch).
        const { turret: shieldPanelTurret, turretIndex: shieldPanelTurretIndex } = activeShieldPanel;
        const shieldPanelRot = shieldPanelTurret.rotation;
        const shieldPanelPitch = shieldPanelTurret.pitch;
        const unitGroundZ = getUnitGroundZ(unit);
        const unitCS = getTransformCosSin(unit.transform);
        const mirrorPivot = resolveWeaponWorldMount(
          unit, shieldPanelTurret, shieldPanelTurretIndex,
          unitCS.cos, unitCS.sin,
          {
            currentTick: this.world.getTick(),
            unitGroundZ,
            surfaceN: unit.unit.surfaceNormal,
          },
          _shieldPanelPivot,
        );
        const panelExclude = isExcludedEntity ? excludePanelIndex : -1;
        const hit = findClosestPanelHit(
          panels, shieldPanelRot, shieldPanelPitch,
          unit.transform.x, unit.transform.y, unitGroundZ,
          startX, startY, startZ, endX, endY, endZ,
          panelExclude,
          mirrorPivot,
        );
        if (hit !== null && hit.t < bestT) {
          bestT = hit.t; found = true;
          _segHit.t = hit.t;
          _segHit.x = hit.x;
          _segHit.y = hit.y;
          _segHit.z = hit.z;
          _segHit.entityId = unit.id;
          _segHit.isMirror = true;
          _segHit.normalX = hit.normalX;
          _segHit.normalY = hit.normalY;
          _segHit.normalZ = hit.normalZ;
          _segHit.panelIndex = hit.panelIndex;
          _segHit.reflectorKind = 'shield';
          _segHit.reflectorPlayerId = unit.ownership !== null
            ? unit.ownership.playerId
            : undefined;
        }
      }

      // Unit body: 3D segment-vs-sphere.
      {
        const t = lineSphereIntersectionT(
          startX, startY, startZ,
          endX, endY, endZ,
          unit.transform.x, unit.transform.y, unit.transform.z,
          unit.unit.radius.hitbox + lineWidth / 2
        );
        if (t !== null && t < bestT) {
          bestT = t; found = true;
          _segHit.t = t;
          _segHit.x = startX + t * dx;
          _segHit.y = startY + t * dy;
          _segHit.z = startZ + t * dz;
          _segHit.entityId = unit.id;
          _segHit.isMirror = false;
          _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 0;
          _segHit.panelIndex = -1;
          _segHit.reflectorKind = undefined;
          _segHit.reflectorPlayerId = undefined;
        }
      }
    }

    if (this.world.turretShieldSpheresEnabled) {
      const shieldHit = findShieldSegmentIntersection(
        this.world,
        startX, startY, startZ,
        endX, endY, endZ,
      );
      if (shieldHit !== null && shieldHit.t < bestT) {
        bestT = shieldHit.t; found = true;
        _segHit.t = shieldHit.t;
        _segHit.x = shieldHit.x;
        _segHit.y = shieldHit.y;
        _segHit.z = shieldHit.z;
        _segHit.entityId = shieldHit.entityId as EntityId;
        _segHit.isMirror = true;
        _segHit.normalX = shieldHit.nx;
        _segHit.normalY = shieldHit.ny;
        _segHit.normalZ = shieldHit.nz;
        _segHit.panelIndex = -1;
        _segHit.reflectorKind = 'shield';
        _segHit.reflectorPlayerId = shieldHit.playerId;
      }
    }

    // Buildings: 3D ray-vs-AABB (x/y footprint × z depth). A beam arcing
    // over a short building correctly misses; clipping the wall stops.
    const nearbyBuildings = spatialGrid.queryBuildingsAlongLine(startX, startY, startZ, endX, endY, endZ, lineWidth + 100);
    for (const building of nearbyBuildings) {
      // Skip the firing building — a tower-mounted turret must not
      // self-block on its own AABB. Mirrors the unit-source guard
      // above (excludeEntityId / excludePanelIndex tracks the entity
      // the beam was just emitted from / last reflected off).
      if (building.id === excludeEntityId) continue;
      if (!building.building || building.building.hp <= 0) continue;
      const bWidth = building.building.width;
      const bHeight = building.building.height;
      const bDepth = building.building.depth;
      const minX = building.transform.x - bWidth / 2;
      const minY = building.transform.y - bHeight / 2;
      const maxX = building.transform.x + bWidth / 2;
      const maxY = building.transform.y + bHeight / 2;
      const minZ = building.transform.z - bDepth / 2;
      const maxZ = building.transform.z + bDepth / 2;
      const t = rayBoxIntersectionT(
        startX, startY, startZ,
        endX, endY, endZ,
        minX, minY, minZ,
        maxX, maxY, maxZ,
      );
      if (t !== null && t < bestT) {
        bestT = t; found = true;
        _segHit.t = t;
        _segHit.x = startX + t * dx;
        _segHit.y = startY + t * dy;
        _segHit.z = startZ + t * dz;
        _segHit.entityId = building.id;
        _segHit.isMirror = false;
        _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 0;
        _segHit.panelIndex = -1;
        _segHit.reflectorKind = undefined;
        _segHit.reflectorPlayerId = undefined;
      }
    }

    const nearbyProjectiles = spatialGrid.queryProjectilesAlongLine(
      startX, startY, startZ, endX, endY, endZ, lineWidth + 60,
    );
    for (const projectile of nearbyProjectiles) {
      if (projectile.id === excludeEntityId) continue;
      const proj = projectile.projectile;
      if (
        proj === null ||
        proj.projectileType !== 'projectile' ||
        proj.hp <= 0 ||
        !isProjectileShot(proj.config.shot)
      ) {
        continue;
      }
      const t = lineSphereIntersectionT(
        startX, startY, startZ,
        endX, endY, endZ,
        projectile.transform.x, projectile.transform.y, projectile.transform.z,
        proj.config.shotProfile.runtime.radius.collision + lineWidth / 2,
      );
      if (t !== null && t < bestT) {
        bestT = t; found = true;
        _segHit.t = t;
        _segHit.x = startX + t * dx;
        _segHit.y = startY + t * dy;
        _segHit.z = startZ + t * dz;
        _segHit.entityId = projectile.id;
        _segHit.isMirror = false;
        _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 0;
        _segHit.panelIndex = -1;
        _segHit.reflectorKind = undefined;
        _segHit.reflectorPlayerId = undefined;
      }
    }

    const groundT = this.findGroundSegmentT(startX, startY, startZ, endX, endY, endZ);
    if (groundT !== null && groundT < bestT) {
      bestT = groundT; found = true;
      _segHit.t = groundT;
      _segHit.x = startX + groundT * dx;
      _segHit.y = startY + groundT * dy;
      _segHit.z = this.world.getGroundZ(_segHit.x, _segHit.y);
      _segHit.entityId = 0 as EntityId;
      _segHit.isMirror = false;
      _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 1;
      _segHit.panelIndex = -1;
      _segHit.reflectorKind = undefined;
      _segHit.reflectorPlayerId = undefined;
    }

    return found ? _segHit : null;
  }

  // Line damage (beams) - sorted by distance, stops at first hit
  // PERFORMANCE: Uses spatial grid line query for O(k) instead of O(n)
  // Note: Beam recoil is applied continuously in updateProjectiles(), not here
  private applyLineDamage(source: LineDamageSource): DamageResult {
    const result = resetResult();

    // Calculate knockback direction (along the beam)
    const beamDx = source.end.x - source.start.x;
    const beamDy = source.end.y - source.start.y;
    const beamLen = magnitude(beamDx, beamDy);
    const knockbackDirX = beamLen > 0 ? beamDx / beamLen : 0;
    const knockbackDirY = beamLen > 0 ? beamDy / beamLen : 0;

    // Beams truncate at the closest hit (the loop below used to collect
    // all hits, sort by T, then unconditionally break on the first one —
    // the sort and per-hit allocations were pure waste). Track the
    // single closest hit instead. PERFORMANCE: spatial grid culls to
    // near-line entities; we still test each candidate but skip the
    // array + sort entirely.
    let bestT = Infinity;
    let bestEntityId: EntityId = 0;
    let bestHostEntityId: EntityId = 0;
    let bestIsUnit = false;

    // PERFORMANCE: Single line-cell sweep — see findLineObstruction.
    const { units: nearbyUnits, buildings: nearbyBuildings } =
      spatialGrid.queryEntitiesAlongLine(
        source.start.x, source.start.y, source.start.z,
        source.end.x, source.end.y, source.end.z, source.width + 100,
      );
    const nearbyProjectiles = spatialGrid.queryProjectilesAlongLine(
      source.start.x, source.start.y, source.start.z,
      source.end.x, source.end.y, source.end.z, source.width + 100,
    );

    // Pack line-damage candidates. Rust owns the 3D segment-vs-sphere
    // and segment-vs-AABB tests; TypeScript keeps spatial broadphase,
    // filtering, turret mount resolution, and damage/event write-back.
    let segmentRowCount = 0;
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (source.excludeCommanders && unit.commander) continue;
      const unitComponent = unit.unit;
      if (unitComponent === null) continue;
      const bodyDamageable = unitComponent.hp > 0;
      if (!bodyDamageable && isConstructionBodyMaterialized(unit)) continue;

      if (bodyDamageable) {
        segmentRowCount = appendSegmentDamageSphereRow(
          segmentRowCount,
          unit.id,
          unit.id,
          true,
          false,
          unit.transform.x,
          unit.transform.y,
          unit.transform.z,
          unitComponent.radius.hitbox + source.width / 2,
        );
      }

      const combat = unit.combat;
      if (combat !== null) {
        const unitCS = getTransformCosSin(unit.transform);
        const unitGroundZ = getUnitGroundZ(unit);
        for (let i = 0; i < combat.turrets.length; i++) {
          const turret = combat.turrets[i];
          if (!isTurretDamageable(turret)) continue;
          const mount = resolveWeaponWorldMount(
            unit, turret, i,
            unitCS.cos, unitCS.sin,
            {
              currentTick: this.world.getTick(),
              unitGroundZ,
              surfaceN: unitComponent.surfaceNormal,
            },
            _subEntityPoint,
          );
          segmentRowCount = appendSegmentDamageSphereRow(
            segmentRowCount,
            turret.id,
            unit.id,
            true,
            false,
            mount.x,
            mount.y,
            mount.z,
            turret.config.radius.hitbox + source.width / 2,
          );
        }
      }

    }

    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      segmentRowCount = appendSegmentDamageBoxRow(
        segmentRowCount,
        building.id,
        building.transform.x,
        building.transform.y,
        building.transform.z,
        building.building.width / 2,
        building.building.height / 2,
        building.building.depth / 2,
      );
    }

    for (const projectile of nearbyProjectiles) {
      if (source.excludeEntities.has(projectile.id)) continue;
      const proj = projectile.projectile;
      if (
        proj === null ||
        proj.projectileType !== 'projectile' ||
        proj.hp <= 0 ||
        !isProjectileShot(proj.config.shot)
      ) {
        continue;
      }

      segmentRowCount = appendSegmentDamageSphereRow(
        segmentRowCount,
        projectile.id,
        projectile.id,
        false,
        true,
        projectile.transform.x,
        projectile.transform.y,
        projectile.transform.z,
        proj.config.shotProfile.runtime.radius.collision + source.width / 2,
      );
    }

    classifySegmentDamageRows(
      segmentRowCount,
      source.start.x, source.start.y, source.start.z,
      source.end.x, source.end.y, source.end.z,
    );
    for (let row = 0; row < segmentRowCount; row++) {
      if ((_segmentDamageOutFlags[row] & DAMAGE_SEGMENT_HIT_FLAG_HIT) === 0) continue;
      const t = _segmentDamageOutT[row];
      if (t >= bestT) continue;
      bestT = t;
      bestEntityId = _segmentDamageEntityIds[row];
      bestHostEntityId = _segmentDamageHostEntityIds[row];
      bestIsUnit = _segmentDamageIsUnit[row] !== 0;
    }

    if (bestT === Infinity) return result;

    const entity = this.world.getEntity(bestHostEntityId || bestEntityId);
    if (!entity) return result;

    // Momentum-based knockback (mass × velocity × MULTIPLIER) — depends
    // only on source, hoist out of the (now-unrolled) hit loop.
    const lineMomentum = (source.projectileMass ?? 0) * PROJECTILE_MASS_MULTIPLIER * (source.velocity ?? 0);

    // Calculate hit point using T value
    const hitX = source.start.x + bestT * (source.end.x - source.start.x);
    const hitY = source.start.y + bestT * (source.end.y - source.start.y);

    // Penetration direction: from hit point through unit center
    const penDirX = entity.transform.x - hitX;
    const penDirY = entity.transform.y - hitY;
    const penMag = magnitude(penDirX, penDirY);
    const penNormX = penMag > 0 ? penDirX / penMag : knockbackDirX;
    const penNormY = penMag > 0 ? penDirY / penMag : knockbackDirY;

    this.applyDamageToEntity(entity, source.damage, result, source.sourceEntityId, {
      penetrationDir: { x: penNormX, y: penNormY },
      attackerVel: { x: knockbackDirX * BEAM_EXPLOSION_MAGNITUDE, y: knockbackDirY * BEAM_EXPLOSION_MAGNITUDE },
      attackMagnitude: source.damage,
    }, bestEntityId);
    result.hitEntityIds.push(entity.id);
    result.truncationT = bestT;

    if (bestIsUnit && lineMomentum > 0) {
      pushKnockback(result, entity.id, knockbackDirX * lineMomentum, knockbackDirY * lineMomentum);
    }

    return result;
  }

  // Swept damage from prevPos to currentPos. Normal shots pass radius 0 so
  // their centerline is tested against target hitboxes; D-gun waves pass a
  // positive radius for their authored damage width.
  // PERFORMANCE: Uses spatial grid line query for O(k) instead of O(n)
  // Note: Recoil for traveling projectiles is applied at fire time in fireTurrets(), not here
  private applySweptDamage(source: SweptDamageSource): DamageResult {
    const result = resetResult();

    // Calculate knockback direction (along projectile travel)
    const projDx = source.current.x - source.prev.x;
    const projDy = source.current.y - source.prev.y;
    const projLen = magnitude(projDx, projDy);
    const knockbackDirX = projLen > 0 ? projDx / projLen : 0;
    const knockbackDirY = projLen > 0 ? projDy / projLen : 0;

    // Collect all hits with their T values
    _reusableHits.length = 0;
    const hits = _reusableHits;

    // PERFORMANCE: Single line-cell sweep — see findLineObstruction.
    // The spatial line query takes a full width and buckets units by
    // center cell, so include the largest known target hitbox radius
    // here. The exact tests below still use each entity's authored
    // hitbox.
    const sweptQueryWidth =
      (source.radius + this.world.getMaxTargetableRadius() + SWEPT_HITBOX_QUERY_EXTRA) * 2;
    const { units: nearbyUnits, buildings: nearbyBuildings } =
      spatialGrid.queryEntitiesAlongLine(
        source.prev.x, source.prev.y, source.prev.z,
        source.current.x, source.current.y, source.current.z, sweptQueryWidth,
      );
    const nearbyProjectiles = spatialGrid.queryProjectilesAlongLine(
      source.prev.x, source.prev.y, source.prev.z,
      source.current.x, source.current.y, source.current.z, sweptQueryWidth,
    );

    // Pack swept-damage candidates. Rust owns the 3D segment-vs-sphere
    // and segment-vs-AABB tests; TypeScript keeps broadphase, filtering,
    // turret mount resolution, sorting, and damage/event write-back.
    let segmentRowCount = 0;
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (source.excludeCommanders && unit.commander) continue;
      const unitComponent = unit.unit;
      if (unitComponent === null) continue;
      const bodyDamageable = unitComponent.hp > 0;
      if (!bodyDamageable && isConstructionBodyMaterialized(unit)) continue;

      if (bodyDamageable) {
        segmentRowCount = appendSegmentDamageSphereRow(
          segmentRowCount,
          unit.id,
          unit.id,
          true,
          false,
          unit.transform.x,
          unit.transform.y,
          unit.transform.z,
          source.radius + unitComponent.radius.hitbox,
        );
      }

      const combat = unit.combat;
      if (combat !== null) {
        const unitCS = getTransformCosSin(unit.transform);
        const unitGroundZ = getUnitGroundZ(unit);
        for (let i = 0; i < combat.turrets.length; i++) {
          const turret = combat.turrets[i];
          if (!isTurretDamageable(turret)) continue;
          const mount = resolveWeaponWorldMount(
            unit, turret, i,
            unitCS.cos, unitCS.sin,
            {
              currentTick: this.world.getTick(),
              unitGroundZ,
              surfaceN: unitComponent.surfaceNormal,
            },
            _subEntityPoint,
          );
          segmentRowCount = appendSegmentDamageSphereRow(
            segmentRowCount,
            turret.id,
            unit.id,
            true,
            false,
            mount.x,
            mount.y,
            mount.z,
            source.radius + turret.config.radius.hitbox,
          );
        }
      }

    }

    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      segmentRowCount = appendSegmentDamageBoxRow(
        segmentRowCount,
        building.id,
        building.transform.x,
        building.transform.y,
        building.transform.z,
        building.building.width / 2 + source.radius,
        building.building.height / 2 + source.radius,
        building.building.depth / 2 + source.radius,
      );
    }

    for (const projectile of nearbyProjectiles) {
      if (source.excludeEntities.has(projectile.id)) continue;
      const proj = projectile.projectile;
      if (
        proj === null ||
        proj.projectileType !== 'projectile' ||
        proj.hp <= 0 ||
        !isProjectileShot(proj.config.shot)
      ) {
        continue;
      }

      segmentRowCount = appendSegmentDamageSphereRow(
        segmentRowCount,
        projectile.id,
        projectile.id,
        false,
        true,
        projectile.transform.x,
        projectile.transform.y,
        projectile.transform.z,
        source.radius + proj.config.shotProfile.runtime.radius.collision,
      );
    }

    classifySegmentDamageRows(
      segmentRowCount,
      source.prev.x, source.prev.y, source.prev.z,
      source.current.x, source.current.y, source.current.z,
    );
    for (let row = 0; row < segmentRowCount; row++) {
      if ((_segmentDamageOutFlags[row] & DAMAGE_SEGMENT_HIT_FLAG_HIT) === 0) continue;
      const hit: HitInfo = {
        entityId: _segmentDamageEntityIds[row],
        t: _segmentDamageOutT[row],
        isUnit: _segmentDamageIsUnit[row] !== 0,
        isBuilding: _segmentDamageIsBuilding[row] !== 0,
        isProjectile: _segmentDamageIsProjectile[row] !== 0,
      };
      const hostEntityId = _segmentDamageHostEntityIds[row];
      if (hostEntityId !== hit.entityId) {
        hit.hostEntityId = hostEntityId;
      }
      hits.push(hit);
    }

    // Sort by T and apply damage in order
    hits.sort((a, b) => a.t - b.t);

    let hitCount = 0;
    for (const hit of hits) {
      if (hitCount >= source.maxHits) break;

      const entity = this.world.getEntity(hit.hostEntityId ?? hit.entityId);
      if (!entity) continue;

      // Calculate momentum-based knockback (p = mv)
      const projMass = (source.projectileMass ?? 0) * PROJECTILE_MASS_MULTIPLIER;
      const sourceVelocity = source.velocity;
      const projSpeed = sourceVelocity === undefined
        ? 0
        : magnitude(sourceVelocity.x, sourceVelocity.y);
      const force = projMass * projSpeed;
      const forceX = knockbackDirX * force;
      const forceY = knockbackDirY * force;

      // Calculate hit point using T value along projectile path
      const hitX = source.prev.x + hit.t * (source.current.x - source.prev.x);
      const hitY = source.prev.y + hit.t * (source.current.y - source.prev.y);

      // Calculate penetration direction: from hit point through unit center
      const penDirX = entity.transform.x - hitX;
      const penDirY = entity.transform.y - hitY;
      const penMag = magnitude(penDirX, penDirY);
      const penNormX = penMag > 0 ? penDirX / penMag : knockbackDirX;
      const penNormY = penMag > 0 ? penDirY / penMag : knockbackDirY;

      // Apply damage with death context (attacker velocity = actual projectile velocity)
      // Use actual projectile velocity if available, otherwise fallback to direction * damage
      const attackerVelX = sourceVelocity === undefined
        ? knockbackDirX * source.damage
        : sourceVelocity.x;
      const attackerVelY = sourceVelocity === undefined
        ? knockbackDirY * source.damage
        : sourceVelocity.y;
      this.queueDamageToEntityBatch(entity, source.damage, result, source.sourceEntityId, {
        penetrationDir: { x: penNormX, y: penNormY },
        attackerVel: { x: attackerVelX, y: attackerVelY },
        attackMagnitude: source.damage,
      });
      if (result.truncationT === undefined) {
        result.truncationT = hit.t;
      }
      result.hitEntityIds.push(entity.id);
      hitCount++;

      // Add knockback for units (buildings don't get pushed)
      if (hit.isUnit && projMass > 0) {
        pushKnockback(result, entity.id, forceX, forceY);
      }
    }

    this.flushDamageBatch(result, source.sourceEntityId);
    return result;
  }

  // Area damage (splash, wave)
  // PERFORMANCE: Uses spatial grid radius query for O(k) instead of O(n)
  private applyAreaDamage(source: AreaDamageSource): DamageResult {
    const result = resetResult();

    const hasSlice = source.sliceAngle !== undefined && source.sliceDirection !== undefined;
    const sliceHalfAngle = hasSlice ? source.sliceAngle! / 2 : Math.PI;

    // PERFORMANCE: Query only entities within the damage radius using spatial grid.
    // Combined single-sweep query — the prior back-to-back unit + building
    // calls rebuilt nearbyCells twice for the same (center, radius). Cell
    // pad is the larger of the two old pads (+100) so neither broadphase
    // misses a candidate; the per-entity distance checks below stay
    // precise.
    const nearby = spatialGrid.queryUnitsAndBuildingsInRadius(
      source.center.x, source.center.y, source.center.z, source.radius + 100,
    );
    const nearbyUnits = nearby.units;
    const nearbyBuildings = nearby.buildings;
    const nearbyProjectiles = spatialGrid.queryEnemyProjectilesInRadius(
      source.center.x, source.center.y, source.center.z, source.radius + 100, source.ownerId,
    );

    // Check units. Rust owns the full 3D sphere-vs-sphere overlap and
    // optional slice-cone filter; TypeScript keeps entity graph write-back,
    // turret sub-hitbox fallback, and event/death side effects.
    ensureAreaDamageCapacity(nearbyUnits.length);
    let areaRowCount = 0;
    for (const unit of nearbyUnits) {
      if (source.excludeEntities.has(unit.id)) continue;
      if (source.excludeCommanders && unit.commander) continue;
      const unitComponent = unit.unit;
      if (!unitComponent) continue;

      const row = areaRowCount++;
      _areaDamageEntities[row] = unit;
      _areaDamageEnabled[row] = 1;
      _areaDamageTargetKind[row] = DAMAGE_TARGET_KIND_UNIT;
      _areaDamageTargetX[row] = unit.transform.x;
      _areaDamageTargetY[row] = unit.transform.y;
      _areaDamageTargetZ[row] = unit.transform.z;
      _areaDamageTargetRadius[row] = unitComponent.radius.hitbox;
      _areaDamageBoxHalfX[row] = 0;
      _areaDamageBoxHalfY[row] = 0;
      _areaDamageBoxHalfZ[row] = 0;
    }
    classifyAreaDamageRows(source, areaRowCount, hasSlice, sliceHalfAngle);
    for (let row = 0; row < areaRowCount; row++) {
      const unit = _areaDamageEntities[row];
      const unitComponent = unit?.unit;
      if (unit === undefined || unitComponent === undefined || unitComponent === null) continue;

      const rowFlags = _areaDamageOutFlags[row];
      if ((rowFlags & DAMAGE_AREA_FLAG_SLICE_PASS) === 0) continue;
      const bodyOverlaps =
        unitComponent.hp > 0 && (rowFlags & DAMAGE_AREA_FLAG_OVERLAP) !== 0;
      const damage = source.damage;
      const dirX = _areaDamageOutDirX[row];
      const dirY = _areaDamageOutDirY[row];
      const dirZ = _areaDamageOutDirZ[row];
      const force = source.knockbackForce ?? (damage * KNOCKBACK.SPLASH);
      const forceX = dirX * force;
      const forceY = dirY * force;
      const forceZ = dirZ * force;

      if (bodyOverlaps) {
        // For area damage, penetration direction is from explosion center
        // through unit (same as knockback direction — outward from center).
        this.queueDamageToEntityBatch(unit, damage, result, source.sourceEntityId, {
          penetrationDir: { x: dirX, y: dirY },
          attackerVel: { x: forceX, y: forceY },
          attackMagnitude: damage,
        });
        result.hitEntityIds.push(unit.id);

        // Add knockback (direction is from center outward)
        if (force > 0 && _areaDamageOutDistance[row] > 0) {
          pushKnockback(result, unit.id, forceX, forceY, forceZ);
        }
      }

      const combat = unit.combat;
      if (combat !== null && !bodyOverlaps) {
        const unitCS = getTransformCosSin(unit.transform);
        const unitGroundZ = getUnitGroundZ(unit);
        for (let i = 0; i < combat.turrets.length; i++) {
          const turret = combat.turrets[i];
          if (!isTurretDamageable(turret)) continue;
          const mount = resolveWeaponWorldMount(
            unit, turret, i,
            unitCS.cos, unitCS.sin,
            {
              currentTick: this.world.getTick(),
              unitGroundZ,
              surfaceN: unitComponent.surfaceNormal,
            },
            _subEntityPoint,
          );
          const tx = mount.x - source.center.x;
          const ty = mount.y - source.center.y;
          const tz = mount.z - source.center.z;
          const turretMaxDist = source.radius + turret.config.radius.hitbox;
          if (tx * tx + ty * ty + tz * tz > turretMaxDist * turretMaxDist) continue;
          this.queueDamageToEntityBatch(unit, damage, result, source.sourceEntityId, {
            penetrationDir: { x: dirX, y: dirY },
            attackerVel: { x: forceX, y: forceY },
            attackMagnitude: damage,
          });
          result.hitEntityIds.push(unit.id);
        }
      }
    }
    clearAreaDamageEntities(areaRowCount);

    // Travelling shots are small damageable bodies. Sustained beams
    // and shields are not inserted as projectile-type bodies, so this
    // only lets weapons chip down real munitions.
    ensureAreaDamageCapacity(nearbyProjectiles.length);
    areaRowCount = 0;
    for (const projectile of nearbyProjectiles) {
      if (source.excludeEntities.has(projectile.id)) continue;
      const proj = projectile.projectile;
      if (
        proj === null ||
        proj.projectileType !== 'projectile' ||
        proj.hp <= 0 ||
        !isProjectileShot(proj.config.shot)
      ) {
        continue;
      }

      const row = areaRowCount++;
      _areaDamageEntities[row] = projectile;
      _areaDamageEnabled[row] = 1;
      _areaDamageTargetKind[row] = DAMAGE_TARGET_KIND_PROJECTILE;
      _areaDamageTargetX[row] = projectile.transform.x;
      _areaDamageTargetY[row] = projectile.transform.y;
      _areaDamageTargetZ[row] = projectile.transform.z;
      _areaDamageTargetRadius[row] = proj.config.shotProfile.runtime.radius.collision;
      _areaDamageBoxHalfX[row] = 0;
      _areaDamageBoxHalfY[row] = 0;
      _areaDamageBoxHalfZ[row] = 0;
    }
    classifyAreaDamageRows(source, areaRowCount, false, Math.PI);
    for (let row = 0; row < areaRowCount; row++) {
      const projectile = _areaDamageEntities[row];
      if (projectile === undefined || (_areaDamageOutFlags[row] & DAMAGE_AREA_FLAG_OVERLAP) === 0) {
        continue;
      }

      this.queueDamageToEntityBatch(projectile, source.damage, result, source.sourceEntityId);
      result.hitEntityIds.push(projectile.id);
    }
    clearAreaDamageEntities(areaRowCount);

    // Check buildings — full 3D. Buildings are axis-aligned boxes
    // (width × height × depth) sitting on the ground. Rust owns the
    // sphere-vs-AABB overlap and horizontal slice filter.
    ensureAreaDamageCapacity(nearbyBuildings.length);
    areaRowCount = 0;
    for (const building of nearbyBuildings) {
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const row = areaRowCount++;
      _areaDamageEntities[row] = building;
      _areaDamageEnabled[row] = 1;
      _areaDamageTargetKind[row] = DAMAGE_TARGET_KIND_BUILDING;
      _areaDamageTargetX[row] = building.transform.x;
      _areaDamageTargetY[row] = building.transform.y;
      _areaDamageTargetZ[row] = building.transform.z;
      _areaDamageTargetRadius[row] = getTargetRadius(building);
      _areaDamageBoxHalfX[row] = building.building.width / 2;
      _areaDamageBoxHalfY[row] = building.building.height / 2;
      _areaDamageBoxHalfZ[row] = building.building.depth / 2;
    }
    classifyAreaDamageRows(source, areaRowCount, hasSlice, sliceHalfAngle);
    for (let row = 0; row < areaRowCount; row++) {
      const building = _areaDamageEntities[row];
      const rowFlags = _areaDamageOutFlags[row];
      if (
        building === undefined ||
        (rowFlags & DAMAGE_AREA_FLAG_OVERLAP) === 0 ||
        (rowFlags & DAMAGE_AREA_FLAG_SLICE_PASS) === 0
      ) {
        continue;
      }

      const damage = source.damage;
      const dirX = _areaDamageOutDirX[row];
      const dirY = _areaDamageOutDirY[row];

      const bForce = source.knockbackForce ?? (damage * KNOCKBACK.SPLASH);
      const bForceX = dirX * bForce;
      const bForceY = dirY * bForce;
      this.queueDamageToEntityBatch(building, damage, result, source.sourceEntityId, {
        penetrationDir: { x: dirX, y: dirY },
        attackerVel: { x: bForceX, y: bForceY },
        attackMagnitude: damage,
      });
      result.hitEntityIds.push(building.id);
    }
    clearAreaDamageEntities(areaRowCount);

    this.flushDamageBatch(result, source.sourceEntityId);
    return result;
  }

  private queueDamageToEntityBatch(
    entity: Entity,
    damage: number,
    result: DamageResult,
    sourceEntityId: EntityId,
    deathContext: DeathContext | undefined = undefined,
  ): void {
    if (_damageBatchEntityIds.has(entity.id)) {
      this.flushDamageBatch(result, sourceEntityId);
    }

    const unit = entity.unit;
    const building = entity.building;
    const projectile = entity.projectile;
    let targetKind = 0;
    let currentHp = 0;
    let buildingFortified = false;

    if (unit && unit.hp > 0) {
      targetKind = DAMAGE_TARGET_KIND_UNIT;
      currentHp = unit.hp;
    } else if (building && building.hp > 0) {
      targetKind = DAMAGE_TARGET_KIND_BUILDING;
      currentHp = building.hp;
      buildingFortified = isBuildingActiveStateFortified(entity);
    } else if (
      projectile &&
      projectile.projectileType === 'projectile' &&
      projectile.hp > 0 &&
      isProjectileShot(projectile.config.shot)
    ) {
      targetKind = DAMAGE_TARGET_KIND_PROJECTILE;
      currentHp = projectile.hp;
    } else {
      return;
    }

    ensureDamageBatchCapacity(_damageBatchCount + 1);
    const row = _damageBatchCount++;
    _damageBatchEntityIds.add(entity.id);
    _damageBatchEntities[row] = entity;
    _damageBatchDeathContexts[row] = deathContext;
    _damageBatchEnabled[row] = 1;
    _damageBatchTargetKind[row] = targetKind;
    _damageBatchHp[row] = currentHp;
    _damageBatchDamage[row] = damage;
    _damageBatchBuildingFortified[row] = buildingFortified ? 1 : 0;
  }

  private flushDamageBatch(result: DamageResult, sourceEntityId: EntityId): void {
    const count = _damageBatchCount;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Damage batch HP write-back requires initialized sim-wasm');
    }
    const processed = sim.damageApplyBatch(
      count,
      _damageBatchEnabled.subarray(0, count),
      _damageBatchTargetKind.subarray(0, count),
      _damageBatchHp.subarray(0, count),
      _damageBatchDamage.subarray(0, count),
      _damageBatchBuildingFortified.subarray(0, count),
      BUILDING_CLOSED_DAMAGE_MULTIPLIER,
      _damageBatchOutHp.subarray(0, count),
      _damageBatchOutEffectiveDamage.subarray(0, count),
      _damageBatchOutFlags.subarray(0, count),
    );
    if (processed !== count) {
      throw new Error(`Damage batch HP write-back failed: ${processed}/${count}`);
    }

    for (let i = 0; i < count; i++) {
      const flags = _damageBatchOutFlags[i];
      if ((flags & DAMAGE_APPLY_FLAG_APPLIED) === 0) continue;

      const entity = _damageBatchEntities[i];
      if (entity === undefined) continue;

      const killed = (flags & DAMAGE_APPLY_FLAG_KILLED) !== 0;
      const targetKind = _damageBatchTargetKind[i];
      if (targetKind === DAMAGE_TARGET_KIND_UNIT && entity.unit !== null) {
        entity.unit.hp = _damageBatchOutHp[i];
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
        if (killed && !result.killedUnitIds.has(entity.id)) {
          result.killedUnitIds.add(entity.id);
          this.recordKiller(result, entity.id, sourceEntityId);
          const deathContext = _damageBatchDeathContexts[i];
          if (deathContext) {
            result.deathContexts.set(entity.id, deathContext);
          }
        }
      } else if (targetKind === DAMAGE_TARGET_KIND_BUILDING && entity.building !== null) {
        if (buildingBlueprintHasActiveState(entity.buildingBlueprintId)) {
          notifyBuildingActiveStateDamaged(this.world, entity);
        }
        entity.building.hp = _damageBatchOutHp[i];
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
        if (killed && !result.killedBuildingIds.has(entity.id)) {
          result.killedBuildingIds.add(entity.id);
          this.recordKiller(result, entity.id, sourceEntityId);
        }
      } else if (targetKind === DAMAGE_TARGET_KIND_PROJECTILE && entity.projectile !== null) {
        entity.projectile.hp = _damageBatchOutHp[i];
        if (killed && !result.killedProjectileIds.has(entity.id)) {
          result.killedProjectileIds.add(entity.id);
        }
      }
    }

    for (let i = 0; i < count; i++) {
      _damageBatchEntities[i] = undefined;
      _damageBatchDeathContexts[i] = undefined;
    }
    _damageBatchCount = 0;
    _damageBatchEntityIds.clear();
  }

  // Helper to apply damage and track kills
  private applyDamageToEntity(
    entity: Entity,
    damage: number,
    result: DamageResult,
    sourceEntityId: EntityId,
    deathContext: DeathContext | undefined = undefined,
    _targetEntityId: EntityId = entity.id,
  ): void {
    // Mounted turret IDs are addressable hit targets, but turrets no longer
    // own health. Damage that enters through a turret hitbox resolves through
    // the host body.
    const unit = entity.unit;
    const building = entity.building;
    const projectile = entity.projectile;
    let targetKind = 0;
    let currentHp = 0;
    let buildingFortified = false;

    if (unit && unit.hp > 0) {
      targetKind = DAMAGE_TARGET_KIND_UNIT;
      currentHp = unit.hp;
    } else if (building && building.hp > 0) {
      targetKind = DAMAGE_TARGET_KIND_BUILDING;
      currentHp = building.hp;
      buildingFortified = isBuildingActiveStateFortified(entity);
    } else if (
      projectile &&
      projectile.projectileType === 'projectile' &&
      projectile.hp > 0 &&
      isProjectileShot(projectile.config.shot)
    ) {
      targetKind = DAMAGE_TARGET_KIND_PROJECTILE;
      currentHp = projectile.hp;
    } else {
      return;
    }

    _damageApplyEnabled[0] = 1;
    _damageApplyTargetKind[0] = targetKind;
    _damageApplyHp[0] = currentHp;
    _damageApplyDamage[0] = damage;
    _damageApplyBuildingFortified[0] = buildingFortified ? 1 : 0;
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Damage HP write-back requires initialized sim-wasm');
    }
    const processed = sim.damageApplyBatch(
      1,
      _damageApplyEnabled,
      _damageApplyTargetKind,
      _damageApplyHp,
      _damageApplyDamage,
      _damageApplyBuildingFortified,
      BUILDING_CLOSED_DAMAGE_MULTIPLIER,
      _damageApplyOutHp,
      _damageApplyOutEffectiveDamage,
      _damageApplyOutFlags,
    );
    if (processed !== 1 || (_damageApplyOutFlags[0] & DAMAGE_APPLY_FLAG_APPLIED) === 0) {
      return;
    }

    const killed = (_damageApplyOutFlags[0] & DAMAGE_APPLY_FLAG_KILLED) !== 0;
    if (targetKind === DAMAGE_TARGET_KIND_UNIT && unit !== null) {
      unit.hp = _damageApplyOutHp[0];
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
      if (killed && !result.killedUnitIds.has(entity.id)) {
        result.killedUnitIds.add(entity.id);
        this.recordKiller(result, entity.id, sourceEntityId);
        // Store death context for explosion effects
        if (deathContext) {
          result.deathContexts.set(entity.id, deathContext);
        }
      }
    } else if (targetKind === DAMAGE_TARGET_KIND_BUILDING && building !== null) {
      if (buildingBlueprintHasActiveState(entity.buildingBlueprintId)) {
        notifyBuildingActiveStateDamaged(this.world, entity);
      }
      building.hp = _damageApplyOutHp[0];
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
      if (killed && !result.killedBuildingIds.has(entity.id)) {
        result.killedBuildingIds.add(entity.id);
        this.recordKiller(result, entity.id, sourceEntityId);
      }
    } else if (targetKind === DAMAGE_TARGET_KIND_PROJECTILE && projectile !== null) {
      projectile.hp = _damageApplyOutHp[0];
      if (killed && !result.killedProjectileIds.has(entity.id)) {
        result.killedProjectileIds.add(entity.id);
      }
    }
  }

  /** Stash the killer's playerId for the death event channel (FOW-17).
   *  Used by the audio serializer to route the death SimEvent to the
   *  killer's recipient regardless of fog-of-war vision — so a player
   *  whose missile lands a kill off-screen still gets the "+1, you
   *  got it" feedback. */
  private recordKiller(
    result: DamageResult,
    deadEntityId: EntityId,
    sourceEntityId: EntityId,
  ): void {
    if (result.killerPlayerIds.has(deadEntityId)) return;
    const killer = this.world.getEntity(sourceEntityId);
    const ownership = killer !== undefined ? killer.ownership : null;
    result.killerPlayerIds.set(
      deadEntityId,
      ownership !== null ? ownership.playerId : undefined,
    );
  }
}
