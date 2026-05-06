/**
 * Blueprint System — Re-exports + derived config builders
 */

export * from './types';
export * from './shots';
export * from './turrets';
export * from './unitRoster';
export * from './units';
export * from './buildings';
export * from './fallbacks';

import type {
  BeamShot,
  BuildSprayShot,
  ForceFieldBarrierConfig,
  ForceShot,
  LaserShot,
  ActiveProjectileShot,
  ProjectileShot,
  ShotConfig,
  TurretConfig,
} from '../types';
import { isLineShotBlueprint } from '@/types/blueprints';
import type { ShotId, TurretId } from '../../../types/blueprintIds';
import { SHOT_BLUEPRINTS } from './shots';
import { TURRET_BLUEPRINTS } from './turrets';
import { UNIT_BLUEPRINTS } from './units';
import { BUILDING_BLUEPRINTS } from './buildings';
import type {
  ShotBlueprint,
  ForceFieldBarrierRatioConfig,
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

/** Compute a ForceFieldBarrierConfig from ratio-based blueprint data and weapon range. */
function computeBarrierConfig(
  barrier: ForceFieldBarrierRatioConfig | undefined,
  range: number,
): ForceFieldBarrierConfig | null {
  if (!barrier) return null;
  const outerRange =
    barrier.rimWidth != null
      ? barrier.rimWidth
      : range * (barrier.outerRatio ?? 1);
  return {
    innerRange: 0,
    outerRange,
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
 *  `shotBlueprint.homingTurnRate` for projectile shots. */
function buildShotConfig(
  shotBlueprint: ShotBlueprint,
  launchForce?: number,
): ShotConfig {
  if (shotBlueprint.type === 'buildSpray') {
    const shot: BuildSprayShot = {
      type: 'buildSpray',
      id: shotBlueprint.id,
      // ignoresGravity is intrinsic to the type — the literal `true`
      // keeps consumers from having to defaulting it themselves.
      ignoresGravity: true,
      lifespan: shotBlueprint.lifespan,
      speed: shotBlueprint.speed,
      visualRadius: shotBlueprint.visualRadius,
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
    };
    return shot;
  }

  // Traveling projectile / rocket shot
  const shot: ProjectileShot = {
    type: shotBlueprint.type,
    id: shotBlueprint.id,
    mass: shotBlueprint.mass,
    launchForce: launchForce ?? 0,
    collision: shotBlueprint.collision,
    explosion: shotBlueprint.explosion,
    detonateOnExpiry: shotBlueprint.detonateOnExpiry || undefined,
    lifespan: shotBlueprint.lifespan,
    lifespanVariance: shotBlueprint.lifespanVariance,
    homingTurnRate: shotBlueprint.homingTurnRate,
    submunitions: shotBlueprint.submunitions,
    ignoresGravity:
      shotBlueprint.type === 'rocket'
        ? (shotBlueprint.ignoresGravity ?? true)
        : shotBlueprint.ignoresGravity,
    smokeTrail: shotBlueprint.smokeTrail,
    shape: shotBlueprint.shape,
    cylinderShape: shotBlueprint.cylinderShape,
  };
  return shot;
}

export function buildProjectileShotConfig(
  shotId: ShotId,
  launchForce?: number,
): ActiveProjectileShot {
  const shotBlueprint = SHOT_BLUEPRINTS[shotId];
  if (!shotBlueprint) throw new Error(`Unknown shot blueprint: ${shotId}`);
  const shot = buildShotConfig(shotBlueprint, launchForce);
  if (shot.type === 'force' || shot.type === 'buildSpray') {
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

  // Determine shot config
  let shot: ShotConfig;

  if (turretBlueprint.forceField) {
    // Force field turret: build a classic projectile barrier.
    const fieldShot: ForceShot = {
      type: 'force',
      angle: turretBlueprint.forceField.angle ?? Math.PI * 2,
      transitionTime: turretBlueprint.forceField.transitionTime ?? 1000,
      barrier:
        computeBarrierConfig(
          turretBlueprint.forceField.barrier,
          turretBlueprint.range,
        ) ?? undefined,
    };
    shot = fieldShot;
  } else if (turretBlueprint.projectileId) {
    // Projectile or beam turret
    const shotBlueprint = SHOT_BLUEPRINTS[turretBlueprint.projectileId];
    if (!shotBlueprint)
      throw new Error(
        `Unknown projectile in turret ${turretId}: ${turretBlueprint.projectileId}`,
      );
    shot = buildShotConfig(shotBlueprint, turretBlueprint.launchForce);
  } else {
    throw new Error(
      `Turret ${turretId} has neither projectileId nor forceField`,
    );
  }

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
    shot,
    highArc: turretBlueprint.highArc ?? false,
    verticalLauncher: turretBlueprint.verticalLauncher ?? false,
    idlePitch: turretBlueprint.idlePitch,
    groundAimFraction: turretBlueprint.groundAimFraction,
    radius: { ...turretBlueprint.radius },
    // visualOnly used to be derived from the presence of the
    // constructionEmitter side-field. Now the construction turret
    // declares its identity via `projectileId: 'buildSpray'`, so the
    // shot type itself drives visualOnly: build-spray emitters do not
    // participate in the auto-targeting / firing pipeline.
    visualOnly: shot.type === 'buildSpray',
    constructionEmitter: turretBlueprint.constructionEmitter
      ? {
          defaultSize: turretBlueprint.constructionEmitter.defaultSize,
          sizes: {
            small: { ...turretBlueprint.constructionEmitter.sizes.small },
            large: { ...turretBlueprint.constructionEmitter.sizes.large },
          },
        }
      : undefined,
  };

  // Derive barrelThickness from shot size, scaled by global multiplier
  if (
    turretBlueprint.projectileId &&
    config.barrel &&
    config.barrel.type !== 'complexSingleEmitter'
  ) {
    const shotBlueprint: ShotBlueprint =
      SHOT_BLUEPRINTS[turretBlueprint.projectileId];
    let rawThickness: number;
    if (isLineShotBlueprint(shotBlueprint)) {
      rawThickness = shotBlueprint.width;
    } else if (shotBlueprint.type === 'buildSpray') {
      rawThickness = shotBlueprint.visualRadius * 2;
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
  if (turretBlueprint.spread) config.spread = { ...turretBlueprint.spread };
  if (turretBlueprint.burst) config.burst = { ...turretBlueprint.burst };
  if (turretBlueprint.isManualFire != null) {
    config.isManualFire = turretBlueprint.isManualFire;
  }
  if (turretBlueprint.passive != null) config.passive = turretBlueprint.passive;

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
  for (let i = 0; i < turrets.length; i++) {
    const turretId = turrets[i].turretId;
    if (!TURRET_BLUEPRINTS[turretId]) {
      throw new Error(
        `Invalid building turret reference for ${bp.id}[${i}]: unknown turretId "${turretId}"`,
      );
    }
  }
}
