import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Unified Damage System
// Handles all damage types consistently: line (beams), swept (projectiles), area (splash/shield)
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full entity scans

import type { WorldState } from '../WorldState';
import type { BeamReflectorKind, Entity, EntityId, PlayerId } from '../types';
import { isProjectileShot, NO_ENTITY_ID } from '../types';
import type {
  AnyDamageSource,
  SweptDamageSource,
  AreaDamageSource,
  DamageResult,
  HitInfo,
  DeathContext,
  KnockbackInfo,
} from './types';
import {
  KNOCKBACK,
  PROJECTILE_MASS_MULTIPLIER,
} from '../../../config';
import { spatialGrid } from '../SpatialGrid';
import { getBuildingCombatCenterZ } from '../buildingAnchors';
import { magnitude, getTransformCosSin } from '../../math';
import {
  REFLECTOR_HIT_KIND_NONE,
  SHIELD_REFLECTION_ENTITY_BEAM,
  SHIELD_PANEL_PROJECTILE_QUERY_PAD,
} from '../combat/reflectorBatch';
import { REFLECTIVE_SHIELD_MATERIAL } from '../blueprints/shieldMaterials';
import { getTargetRadius, resolveWeaponWorldMount } from '../combat/combatUtils';
import {
  distanceToRayConfigRangeCylinder,
  type RayConfigRangeCylinder,
} from '../combat/lineShotRange';
import { getActiveShields } from '../combat/shieldTurret';
import { ENTITY_CHANGED_HP, PROJECTILE_TYPE_PROJECTILE } from '../../../types/network';
import { getSimWasm, type SimWasm } from '../../sim-wasm/init';
import {
  ENTITY_SLOT_FLAG_HAS_BUILDING,
  ENTITY_SLOT_FLAG_HAS_UNIT,
  entitySlotRegistry,
} from '../EntitySlotRegistry';
import {
  BUILDING_CLOSED_DAMAGE_MULTIPLIER,
  buildingBlueprintHasActiveState,
  isBuildingActiveStateFortified,
  notifyBuildingActiveStateDamaged,
} from '../buildingActiveState';
import { getUnitGroundZ } from '../unitGeometry';
import { isConstructionBodyMaterialized } from '../buildableHelpers';


// Reusable DamageResult to avoid per-call allocations
const _reusableResult: DamageResult = {
  hitEntityIds: [],
  killedUnitIds: new Set(),
  killedBuildingIds: new Set(),
  killedProjectileIds: new Set(),
  truncationT: null,
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
  _reusableResult.truncationT = null;
  // Recycle prior tick's knockback entries before clearing the array.
  for (const k of _reusableResult.knockbacks) _knockbackPool.push(k);
  _reusableResult.knockbacks.length = 0;
  _reusableResult.deathContexts.clear();
  _reusableResult.killerPlayerIds.clear();
  return _reusableResult;
}

// Reusable HitInfo array for multi-hit swept damage sorting.
const _reusableHits: HitInfo[] = [];

// Reset module-level reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetDamageBuffers(): void {
  _reusableResult.hitEntityIds.length = 0;
  _reusableResult.killedUnitIds.clear();
  _reusableResult.killedBuildingIds.clear();
  _reusableResult.killedProjectileIds.clear();
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
  trimDamageBuffers();
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
  /** Unit-length reflected segment direction from the Rust kernel —
   *  the one shared mirror formula beams, plasma, and rockets all use.
   *  All-zero means the reflection was degenerate (terminal hit). */
  reflectDirX: 0,
  reflectDirY: 0,
  reflectDirZ: 0,
  panelIndex: -1,
  reflectorKind: undefined as BeamReflectorKind | undefined,
  reflectorPlayerId: undefined as PlayerId | undefined,
};

// n=1 scratch rows for the shared Rust reflector-intersection batch.
// The beam tracer queries one segment at a time (each bounce depends on
// the previous hit), reusing the same kernel + stamped surface pool the
// plasma/rocket path batches through.
const _beamReflEnabled = new Uint8Array([1]);
const _beamReflStartX = new Float64Array(1);
const _beamReflStartY = new Float64Array(1);
const _beamReflStartZ = new Float64Array(1);
const _beamReflEndX = new Float64Array(1);
const _beamReflEndY = new Float64Array(1);
const _beamReflEndZ = new Float64Array(1);
const _beamReflRadius = new Float64Array(1);
const _beamReflReflectionEntity = new Uint8Array([SHIELD_REFLECTION_ENTITY_BEAM]);
const _beamReflExcludeEntityId = new Int32Array(1);
const _beamReflExcludePanelIndex = new Int32Array(1);
const _beamReflOutKind = new Uint8Array(1);
const _beamReflOutEntityId = new Int32Array(1);
const _beamReflOutPanelIndex = new Int32Array(1);
const _beamReflOutT = new Float64Array(1);
const _beamReflOutX = new Float64Array(1);
const _beamReflOutY = new Float64Array(1);
const _beamReflOutZ = new Float64Array(1);
const _beamReflOutNormalX = new Float64Array(1);
const _beamReflOutNormalY = new Float64Array(1);
const _beamReflOutNormalZ = new Float64Array(1);
const _beamReflOutReflectDirX = new Float64Array(1);
const _beamReflOutReflectDirY = new Float64Array(1);
const _beamReflOutReflectDirZ = new Float64Array(1);
const _beamReflOutSurfVelX = new Float64Array(1);
const _beamReflOutSurfVelY = new Float64Array(1);
const _beamReflOutSurfVelZ = new Float64Array(1);
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
const DAMAGE_DEATH_EXPLOSION_ROW_FLAG_BODY_HIT = 1 << 2;
const DAMAGE_SEGMENT_HIT_FLAG_HIT = 1 << 0;

function lineSphereIntersectionTWithDelta(
  startX: number, startY: number, startZ: number,
  dx: number, dy: number, dz: number,
  segmentLenSq: number,
  cx: number, cy: number, cz: number,
  r: number,
): number | null {
  const fx = startX - cx;
  const fy = startY - cy;
  const fz = startZ - cz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  if (c <= 0) return 0;
  if (segmentLenSq === 0) return null;

  let discriminant = b * b - 4 * segmentLenSq * c;
  if (discriminant < 0) return null;
  discriminant = Math.sqrt(discriminant);

  const invDenom = 1 / (2 * segmentLenSq);
  const t1 = (-b - discriminant) * invDenom;
  if (t1 >= 0 && t1 <= 1) return t1;
  const t2 = (-b + discriminant) * invDenom;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

function rayBoxIntersectionTWithDelta(
  sx: number, sy: number, sz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number | null {
  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) > 1e-9) {
    let t1 = (minX - sx) / dx;
    let t2 = (maxX - sx) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  } else if (sx < minX || sx > maxX) {
    return null;
  }
  if (tmin > tmax) return null;

  if (Math.abs(dy) > 1e-9) {
    let t1 = (minY - sy) / dy;
    let t2 = (maxY - sy) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  } else if (sy < minY || sy > maxY) {
    return null;
  }
  if (tmin > tmax) return null;

  if (Math.abs(dz) > 1e-9) {
    let t1 = (minZ - sz) / dz;
    let t2 = (maxZ - sz) / dz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  } else if (sz < minZ || sz > maxZ) {
    return null;
  }
  if (tmin > tmax || tmax < 0) return null;
  return Math.max(tmin, 0);
}

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
let _areaDamageSlots = new Uint32Array(0);
let _areaBuildingSlotScratch = new Uint32Array(0);
// DEV-only scratch: the slab kernel is authoritative; dev builds also run
// the array-based damageAreaOverlapBatch into these and assert per-row
// output matches (catches slot-mapping / slab-coherence drift).
let _areaDamageRefFlags = new Uint8Array(0);
let _areaDamageRefDirX = new Float64Array(0);
let _areaDamageRefDirY = new Float64Array(0);
let _areaDamageRefDirZ = new Float64Array(0);
let _areaDamageRefDistance = new Float64Array(0);
let _areaDamageTurretStart = new Int32Array(0);
let _areaDamageTurretEnd = new Int32Array(0);
let _areaTurretDamageCapacity = 0;
let _areaTurretDamageSlots = new Uint32Array(0);
let _areaTurretDamageTurretIndices = new Int32Array(0);
let _areaTurretDamageOutFlags = new Uint8Array(0);
let _areaTurretDamageRefFlags = new Uint8Array(0);
let _deathExplosionDamageCapacity = 0;
let _deathExplosionDamageSlots = new Uint32Array(0);
let _deathExplosionDamageTargetKind = new Uint8Array(0);
let _deathExplosionDamageOutFlags = new Uint8Array(0);
let _deathExplosionDamageOutDirX = new Float64Array(0);
let _deathExplosionDamageOutDirY = new Float64Array(0);
let _deathExplosionDamageOutDirZ = new Float64Array(0);
let _deathExplosionDamageOutDistance = new Float64Array(0);
const _deathExplosionDamageOutCount = new Uint32Array(1);
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
let _segmentDamageSlots = new Uint32Array(0);
let _segmentDamageTurretIndices = new Int32Array(0);
let _segmentDamageOutFlags = new Uint8Array(0);
let _segmentDamageOutT = new Float64Array(0);
let _segmentDamageRefFlags = new Uint8Array(0);
let _segmentDamageRefT = new Float64Array(0);

