/**
 * Blueprint System — Re-exports + derived config builders
 */

export * from './types';
export * from './shots';
export * from './rays';
export * from './shields';
export * from './shieldMaterials';
export * from './turrets';
export * from './unitRoster';
export * from './units';
export * from './buildings';
export * from './fallbacks';

import type {
  BeamRay,
  ShieldBarrierConfig,
  ShieldConfig,
  EmissionConfig,
  LaserRay,
  ActiveProjectileShot,
  ShotConfig,
  TurretConfig,
} from '../types';
import { isProjectileShot } from '../types';
import type { ShotBlueprintId, TurretBlueprintId } from '../../../types/blueprintIds';
import { SHOT_BLUEPRINTS } from './shots';
import { RAY_BLUEPRINTS } from './rays';
import { SHIELD_BLUEPRINTS } from './shields';
import { getShieldMaterial } from './shieldMaterials';
import { TURRET_BLUEPRINTS } from './turrets';
import { UNIT_BLUEPRINTS, resolveUnitTurretMounts } from './units';
import { BUILDING_BLUEPRINTS } from './buildings';
import type {
  ShotBlueprint,
  RayBlueprint,
  ShieldBarrierRatioConfig,
  ShieldBlueprint,
  LockOnInclusionObject,
  TurretBlueprint,
} from './types';
import {
  buildingBlueprintIdToCode,
  codeToBuildingBlueprintId,
  codeToShotBlueprintId,
  codeToTurretBlueprintId,
  codeToUnitBlueprintId,
  getNetworkBuildingBlueprintIds,
  getNetworkShotBlueprintIds,
  getNetworkTurretBlueprintIds,
  getNetworkUnitBlueprintIds,
  shotBlueprintIdToCode,
  turretBlueprintIdToCode,
  unitBlueprintIdToCode,
  BUILDING_BLUEPRINT_CODE_UNKNOWN,
  SHOT_BLUEPRINT_CODE_UNKNOWN,
  TURRET_BLUEPRINT_CODE_UNKNOWN,
  UNIT_BLUEPRINT_CODE_UNKNOWN,
} from '../../../types/network';

// LOCK-ON-03 — Compile per-turret lock-on inclusion bitmasks. Reads
// the authored inclusion strings on the blueprint, resolves level-1
// blueprint names through the network wire-code helpers, and packs
// everything into the numeric fields the targeting slab consumes.
import {
  CT_LOCK_ON_REL_INCLUDE_ENEMY,
  CT_LOCK_ON_REL_INCLUDE_FRIENDLY,
  CT_LOCK_ON_FAM_INCLUDE_BUILDINGS,
  CT_LOCK_ON_FAM_INCLUDE_TOWERS,
  CT_LOCK_ON_FAM_INCLUDE_UNITS,
  CT_LOCK_ON_FAM_INCLUDE_TURRETS,
  CT_LOCK_ON_FAM_INCLUDE_SHOTS,
  CT_LOCK_ON_LEVEL1_MASK_CAPACITY,
  CT_LOCK_ON_RECIPROCAL_IGNORE,
  CT_LOCK_ON_RECIPROCAL_PREFER_HOLD,
  CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE,
  CT_LOCK_ON_RECIPROCAL_REQUIRE,
} from '../../sim-wasm/init';
import { isTowerBuildingBlueprintId, type BuildingBlueprintId } from '../../../types/buildingTypes';
import { getSecondaryLockOnProfile } from './lockOnConfig';

