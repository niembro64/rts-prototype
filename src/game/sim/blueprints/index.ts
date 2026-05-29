/**
 * Blueprint System — Re-exports + derived config builders
 */

export * from './types';
export * from './shots';
export * from './turrets';
export * from './locomotion';
export * from './unitRoster';
export * from './units';
export * from './buildings';
export * from './fallbacks';

import type {
  BeamShot,
  ForceFieldBarrierConfig,
  ForceShot,
  LaserShot,
  ActiveProjectileShot,
  ProjectileShot,
  ShotConfig,
  TurretConfig,
} from '../types';
import { isProjectileShot } from '../types';
import { isLineShotBlueprint } from '@/types/blueprints';
import type { ShotId, TurretId } from '../../../types/blueprintIds';
import { SHOT_BLUEPRINTS } from './shots';
import { TURRET_BLUEPRINTS } from './turrets';
import { UNIT_BLUEPRINTS, resolveUnitTurretMounts } from './units';
import { BUILDING_BLUEPRINTS } from './buildings';
import type {
  ShotBlueprint,
  ForceFieldBarrierRatioConfig,
  LockOnExclusionObject,
  TurretBlueprint,
} from './types';
import {
  buildingTypeToCode,
  codeToBuildingType,
  codeToShotId,
  codeToTurretId,
  codeToUnitType,
  getNetworkBuildingTypeIds,
  getNetworkShotIds,
  getNetworkTurretIds,
  getNetworkUnitTypeIds,
  shotIdToCode,
  turretIdToCode,
  unitTypeToCode,
  BUILDING_TYPE_UNKNOWN,
  SHOT_ID_UNKNOWN,
  TURRET_ID_UNKNOWN,
  UNIT_TYPE_UNKNOWN,
} from '../../../types/network';

// LOCK-ON-03 — Compile per-turret lock-on exclusion bitmasks. Reads
// the authored exclusion strings on the blueprint, resolves level-1
// blueprint names through the network wire-code helpers, and packs
// everything into the numeric fields the targeting slab consumes.
import {
  CT_LOCK_ON_REL_EXCLUDE_ENEMY,
  CT_LOCK_ON_REL_EXCLUDE_FRIENDLY,
  CT_LOCK_ON_FAM_EXCLUDE_BUILDINGS,
  CT_LOCK_ON_FAM_EXCLUDE_TOWERS,
  CT_LOCK_ON_FAM_EXCLUDE_UNITS,
  CT_LOCK_ON_FAM_EXCLUDE_TURRETS,
  CT_LOCK_ON_LEVEL1_MASK_CAPACITY,
} from '../../sim-wasm/init';
import { isTowerBuildingType, type BuildingType } from '../../../types/buildingTypes';

export type LockOnMasks = {
  relationship: number;
  entityFamily: number;
  building: number;
  tower: number;
  unit: number;
  turret: number;
};

function lockOnLevel1Mask(
  label: string,
  field: string,
  names: readonly string[],
  toCode: (s: string) => number,
  unknownCode: number,
  kindLabel: string,
): number {
  let mask = 0;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const code = toCode(name);
    if (code === unknownCode) {
      throw new Error(
        `Invalid ${label}: ${field}[${i}] = "${name}" has no network ${kindLabel} code`,
      );
    }
    if (code >= CT_LOCK_ON_LEVEL1_MASK_CAPACITY) {
      throw new Error(
        `Invalid ${label}: ${field}[${i}] = "${name}" has ${kindLabel} wire code ${code} >= bitmask capacity ${CT_LOCK_ON_LEVEL1_MASK_CAPACITY}; widen the lockon level-1 masks before adding more ${kindLabel} blueprints`,
      );
    }
    mask |= 1 << code;
  }
  return mask >>> 0;
}