function trimDamageBuffers(): void {
  _damageBatchCapacity = 0;
  _damageBatchCount = 0;
  _damageBatchEntities = [];
  _damageBatchDeathContexts = [];
  _damageBatchEnabled = new Uint8Array(0);
  _damageBatchTargetKind = new Uint8Array(0);
  _damageBatchHp = new Float64Array(0);
  _damageBatchDamage = new Float64Array(0);
  _damageBatchBuildingFortified = new Uint8Array(0);
  _damageBatchOutHp = new Float64Array(0);
  _damageBatchOutEffectiveDamage = new Float64Array(0);
  _damageBatchOutFlags = new Uint8Array(0);

  _areaDamageCapacity = 0;
  _areaDamageEntities = [];
  _areaDamageEnabled = new Uint8Array(0);
  _areaDamageTargetKind = new Uint8Array(0);
  _areaDamageTargetX = new Float64Array(0);
  _areaDamageTargetY = new Float64Array(0);
  _areaDamageTargetZ = new Float64Array(0);
  _areaDamageTargetRadius = new Float64Array(0);
  _areaDamageBoxHalfX = new Float64Array(0);
  _areaDamageBoxHalfY = new Float64Array(0);
  _areaDamageBoxHalfZ = new Float64Array(0);
  _areaDamageOutFlags = new Uint8Array(0);
  _areaDamageOutDirX = new Float64Array(0);
  _areaDamageOutDirY = new Float64Array(0);
  _areaDamageOutDirZ = new Float64Array(0);
  _areaDamageOutDistance = new Float64Array(0);
  _areaDamageSlots = new Uint32Array(0);
  _areaBuildingSlotScratch = new Uint32Array(0);
  _areaDamageRefFlags = new Uint8Array(0);
  _areaDamageRefDirX = new Float64Array(0);
  _areaDamageRefDirY = new Float64Array(0);
  _areaDamageRefDirZ = new Float64Array(0);
  _areaDamageRefDistance = new Float64Array(0);
  _areaDamageTurretStart = new Int32Array(0);
  _areaDamageTurretEnd = new Int32Array(0);

  _areaTurretDamageCapacity = 0;
  _areaTurretDamageSlots = new Uint32Array(0);
  _areaTurretDamageTurretIndices = new Int32Array(0);
  _areaTurretDamageOutFlags = new Uint8Array(0);
  _areaTurretDamageRefFlags = new Uint8Array(0);

  _deathExplosionDamageCapacity = 0;
  _deathExplosionDamageSlots = new Uint32Array(0);
  _deathExplosionDamageTargetKind = new Uint8Array(0);
  _deathExplosionDamageOutFlags = new Uint8Array(0);
  _deathExplosionDamageOutDirX = new Float64Array(0);
  _deathExplosionDamageOutDirY = new Float64Array(0);
  _deathExplosionDamageOutDirZ = new Float64Array(0);
  _deathExplosionDamageOutDistance = new Float64Array(0);

  _segmentDamageCapacity = 0;
  _segmentDamageEntityIds = [];
  _segmentDamageHostEntityIds = [];
  _segmentDamageIsUnit = new Uint8Array(0);
  _segmentDamageIsBuilding = new Uint8Array(0);
  _segmentDamageIsProjectile = new Uint8Array(0);
  _segmentDamageEnabled = new Uint8Array(0);
  _segmentDamageTargetKind = new Uint8Array(0);
  _segmentDamageTargetX = new Float64Array(0);
  _segmentDamageTargetY = new Float64Array(0);
  _segmentDamageTargetZ = new Float64Array(0);
  _segmentDamageTargetRadius = new Float64Array(0);
  _segmentDamageBoxHalfX = new Float64Array(0);
  _segmentDamageBoxHalfY = new Float64Array(0);
  _segmentDamageBoxHalfZ = new Float64Array(0);
  _segmentDamageSlots = new Uint32Array(0);
  _segmentDamageTurretIndices = new Int32Array(0);
  _segmentDamageOutFlags = new Uint8Array(0);
  _segmentDamageOutT = new Float64Array(0);
  _segmentDamageRefFlags = new Uint8Array(0);
  _segmentDamageRefT = new Float64Array(0);
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
  _areaDamageSlots = new Uint32Array(next);
  _areaDamageRefFlags = new Uint8Array(next);
  _areaDamageRefDirX = new Float64Array(next);
  _areaDamageRefDirY = new Float64Array(next);
  _areaDamageRefDirZ = new Float64Array(next);
  _areaDamageRefDistance = new Float64Array(next);
  _areaDamageTurretStart = new Int32Array(next);
  _areaDamageTurretEnd = new Int32Array(next);
}

function ensureAreaBuildingSlotScratchCapacity(count: number): void {
  if (count <= _areaBuildingSlotScratch.length) return;
  let next = Math.max(16, _areaBuildingSlotScratch.length);
  while (next < count) next *= 2;
  _areaBuildingSlotScratch = new Uint32Array(next);
}

function clearAreaDamageEntities(count: number): void {
  for (let i = 0; i < count; i++) {
    _areaDamageEntities[i] = undefined;
  }
}

function ensureAreaTurretDamageCapacity(count: number): void {
  if (count <= _areaTurretDamageCapacity) return;
  let next = Math.max(16, _areaTurretDamageCapacity);
  while (next < count) next *= 2;
  _areaTurretDamageCapacity = next;
  _areaTurretDamageSlots = new Uint32Array(next);
  _areaTurretDamageTurretIndices = new Int32Array(next);
  _areaTurretDamageOutFlags = new Uint8Array(next);
  _areaTurretDamageRefFlags = new Uint8Array(next);
}

function ensureDeathExplosionDamageCapacity(count: number): void {
  if (count <= _deathExplosionDamageCapacity) return;
  let next = Math.max(16, _deathExplosionDamageCapacity);
  while (next < count) next *= 2;
  _deathExplosionDamageCapacity = next;
  _deathExplosionDamageSlots = new Uint32Array(next);
  _deathExplosionDamageTargetKind = new Uint8Array(next);
  _deathExplosionDamageOutFlags = new Uint8Array(next);
  _deathExplosionDamageOutDirX = new Float64Array(next);
  _deathExplosionDamageOutDirY = new Float64Array(next);
  _deathExplosionDamageOutDirZ = new Float64Array(next);
  _deathExplosionDamageOutDistance = new Float64Array(next);
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

// Slab-driven area classification: pack each candidate's combat-targeting
// slot instead of its position/radius/box, and Rust reads the geometry from
// the slab (damageAreaCandidatesBatch). Output is the same _areaDamageOut*
// contract the callers already apply. In DEV the legacy array-based path is
// run alongside and the per-row output asserted equal.
function classifyAreaDamageRowsViaSlab(
  source: AreaDamageSource,
  count: number,
  hasSlice: boolean,
  sliceHalfAngle: number,
): void {
  if (count === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Area damage candidate classification requires initialized sim-wasm');
  }
  sim.damageAreaCandidatesBatch(
    count,
    _areaDamageSlots.subarray(0, count),
    source.center.x,
    source.center.y,
    source.center.z,
    source.radius,
    hasSlice ? 1 : 0,
    source.sliceDirection ?? 0,
    sliceHalfAngle,
    _areaDamageOutFlags.subarray(0, count),
    _areaDamageOutDirX.subarray(0, count),
    _areaDamageOutDirY.subarray(0, count),
    _areaDamageOutDirZ.subarray(0, count),
    _areaDamageOutDistance.subarray(0, count),
  );
  if (import.meta.env.DEV) {
    assertAreaSlabMatchesPacked(source, count, hasSlice, sliceHalfAngle);
  }
}

// DEV-only: re-run the legacy array-based classifier (over geometry packed in
// the calling loop's DEV branch) and assert it matches the slab kernel row by
// row. Throws on the first divergence so a slot-mapping or coherence bug
// surfaces immediately instead of as silent hit-detection drift.
// DEV-only: throttle the slab/pack divergence log to once per entity id. A
// persistent (pre-existing) divergence otherwise re-logs every explosion every
// tick, and the per-tick console.error chokes the dev tick loop.
const _loggedAreaDivergences = new Set<number | undefined>();
function assertAreaSlabMatchesPacked(
  source: AreaDamageSource,
  count: number,
  hasSlice: boolean,
  sliceHalfAngle: number,
): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  sim.damageAreaOverlapBatch(
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
    _areaDamageRefFlags.subarray(0, count),
    _areaDamageRefDirX.subarray(0, count),
    _areaDamageRefDirY.subarray(0, count),
    _areaDamageRefDirZ.subarray(0, count),
    _areaDamageRefDistance.subarray(0, count),
  );
  for (let i = 0; i < count; i++) {
    if (
      _areaDamageOutFlags[i] !== _areaDamageRefFlags[i] ||
      _areaDamageOutDirX[i] !== _areaDamageRefDirX[i] ||
      _areaDamageOutDirY[i] !== _areaDamageRefDirY[i] ||
      _areaDamageOutDirZ[i] !== _areaDamageRefDirZ[i] ||
      _areaDamageOutDistance[i] !== _areaDamageRefDistance[i]
    ) {
      const entity = _areaDamageEntities[i];
      // Match the codebase's dev-compare convention (snapshot wire oracle):
      // log the first divergence loudly instead of throwing, so a slot /
      // coherence bug surfaces without crashing the dev session.
      if (!_loggedAreaDivergences.has(entity?.id)) {
        _loggedAreaDivergences.add(entity?.id);
        console.error('[C1-area] slab/pack hit-classification divergence', {
          row: i,
          entityId: entity?.id,
          slot: _areaDamageSlots[i],
          flags: _areaDamageOutFlags[i],
          refFlags: _areaDamageRefFlags[i],
          distance: _areaDamageOutDistance[i],
          refDistance: _areaDamageRefDistance[i],
        });
      }
      return;
    }
  }
}