export type LockOnMasks = {
  relationship: number;
  entityFamily: number;
  building: number;
  tower: number;
  unit: number;
  turret: number;
  shot: number;
  reciprocal: number;
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

function compileLockOnMasks(label: string, policy: LockOnInclusionObject): LockOnMasks {
  let relationship = 0;
  for (const r of policy.includeLockOnLevel0FriendsAndEnemies) {
    if (r === 'friendly_entities') relationship |= CT_LOCK_ON_REL_INCLUDE_FRIENDLY;
    else if (r === 'enemy_entities') relationship |= CT_LOCK_ON_REL_INCLUDE_ENEMY;
    else {
      throw new Error(
        `Invalid ${label}: includeLockOnLevel0FriendsAndEnemies entry "${r}" is not a known relationship`,
      );
    }
  }
  let entityFamily = 0;
  for (const f of policy.includeLockOnLevel0Entities) {
    if (f === 'buildings') entityFamily |= CT_LOCK_ON_FAM_INCLUDE_BUILDINGS;
    else if (f === 'towers') entityFamily |= CT_LOCK_ON_FAM_INCLUDE_TOWERS;
    else if (f === 'units') entityFamily |= CT_LOCK_ON_FAM_INCLUDE_UNITS;
    else if (f === 'turrets') entityFamily |= CT_LOCK_ON_FAM_INCLUDE_TURRETS;
    else if (f === 'shots') entityFamily |= CT_LOCK_ON_FAM_INCLUDE_SHOTS;
    else {
      throw new Error(
        `Invalid ${label}: includeLockOnLevel0Entities entry "${f}" is not a known family`,
      );
    }
  }
  const building = lockOnLevel1Mask(
    label,
    'includeLockOnLevel1Buildings',
    policy.includeLockOnLevel1Buildings,
    buildingBlueprintIdToCode,
    BUILDING_BLUEPRINT_CODE_UNKNOWN,
    'building',
  );
  // Towers share the static-structure wire-code space with buildings,
  // so the level-1 tower mask uses the same wire-code lookup. The
  // Rust kernel reads tower vs. building from the candidate's
  // entity_family and consults the appropriate mask.
  const tower = lockOnLevel1Mask(
    label,
    'includeLockOnLevel1Towers',
    policy.includeLockOnLevel1Towers,
    buildingBlueprintIdToCode,
    BUILDING_BLUEPRINT_CODE_UNKNOWN,
    'tower',
  );
  const unit = lockOnLevel1Mask(
    label,
    'includeLockOnLevel1Units',
    policy.includeLockOnLevel1Units,
    unitBlueprintIdToCode,
    UNIT_BLUEPRINT_CODE_UNKNOWN,
    'unit',
  );
  const turret = lockOnLevel1Mask(
    label,
    'includeLockOnLevel1Turrets',
    policy.includeLockOnLevel1Turrets,
    turretBlueprintIdToCode,
    TURRET_BLUEPRINT_CODE_UNKNOWN,
    'turret',
  );
  const shot = lockOnLevel1Mask(
    label,
    'includeLockOnLevel1Shots',
    policy.includeLockOnLevel1Shots,
    shotBlueprintIdToCode,
    SHOT_BLUEPRINT_CODE_UNKNOWN,
    'shot',
  );
  let reciprocal = CT_LOCK_ON_RECIPROCAL_IGNORE;
  if (policy.lockOnRequiresTargetLockedOntoSelf === 'require') {
    reciprocal = CT_LOCK_ON_RECIPROCAL_REQUIRE;
  } else if (policy.lockOnRequiresTargetLockedOntoSelf === 'preferReacquire') {
    reciprocal = CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE;
  } else if (policy.lockOnRequiresTargetLockedOntoSelf === 'preferHold') {
    reciprocal = CT_LOCK_ON_RECIPROCAL_PREFER_HOLD;
  } else if (policy.lockOnRequiresTargetLockedOntoSelf !== 'ignore') {
    throw new Error(
      `Invalid ${label}: lockOnRequiresTargetLockedOntoSelf "${policy.lockOnRequiresTargetLockedOntoSelf}" is not a known reciprocal lock-on mode`,
    );
  }
  return { relationship, entityFamily, building, tower, unit, turret, shot, reciprocal };
}

function compileTurretLockOnMasks(turretBlueprint: TurretBlueprint): LockOnMasks {
  return compileLockOnMasks(`turret blueprint ${turretBlueprint.turretBlueprintId}`, turretBlueprint);
}

// Lock-on is off by default: all-zero masks include no relationship and
// no family, so a locker with these masks can lock onto nothing. This is
// the correct fallback for hosts that carry no lock-on inclusion object
// (e.g. buildings).
export const EMPTY_LOCK_ON_MASKS: LockOnMasks = Object.freeze({
  relationship: 0,
  entityFamily: 0,
  building: 0,
  tower: 0,
  unit: 0,
  turret: 0,
  shot: 0,
  reciprocal: CT_LOCK_ON_RECIPROCAL_IGNORE,
});

function buildUnitHostLockOnMasks(): Record<string, LockOnMasks> {
  const masks: Record<string, LockOnMasks> = {};
  const ids = Object.keys(UNIT_BLUEPRINTS);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    masks[id] = compileLockOnMasks(`unit blueprint ${id}`, UNIT_BLUEPRINTS[id]);
  }
  return masks;
}

function buildTowerHostLockOnMasks(): Partial<Record<BuildingBlueprintId, LockOnMasks>> {
  const masks: Partial<Record<BuildingBlueprintId, LockOnMasks>> = {};
  const ids = Object.keys(BUILDING_BLUEPRINTS) as BuildingBlueprintId[];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!isTowerBuildingBlueprintId(id)) continue;
    const blueprint = BUILDING_BLUEPRINTS[id] as (typeof BUILDING_BLUEPRINTS)[BuildingBlueprintId] & LockOnInclusionObject;
    masks[id] = compileLockOnMasks(`tower blueprint ${id}`, blueprint);
  }
  return masks;
}