function compileLockOnMasks(label: string, policy: LockOnExclusionObject): LockOnMasks {
  let relationship = 0;
  for (const r of policy.excludeLockOnLevel0FriendsAndEnemies) {
    if (r === 'friendly_entities') relationship |= CT_LOCK_ON_REL_EXCLUDE_FRIENDLY;
    else if (r === 'enemy_entities') relationship |= CT_LOCK_ON_REL_EXCLUDE_ENEMY;
    else {
      throw new Error(
        `Invalid ${label}: excludeLockOnLevel0FriendsAndEnemies entry "${r}" is not a known relationship`,
      );
    }
  }
  let entityFamily = 0;
  for (const f of policy.excludeLockOnLevel0Entities) {
    if (f === 'buildings') entityFamily |= CT_LOCK_ON_FAM_EXCLUDE_BUILDINGS;
    else if (f === 'towers') entityFamily |= CT_LOCK_ON_FAM_EXCLUDE_TOWERS;
    else if (f === 'units') entityFamily |= CT_LOCK_ON_FAM_EXCLUDE_UNITS;
    else if (f === 'turrets') entityFamily |= CT_LOCK_ON_FAM_EXCLUDE_TURRETS;
    else {
      throw new Error(
        `Invalid ${label}: excludeLockOnLevel0Entities entry "${f}" is not a known family`,
      );
    }
  }
  const building = lockOnLevel1Mask(
    label,
    'excludeLockOnLevel1Buildings',
    policy.excludeLockOnLevel1Buildings,
    buildingTypeToCode,
    BUILDING_TYPE_UNKNOWN,
    'building',
  );
  // Towers share the static-structure wire-code space with buildings,
  // so the level-1 tower mask uses the same wire-code lookup. The
  // Rust kernel reads tower vs. building from the candidate's
  // entity_family and consults the appropriate mask.
  const tower = lockOnLevel1Mask(
    label,
    'excludeLockOnLevel1Towers',
    policy.excludeLockOnLevel1Towers,
    buildingTypeToCode,
    BUILDING_TYPE_UNKNOWN,
    'tower',
  );
  const unit = lockOnLevel1Mask(
    label,
    'excludeLockOnLevel1Units',
    policy.excludeLockOnLevel1Units,
    unitTypeToCode,
    UNIT_TYPE_UNKNOWN,
    'unit',
  );
  const turret = lockOnLevel1Mask(
    label,
    'excludeLockOnLevel1Turrets',
    policy.excludeLockOnLevel1Turrets,
    turretIdToCode,
    TURRET_ID_UNKNOWN,
    'turret',
  );
  return { relationship, entityFamily, building, tower, unit, turret };
}

function compileTurretLockOnMasks(turretBlueprint: TurretBlueprint): LockOnMasks {
  return compileLockOnMasks(`turret blueprint ${turretBlueprint.id}`, turretBlueprint);
}

export const EMPTY_LOCK_ON_MASKS: LockOnMasks = Object.freeze({
  relationship: 0,
  entityFamily: 0,
  building: 0,
  tower: 0,
  unit: 0,
  turret: 0,
});

export const UNIT_HOST_LOCK_ON_MASKS: Record<string, LockOnMasks> =
  Object.fromEntries(
    Object.entries(UNIT_BLUEPRINTS).map(([id, blueprint]) => [
      id,
      compileLockOnMasks(`unit blueprint ${id}`, blueprint),
    ]),
  );

export const TOWER_HOST_LOCK_ON_MASKS: Partial<Record<BuildingType, LockOnMasks>> =
  Object.fromEntries(
    Object.entries(BUILDING_BLUEPRINTS)
      .filter(([id]) => isTowerBuildingType(id as BuildingType))
      .map(([id, blueprint]) => [
        id as BuildingType,
        compileLockOnMasks(
          `tower blueprint ${id}`,
          blueprint as typeof blueprint & LockOnExclusionObject,
        ),
      ]),
  );

export function getUnitHostLockOnMasks(unitType: string): LockOnMasks {
  return UNIT_HOST_LOCK_ON_MASKS[unitType] ?? EMPTY_LOCK_ON_MASKS;
}