function classifyAreaTurretDamageRows(
  source: AreaDamageSource,
  count: number,
): void {
  if (count === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Area turret damage candidate classification requires initialized sim-wasm');
  }
  const processed = sim.damageAreaTurretCandidatesBatch(
    count,
    _areaTurretDamageSlots.subarray(0, count),
    _areaTurretDamageTurretIndices.subarray(0, count),
    source.center.x,
    source.center.y,
    source.center.z,
    source.radius,
    _areaTurretDamageOutFlags.subarray(0, count),
  );
  if (processed !== count) {
    throw new Error(`Area turret damage candidate classification failed: ${processed}/${count}`);
  }
  if (import.meta.env.DEV) {
    assertAreaTurretSlabMatchesPacked(count);
  }
}

function assertAreaTurretSlabMatchesPacked(count: number): void {
  for (let i = 0; i < count; i++) {
    if (_areaTurretDamageOutFlags[i] !== _areaTurretDamageRefFlags[i]) {
      console.error('[C1-area-turret] slab/pack hit-classification divergence', {
        row: i,
        slot: _areaTurretDamageSlots[i],
        turretIndex: _areaTurretDamageTurretIndices[i],
        flags: _areaTurretDamageOutFlags[i],
        refFlags: _areaTurretDamageRefFlags[i],
      });
      return;
    }
  }
}

function classifyDeathExplosionDamageRows(source: AreaDamageSource): number {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Death-explosion candidate classification requires initialized sim-wasm');
  }

  ensureDeathExplosionDamageCapacity(16);
  for (;;) {
    _deathExplosionDamageOutCount[0] = 0;
    const processed = sim.damageDeathExplosionCandidatesBatch(
      source.center.x,
      source.center.y,
      source.center.z,
      source.radius,
      source.radius + 100,
      _deathExplosionDamageCapacity,
      _deathExplosionDamageSlots,
      _deathExplosionDamageTargetKind,
      _deathExplosionDamageOutFlags,
      _deathExplosionDamageOutDirX,
      _deathExplosionDamageOutDirY,
      _deathExplosionDamageOutDirZ,
      _deathExplosionDamageOutDistance,
      _deathExplosionDamageOutCount,
    );
    const count = _deathExplosionDamageOutCount[0];
    if (count > _deathExplosionDamageCapacity) {
      ensureDeathExplosionDamageCapacity(count);
      continue;
    }
    if (processed !== count) {
      throw new Error(`Death-explosion candidate classification failed: ${processed}/${count}`);
    }
    return count;
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
  _segmentDamageSlots = new Uint32Array(next);
  _segmentDamageTurretIndices = new Int32Array(next);
  _segmentDamageOutFlags = new Uint8Array(next);
  _segmentDamageOutT = new Float64Array(next);
  _segmentDamageRefFlags = new Uint8Array(next);
  _segmentDamageRefT = new Float64Array(next);
}

function writeSegmentDamageRowMetadata(
  row: number,
  entityId: EntityId,
  hostEntityId: EntityId,
  isUnit: boolean,
  isBuilding: boolean,
  isProjectile: boolean,
  targetKind: number,
): void {
  _segmentDamageEntityIds[row] = entityId;
  _segmentDamageHostEntityIds[row] = hostEntityId;
  _segmentDamageIsUnit[row] = isUnit ? 1 : 0;
  _segmentDamageIsBuilding[row] = isBuilding ? 1 : 0;
  _segmentDamageIsProjectile[row] = isProjectile ? 1 : 0;
  _segmentDamageEnabled[row] = 1;
  _segmentDamageTargetKind[row] = targetKind;
}

function writeSegmentDamageSphereReference(
  row: number,
  x: number,
  y: number,
  z: number,
  radius: number,
): void {
  _segmentDamageTargetX[row] = x;
  _segmentDamageTargetY[row] = y;
  _segmentDamageTargetZ[row] = z;
  _segmentDamageTargetRadius[row] = radius;
  _segmentDamageBoxHalfX[row] = 0;
  _segmentDamageBoxHalfY[row] = 0;
  _segmentDamageBoxHalfZ[row] = 0;
}

function writeSegmentDamageBoxReference(
  row: number,
  x: number,
  y: number,
  z: number,
  halfX: number,
  halfY: number,
  halfZ: number,
): void {
  _segmentDamageTargetX[row] = x;
  _segmentDamageTargetY[row] = y;
  _segmentDamageTargetZ[row] = z;
  _segmentDamageTargetRadius[row] = 0;
  _segmentDamageBoxHalfX[row] = halfX;
  _segmentDamageBoxHalfY[row] = halfY;
  _segmentDamageBoxHalfZ[row] = halfZ;
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
  writeSegmentDamageRowMetadata(
    row,
    entityId,
    hostEntityId,
    isUnit,
    false,
    isProjectile,
    isProjectile ? DAMAGE_TARGET_KIND_PROJECTILE : DAMAGE_TARGET_KIND_UNIT,
  );
  _segmentDamageSlots[row] = 0;
  _segmentDamageTurretIndices[row] = -1;
  writeSegmentDamageSphereReference(row, x, y, z, radius);
  return row + 1;
}

function appendSegmentDamageSlabRow(
  row: number,
  entityId: EntityId,
  hostEntityId: EntityId,
  isUnit: boolean,
  isBuilding: boolean,
  slot: number,
  turretIndex: number,
): number {
  ensureSegmentDamageCapacity(row + 1);
  writeSegmentDamageRowMetadata(
    row,
    entityId,
    hostEntityId,
    isUnit,
    isBuilding,
    false,
    isBuilding ? DAMAGE_TARGET_KIND_BUILDING : DAMAGE_TARGET_KIND_UNIT,
  );
  _segmentDamageSlots[row] = slot;
  _segmentDamageTurretIndices[row] = turretIndex;
  return row + 1;
}

function classifySegmentDamageRowsPackedRange(
  rowStart: number,
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
  const rowEnd = rowStart + count;
  const processed = sim.damageSegmentHitsBatch(
    count,
    _segmentDamageEnabled.subarray(rowStart, rowEnd),
    _segmentDamageTargetKind.subarray(rowStart, rowEnd),
    startX,
    startY,
    startZ,
    endX,
    endY,
    endZ,
    _segmentDamageTargetX.subarray(rowStart, rowEnd),
    _segmentDamageTargetY.subarray(rowStart, rowEnd),
    _segmentDamageTargetZ.subarray(rowStart, rowEnd),
    _segmentDamageTargetRadius.subarray(rowStart, rowEnd),
    _segmentDamageBoxHalfX.subarray(rowStart, rowEnd),
    _segmentDamageBoxHalfY.subarray(rowStart, rowEnd),
    _segmentDamageBoxHalfZ.subarray(rowStart, rowEnd),
    _segmentDamageOutFlags.subarray(rowStart, rowEnd),
    _segmentDamageOutT.subarray(rowStart, rowEnd),
  );
  if (processed !== count) {
    throw new Error(`Segment damage hit classification failed: ${processed}/${count}`);
  }
}

function classifySegmentDamageRowsViaSlab(
  count: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  sphereInflation: number,
  aabbInflation: number,
): void {
  if (count === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Segment damage candidate classification requires initialized sim-wasm');
  }
  const processed = sim.damageSegmentCandidatesBatch(
    count,
    _segmentDamageSlots.subarray(0, count),
    _segmentDamageTurretIndices.subarray(0, count),
    startX,
    startY,
    startZ,
    endX,
    endY,
    endZ,
    sphereInflation,
    aabbInflation,
    _segmentDamageOutFlags.subarray(0, count),
    _segmentDamageOutT.subarray(0, count),
  );
  if (processed !== count) {
    throw new Error(`Segment damage candidate classification failed: ${processed}/${count}`);
  }
  if (import.meta.env.DEV) {
    assertSegmentSlabMatchesPacked(
      count,
      startX,
      startY,
      startZ,
      endX,
      endY,
      endZ,
      sphereInflation,
      aabbInflation,
    );
  }
}

function assertSegmentSlabMatchesPacked(
  count: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  sphereInflation: number,
  aabbInflation: number,
): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  sim.damageSegmentHitsBatch(
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
    _segmentDamageRefFlags.subarray(0, count),
    _segmentDamageRefT.subarray(0, count),
  );
  for (let i = 0; i < count; i++) {
    if (
      _segmentDamageOutFlags[i] !== _segmentDamageRefFlags[i] ||
      _segmentDamageOutT[i] !== _segmentDamageRefT[i]
    ) {
      console.error('[C1-segment] slab/pack hit-classification divergence', {
        row: i,
        entityId: _segmentDamageEntityIds[i],
        hostEntityId: _segmentDamageHostEntityIds[i],
        slot: _segmentDamageSlots[i],
        turretIndex: _segmentDamageTurretIndices[i],
        flags: _segmentDamageOutFlags[i],
        refFlags: _segmentDamageRefFlags[i],
        t: _segmentDamageOutT[i],
        refT: _segmentDamageRefT[i],
        sphereInflation,
        aabbInflation,
      });
      return;
    }
  }
}

function classifySegmentDamageRowsMixed(
  slabRowCount: number,
  totalRowCount: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  sphereInflation: number,
  aabbInflation: number,
): void {
  classifySegmentDamageRowsViaSlab(
    slabRowCount,
    startX,
    startY,
    startZ,
    endX,
    endY,
    endZ,
    sphereInflation,
    aabbInflation,
  );
  classifySegmentDamageRowsPackedRange(
    slabRowCount,
    totalRowCount - slabRowCount,
    startX,
    startY,
    startZ,
    endX,
    endY,
    endZ,
  );
}


export class DamageSystem {
  constructor(private world: WorldState) {}