const UNIT_HOST_LOCK_ON_MASKS: Record<string, LockOnMasks> = buildUnitHostLockOnMasks();

const TOWER_HOST_LOCK_ON_MASKS: Partial<Record<BuildingBlueprintId, LockOnMasks>> =
  buildTowerHostLockOnMasks();

export function getUnitHostLockOnMasks(unitBlueprintId: string): LockOnMasks {
  return UNIT_HOST_LOCK_ON_MASKS[unitBlueprintId] ?? EMPTY_LOCK_ON_MASKS;
}

export function getTowerHostLockOnMasks(buildingBlueprintId: BuildingBlueprintId): LockOnMasks {
  return TOWER_HOST_LOCK_ON_MASKS[buildingBlueprintId] ?? EMPTY_LOCK_ON_MASKS;
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
  getNetworkUnitBlueprintIds(),
  unitBlueprintIdToCode,
  codeToUnitBlueprintId,
  UNIT_BLUEPRINT_CODE_UNKNOWN,
);

validateStableWireIds(
  'building',
  Object.keys(BUILDING_BLUEPRINTS),
  getNetworkBuildingBlueprintIds(),
  buildingBlueprintIdToCode,
  codeToBuildingBlueprintId,
  BUILDING_BLUEPRINT_CODE_UNKNOWN,
);

validateStableWireIds(
  'shot',
  Object.keys(SHOT_BLUEPRINTS),
  getNetworkShotBlueprintIds(),
  shotBlueprintIdToCode,
  codeToShotBlueprintId,
  SHOT_BLUEPRINT_CODE_UNKNOWN,
);

validateStableWireIds(
  'turret',
  Object.keys(TURRET_BLUEPRINTS),
  getNetworkTurretBlueprintIds(),
  turretBlueprintIdToCode,
  codeToTurretBlueprintId,
  TURRET_BLUEPRINT_CODE_UNKNOWN,
);

resolveUnitTurretMounts((turretBlueprintId) => {
  const turretBlueprint = TURRET_BLUEPRINTS[turretBlueprintId];
  if (!turretBlueprint) {
    throw new Error(
      `Invalid unit turret mount resolver: unknown turretBlueprintId "${turretBlueprintId}"`,
    );
  }
  return turretBlueprint.radius.visual;
});