export function getTowerHostLockOnMasks(buildingType: BuildingType): LockOnMasks {
  return TOWER_HOST_LOCK_ON_MASKS[buildingType] ?? EMPTY_LOCK_ON_MASKS;
}

function validateStableWireIds(
  label: string,
  blueprintIds: readonly string[],
  wireIds: readonly string[],
  toCode: (id: string) => number,
  fromCode: (code: number) => string | null,
  unknownCode: number,
): void {
  const blueprintSet = new Set(blueprintIds);
  const seenWireIds = new Set<string>();

  for (let code = 0; code < wireIds.length; code++) {
    const id = wireIds[code];
    if (seenWireIds.has(id)) {
      throw new Error(`Duplicate ${label} network wire id '${id}'`);
    }
    seenWireIds.add(id);
    if (!blueprintSet.has(id)) {
      throw new Error(
        `Stale ${label} network wire id '${id}' has no matching blueprint`,
      );
    }
    const encoded = toCode(id);
    if (
      encoded === unknownCode ||
      encoded !== code ||
      fromCode(encoded) !== id
    ) {
      throw new Error(
        `Invalid ${label} network wire mapping for '${id}': expected code ${code}, got ${encoded}`,
      );
    }
  }

  for (const id of blueprintIds) {
    if (!seenWireIds.has(id)) {
      throw new Error(`Missing ${label} network wire id for blueprint '${id}'`);
    }
  }
}

validateStableWireIds(
  'unit',
  Object.keys(UNIT_BLUEPRINTS),
  getNetworkUnitTypeIds(),
  unitTypeToCode,
  codeToUnitType,
  UNIT_TYPE_UNKNOWN,
);

validateStableWireIds(
  'building',
  Object.keys(BUILDING_BLUEPRINTS),
  getNetworkBuildingTypeIds(),
  buildingTypeToCode,
  codeToBuildingType,
  BUILDING_TYPE_UNKNOWN,
);

validateStableWireIds(
  'shot',
  Object.keys(SHOT_BLUEPRINTS),
  getNetworkShotIds(),
  shotIdToCode,
  codeToShotId,
  SHOT_ID_UNKNOWN,
);

validateStableWireIds(
  'turret',
  Object.keys(TURRET_BLUEPRINTS),
  getNetworkTurretIds(),
  turretIdToCode,
  codeToTurretId,
  TURRET_ID_UNKNOWN,
);

resolveUnitTurretMounts((turretId) => {
  const turretBlueprint = TURRET_BLUEPRINTS[turretId];
  if (!turretBlueprint) {
    throw new Error(
      `Invalid unit turret mount resolver: unknown turretId "${turretId}"`,
    );
  }
  return turretBlueprint.radius.body;
});