  // Main entry point - apply any damage source
  applyDamage(source: AnyDamageSource): DamageResult {
    switch (source.type) {
      case 'swept':
        return this.applySweptDamage(source);
      case 'area':
        return this.applyAreaDamage(source);
    }
  }

  // Find beam path with reflections off mirror units and shield
  // spheres — full 3D.
  //
  // Damage is clipped at the first of: a unit hit, a building hit, a
  // ground hit, an optional trace limiter, or the configured max
  // segment count. Mirrors and shields bounce. A limiter endpoint can
  // be an open ray for visuals, not a physical impact point.
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
    maxSegments: number = 4,
    rangeCylinder: RayConfigRangeCylinder | undefined = undefined,
    dtMs: number = 0,
    traceLimitEndpointDamageable: boolean = rangeCylinder === undefined,
    reflectionEntity: number = SHIELD_REFLECTION_ENTITY_BEAM,
  ): {
    endX: number; endY: number; endZ: number;
    obstructionT: number | undefined;
    reflections: BeamReflectorPoint[];
    terminalReflection: BeamReflectorPoint | undefined;
    endpointDamageable: boolean;
    segmentLimitReached: boolean;
    /** Entity the final segment terminated on; NO_ENTITY_ID for a free
     *  range/cylinder end. A change in this identity between traces is
     *  a discrete endpoint event (the beam swept onto/off a body), so
     *  the caller must not finite-diff endpoint velocity across it. */
    endEntityId: EntityId;
  } {
    const reflections: BeamReflectorPoint[] = [];
    let loopEndEntityId: EntityId = NO_ENTITY_ID;
    const segmentLimit = Math.max(1, Math.floor(maxSegments));
    let remainingRange = DMath.hypot(endX - startX, endY - startY, endZ - startZ);
    let curSX = startX, curSY = startY, curSZ = startZ;
    let curEX = endX, curEY = endY, curEZ = endZ;
    let bodyExcludeEntityId = sourceEntityId;
    let bodyExcludePanelIndex = -1;
    let reflectorExcludeEntityId = NO_ENTITY_ID;
    let reflectorExcludePanelIndex = -1;
    const panelsActive = this.world.turretShieldPanelsEnabled &&
      this.world.getShieldPanelUnits().length > 0;
    const fieldsActive = this.world.turretShieldSpheresEnabled &&
      getActiveShields().length > 0;
    const reflectorSim = panelsActive || fieldsActive ? getSimWasm() : undefined;

    for (let segmentIndex = 0; segmentIndex < segmentLimit; segmentIndex++) {
      if (rangeCylinder) {
        const segDx = curEX - curSX;
        const segDy = curEY - curSY;
        const segDz = curEZ - curSZ;
        const segLen = DMath.hypot(segDx, segDy, segDz);
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
        bodyExcludeEntityId,
        bodyExcludePanelIndex,
        reflectorExcludeEntityId,
        reflectorExcludePanelIndex,
        lineWidth,
        dtMs,
        reflectionEntity,
        reflectorSim,
        panelsActive,
        fieldsActive,
      );

      if (!hit) {
        return {
          endX: curEX,
          endY: curEY,
          endZ: curEZ,
          obstructionT: undefined,
          reflections,
          terminalReflection: undefined,
          endpointDamageable: traceLimitEndpointDamageable,
          segmentLimitReached: false,
          endEntityId: NO_ENTITY_ID,
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
            endEntityId: hit.entityId,
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
          endEntityId: hit.entityId,
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

      if (segmentIndex === segmentLimit - 1) {
        return {
          endX: hit.x,
          endY: hit.y,
          endZ: hit.z,
          obstructionT: undefined,
          reflections,
          terminalReflection: reflection,
          endpointDamageable: false,
          endEntityId: hit.entityId,
          segmentLimitReached: true,
        };
      }

      const segDx = curEX - curSX;
      const segDy = curEY - curSY;
      const segDz = curEZ - curSZ;
      const segLen = DMath.hypot(segDx, segDy, segDz);
      // Reflected direction comes from the Rust kernel (the one shared
      // mirror formula for beams, plasma, and rockets). All-zero means
      // the bounce was degenerate — terminal hit on the reflector.
      const reflDirX = hit.reflectDirX;
      const reflDirY = hit.reflectDirY;
      const reflDirZ = hit.reflectDirZ;
      const reflLenSq = reflDirX * reflDirX + reflDirY * reflDirY + reflDirZ * reflDirZ;
      if (segLen <= 1e-9 || reflLenSq <= 1e-12) {
        return {
          endX: hit.x,
          endY: hit.y,
          endZ: hit.z,
          obstructionT: undefined,
          reflections,
          terminalReflection: reflection,
          endpointDamageable: false,
          endEntityId: hit.entityId,
          segmentLimitReached: false,
        };
      }

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
          loopEndEntityId = hit.entityId;
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
          loopEndEntityId = hit.entityId;
          break;
        }
        curEX = hit.x + reflDirX * remainingRange;
        curEY = hit.y + reflDirY * remainingRange;
        curEZ = hit.z + reflDirZ * remainingRange;
      }
      bodyExcludeEntityId = hit.entityId;
      bodyExcludePanelIndex = hit.panelIndex;
      reflectorExcludeEntityId = hit.entityId;
      reflectorExcludePanelIndex = hit.panelIndex;
    }

    return {
      endX: curEX,
      endY: curEY,
      endZ: curEZ,
      obstructionT: undefined,
      reflections,
      terminalReflection: undefined,
      endpointDamageable: traceLimitEndpointDamageable,
      segmentLimitReached: false,
      endEntityId: loopEndEntityId,
    };
  }

  // Find closest beam hit — checks shield panel rectangles AND regular
  // entity colliders, all in 3D.
  // Body exclusion and reflector exclusion are deliberately separate:
  // launch excludes the firing body, but not its shield material. A
  // turret inside its own active shield must still reflect on the first
  // segment. After an actual reflector hit, both exclusions move to that
  // reflector so the next segment does not immediately re-hit the same
  // surface.
  private findGroundSegmentT(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    maxT: number = 1,
  ): number | null {
    const clampedMaxT = Math.max(0, Math.min(1, maxT));
    if (clampedMaxT <= 0) return null;
    const dx = endX - startX;
    const dy = endY - startY;
    const dz = endZ - startZ;
    let prevT = 0;
    let prevClear = startZ - this.world.getGroundZ(startX, startY);
    if (prevClear < -BEAM_GROUND_EPSILON) return 0;

    for (let i = 1; i <= BEAM_GROUND_HIT_STEPS; i++) {
      const t = Math.min(i / BEAM_GROUND_HIT_STEPS, clampedMaxT);
      const x = startX + dx * t;
      const y = startY + dy * t;
      const z = startZ + dz * t;
      const clear = z - this.world.getGroundZ(x, y);
      if (clear <= BEAM_GROUND_EPSILON && prevClear > BEAM_GROUND_EPSILON) {
        let lo = prevT;
        let hi = t;
        for (let b = 0; b < BEAM_GROUND_HIT_BISECT_STEPS; b++) {
          const mid = (lo + hi) * 0.5;
          const midX = startX + dx * mid;
          const midY = startY + dy * mid;
          const midZ = startZ + dz * mid;
          if (midZ - this.world.getGroundZ(midX, midY) <= BEAM_GROUND_EPSILON) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        return hi;
      }
      prevT = t;
      prevClear = clear;
      if (t >= clampedMaxT) break;
    }

    return null;
  }

  private findBeamSegmentHit(
    startX: number, startY: number, startZ: number,
    endX: number, endY: number, endZ: number,
    bodyExcludeEntityId: EntityId,
    bodyExcludePanelIndex: number,
    reflectorExcludeEntityId: EntityId,
    reflectorExcludePanelIndex: number,
    lineWidth: number,
    dtMs: number,
    reflectionEntity: number,
    reflectorSim: SimWasm | undefined,
    panelsActive: boolean,
    fieldsActive: boolean,
  ): typeof _segHit | null {
    let bestT = Infinity;
    let found = false;
    let bestHitIsGround = false;

    const dx = endX - startX;
    const dy = endY - startY;
    const dz = endZ - startZ;
    const segLenSq = dx * dx + dy * dy;
    const segLen3Sq = segLenSq + dz * dz;
    const halfLineWidth = lineWidth / 2;
    const unitProjectileQueryWidth = lineWidth + 60;
    const buildingQueryWidth = lineWidth + 100;
    const bodyQueryWidth = Math.max(unitProjectileQueryWidth, buildingQueryWidth);

    const nearbyBodySlots = spatialGrid.queryUnitBuildingSlotRangesAlongLine(
      startX, startY, startZ,
      endX, endY, endZ,
      bodyQueryWidth,
    );
    const entityViews = entitySlotRegistry.getViews();
    if (entityViews !== null) {
      const slots = nearbyBodySlots.slots;
      const unitEnd = nearbyBodySlots.unitStart + nearbyBodySlots.unitCount;
      const capacity = entityViews.capacity;
      const entityIds = entityViews.entityId;
      const hp = entityViews.hp;
      const posX = entityViews.posX;
      const posY = entityViews.posY;
      const posZ = entityViews.posZ;
      const radiusHitbox = entityViews.radiusHitbox;
      for (let i = nearbyBodySlots.unitStart; i < unitEnd; i++) {
        const slot = slots[i];
        if (slot >= capacity) continue;
        const unitId = entityIds[slot] as EntityId;
        const isExcludedEntity = unitId === bodyExcludeEntityId;
        if (isExcludedEntity && bodyExcludePanelIndex < 0) continue;
        if (hp[slot] <= 0) continue;

        // Horizontal-only early-out — the beam may arc vertically past
        // the unit, but we still require its XY projection to come near
        // the unit's bounding radius. Reflector surfaces (panels/fields)
        // are tested by the shared Rust kernel below, not per unit here.
        const unitX = posX[slot];
        const unitY = posY[slot];
        const unitZ = posZ[slot];
        const ux = unitX - startX, uy = unitY - startY;
        const crossSq = (ux * dy - uy * dx);
        const boundR = radiusHitbox[slot] + halfLineWidth;
        if (crossSq * crossSq > boundR * boundR * segLenSq) continue;

        // Unit body: 3D segment-vs-sphere.
        const t = lineSphereIntersectionTWithDelta(
          startX, startY, startZ,
          dx, dy, dz,
          segLen3Sq,
          unitX, unitY, unitZ,
          boundR,
        );
        if (t !== null && t < bestT) {
          bestT = t; found = true;
          bestHitIsGround = false;
          _segHit.t = t;
          _segHit.x = startX + t * dx;
          _segHit.y = startY + t * dy;
          _segHit.z = startZ + t * dz;
          _segHit.entityId = unitId;
          _segHit.isMirror = false;
          _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 0;
          _segHit.reflectDirX = 0; _segHit.reflectDirY = 0; _segHit.reflectDirZ = 0;
          _segHit.panelIndex = -1;
          _segHit.reflectorKind = undefined;
          _segHit.reflectorPlayerId = undefined;
        }
      }
    }

    // Reflector surfaces (mirror panels AND sphere/cylinder fields):
    // the SAME Rust kernel and stamped surface pool the plasma/rocket
    // path uses — one pose epoch and one mirror formula for every
    // emission kind, so a beam and a rocket can never disagree about
    // where a surface is or how it bounces.
    if (
      reflectorSim !== undefined &&
      (panelsActive || fieldsActive)
    ) {
      _beamReflStartX[0] = startX;
      _beamReflStartY[0] = startY;
      _beamReflStartZ[0] = startZ;
      _beamReflEndX[0] = endX;
      _beamReflEndY[0] = endY;
      _beamReflEndZ[0] = endZ;
      _beamReflRadius[0] = Math.max(0, lineWidth);
      _beamReflReflectionEntity[0] = reflectionEntity;
      _beamReflExcludeEntityId[0] = reflectorExcludeEntityId;
      _beamReflExcludePanelIndex[0] = reflectorExcludePanelIndex;
      reflectorSim.projectileReflectorIntersectionsBatch(
        1,
        _beamReflEnabled,
        _beamReflStartX,
        _beamReflStartY,
        _beamReflStartZ,
        _beamReflEndX,
        _beamReflEndY,
        _beamReflEndZ,
        _beamReflRadius,
        _beamReflReflectionEntity,
        _beamReflExcludeEntityId,
        _beamReflExcludePanelIndex,
        panelsActive ? 1 : 0,
        fieldsActive ? 1 : 0,
        // Beams are instantaneous rays: resolve against the current
        // shield pose only, never the swept prev->cur fallback.
        1,
        SHIELD_PANEL_PROJECTILE_QUERY_PAD,
        dtMs,
        _beamReflOutKind,
        _beamReflOutEntityId,
        _beamReflOutPanelIndex,
        _beamReflOutT,
        _beamReflOutX,
        _beamReflOutY,
        _beamReflOutZ,
        _beamReflOutNormalX,
        _beamReflOutNormalY,
        _beamReflOutNormalZ,
        _beamReflOutReflectDirX,
        _beamReflOutReflectDirY,
        _beamReflOutReflectDirZ,
        _beamReflOutSurfVelX,
        _beamReflOutSurfVelY,
        _beamReflOutSurfVelZ,
      );
      if (_beamReflOutKind[0] !== REFLECTOR_HIT_KIND_NONE && _beamReflOutT[0] < bestT) {
        bestT = _beamReflOutT[0]; found = true;
        bestHitIsGround = false;
        _segHit.t = _beamReflOutT[0];
        _segHit.x = _beamReflOutX[0];
        _segHit.y = _beamReflOutY[0];
        _segHit.z = _beamReflOutZ[0];
        _segHit.entityId = _beamReflOutEntityId[0] as EntityId;
        _segHit.isMirror = true;
        _segHit.normalX = _beamReflOutNormalX[0];
        _segHit.normalY = _beamReflOutNormalY[0];
        _segHit.normalZ = _beamReflOutNormalZ[0];
        _segHit.reflectDirX = _beamReflOutReflectDirX[0];
        _segHit.reflectDirY = _beamReflOutReflectDirY[0];
        _segHit.reflectDirZ = _beamReflOutReflectDirZ[0];
        _segHit.panelIndex = _beamReflOutPanelIndex[0];
        _segHit.reflectorKind = 'shield';
        const owner = this.world.getEntity(_segHit.entityId);
        _segHit.reflectorPlayerId =
          owner !== undefined && owner !== null && owner.ownership !== null
            ? owner.ownership.playerId
            : undefined;
      }
    }

    // Buildings: 3D ray-vs-AABB (x/y footprint × z depth). A beam arcing
    // over a short building correctly misses; clipping the wall stops.
    if (entityViews !== null) {
      const slots = nearbyBodySlots.slots;
      const buildingEnd = nearbyBodySlots.buildingStart + nearbyBodySlots.buildingCount;
      const capacity = entityViews.capacity;
      const entityIds = entityViews.entityId;
      const hp = entityViews.hp;
      const posX = entityViews.posX;
      const posY = entityViews.posY;
      const posZ = entityViews.posZ;
      const aabbHx = entityViews.aabbHx;
      const aabbHy = entityViews.aabbHy;
      const aabbHz = entityViews.aabbHz;
      for (let i = nearbyBodySlots.buildingStart; i < buildingEnd; i++) {
        const slot = slots[i];
        if (slot >= capacity) continue;
        const buildingId = entityIds[slot] as EntityId;
        // Skip the firing building — a tower-mounted turret must not
        // self-block on its own AABB. Mirrors the unit-source guard
        // above (bodyExclude* tracks the entity the beam was just
        // emitted from / last reflected off).
        if (buildingId === bodyExcludeEntityId) continue;
        if (hp[slot] <= 0) continue;
        const bCenterX = posX[slot];
        const bCenterY = posY[slot];
        const bCenterZ = posZ[slot];
        const bHalfX = aabbHx[slot];
        const bHalfY = aabbHy[slot];
        const bHalfZ = aabbHz[slot];
        const t = rayBoxIntersectionTWithDelta(
          startX, startY, startZ,
          dx, dy, dz,
          bCenterX - bHalfX, bCenterY - bHalfY, bCenterZ - bHalfZ,
          bCenterX + bHalfX, bCenterY + bHalfY, bCenterZ + bHalfZ,
        );
        if (t !== null && t < bestT) {
          bestT = t; found = true;
          bestHitIsGround = false;
          _segHit.t = t;
          _segHit.x = startX + t * dx;
          _segHit.y = startY + t * dy;
          _segHit.z = startZ + t * dz;
          _segHit.entityId = buildingId;
          _segHit.isMirror = false;
          _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 0;
          _segHit.panelIndex = -1;
          _segHit.reflectorKind = undefined;
          _segHit.reflectorPlayerId = undefined;
        }
      }
    }

    const groundT = this.findGroundSegmentT(
      startX,
      startY,
      startZ,
      endX,
      endY,
      endZ,
      bestT,
    );
    if (groundT !== null && groundT < bestT) {
      bestT = groundT; found = true;
      bestHitIsGround = true;
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

    let queryEndX = endX;
    let queryEndY = endY;
    let queryEndZ = endZ;
    if (bestT < 1) {
      queryEndX = startX + bestT * dx;
      queryEndY = startY + bestT * dy;
      queryEndZ = startZ + bestT * dz;
    }
    const nearbyProjectiles = spatialGrid.queryProjectileSlotsAlongLine(
      startX, startY, startZ,
      queryEndX, queryEndY, queryEndZ,
      unitProjectileQueryWidth,
    );
    if (entityViews !== null) {
      const slots = nearbyProjectiles.slots;
      const count = nearbyProjectiles.count;
      const capacity = entityViews.capacity;
      const entityIds = entityViews.entityId;
      const hp = entityViews.hp;
      const posX = entityViews.posX;
      const posY = entityViews.posY;
      const posZ = entityViews.posZ;
      const radiusCollision = entityViews.radiusCollision;
      for (let i = 0; i < count; i++) {
        const slot = slots[i];
        if (slot >= capacity) continue;
        const projectileId = entityIds[slot] as EntityId;
        if (projectileId === bodyExcludeEntityId) continue;
        if (hp[slot] <= 0) continue;
        const boundR = radiusCollision[slot] + halfLineWidth;
        const t = lineSphereIntersectionTWithDelta(
          startX, startY, startZ,
          dx, dy, dz,
          segLen3Sq,
          posX[slot], posY[slot], posZ[slot],
          boundR,
        );
        if (t !== null && (t < bestT || (bestHitIsGround && t === bestT))) {
          bestT = t; found = true;
          bestHitIsGround = false;
          _segHit.t = t;
          _segHit.x = startX + t * dx;
          _segHit.y = startY + t * dy;
          _segHit.z = startZ + t * dz;
          _segHit.entityId = projectileId;
          _segHit.isMirror = false;
          _segHit.normalX = 0; _segHit.normalY = 0; _segHit.normalZ = 0;
          _segHit.panelIndex = -1;
          _segHit.reflectorKind = undefined;
          _segHit.reflectorPlayerId = undefined;
        }
      }
    }

    return found ? _segHit : null;
  }

  // Swept damage from prevPos to currentPos. Normal shots pass radius 0 so
  // their centerline is tested against target hitboxes; D-gun waves pass a
  // positive radius for their authored damage width.
  // PERFORMANCE: Uses spatial grid line query for O(k) instead of O(n)
  // Note: Recoil for traveling projectiles is applied at fire time in fireTurrets(), not here
  private applySweptDamage(source: SweptDamageSource): DamageResult {
    const result = resetResult();
    if (source.maxHits <= 0) return result;

    // Calculate knockback direction (along projectile travel)
    const projDx = source.current.x - source.prev.x;
    const projDy = source.current.y - source.prev.y;
    const projLen = magnitude(projDx, projDy);
    const knockbackDirX = projLen > 0 ? projDx / projLen : 0;
    const knockbackDirY = projLen > 0 ? projDy / projLen : 0;

    // PERFORMANCE: Single line-cell sweep for unit/building body rows.
    // The spatial line query takes a full width and buckets units by
    // center cell, so include the largest known target hitbox radius
    // here. The exact tests below still use each entity's authored
    // hitbox.
    const sweptQueryWidth =
      (source.radius + this.world.getMaxTargetableRadius() + SWEPT_HITBOX_QUERY_EXTRA) * 2;
    const {
      units: nearbyUnits,
      buildings: nearbyBuildings,
      unitSlots: nearbyUnitSlots,
      buildingSlots: nearbyBuildingSlots,
    } = spatialGrid.queryEntitySlotsAlongLine(
        source.prev.x, source.prev.y, source.prev.z,
        source.current.x, source.current.y, source.current.z, sweptQueryWidth,
      );

    // Pack swept-damage candidates. Unit/building bodies and turret
    // sub-hitboxes use the combat-targeting slab; projectile rows stay on
    // the legacy array classifier with live post-integration geometry.
    const sphereInflation = source.radius;
    const aabbInflation = source.radius;
    let segmentRowCount = 0;
    for (let unitIndex = 0; unitIndex < nearbyUnits.length; unitIndex++) {
      const unit = nearbyUnits[unitIndex];
      if (source.excludeEntities.has(unit.id)) continue;
      if (source.excludeCommanders && unit.commander) continue;
      const unitComponent = unit.unit;
      if (unitComponent === null) continue;
      const bodyDamageable = unitComponent.hp > 0;
      if (!bodyDamageable && isConstructionBodyMaterialized(unit)) continue;
      const unitSlot = nearbyUnitSlots[unitIndex];

      if (bodyDamageable) {
        const row = segmentRowCount;
        segmentRowCount = appendSegmentDamageSlabRow(
          segmentRowCount,
          unit.id,
          unit.id,
          true,
          false,
          unitSlot,
          -1,
        );
        if (import.meta.env.DEV) {
          writeSegmentDamageSphereReference(
            row,
            unit.transform.x,
            unit.transform.y,
            unit.transform.z,
            unitComponent.radius.hitbox + sphereInflation,
          );
        }
      }

      const combat = unit.combat;
      if (combat !== null) {
        let unitCS: ReturnType<typeof getTransformCosSin> | undefined;
        let unitGroundZ = 0;
        if (import.meta.env.DEV) {
          unitCS = getTransformCosSin(unit.transform);
          unitGroundZ = getUnitGroundZ(unit);
        }
        for (let i = 0; i < combat.turrets.length; i++) {
          const turret = combat.turrets[i];
          if (turret.id === NO_ENTITY_ID || turret.config.visualOnly) continue;
          const row = segmentRowCount;
          segmentRowCount = appendSegmentDamageSlabRow(
            segmentRowCount,
            turret.id,
            unit.id,
            true,
            false,
            unitSlot,
            i,
          );
          if (import.meta.env.DEV) {
            const mount = resolveWeaponWorldMount(
              unit, turret, i,
              unitCS!.cos, unitCS!.sin,
              {
                currentTick: this.world.getTick(),
                unitGroundZ,
                surfaceN: unitComponent.surfaceNormal,
              },
              _subEntityPoint,
            );
            writeSegmentDamageSphereReference(
              row,
              mount.x,
              mount.y,
              mount.z,
              turret.config.radius.hitbox + sphereInflation,
            );
          }
        }
      }

    }

    for (let buildingIndex = 0; buildingIndex < nearbyBuildings.length; buildingIndex++) {
      const building = nearbyBuildings[buildingIndex];
      if (source.excludeEntities.has(building.id)) continue;
      if (!building.building || building.building.hp <= 0) continue;

      const row = segmentRowCount;
      segmentRowCount = appendSegmentDamageSlabRow(
        segmentRowCount,
        building.id,
        building.id,
        false,
        true,
        nearbyBuildingSlots[buildingIndex],
        -1,
      );
      if (import.meta.env.DEV) {
        writeSegmentDamageBoxReference(
          row,
          building.transform.x,
          building.transform.y,
          getBuildingCombatCenterZ(building),
          building.building.width / 2 + aabbInflation,
          building.building.height / 2 + aabbInflation,
          building.building.depth / 2 + aabbInflation,
        );
      }
    }

    const slabRowCount = segmentRowCount;
    // Slot-native projectile rows: a 'projectile' type code implies a
    // travelling shot emission (plasma/rocket/missile) — projectileType
    // is derived from the emission kind at spawn, so the old
    // isProjectileShot(config.shot) re-check is equivalent. Slab
    // radiusCollision mirrors shotProfile.runtime.radius.collision.
    // Queried here (not earlier) because the slot result is a live view
    // over the shared query scratch — consume before any other query.
    const nearbyProjectileSlots = spatialGrid.queryProjectileSlotsAlongLine(
      source.prev.x, source.prev.y, source.prev.z,
      source.current.x, source.current.y, source.current.z, sweptQueryWidth,
    );
    const projectileViews = entitySlotRegistry.getViews();
    if (projectileViews !== null) {
      const slots = nearbyProjectileSlots.slots;
      const count = nearbyProjectileSlots.count;
      for (let i = 0; i < count; i++) {
        const slot = slots[i];
        if (slot >= projectileViews.capacity) continue;
        if (projectileViews.projectileTypeCode[slot] !== PROJECTILE_TYPE_PROJECTILE) continue;
        if (projectileViews.hp[slot] <= 0) continue;
        const projectileId = projectileViews.entityId[slot] as EntityId;
        if (source.excludeEntities.has(projectileId)) continue;
        segmentRowCount = appendSegmentDamageSphereRow(
          segmentRowCount,
          projectileId,
          projectileId,
          false,
          true,
          projectileViews.posX[slot],
          projectileViews.posY[slot],
          projectileViews.posZ[slot],
          projectileViews.radiusCollision[slot] + sphereInflation,
        );
      }
    }

    classifySegmentDamageRowsMixed(
      slabRowCount,
      segmentRowCount,
      source.prev.x, source.prev.y, source.prev.z,
      source.current.x, source.current.y, source.current.z,
      sphereInflation,
      aabbInflation,
    );

    const sourceVelocity = source.velocity;
    const projMass = (source.projectileMass ?? 0) * PROJECTILE_MASS_MULTIPLIER;
    const projSpeed = sourceVelocity === undefined
      ? 0
      : magnitude(sourceVelocity.x, sourceVelocity.y);
    const force = projMass * projSpeed;
    const forceX = knockbackDirX * force;
    const forceY = knockbackDirY * force;
    const attackerVelX = sourceVelocity === undefined
      ? knockbackDirX * source.damage
      : sourceVelocity.x;
    const attackerVelY = sourceVelocity === undefined
      ? knockbackDirY * source.damage
      : sourceVelocity.y;

    if (source.maxHits === 1) {
      let bestRow = -1;
      let bestT = Infinity;
      let bestEntity: Entity | undefined;
      for (let row = 0; row < segmentRowCount; row++) {
        if ((_segmentDamageOutFlags[row] & DAMAGE_SEGMENT_HIT_FLAG_HIT) === 0) continue;
        const t = _segmentDamageOutT[row];
        if (t >= bestT) continue;
        const entityId = _segmentDamageEntityIds[row];
        const hostEntityId = _segmentDamageHostEntityIds[row];
        const entity = this.world.getEntity(hostEntityId !== entityId ? hostEntityId : entityId);
        if (!entity) continue;
        bestRow = row;
        bestT = t;
        bestEntity = entity;
      }

      if (bestRow >= 0 && bestEntity !== undefined) {
        this.applySweptDamageHit(
          source,
          result,
          bestEntity,
          bestT,
          _segmentDamageIsUnit[bestRow] !== 0,
          knockbackDirX,
          knockbackDirY,
          projMass,
          forceX,
          forceY,
          attackerVelX,
          attackerVelY,
        );
      }
      this.flushDamageBatch(result, source.sourceEntityId);
      return result;
    }

    _reusableHits.length = 0;
    const hits = _reusableHits;
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

      this.applySweptDamageHit(
        source,
        result,
        entity,
        hit.t,
        hit.isUnit,
        knockbackDirX,
        knockbackDirY,
        projMass,
        forceX,
        forceY,
        attackerVelX,
        attackerVelY,
      );
      hitCount++;
    }

    this.flushDamageBatch(result, source.sourceEntityId);
    return result;
  }

  private applySweptDamageHit(
    source: SweptDamageSource,
    result: DamageResult,
    entity: Entity,
    hitT: number,
    isUnit: boolean,
    knockbackDirX: number,
    knockbackDirY: number,
    projMass: number,
    forceX: number,
    forceY: number,
    attackerVelX: number,
    attackerVelY: number,
  ): void {
    // Calculate hit point using T value along projectile path.
    const hitX = source.prev.x + hitT * (source.current.x - source.prev.x);
    const hitY = source.prev.y + hitT * (source.current.y - source.prev.y);

    // Calculate penetration direction: from hit point through unit center.
    const penDirX = entity.transform.x - hitX;
    const penDirY = entity.transform.y - hitY;
    const penMag = magnitude(penDirX, penDirY);
    const penNormX = penMag > 0 ? penDirX / penMag : knockbackDirX;
    const penNormY = penMag > 0 ? penDirY / penMag : knockbackDirY;

    this.queueDamageToEntityBatch(entity, source.damage, result, source.sourceEntityId, {
      penetrationDir: { x: penNormX, y: penNormY },
      attackerVel: { x: attackerVelX, y: attackerVelY },
      attackMagnitude: source.damage,
    });
    if (result.truncationT === null) {
      result.truncationT = hitT;
    }
    result.hitEntityIds.push(entity.id);

    // Add knockback for units (buildings don't get pushed).
    if (isUnit && projMass > 0) {
      pushKnockback(result, entity.id, forceX, forceY);
    }
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
    const nearby = spatialGrid.queryUnitBuildingSlotRangesInRadius(
      source.center.x, source.center.y, source.center.z, source.radius + 100,
    );
    const nearbySlots = nearby.slots;
    const nearbyUnitStart = nearby.unitStart;
    const nearbyUnitEnd = nearbyUnitStart + nearby.unitCount;
    const nearbyBuildingStart = nearby.buildingStart;
    const nearbyBuildingCount = nearby.buildingCount;
    ensureAreaBuildingSlotScratchCapacity(nearbyBuildingCount);
    for (let i = 0; i < nearbyBuildingCount; i++) {
      _areaBuildingSlotScratch[i] = nearbySlots[nearbyBuildingStart + i];
    }
    const entityViews = entitySlotRegistry.getViews();

    // Check units. Rust owns the full 3D sphere-vs-sphere overlap and
    // optional slice-cone filter; TypeScript keeps entity graph write-back,
    // turret sub-hitbox fallback, and event/death side effects.
    ensureAreaDamageCapacity(nearby.unitCount);
    let areaRowCount = 0;
    if (entityViews !== null) {
      const entityIds = entityViews.entityId;
      const flags = entityViews.flags;
      const capacity = entityViews.capacity;
      for (let unitIndex = nearbyUnitStart; unitIndex < nearbyUnitEnd; unitIndex++) {
        const slot = nearbySlots[unitIndex];
        if (slot >= capacity) continue;
        const unitId = entityIds[slot] as EntityId;
        if (unitId < 0 || source.excludeEntities.has(unitId)) continue;
        if ((flags[slot] & ENTITY_SLOT_FLAG_HAS_UNIT) === 0) continue;

        let unit: Entity | undefined;
        if (source.excludeCommanders || import.meta.env.DEV) {
          unit = entitySlotRegistry.resolveSlot(slot);
          const unitComponent = unit?.unit;
          if (
            unit === undefined ||
            unitComponent === undefined ||
            unitComponent === null ||
            (source.excludeCommanders && unit.commander)
          ) {
            continue;
          }
        }

        const row = areaRowCount++;
        _areaDamageEntities[row] = unit;
        // Slab path: pack the combat-targeting slot; Rust reads pos + hitbox
        // radius from the slab. Units don't move between the once-per-tick
        // stamp and damage, so the slab geometry is coherent here.
        _areaDamageSlots[row] = slot;
        if (import.meta.env.DEV) {
          const unitComponent = unit!.unit!;
          _areaDamageEnabled[row] = 1;
          _areaDamageTargetKind[row] = DAMAGE_TARGET_KIND_UNIT;
          _areaDamageTargetX[row] = unit!.transform.x;
          _areaDamageTargetY[row] = unit!.transform.y;
          _areaDamageTargetZ[row] = unit!.transform.z;
          _areaDamageTargetRadius[row] = unitComponent.radius.hitbox;
          _areaDamageBoxHalfX[row] = 0;
          _areaDamageBoxHalfY[row] = 0;
          _areaDamageBoxHalfZ[row] = 0;
        }
      }
    }
    classifyAreaDamageRowsViaSlab(source, areaRowCount, hasSlice, sliceHalfAngle);
    let areaTurretRowCount = 0;
    for (let row = 0; row < areaRowCount; row++) {
      _areaDamageTurretStart[row] = -1;
      _areaDamageTurretEnd[row] = -1;
      const rowFlags = _areaDamageOutFlags[row];
      if ((rowFlags & DAMAGE_AREA_FLAG_SLICE_PASS) === 0) continue;
      const slot = _areaDamageSlots[row];
      const bodyOverlaps =
        entityViews !== null &&
        slot < entityViews.capacity &&
        entityViews.hp[slot] > 0 &&
        (rowFlags & DAMAGE_AREA_FLAG_OVERLAP) !== 0;
      if (bodyOverlaps) continue;

      const unit = _areaDamageEntities[row] ?? entitySlotRegistry.resolveSlot(slot);
      const unitComponent = unit?.unit;
      if (unit === undefined || unitComponent === undefined || unitComponent === null) continue;
      _areaDamageEntities[row] = unit;

      const combat = unit.combat;
      if (combat !== null) {
        const fallbackStart = areaTurretRowCount;
        let unitCS: ReturnType<typeof getTransformCosSin> | undefined;
        let unitGroundZ = 0;
        if (import.meta.env.DEV) {
          unitCS = getTransformCosSin(unit.transform);
          unitGroundZ = getUnitGroundZ(unit);
        }
        for (let i = 0; i < combat.turrets.length; i++) {
          const turret = combat.turrets[i];
          if (turret.id === NO_ENTITY_ID || turret.config.visualOnly) continue;
          ensureAreaTurretDamageCapacity(areaTurretRowCount + 1);
          const turretRow = areaTurretRowCount++;
          _areaTurretDamageSlots[turretRow] = _areaDamageSlots[row];
          _areaTurretDamageTurretIndices[turretRow] = i;
          if (import.meta.env.DEV) {
            _areaTurretDamageRefFlags[turretRow] = 0;
            const mount = resolveWeaponWorldMount(
              unit, turret, i,
              unitCS!.cos, unitCS!.sin,
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
            if (tx * tx + ty * ty + tz * tz <= turretMaxDist * turretMaxDist) {
              _areaTurretDamageRefFlags[turretRow] = DAMAGE_AREA_FLAG_OVERLAP;
            }
          }
        }
        if (areaTurretRowCount > fallbackStart) {
          _areaDamageTurretStart[row] = fallbackStart;
          _areaDamageTurretEnd[row] = areaTurretRowCount;
        }
      }
    }
    classifyAreaTurretDamageRows(source, areaTurretRowCount);
    for (let row = 0; row < areaRowCount; row++) {
      const rowFlags = _areaDamageOutFlags[row];
      if ((rowFlags & DAMAGE_AREA_FLAG_SLICE_PASS) === 0) continue;
      const slot = _areaDamageSlots[row];
      const bodyOverlaps =
        entityViews !== null &&
        slot < entityViews.capacity &&
        entityViews.hp[slot] > 0 &&
        (rowFlags & DAMAGE_AREA_FLAG_OVERLAP) !== 0;
      const fallbackStart = _areaDamageTurretStart[row];
      const fallbackEnd = _areaDamageTurretEnd[row];
      if (
        !bodyOverlaps &&
        (fallbackStart < 0 || fallbackStart >= fallbackEnd)
      ) {
        continue;
      }

      const unit = _areaDamageEntities[row] ?? entitySlotRegistry.resolveSlot(slot);
      const unitComponent = unit?.unit;
      if (unit === undefined || unitComponent === undefined || unitComponent === null) continue;
      const liveBodyOverlaps =
        unitComponent.hp > 0 && (rowFlags & DAMAGE_AREA_FLAG_OVERLAP) !== 0;
      if (
        !liveBodyOverlaps &&
        (fallbackStart < 0 || fallbackStart >= fallbackEnd)
      ) {
        continue;
      }
      _areaDamageEntities[row] = unit;

      const damage = source.damage;
      const dirX = _areaDamageOutDirX[row];
      const dirY = _areaDamageOutDirY[row];
      const dirZ = _areaDamageOutDirZ[row];
      const force = source.knockbackForce ?? (damage * KNOCKBACK.SPLASH);
      const forceX = dirX * force;
      const forceY = dirY * force;
      const forceZ = dirZ * force;

      if (liveBodyOverlaps) {
        // For area damage, penetration direction is from explosion center
        // through unit (same as knockback direction - outward from center).
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
        continue;
      }

      for (let turretRow = fallbackStart; turretRow < fallbackEnd; turretRow++) {
        if ((_areaTurretDamageOutFlags[turretRow] & DAMAGE_AREA_FLAG_OVERLAP) === 0) continue;
        this.queueDamageToEntityBatch(unit, damage, result, source.sourceEntityId, {
          penetrationDir: { x: dirX, y: dirY },
          attackerVel: { x: forceX, y: forceY },
          attackMagnitude: damage,
        });
        result.hitEntityIds.push(unit.id);
      }
    }
    clearAreaDamageEntities(areaRowCount);

    // Travelling shots are small damageable bodies. Sustained beams
    // and shields are not inserted as projectile-type bodies, so this
    // only lets weapons chip down real munitions.
    const nearbyProjectileSlots = spatialGrid.queryEnemyProjectileSlotsInRadius(
      source.center.x, source.center.y, source.center.z, source.radius + 100, source.ownerId,
    );
    ensureAreaDamageCapacity(nearbyProjectileSlots.count);
    areaRowCount = 0;
    const projectileSlots = nearbyProjectileSlots.slots;
    if (entityViews !== null) {
      for (let projectileIndex = 0; projectileIndex < nearbyProjectileSlots.count; projectileIndex++) {
        const slot = projectileSlots[projectileIndex];
        if (slot >= entityViews.capacity) continue;
        const projectileId = entityViews.entityId[slot] as EntityId;
        if (source.excludeEntities.has(projectileId)) continue;
        if (entityViews.hp[slot] <= 0) continue;

        const row = areaRowCount++;
        _areaDamageEntities[row] = undefined;
        _areaDamageSlots[row] = slot;
        _areaDamageEnabled[row] = 1;
        _areaDamageTargetKind[row] = DAMAGE_TARGET_KIND_PROJECTILE;
        _areaDamageTargetX[row] = entityViews.posX[slot];
        _areaDamageTargetY[row] = entityViews.posY[slot];
        _areaDamageTargetZ[row] = entityViews.posZ[slot];
        _areaDamageTargetRadius[row] = entityViews.radiusCollision[slot];
        _areaDamageBoxHalfX[row] = 0;
        _areaDamageBoxHalfY[row] = 0;
        _areaDamageBoxHalfZ[row] = 0;
        if (import.meta.env.DEV) {
          const projectile = entitySlotRegistry.resolveSlot(slot);
          const proj = projectile?.projectile ?? null;
          if (
            projectile === undefined ||
            proj === null ||
            proj.projectileType !== 'projectile' ||
            proj.hp <= 0 ||
            !isProjectileShot(proj.config.shot)
          ) {
            areaRowCount--;
            continue;
          }
          _areaDamageEntities[row] = projectile;
        }
      }
    }
    // No JS fallback when the slab views are unavailable: the sim
    // cannot run without wasm, so rows only ever populate through the
    // slot-native branch above.
    classifyAreaDamageRows(source, areaRowCount, false, Math.PI);
    for (let row = 0; row < areaRowCount; row++) {
      if ((_areaDamageOutFlags[row] & DAMAGE_AREA_FLAG_OVERLAP) === 0) continue;
      const projectile = entitySlotRegistry.resolveSlot(_areaDamageSlots[row]);
      const proj = projectile?.projectile ?? null;
      if (
        projectile === undefined ||
        proj === null ||
        proj.projectileType !== 'projectile' ||
        proj.hp <= 0 ||
        !isProjectileShot(proj.config.shot)
      ) {
        continue;
      }

      this.queueDamageToEntityBatch(projectile, source.damage, result, source.sourceEntityId);
      result.hitEntityIds.push(projectile.id);
    }
    clearAreaDamageEntities(areaRowCount);

    // Check buildings — full 3D. Buildings are axis-aligned combat boxes
    // (width × height × depth). Rust owns the sphere-vs-AABB overlap and
    // horizontal slice filter.
    ensureAreaDamageCapacity(nearbyBuildingCount);
    areaRowCount = 0;
    if (entityViews !== null) {
      const entityIds = entityViews.entityId;
      const flags = entityViews.flags;
      const hp = entityViews.hp;
      const capacity = entityViews.capacity;
      for (let buildingIndex = 0; buildingIndex < nearbyBuildingCount; buildingIndex++) {
        const slot = _areaBuildingSlotScratch[buildingIndex];
        if (slot >= capacity) continue;
        const buildingId = entityIds[slot] as EntityId;
        if (buildingId < 0 || source.excludeEntities.has(buildingId)) continue;
        if ((flags[slot] & ENTITY_SLOT_FLAG_HAS_BUILDING) === 0 || hp[slot] <= 0) continue;

        let building: Entity | undefined;
        if (import.meta.env.DEV) {
          building = entitySlotRegistry.resolveSlot(slot);
          const buildingComponent = building?.building;
          if (
            building === undefined ||
            buildingComponent === undefined ||
            buildingComponent === null ||
            buildingComponent.hp <= 0
          ) {
            continue;
          }
        }

        const row = areaRowCount++;
        _areaDamageEntities[row] = building;
        // Slab path: buildings are static, so their stamped slab geometry
        // (targetRadius in entity_radius_hitbox + AABB half-extents) is always
        // coherent at damage time.
        _areaDamageSlots[row] = slot;
        if (import.meta.env.DEV) {
          const buildingComponent = building!.building!;
          _areaDamageEnabled[row] = 1;
          _areaDamageTargetKind[row] = DAMAGE_TARGET_KIND_BUILDING;
          _areaDamageTargetX[row] = building!.transform.x;
          _areaDamageTargetY[row] = building!.transform.y;
          _areaDamageTargetZ[row] = getBuildingCombatCenterZ(building!);
          _areaDamageTargetRadius[row] = getTargetRadius(building!);
          _areaDamageBoxHalfX[row] = buildingComponent.width / 2;
          _areaDamageBoxHalfY[row] = buildingComponent.height / 2;
          _areaDamageBoxHalfZ[row] = buildingComponent.depth / 2;
        }
      }
    }
    classifyAreaDamageRowsViaSlab(source, areaRowCount, hasSlice, sliceHalfAngle);
    for (let row = 0; row < areaRowCount; row++) {
      const rowFlags = _areaDamageOutFlags[row];
      if (
        (rowFlags & DAMAGE_AREA_FLAG_OVERLAP) === 0 ||
        (rowFlags & DAMAGE_AREA_FLAG_SLICE_PASS) === 0
      ) {
        continue;
      }
      const building = _areaDamageEntities[row] ?? entitySlotRegistry.resolveSlot(_areaDamageSlots[row]);
      const buildingComponent = building?.building;
      if (
        building === undefined ||
        buildingComponent === undefined ||
        buildingComponent === null ||
        buildingComponent.hp <= 0 ||
        source.excludeEntities.has(building.id)
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

  applyDeathExplosionDamage(source: AreaDamageSource): DamageResult {
    const result = resetResult();
    const rowCount = classifyDeathExplosionDamageRows(source);

    // Unit/body rows and unit turret-fallback rows. Rust owns the
    // broadphase + slab geometry; TS resolves compact slots to live
    // entities and applies HP through the shared batch.
    for (let row = 0; row < rowCount; row++) {
      if (_deathExplosionDamageTargetKind[row] !== DAMAGE_TARGET_KIND_UNIT) continue;
      const unit = spatialGrid.resolveSlot(_deathExplosionDamageSlots[row]);
      const unitComponent = unit?.unit;
      if (
        unit === undefined ||
        unitComponent === undefined ||
        unitComponent === null ||
        unitComponent.hp <= 0 ||
        source.excludeEntities.has(unit.id) ||
        (source.excludeCommanders && unit.commander)
      ) {
        continue;
      }

      const damage = source.damage;
      const dirX = _deathExplosionDamageOutDirX[row];
      const dirY = _deathExplosionDamageOutDirY[row];
      const dirZ = _deathExplosionDamageOutDirZ[row];
      const force = source.knockbackForce ?? (damage * KNOCKBACK.SPLASH);
      const forceX = dirX * force;
      const forceY = dirY * force;
      const forceZ = dirZ * force;
      this.queueDamageToEntityBatch(unit, damage, result, source.sourceEntityId, {
        penetrationDir: { x: dirX, y: dirY },
        attackerVel: { x: forceX, y: forceY },
        attackMagnitude: damage,
      });
      result.hitEntityIds.push(unit.id);

      if (
        (_deathExplosionDamageOutFlags[row] & DAMAGE_DEATH_EXPLOSION_ROW_FLAG_BODY_HIT) !== 0 &&
        force > 0 &&
        _deathExplosionDamageOutDistance[row] > 0
      ) {
        pushKnockback(result, unit.id, forceX, forceY, forceZ);
      }
    }

    // Travelling shots remain live-geometry rows by design: their
    // post-integration position is authoritative after movement, while
    // the combat slab is a once-per-tick targeting snapshot.
    const nearbyProjectiles = spatialGrid.queryEnemyProjectilesInRadius(
      source.center.x, source.center.y, source.center.z, source.radius + 100, source.ownerId,
    );
    ensureAreaDamageCapacity(nearbyProjectiles.length);
    let projectileRowCount = 0;
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

      const row = projectileRowCount++;
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
    classifyAreaDamageRows(source, projectileRowCount, false, Math.PI);
    for (let row = 0; row < projectileRowCount; row++) {
      const projectile = _areaDamageEntities[row];
      if (
        projectile === undefined ||
        (_areaDamageOutFlags[row] & DAMAGE_AREA_FLAG_OVERLAP) === 0
      ) {
        continue;
      }
      this.queueDamageToEntityBatch(projectile, source.damage, result, source.sourceEntityId);
      result.hitEntityIds.push(projectile.id);
    }
    clearAreaDamageEntities(projectileRowCount);

    for (let row = 0; row < rowCount; row++) {
      if (_deathExplosionDamageTargetKind[row] !== DAMAGE_TARGET_KIND_BUILDING) continue;
      const building = spatialGrid.resolveSlot(_deathExplosionDamageSlots[row]);
      const buildingComponent = building?.building;
      if (
        building === undefined ||
        buildingComponent === undefined ||
        buildingComponent === null ||
        buildingComponent.hp <= 0 ||
        source.excludeEntities.has(building.id)
      ) {
        continue;
      }

      const damage = source.damage;
      const dirX = _deathExplosionDamageOutDirX[row];
      const dirY = _deathExplosionDamageOutDirY[row];
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
      ownership !== null ? ownership.playerId : null,
    );
  }
}