function assertFiniteRangeMultiplier(
  turretBlueprintId: string,
  path: string,
  value: number,
): void {
  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid turret range multiplier for ${turretBlueprintId}: ${path} must be finite, got ${value}`,
    );
  }
}

function validateTurretRangeMultipliers(
  turretBlueprintId: string,
  ranges: TurretBlueprint['rangeMultiplierOverrides'],
): void {
  const max = ranges.engageRangeMax;
  const min = ranges.engageRangeMin;
  const tracking = ranges.trackingRange;

  assertFiniteRangeMultiplier(turretBlueprintId, 'engageRangeMax.acquire', max.acquire);
  assertFiniteRangeMultiplier(turretBlueprintId, 'engageRangeMax.release', max.release);

  if (max.release <= max.acquire) {
    throw new Error(
      `Invalid turret range multipliers for ${turretBlueprintId}: engageRangeMax.release (${max.release}) must be greater than engageRangeMax.acquire (${max.acquire})`,
    );
  }

  // engageRangeMin is `null` when the turret has no soft inner target
  // preference. When set, both edges must be finite and acquire must be
  // farther out than release so target preference doesn't flicker when
  // enemies sit on the inner boundary.
  if (min) {
    assertFiniteRangeMultiplier(
      turretBlueprintId,
      'engageRangeMin.acquire',
      min.acquire,
    );
    assertFiniteRangeMultiplier(
      turretBlueprintId,
      'engageRangeMin.release',
      min.release,
    );
    if (min.acquire <= min.release) {
      throw new Error(
        `Invalid turret range multipliers for ${turretBlueprintId}: engageRangeMin.acquire (${min.acquire}) must be greater than engageRangeMin.release (${min.release})`,
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
      turretBlueprintId,
      'trackingRange.acquire',
      tracking.acquire,
    );
    assertFiniteRangeMultiplier(
      turretBlueprintId,
      'trackingRange.release',
      tracking.release,
    );
    if (tracking.release <= tracking.acquire) {
      throw new Error(
        `Invalid turret range multipliers for ${turretBlueprintId}: trackingRange.release (${tracking.release}) must be greater than trackingRange.acquire (${tracking.acquire})`,
      );
    }
    if (tracking.acquire <= max.acquire) {
      throw new Error(
        `Invalid turret range multipliers for ${turretBlueprintId}: trackingRange.acquire (${tracking.acquire}) must sit OUTSIDE engageRangeMax.acquire (${max.acquire})`,
      );
    }
    if (tracking.release <= max.release) {
      throw new Error(
        `Invalid turret range multipliers for ${turretBlueprintId}: trackingRange.release (${tracking.release}) must sit OUTSIDE engageRangeMax.release (${max.release})`,
      );
    }
  }
}

function validateTurretAimStyle(
  turretBlueprintId: string,
  turretBlueprint: TurretBlueprint,
  emission: EmissionConfig | null,
): void {
  const secondaryLockOnProfile = getSecondaryLockOnProfile(turretBlueprintId);
  if (secondaryLockOnProfile !== undefined) {
    if (secondaryLockOnProfile.mode !== 'incomingThreatReflector') {
      throw new Error(
        `Turret ${turretBlueprintId} has unsupported secondary lock-on profile "${secondaryLockOnProfile.mode}"`,
      );
    }
    if (turretBlueprint.aimStyle.angleType !== 'rayBisectTurretAndBody') {
      throw new Error(
        `Turret ${turretBlueprintId} incomingThreatReflector profile requires aimStyle.angleType "rayBisectTurretAndBody"`,
      );
    }
    if (!turretBlueprint.passive) {
      throw new Error(
        `Turret ${turretBlueprintId} incomingThreatReflector profile requires passive shield-panel targeting`,
      );
    }
    if (turretBlueprint.lockOnRequiresTargetLockedOntoSelf !== 'require') {
      throw new Error(
        `Turret ${turretBlueprintId} incomingThreatReflector profile requires lockOnRequiresTargetLockedOntoSelf "require"`,
      );
    }
    if (
      !turretBlueprint.includeLockOnLevel0FriendsAndEnemies.includes('enemy_entities') ||
      !turretBlueprint.includeLockOnLevel0Entities.includes('turrets')
    ) {
      throw new Error(
        `Turret ${turretBlueprintId} incomingThreatReflector profile requires enemy turret lock-on inclusions`,
      );
    }
    if (emission === null || emission.type !== 'shield' || emission.barrier !== undefined) {
      throw new Error(
        `Turret ${turretBlueprintId} incomingThreatReflector profile requires a flat shield-panel emission`,
      );
    }
  }
  switch (turretBlueprint.aimStyle.angleType) {
    case 'ballisticArcLow':
    case 'ballisticArcLowOnlyUnder':
    case 'ballisticArcHigh':
      if (!emission || !isProjectileShot(emission)) {
        throw new Error(
          `Turret ${turretBlueprintId} uses aimStyle.angleType "${turretBlueprint.aimStyle.angleType}" without a plasma/rocket shot`,
        );
      }
      return;
    case 'rayBisectTurretAndBody':
      if (!turretBlueprint.includeLockOnLevel0Entities.includes('turrets')) {
        throw new Error(
          `Turret ${turretBlueprintId} uses aimStyle.angleType "rayBisectTurretAndBody" without turret-family lock-on inclusions`,
        );
      }
      return;
    case 'rayDirect':
      return;
  }
}

/** Compute a ShieldBarrierConfig from ratio-based blueprint data and weapon range. */
function computeBarrierConfig(
  barrier: ShieldBarrierRatioConfig | null,
  range: number,
  material: ShieldConfig['material'],
): ShieldBarrierConfig | null {
  if (!barrier) return null;
  const outerRange =
    barrier.rimWidth != null
      ? barrier.rimWidth
      : range * (barrier.outerRatio ?? 1);
  const originOffsetZ = outerRange * (barrier.originOffsetRadiusRatio ?? 0);
  return {
    shape: barrier.shape,
    innerRange: 0,
    outerRange,
    originOffsetZ,
    color: material.visual.color,
    alpha: material.visual.alpha,
    particleAlpha: material.visual.particleAlpha,
  };
}

/** Derive a shot's runtime explosion from its base-ledger death explosion.
 *
 *  base.deathExplosion is the single source of truth for a shot's death
 *  blast (see "Every death is an explosion" / "Shots are destructible
 *  bodies too"). The runtime ShotExplosion is a field-reordered cache of it
 *  ({radius,force,damage} -> {radius,damage,force}); a zero-radius blast
 *  produces no explosion (hasExplosion stays false downstream). */
function deriveShotExplosion(
  blast: ShotBlueprint['base']['deathExplosion'],
): ShotConfig['explosion'] {
  if (!(blast.radius > 0)) return undefined;
  return { radius: blast.radius, damage: blast.damage, force: blast.force };
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
): ShotConfig {
  return {
    type: shotBlueprint.type,
    shotBlueprintId: shotBlueprint.shotBlueprintId,
    base: shotBlueprint.base,
    mass: shotBlueprint.mass,
    health: shotBlueprint.health,
    launchForce,
    radius: shotBlueprint.radius,
    explosion: deriveShotExplosion(shotBlueprint.base.deathExplosion),
    detonateOnExpiry: shotBlueprint.detonateOnExpiry || undefined,
    maxLifespan: Number.isFinite(shotBlueprint.maxLifespan)
      ? shotBlueprint.maxLifespan!
      : undefined,
    homingTurnRate: shotBlueprint.homingTurnRate ?? undefined,
    homingThrust: shotBlueprint.homingThrust ?? undefined,
    homingDelayMs: shotBlueprint.homingDelayMs ?? undefined,
    propulsionForce: shotBlueprint.propulsionForce ?? undefined,
    gravityForceMultiplier: shotBlueprint.gravityForceMultiplier,
    airFrictionPer60HzFrame: shotBlueprint.airFrictionPer60HzFrame,
    submunitions: shotBlueprint.submunitions ?? undefined,
    smokeTrail: shotBlueprint.smokeTrail ?? undefined,
  };
}

function buildRayConfig(rayBlueprint: RayBlueprint): BeamRay | LaserRay {
  if (rayBlueprint.type === 'beam') {
    return {
      type: 'beam',
      rayBlueprintId: rayBlueprint.rayBlueprintId,
      dps: rayBlueprint.dps,
      force: rayBlueprint.force,
      recoil: rayBlueprint.recoil,
      radius: rayBlueprint.radius,
      width: rayBlueprint.width,
      damageSphere: { radius: rayBlueprint.damageSphere.radius },
      gravityForceMultiplier: rayBlueprint.gravityForceMultiplier,
    };
  }
  return {
    type: 'laser',
    rayBlueprintId: rayBlueprint.rayBlueprintId,
    dps: rayBlueprint.dps,
    force: rayBlueprint.force,
    recoil: rayBlueprint.recoil,
    radius: rayBlueprint.radius,
    width: rayBlueprint.width,
    damageSphere: { radius: rayBlueprint.damageSphere.radius },
    duration: rayBlueprint.duration,
    gravityForceMultiplier: rayBlueprint.gravityForceMultiplier,
  };
}

function buildShieldConfig(
  shieldBlueprint: ShieldBlueprint,
  range: number,
): ShieldConfig {
  const material = getShieldMaterial(shieldBlueprint.materialId);
  return {
    type: 'shield',
    shieldBlueprintId: shieldBlueprint.shieldBlueprintId,
    material,
    angle: shieldBlueprint.angle,
    transitionTime: shieldBlueprint.transitionTime,
    reflection: {
      entities: { ...shieldBlueprint.reflection.entities },
    },
    barrier:
      computeBarrierConfig(
        shieldBlueprint.barrier,
        range,
        material,
      ) ?? undefined,
  };
}

function buildEmissionConfig(
  turretBlueprintId: TurretBlueprintId,
  turretBlueprint: TurretBlueprint,
): EmissionConfig | null {
  if (turretBlueprint.emissionKind === null || turretBlueprint.emissionBlueprintId === null) {
    if (turretBlueprint.emissionKind !== null || turretBlueprint.emissionBlueprintId !== null) {
      throw new Error(
        `Turret ${turretBlueprintId} must set both emissionKind and emissionBlueprintId, or neither`,
      );
    }
    return null;
  }

  const id = turretBlueprint.emissionBlueprintId;
  if (turretBlueprint.emissionKind === 'shot') {
    const shotBlueprint = SHOT_BLUEPRINTS[id as ShotBlueprintId];
    if (!shotBlueprint) throw new Error(`Unknown shot in turret ${turretBlueprintId}: ${id}`);
    return buildShotConfig(shotBlueprint, turretBlueprint.launchForce);
  }
  if (turretBlueprint.emissionKind === 'ray') {
    const rayBlueprint = RAY_BLUEPRINTS[id as keyof typeof RAY_BLUEPRINTS];
    if (!rayBlueprint) throw new Error(`Unknown ray in turret ${turretBlueprintId}: ${id}`);
    return buildRayConfig(rayBlueprint);
  }
  const shieldBlueprint = SHIELD_BLUEPRINTS[id as keyof typeof SHIELD_BLUEPRINTS];
  if (!shieldBlueprint) throw new Error(`Unknown shield in turret ${turretBlueprintId}: ${id}`);
  return buildShieldConfig(shieldBlueprint, turretBlueprint.range);
}

export function buildProjectileShotConfig(
  shotBlueprintId: ShotBlueprintId,
  launchForce = 0,
): ActiveProjectileShot {
  const shotBlueprint = SHOT_BLUEPRINTS[shotBlueprintId];
  if (!shotBlueprint) throw new Error(`Unknown shot blueprint: ${shotBlueprintId}`);
  return buildShotConfig(shotBlueprint, launchForce);
}

/**
 * Build a TurretConfig (for runtime sim) from a TurretBlueprint.
 */
function buildTurretConfig(turretBlueprintId: TurretBlueprintId): TurretConfig {
  const turretBlueprint: TurretBlueprint = TURRET_BLUEPRINTS[turretBlueprintId];
  if (!turretBlueprint)
    throw new Error(`Unknown turret blueprint: ${turretBlueprintId}`);
  validateTurretRangeMultipliers(
    turretBlueprintId,
    turretBlueprint.rangeMultiplierOverrides,
  );
  // `radius.visual: null` is the explicit "draw no body sphere" signal —
  // the turret renders no head sphere (and barrels, which scale off it,
  // collapse to nothing). Any other non-positive / non-finite value is an
  // authoring mistake.
  const radiusVisual = turretBlueprint.radius.visual;
  if (radiusVisual != null && (!Number.isFinite(radiusVisual) || radiusVisual <= 0)) {
    throw new Error(
      `Turret blueprint ${turretBlueprintId} radius.visual must be a positive number or null`,
    );
  }

  // Determine emission config. Construction emitters and unit launchers
  // have no shot/ray/shield emission: pylons are renderer-owned cosmetics,
  // while unit launchers apply force directly to the produced unit.
  const shot = buildEmissionConfig(turretBlueprintId, turretBlueprint);
  const unitLauncher = turretBlueprint.unitLauncher ?? null;

  if (
    shot === null &&
    turretBlueprint.constructionEmitter === null &&
    unitLauncher === null
  ) {
    throw new Error(
      `Turret ${turretBlueprintId} has neither emissionBlueprintId, constructionEmitter, nor unitLauncher`,
    );
  }
  validateTurretAimStyle(turretBlueprintId, turretBlueprint, shot);

  const lockOn = compileTurretLockOnMasks(turretBlueprint);

  const config: TurretConfig = {
    turretBlueprintId: turretBlueprint.turretBlueprintId,
    range: turretBlueprint.range,
    rangeVolume: turretBlueprint.rangeVolume,
    cooldown: turretBlueprint.cooldown,
    launchForce: turretBlueprint.launchForce,
    addTurretVelocityToEmissionLaunch: turretBlueprint.addTurretVelocityToEmissionLaunch,
    color: turretBlueprint.color,
    barrel: turretBlueprint.barrel,
    angular: {
      turnAccel: turretBlueprint.turretTurnAccel,
      drag: turretBlueprint.turretDrag,
    },
    rangeOverrides: turretBlueprint.rangeMultiplierOverrides,
    eventsSmooth: turretBlueprint.eventsSmooth,
    spread: null,
    burst: null,
    isManualFire: turretBlueprint.isManualFire,
    passive: turretBlueprint.passive,
    shot,
    submunitions: turretBlueprint.submunitions ?? null,
    turretIndex: -1,
    requiresNonObstructedLineOfSight: turretBlueprint.requiresNonObstructedLineOfSight,
    aimStyle: { ...turretBlueprint.aimStyle },
    verticalLauncher: turretBlueprint.verticalLauncher,
    idlePitch: turretBlueprint.idlePitch,
    groundAimFraction: turretBlueprint.groundAimFraction,
    // Turrets author only `radius.visual` (the body sphere). hitbox/collision
    // are pinned to 0 here: a turret is not a separate hit/collide body — it
    // extends no hit-surface and does its own muzzle self-clearance off 0
    // (the host body's own collision covers clearance). See turretHostIntegration.
    radius: { visual: turretBlueprint.radius.visual, hitbox: 0, collision: 0 },
    headOnly: turretBlueprint.headOnly,
    visualOnly: shot === null && unitLauncher === null,
    // hostDirected is a per-MOUNT tag, not a per-blueprint constant. The
    // shared TurretConfig defaults to false; the runtime turret factory
    // (makeRuntimeTurret) overrides it from each mount's hostDirected flag.
    hostDirected: false,
    // Unit mounts opt into fight/patrol halt gating individually. Building
    // mounts never participate in unit movement halt checks.
    requiredEngagedForFightStop: false,
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
      : null,
    unitLauncher: unitLauncher !== null
      ? {
          aimMode: unitLauncher.aimMode,
          producedUnitBlueprintId: unitLauncher.producedUnitBlueprintId,
          autoProduce: unitLauncher.autoProduce,
        }
      : null,
    visualVariant: null,
    lockOnRelationshipIncludeMask: lockOn.relationship,
    lockOnEntityFamilyIncludeMask: lockOn.entityFamily,
    lockOnBuildingIncludeMask: lockOn.building,
    lockOnTowerIncludeMask: lockOn.tower,
    lockOnUnitIncludeMask: lockOn.unit,
    lockOnTurretIncludeMask: lockOn.turret,
    lockOnShotIncludeMask: lockOn.shot,
    lockOnRequiresTargetLockedOntoSelfMode: lockOn.reciprocal,
  };

  // Derive barrelThickness from shot size, scaled by global multiplier.
  // Skip the barrel-less shield emitters (sphere + panel): they
  // carry no gun barrel to thicken.
  if (
    turretBlueprint.emissionKind !== null &&
    turretBlueprint.emissionBlueprintId !== null &&
    config.barrel &&
    config.barrel.type !== 'complexSingleEmitter' &&
    config.barrel.type !== 'shieldPanelEmitter'
  ) {
    let rawThickness: number;
    if (turretBlueprint.emissionKind === 'ray') {
      const rayBlueprint = RAY_BLUEPRINTS[turretBlueprint.emissionBlueprintId as keyof typeof RAY_BLUEPRINTS];
      rawThickness = rayBlueprint?.width ?? 2;
    } else if (turretBlueprint.emissionKind === 'shield') {
      rawThickness = 2;
    } else {
      const shotBlueprint = SHOT_BLUEPRINTS[turretBlueprint.emissionBlueprintId as ShotBlueprintId];
      rawThickness =
        shotBlueprint && shotBlueprint.radius.visual > 0
          ? shotBlueprint.radius.visual * 2
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
export function buildAllTurretConfigs(): Record<TurretBlueprintId, TurretConfig> {
  const result = {} as Record<TurretBlueprintId, TurretConfig>;
  for (const id of Object.keys(TURRET_BLUEPRINTS) as TurretBlueprintId[]) {
    result[id] = buildTurretConfig(id);
  }
  return result;
}

// Cross-blueprint validation: every turretBlueprintId referenced by a unit or
// building blueprint must resolve to a real turret blueprint. Runs at
// module-load so a missing/typoed reference throws immediately on
// import, not deep inside a runtime call. Leaf blueprint modules keep
// sibling imports minimal; the aggregation file owns relationship
// validation.
for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  for (let i = 0; i < bp.turrets.length; i++) {
    const turretBlueprintId = bp.turrets[i].turretBlueprintId;
    if (!TURRET_BLUEPRINTS[turretBlueprintId]) {
      throw new Error(
        `Invalid turret reference for ${bp.unitBlueprintId}[${i}]: unknown turretBlueprintId "${turretBlueprintId}"`,
      );
    }
  }
  if (bp.dgun && !TURRET_BLUEPRINTS[bp.dgun.turretBlueprintId]) {
    throw new Error(
      `Invalid dgun turret reference for ${bp.unitBlueprintId}: unknown turretBlueprintId "${bp.dgun.turretBlueprintId}"`,
    );
  }
}
for (const bp of Object.values(BUILDING_BLUEPRINTS)) {
  const turrets = bp.turrets;
  if (!turrets) continue;
  if (turrets.length > 0 && !isTowerBuildingBlueprintId(bp.buildingBlueprintId)) {
    throw new Error(
      `Invalid building blueprint ${bp.buildingBlueprintId}: non-tower buildings must not declare turrets; move the blueprint to towers.json or remove the turret mounts`,
    );
  }
  for (let i = 0; i < turrets.length; i++) {
    const turretBlueprintId = turrets[i].turretBlueprintId;
    if (!TURRET_BLUEPRINTS[turretBlueprintId]) {
      throw new Error(
        `Invalid building turret reference for ${bp.buildingBlueprintId}[${i}]: unknown turretBlueprintId "${turretBlueprintId}"`,
      );
    }
  }
}

// Host-directed validation. "Host-directed turrets carry the host
// lock-on" is a per-mount choice: zero, one, or many mounts may inherit
// the host target. The loader only enforces that every mount states the
// choice explicitly so blueprint behavior is auditable at import time.
export function validateHostDirectedMounts(
  hostLabel: string,
  hostId: string,
  mounts: ReadonlyArray<{ turretBlueprintId: string; hostDirected: unknown }>,
): void {
  for (let i = 0; i < mounts.length; i++) {
    const mount = mounts[i];
    if (typeof mount.hostDirected !== 'boolean') {
      throw new Error(
        `Invalid ${hostLabel} ${hostId}[${i}] ${mount.turretBlueprintId}: mount must define a boolean hostDirected`,
      );
    }
  }
}

for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  validateHostDirectedMounts('unit blueprint', bp.unitBlueprintId, bp.turrets);
}
for (const bp of Object.values(BUILDING_BLUEPRINTS)) {
  if (!bp.turrets || bp.turrets.length === 0) continue;
  validateHostDirectedMounts('building blueprint', bp.buildingBlueprintId, bp.turrets);
}

// Cross-blueprint lock-on inclusion validation. Each level-1 named
// inclusion list must reference real blueprint ids; unknown names are
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
function buildKnownBuildingIds(tower: boolean): ReadonlySet<string> {
  const knownIds = new Set<string>();
  const ids = Object.keys(BUILDING_BLUEPRINTS) as BuildingBlueprintId[];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (isTowerBuildingBlueprintId(id) === tower) knownIds.add(id);
  }
  return knownIds;
}

const KNOWN_BUILDING_IDS: ReadonlySet<string> = buildKnownBuildingIds(false);
const KNOWN_TOWER_IDS: ReadonlySet<string> = buildKnownBuildingIds(true);
const KNOWN_UNIT_IDS: ReadonlySet<string> = new Set(Object.keys(UNIT_BLUEPRINTS));
const KNOWN_TURRET_BLUEPRINT_IDS: ReadonlySet<string> = new Set(Object.keys(TURRET_BLUEPRINTS));
const KNOWN_SHOT_IDS: ReadonlySet<string> = new Set(Object.keys(SHOT_BLUEPRINTS));
for (const [id, bp] of Object.entries(TURRET_BLUEPRINTS)) {
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'includeLockOnLevel1Buildings',
    bp.includeLockOnLevel1Buildings,
    KNOWN_BUILDING_IDS,
    'building',
  );
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'includeLockOnLevel1Towers',
    bp.includeLockOnLevel1Towers,
    KNOWN_TOWER_IDS,
    'tower',
  );
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'includeLockOnLevel1Units',
    bp.includeLockOnLevel1Units,
    KNOWN_UNIT_IDS,
    'unit',
  );
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'includeLockOnLevel1Turrets',
    bp.includeLockOnLevel1Turrets,
    KNOWN_TURRET_BLUEPRINT_IDS,
    'turret',
  );
  assertLevel1IdsInSet(
    `turret blueprint ${id}`,
    'includeLockOnLevel1Shots',
    bp.includeLockOnLevel1Shots,
    KNOWN_SHOT_IDS,
    'shot',
  );
}
for (const [id, bp] of Object.entries(UNIT_BLUEPRINTS)) {
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'includeLockOnLevel1Buildings',
    bp.includeLockOnLevel1Buildings,
    KNOWN_BUILDING_IDS,
    'building',
  );
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'includeLockOnLevel1Towers',
    bp.includeLockOnLevel1Towers,
    KNOWN_TOWER_IDS,
    'tower',
  );
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'includeLockOnLevel1Units',
    bp.includeLockOnLevel1Units,
    KNOWN_UNIT_IDS,
    'unit',
  );
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'includeLockOnLevel1Turrets',
    bp.includeLockOnLevel1Turrets,
    KNOWN_TURRET_BLUEPRINT_IDS,
    'turret',
  );
  assertLevel1IdsInSet(
    `unit blueprint ${id}`,
    'includeLockOnLevel1Shots',
    bp.includeLockOnLevel1Shots,
    KNOWN_SHOT_IDS,
    'shot',
  );
}
for (const [id, bp] of Object.entries(BUILDING_BLUEPRINTS)) {
  if (!isTowerBuildingBlueprintId(id as BuildingBlueprintId)) continue;
  const tower = bp as typeof bp & LockOnInclusionObject;
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'includeLockOnLevel1Buildings',
    tower.includeLockOnLevel1Buildings,
    KNOWN_BUILDING_IDS,
    'building',
  );
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'includeLockOnLevel1Towers',
    tower.includeLockOnLevel1Towers,
    KNOWN_TOWER_IDS,
    'tower',
  );
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'includeLockOnLevel1Units',
    tower.includeLockOnLevel1Units,
    KNOWN_UNIT_IDS,
    'unit',
  );
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'includeLockOnLevel1Turrets',
    tower.includeLockOnLevel1Turrets,
    KNOWN_TURRET_BLUEPRINT_IDS,
    'turret',
  );
  assertLevel1IdsInSet(
    `tower blueprint ${id}`,
    'includeLockOnLevel1Shots',
    tower.includeLockOnLevel1Shots,
    KNOWN_SHOT_IDS,
    'shot',
  );
}