function assertFiniteRangeMultiplier(
  turretId: string,
  path: string,
  value: number,
): void {
  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid turret range multiplier for ${turretId}: ${path} must be finite, got ${value}`,
    );
  }
}

function validateTurretRangeMultipliers(
  turretId: string,
  ranges: TurretBlueprint['rangeMultiplierOverrides'],
): void {
  const max = ranges.engageRangeMax;
  const min = ranges.engageRangeMin;
  const tracking = ranges.trackingRange;

  assertFiniteRangeMultiplier(turretId, 'engageRangeMax.acquire', max.acquire);
  assertFiniteRangeMultiplier(turretId, 'engageRangeMax.release', max.release);

  if (max.release <= max.acquire) {
    throw new Error(
      `Invalid turret range multipliers for ${turretId}: engageRangeMax.release (${max.release}) must be greater than engageRangeMax.acquire (${max.acquire})`,
    );
  }

  // engageRangeMin is `null` when the turret has no soft inner target
  // preference. When set, both edges must be finite and acquire must be
  // farther out than release so target preference doesn't flicker when
  // enemies sit on the inner boundary.
  if (min) {
    assertFiniteRangeMultiplier(
      turretId,
      'engageRangeMin.acquire',
      min.acquire,
    );
    assertFiniteRangeMultiplier(
      turretId,
      'engageRangeMin.release',
      min.release,
    );
    if (min.acquire <= min.release) {
      throw new Error(
        `Invalid turret range multipliers for ${turretId}: engageRangeMin.acquire (${min.acquire}) must be greater than engageRangeMin.release (${min.release})`,
      );
    }
  }

  // trackingRange is `null` when the turret only ever cares about its
  // fire envelope (acquires + engages on contact). When set, the
  // tracking shell MUST sit strictly outside engageRangeMax — its
  // whole purpose is pre-rotation toward enemies that aren't yet in
  // fire range.
  if (tracking) {
    assertFiniteRangeMultiplier(
      turretId,
      'trackingRange.acquire',
      tracking.acquire,
    );
    assertFiniteRangeMultiplier(
      turretId,
      'trackingRange.release',
      tracking.release,
    );
    if (tracking.release <= tracking.acquire) {
      throw new Error(
        `Invalid turret range multipliers for ${turretId}: trackingRange.release (${tracking.release}) must be greater than trackingRange.acquire (${tracking.acquire})`,
      );
    }
    if (tracking.acquire <= max.acquire) {
      throw new Error(
        `Invalid turret range multipliers for ${turretId}: trackingRange.acquire (${tracking.acquire}) must sit OUTSIDE engageRangeMax.acquire (${max.acquire})`,
      );
    }
    if (tracking.release <= max.release) {
      throw new Error(
        `Invalid turret range multipliers for ${turretId}: trackingRange.release (${tracking.release}) must sit OUTSIDE engageRangeMax.release (${max.release})`,
      );
    }
  }
}

function validateTurretAimStyle(
  turretId: string,
  turretBlueprint: TurretBlueprint,
  shot: ShotConfig | null,
): void {
  switch (turretBlueprint.aimStyle.angleType) {
    case 'ballisticArcLow':
    case 'ballisticArcLowOnlyUnder':
    case 'ballisticArcHigh':
      if (!shot || !isProjectileShot(shot)) {
        throw new Error(
          `Turret ${turretId} uses aimStyle.angleType "${turretBlueprint.aimStyle.angleType}" without a plasma/rocket shot`,
        );
      }
      return;
    case 'rayBisectTurretAndBody':
      if (turretBlueprint.aimStyle.lockOnType !== 'lockOnToTurret') {
        throw new Error(
          `Turret ${turretId} uses aimStyle.angleType "rayBisectTurretAndBody" without lockOnType "lockOnToTurret"`,
        );
      }
      return;
    case 'rayDirect':
      return;
  }
}

/** Compute a ForceFieldBarrierConfig from ratio-based blueprint data and weapon range. */
function computeBarrierConfig(
  barrier: ForceFieldBarrierRatioConfig | null,
  range: number,
): ForceFieldBarrierConfig | null {
  if (!barrier) return null;
  const outerRange =
    barrier.rimWidth != null
      ? barrier.rimWidth
      : range * (barrier.outerRatio ?? 1);
  const originOffsetZ = outerRange * (barrier.originOffsetRadiusRatio ?? 0);
  return {
    innerRange: 0,
    outerRange,
    originOffsetZ,
    color: barrier.color,
    alpha: barrier.alpha,
    particleAlpha: barrier.particleAlpha,
  };
}

/** Build a ShotConfig from a ShotBlueprint + turret blueprint data.
 *
 *  `homingTurnRate` lives on the SHOT BLUEPRINT (it's a property of
 *  the rocket, not the turret), so it doesn't appear here as a
 *  parameter — `buildShotConfig` pulls it directly from
 *  `shotBlueprint.homingTurnRate` for plasma/rocket shots. */
function buildShotConfig(
  shotBlueprint: ShotBlueprint,
  launchForce: number,
  range: number,
): ShotConfig {
  if (shotBlueprint.type === 'forceField') {
    const shot: ForceShot = {
      type: 'forceField',
      id: shotBlueprint.id,
      angle: shotBlueprint.angle,
      transitionTime: shotBlueprint.transitionTime,
      barrier:
        computeBarrierConfig(
          shotBlueprint.barrier,
          range,
        ) ?? undefined,
    };
    return shot;
  }

  if (shotBlueprint.type === 'beam') {
    const shot: BeamShot = {
      type: 'beam',
      id: shotBlueprint.id,
      dps: shotBlueprint.dps,
      force: shotBlueprint.force,
      recoil: shotBlueprint.recoil,
      radius: shotBlueprint.radius,
      width: shotBlueprint.width,
      damageSphere: { radius: shotBlueprint.damageSphere.radius },
      gravityForceMultiplier: shotBlueprint.gravityForceMultiplier,
    };
    return shot;
  }

  if (shotBlueprint.type === 'laser') {
    const shot: LaserShot = {
      type: 'laser',
      id: shotBlueprint.id,
      dps: shotBlueprint.dps,
      force: shotBlueprint.force,
      recoil: shotBlueprint.recoil,
      radius: shotBlueprint.radius,
      width: shotBlueprint.width,
      damageSphere: { radius: shotBlueprint.damageSphere.radius },
      duration: shotBlueprint.duration,
      gravityForceMultiplier: shotBlueprint.gravityForceMultiplier,
    };
    return shot;
  }

  // Traveling plasma / rocket shot
  const shot: ProjectileShot = {
    type: shotBlueprint.type,
    id: shotBlueprint.id,
    mass: shotBlueprint.mass,
    launchForce,
    collision: shotBlueprint.collision,
    explosion: shotBlueprint.explosion ?? undefined,
    detonateOnExpiry: shotBlueprint.detonateOnExpiry || undefined,
    maxLifespan: Number.isFinite(shotBlueprint.maxLifespan)
      ? shotBlueprint.maxLifespan!
      : undefined,
    homingTurnRate: shotBlueprint.homingTurnRate ?? undefined,
    homingThrust: shotBlueprint.homingThrust ?? undefined,
    gravityForceMultiplier: shotBlueprint.gravityForceMultiplier,
    submunitions: shotBlueprint.submunitions ?? undefined,
    smokeTrail: shotBlueprint.smokeTrail ?? undefined,
  };
  return shot;
}

export function buildProjectileShotConfig(
  shotId: ShotId,
  launchForce = 0,
): ActiveProjectileShot {
  const shotBlueprint = SHOT_BLUEPRINTS[shotId];
  if (!shotBlueprint) throw new Error(`Unknown shot blueprint: ${shotId}`);
  if (shotBlueprint.type === 'forceField') {
    throw new Error(
      `Shot blueprint ${shotId} cannot build a projectile config`,
    );
  }
  const shot = buildShotConfig(shotBlueprint, launchForce, 0);
  if (shot.type === 'forceField') {
    throw new Error(
      `Shot blueprint ${shotId} cannot build a projectile config`,
    );
  }
  return shot;
}

/**
 * Build a TurretConfig (for runtime sim) from a TurretBlueprint.
 */
export function buildTurretConfig(turretId: TurretId): TurretConfig {
  const turretBlueprint: TurretBlueprint = TURRET_BLUEPRINTS[turretId];
  if (!turretBlueprint)
    throw new Error(`Unknown turret blueprint: ${turretId}`);
  validateTurretRangeMultipliers(
    turretId,
    turretBlueprint.rangeMultiplierOverrides,
  );
  if (
    !Number.isFinite(turretBlueprint.radius.body) ||
    turretBlueprint.radius.body <= 0
  ) {
    throw new Error(
      `Turret blueprint ${turretId} must define positive radius.body`,
    );
  }

  // Determine shot config. Visual-only construction emitters have no
  // shot: their particles are renderer-owned cosmetics, not simulated
  // projectiles.
  let shot: ShotConfig | null = null;

  if (turretBlueprint.shotId !== null) {
    const shotBlueprint = SHOT_BLUEPRINTS[turretBlueprint.shotId];
    if (!shotBlueprint)
      throw new Error(
        `Unknown shot in turret ${turretId}: ${turretBlueprint.shotId}`,
      );
    shot = buildShotConfig(
      shotBlueprint,
      turretBlueprint.launchForce,
      turretBlueprint.range,
    );
  } else if (turretBlueprint.constructionEmitter === null) {
    throw new Error(
      `Turret ${turretId} has neither shotId nor constructionEmitter`,
    );
  }
  validateTurretAimStyle(turretId, turretBlueprint, shot);

  const lockOn = compileTurretLockOnMasks(turretBlueprint);

  const config: TurretConfig = {
    id: turretBlueprint.id,
    range: turretBlueprint.range,
    cooldown: turretBlueprint.cooldown ?? 0,
    color: turretBlueprint.color,
    barrel: turretBlueprint.barrel,
    angular: {
      turnAccel: turretBlueprint.turretTurnAccel,
      drag: turretBlueprint.turretDrag,
    },
    rangeOverrides: turretBlueprint.rangeMultiplierOverrides,
    eventsSmooth: turretBlueprint.eventsSmooth,
    spread: undefined,
    burst: undefined,
    isManualFire: turretBlueprint.isManualFire,
    passive: turretBlueprint.passive,
    shot: shot ?? undefined,
    turretIndex: undefined,
    requiresNonObstructedLineOfSight: turretBlueprint.requiresNonObstructedLineOfSight,
    aimStyle: { ...turretBlueprint.aimStyle },
    verticalLauncher: turretBlueprint.verticalLauncher,
    idlePitch: turretBlueprint.idlePitch,
    groundAimFraction: turretBlueprint.groundAimFraction ?? undefined,
    radius: { ...turretBlueprint.radius },
    headOnly: turretBlueprint.headOnly,
    visualOnly: shot === null,
    // hostDirected is a per-MOUNT tag, not a per-blueprint constant. The
    // shared TurretConfig defaults to false; the runtime turret factory
    // (makeRuntimeTurret) overrides it from each mount's hostDirected flag.
    hostDirected: false,
    constructionEmitter: turretBlueprint.constructionEmitter !== null
      ? {
          defaultSize: turretBlueprint.constructionEmitter.defaultSize,
          particleTravelSpeed: turretBlueprint.constructionEmitter.particleTravelSpeed,
          particleRadius: turretBlueprint.constructionEmitter.particleRadius,
          sizes: {
            small: { ...turretBlueprint.constructionEmitter.sizes.small },
            large: { ...turretBlueprint.constructionEmitter.sizes.large },
          },
        }
      : undefined,
    visualVariant: undefined,
    lockOnRelationshipExcludeMask: lockOn.relationship,
    lockOnEntityFamilyExcludeMask: lockOn.entityFamily,
    lockOnBuildingExcludeMask: lockOn.building,
    lockOnTowerExcludeMask: lockOn.tower,
    lockOnUnitExcludeMask: lockOn.unit,
    lockOnTurretExcludeMask: lockOn.turret,
  };

  // Derive barrelThickness from shot size, scaled by global multiplier.
  // Skip the barrel-less force-field emitters (sphere + panel): they
  // carry no gun barrel to thicken.
  if (
    turretBlueprint.shotId !== null &&
    config.barrel &&
    config.barrel.type !== 'complexSingleEmitter' &&
    config.barrel.type !== 'forceFieldPanelEmitter'
  ) {
    const shotBlueprint: ShotBlueprint =
      SHOT_BLUEPRINTS[turretBlueprint.shotId];
    let rawThickness: number;
    if (isLineShotBlueprint(shotBlueprint)) {
      rawThickness = shotBlueprint.width;
    } else if (shotBlueprint.type === 'forceField') {
      rawThickness = 2;
    } else {
      rawThickness =
        shotBlueprint.collision.radius > 0
          ? shotBlueprint.collision.radius * 2
          : 2;
    }
    config.barrel = {
      ...config.barrel,
      barrelThickness: config.barrel.barrelThickness ?? rawThickness,
    };
  }

  // Optional firing modifiers
  if (turretBlueprint.spread !== null) config.spread = { ...turretBlueprint.spread };
  if (turretBlueprint.burst !== null) config.burst = { ...turretBlueprint.burst };
  config.isManualFire = turretBlueprint.isManualFire;
  config.passive = turretBlueprint.passive;

  return config;
}

/**
 * Build all turret configs from blueprints.
 */
export function buildAllTurretConfigs(): Record<TurretId, TurretConfig> {
  const result = {} as Record<TurretId, TurretConfig>;
  for (const id of Object.keys(TURRET_BLUEPRINTS) as TurretId[]) {
    result[id] = buildTurretConfig(id);
  }
  return result;
}

// Cross-blueprint validation: every turretId referenced by a unit or
// building blueprint must resolve to a real turret blueprint. Runs at
// module-load so a missing/typoed reference throws immediately on
// import, not deep inside a runtime call. Leaf blueprint modules keep
// sibling imports minimal; the aggregation file owns relationship
// validation.
for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  for (let i = 0; i < bp.turrets.length; i++) {
    const turretId = bp.turrets[i].turretId;
    if (!TURRET_BLUEPRINTS[turretId]) {
      throw new Error(
        `Invalid turret reference for ${bp.id}[${i}]: unknown turretId "${turretId}"`,
      );
    }
  }
  if (bp.dgun && !TURRET_BLUEPRINTS[bp.dgun.turretId]) {
    throw new Error(
      `Invalid dgun turret reference for ${bp.id}: unknown turretId "${bp.dgun.turretId}"`,
    );
  }
}
for (const bp of Object.values(BUILDING_BLUEPRINTS)) {
  const turrets = bp.turrets;
  if (!turrets) continue;
  if (turrets.length > 0 && !isTowerBuildingType(bp.id)) {
    throw new Error(
      `Invalid building blueprint ${bp.id}: non-tower buildings must not declare turrets; move the blueprint to towers.json or remove the turret mounts`,
    );
  }
  for (let i = 0; i < turrets.length; i++) {
    const turretId = turrets[i].turretId;
    if (!TURRET_BLUEPRINTS[turretId]) {
      throw new Error(
        `Invalid building turret reference for ${bp.id}[${i}]: unknown turretId "${turretId}"`,
      );
    }
  }
}

// Host-directed-per-kind validation. "Host-directed turrets carry the
// host lock-on" requires that, for each turret KIND a host (unit or
// tower) mounts, EXACTLY ONE mount is tagged hostDirected — zero means
// the player's order for that kind has no weapon to land on; two-or-more
// means the primary is ambiguous. Pure buildings carry no turrets and
// are no-ops here. Runs at module-load so a bad host throws on import.
export function validateHostDirectedMounts(
  hostLabel: string,
  hostId: string,
  mounts: ReadonlyArray<{ turretId: string; hostDirected: unknown }>,
): void {
  const total = new Map<string, number>();
  const directed = new Map<string, number>();
  for (let i = 0; i < mounts.length; i++) {
    const mount = mounts[i];
    if (typeof mount.hostDirected !== 'boolean') {
      throw new Error(
        `Invalid ${hostLabel} ${hostId}[${i}] ${mount.turretId}: mount must define a boolean hostDirected`,
      );
    }
    const kind = TURRET_BLUEPRINTS[mount.turretId as TurretId].kind;
    total.set(kind, (total.get(kind) ?? 0) + 1);
    if (mount.hostDirected) directed.set(kind, (directed.get(kind) ?? 0) + 1);
  }
  for (const kind of total.keys()) {
    const count = directed.get(kind) ?? 0;
    if (count !== 1) {
      throw new Error(
        `Invalid ${hostLabel} ${hostId}: turret kind "${kind}" has ${count} host-directed mount(s); exactly one is required so the host's ${kind} order lands on a single primary turret`,
      );
    }
  }
}

for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  validateHostDirectedMounts('unit blueprint', bp.id, bp.turrets);
}
for (const bp of Object.values(BUILDING_BLUEPRINTS)) {
  if (!bp.turrets || bp.turrets.length === 0) continue;
  validateHostDirectedMounts('building blueprint', bp.id, bp.turrets);
}

// Cross-blueprint lock-on exclusion validation. Each level-1 named
// exclusion list must reference real blueprint ids; unknown names are
// authoring mistakes, not silent drops.
function assertLevel1IdsInSet(
  label: string,
  field: string,
  ids: readonly string[],
  validSet: ReadonlySet<string>,
  kindLabel: string,
): void {
  for (let i = 0; i < ids.length; i++) {
    if (!validSet.has(ids[i])) {
      throw new Error(
        `Invalid ${label}: ${field}[${i}] = "${ids[i]}" is not a known ${kindLabel} id`,
      );
    }
  }
}
const KNOWN_BUILDING_IDS: ReadonlySet<string> = new Set(
  Object.keys(BUILDING_BLUEPRINTS).filter(
    (id) => !isTowerBuildingType(id as BuildingType),
  ),
);
const KNOWN_TOWER_IDS: ReadonlySet<string> = new Set(
  Object.keys(BUILDING_BLUEPRINTS).filter((id) =>
    isTowerBuildingType(id as BuildingType),
  ),
);
const KNOWN_UNIT_IDS: ReadonlySet<string> = new Set(Object.keys(UNIT_BLUEPRINTS));
const KNOWN_TURRET_IDS: ReadonlySet<string> = new Set(Object.keys(TURRET_BLUEPRINTS));
for (const [id, bp] of Object.entries(TURRET_BLUEPRINTS)) {
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'excludeLockOnLevel1Buildings',
    bp.excludeLockOnLevel1Buildings,
    KNOWN_BUILDING_IDS,
    'building',
  );
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'excludeLockOnLevel1Towers',
    bp.excludeLockOnLevel1Towers,
    KNOWN_TOWER_IDS,
    'tower',
  );
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'excludeLockOnLevel1Units',
    bp.excludeLockOnLevel1Units,
    KNOWN_UNIT_IDS,
    'unit',
  );
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'excludeLockOnLevel1Turrets',
    bp.excludeLockOnLevel1Turrets,
    KNOWN_TURRET_IDS,
    'turret',
  );
}
for (const [id, bp] of Object.entries(UNIT_BLUEPRINTS)) {
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'excludeLockOnLevel1Buildings',
    bp.excludeLockOnLevel1Buildings,
    KNOWN_BUILDING_IDS,
    'building',
  );
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'excludeLockOnLevel1Towers',
    bp.excludeLockOnLevel1Towers,
    KNOWN_TOWER_IDS,
    'tower',
  );
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'excludeLockOnLevel1Units',
    bp.excludeLockOnLevel1Units,
    KNOWN_UNIT_IDS,
    'unit',
  );
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'excludeLockOnLevel1Turrets',
    bp.excludeLockOnLevel1Turrets,
    KNOWN_TURRET_IDS,
    'turret',
  );
}
for (const [id, bp] of Object.entries(BUILDING_BLUEPRINTS)) {
  if (!isTowerBuildingType(id as BuildingType)) continue;
  const tower = bp as typeof bp & LockOnExclusionObject;
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'excludeLockOnLevel1Buildings',
    tower.excludeLockOnLevel1Buildings,
    KNOWN_BUILDING_IDS,
    'building',
  );
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'excludeLockOnLevel1Towers',
    tower.excludeLockOnLevel1Towers,
    KNOWN_TOWER_IDS,
    'tower',
  );
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'excludeLockOnLevel1Units',
    tower.excludeLockOnLevel1Units,
    KNOWN_UNIT_IDS,
    'unit',
  );
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'excludeLockOnLevel1Turrets',
    tower.excludeLockOnLevel1Turrets,
    KNOWN_TURRET_IDS,
    'turret',
  );
}
