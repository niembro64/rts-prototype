import { COST_MULTIPLIER } from '@/config';
import {
  getBuildingBlueprint,
  getShotBlueprint,
  getTurretBlueprint,
  getUnitBlueprint,
  getUnitLocomotion,
} from '@/game/sim/blueprints';
import { createBuildingRuntimeTurrets, createUnitRuntimeTurrets } from '@/game/sim/runtimeTurrets';
import { BUILD_GRID_CELL_SIZE } from '@/game/sim/buildGrid';
import { getUnitBuilderConstructionRate } from '@/game/sim/builderBuildRoster';
import { getTurretCooldownDuration } from '@/game/sim/turretCooldown';
import { computeLocomotionClimbProfile } from '@/game/sim/pathfindingMobility';
import { getUnitLocomotionPrimaryPropulsionPhysics } from '@/game/sim/unitLocomotion';
import type { BuildingBlueprint } from '@/game/sim/blueprints';
import type {
  ShotBlueprint,
  UnitBlueprint,
} from '@/types/blueprints';
import type { UnitLocomotion } from '@/types/unitLocomotionTypes';
import type {
  EmissionConfig,
  ProjectileShot,
  Turret,
  TurretConfig,
} from '@/game/sim/types';
import { getEmissionBlueprintId, isProjectileShot, isRayConfig, isShieldConfig } from '@/game/sim/types';
import type { StructureBlueprintId, UnitBlueprintId } from '@/types/blueprintIds';
import type { LoadingEntityBlueprintId, LoadingPreviewKind } from './loadingUnitPreviewScene';

export type LoadingUnitInfoNode = {
  label: string;
  value?: string;
  detail?: string;
  children?: LoadingUnitInfoNode[];
};

export type LoadingUnitInfoSection = {
  id: string;
  title: string;
  items: LoadingUnitInfoNode[];
};

type LoadingUnitInfo = {
  summary: LoadingUnitInfoNode[];
  leftSections: LoadingUnitInfoSection[];
  rightSections: LoadingUnitInfoSection[];
};

type Firepower = {
  alphaDamage: number;
  sustainedDps: number;
};

export function buildLoadingEntityInfo(
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): LoadingUnitInfo {
  return kind === 'unit'
    ? buildUnitInfo(blueprintId as UnitBlueprintId)
    : buildBuildingInfo(blueprintId as StructureBlueprintId, kind === 'tower');
}

function buildUnitInfo(unitBlueprintId: UnitBlueprintId): LoadingUnitInfo {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const locomotion = getUnitLocomotion(unitBlueprintId);
  const turrets = createUnitRuntimeTurrets(unitBlueprintId, blueprint.radius.other);
  const damagingTurrets = turrets.filter((turret) => turret.config.shot && !turret.config.visualOnly);
  const firepower = turrets.reduce<Firepower>(
    (acc, turret) => {
      const next = computeTurretFirepower(turret.config);
      acc.alphaDamage += next.alphaDamage;
      acc.sustainedDps += next.sustainedDps;
      return acc;
    },
    { alphaDamage: 0, sustainedDps: 0 },
  );
  const longestRange = turrets.reduce(
    (best, turret) => Math.max(best, turret.ranges.fire.max.acquire),
    0,
  );
  const buildCost = {
    energy: blueprint.cost.energy * COST_MULTIPLIER,
    metal: blueprint.cost.metal * COST_MULTIPLIER,
  };

  return {
    summary: [
      stat('Role', summarizeUnitRole(blueprint, damagingTurrets.length)),
      stat('Cost', `${fmt(buildCost.energy)}E / ${fmt(buildCost.metal)}M`),
      stat('HP', fmt(blueprint.hp)),
      stat('Firepower', firepower.sustainedDps > 0 ? `${fmt(firepower.sustainedDps, 1)} DPS` : 'non-damaging'),
      stat('Range', longestRange > 0 ? fmt(longestRange) : 'none'),
      stat('Mobility', `${labelCase(locomotion.type)} / ${describeRouteMedia(blueprint)}`),
    ],
    leftSections: [
      buildEconomySection(blueprint, buildCost),
      buildMovementSection(blueprint),
    ],
    rightSections: [
      buildCombatSummarySection(turrets, firepower, longestRange),
      buildTurretsSection(turrets),
      buildSystemsSection(blueprint),
    ],
  };
}

function buildBuildingInfo(buildingBlueprintId: StructureBlueprintId, isTower: boolean): LoadingUnitInfo {
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  const turrets = isTower ? createBuildingRuntimeTurrets(buildingBlueprintId) : [];
  const damagingTurrets = turrets.filter((turret) => turret.config.shot && !turret.config.visualOnly);
  const firepower = turrets.reduce<Firepower>(
    (acc, turret) => {
      const next = computeTurretFirepower(turret.config);
      acc.alphaDamage += next.alphaDamage;
      acc.sustainedDps += next.sustainedDps;
      return acc;
    },
    { alphaDamage: 0, sustainedDps: 0 },
  );
  const longestRange = turrets.reduce(
    (best, turret) => Math.max(best, turret.ranges.fire.max.acquire),
    0,
  );
  const buildCost = {
    energy: blueprint.cost.energy * COST_MULTIPLIER,
    metal: blueprint.cost.metal * COST_MULTIPLIER,
  };
  const widthUnits = blueprint.gridWidth * BUILD_GRID_CELL_SIZE;
  const depthUnits = blueprint.gridHeight * BUILD_GRID_CELL_SIZE;

  const identitySection: LoadingUnitInfoSection = {
    id: 'identity',
    title: isTower ? 'Tower' : 'Building',
    items: [
      stat('Blueprint', blueprint.buildingBlueprintId),
      stat('Build cost', `${fmt(buildCost.energy)} energy / ${fmt(buildCost.metal)} metal`),
      stat('Hit points', fmt(blueprint.hp)),
      stat('Mass', fmt(blueprint.base.mass)),
      stat('Footprint', `${blueprint.gridWidth}x${blueprint.gridHeight} cells / ${fmt(widthUnits)}x${fmt(depthUnits)}`),
      stat('Visual height', fmt(blueprint.visualHeight)),
    ],
  };

  const functionItems = buildBuildingFunctionItems(blueprint);
  const functionSection: LoadingUnitInfoSection = {
    id: 'function',
    title: isTower ? 'Economy' : 'Function',
    items: functionItems.length > 0 ? functionItems : [stat('Output', 'passive structure')],
  };

  const summary: LoadingUnitInfoNode[] = [
    stat('Role', summarizeBuildingRole(blueprint, isTower, damagingTurrets.length)),
    stat('Cost', `${fmt(buildCost.energy)}E / ${fmt(buildCost.metal)}M`),
    stat('HP', fmt(blueprint.hp)),
    stat('Output', describeBuildingOutput(blueprint, firepower)),
    stat('Range', longestRange > 0 ? fmt(longestRange) : 'none'),
    stat('Footprint', `${blueprint.gridWidth}x${blueprint.gridHeight}`),
  ];

  if (isTower) {
    return {
      summary,
      leftSections: functionItems.length > 0 ? [identitySection, functionSection] : [identitySection],
      rightSections: [
        buildCombatSummarySection(turrets, firepower, longestRange),
        buildTurretsSection(turrets),
      ],
    };
  }
  return {
    summary,
    leftSections: [identitySection],
    rightSections: [functionSection],
  };
}

function buildBuildingFunctionItems(blueprint: BuildingBlueprint): LoadingUnitInfoNode[] {
  const items: LoadingUnitInfoNode[] = [];
  if (blueprint.energyProduction) items.push(stat('Energy output', `${fmt(blueprint.energyProduction)}/s`));
  if (blueprint.metalProduction) items.push(stat('Metal output', `${fmt(blueprint.metalProduction)}/s`));
  if (blueprint.constructionRate) items.push(stat('Construction rate', `${fmt(blueprint.constructionRate)}/s`));
  if (blueprint.conversionRate) items.push(stat('Conversion rate', `${fmt(blueprint.conversionRate)}/s`));
  return items;
}

function summarizeBuildingRole(
  blueprint: BuildingBlueprint,
  isTower: boolean,
  weaponCount: number,
): string {
  if (isTower && weaponCount > 0) return 'defense tower';
  if (blueprint.constructionRate) return 'unit fabricator';
  if (blueprint.conversionRate) return 'resource converter';
  if (blueprint.metalProduction) return 'metal extractor';
  if (blueprint.energyProduction) return 'energy generator';
  if (blueprint.buildingBlueprintId === 'buildingRadar') return 'radar';
  return isTower ? 'static host' : 'structure';
}

function describeBuildingOutput(blueprint: BuildingBlueprint, firepower: Firepower): string {
  if (firepower.sustainedDps > 0) return `${fmt(firepower.sustainedDps, 1)} DPS`;
  if (blueprint.energyProduction) return `+${fmt(blueprint.energyProduction)} energy/s`;
  if (blueprint.metalProduction) return `+${fmt(blueprint.metalProduction)} metal/s`;
  if (blueprint.constructionRate) return `${fmt(blueprint.constructionRate)} build/s`;
  if (blueprint.conversionRate) return `${fmt(blueprint.conversionRate)} conv/s`;
  if (blueprint.buildingBlueprintId === 'buildingRadar') return 'radar';
  return 'passive';
}

function buildEconomySection(
  blueprint: UnitBlueprint,
  buildCost: { energy: number; metal: number },
): LoadingUnitInfoSection {
  const fightStopMounts = blueprint.turrets
    .filter((mount) => mount.requiredEngagedForFightStop)
    .map((mount) => mount.turretBlueprintId);
  return {
    id: 'economy',
    title: 'Unit',
    items: [
      stat('Blueprint', blueprint.unitBlueprintId),
      stat('Build cost', `${fmt(buildCost.energy)} energy / ${fmt(buildCost.metal)} metal`),
      stat('Hit points', fmt(blueprint.hp)),
      stat('Mass', fmt(blueprint.mass)),
      stat('Size', fmt(blueprint.radius.other)),
      stat(
        'Fight-move stop',
        fightStopMounts.length === 0
          ? 'never; keeps moving'
          : `requires ${fightStopMounts.join(', ')}`,
      ),
    ],
  };
}

function buildMovementSection(blueprint: UnitBlueprint): LoadingUnitInfoSection {
  const runtime = getUnitLocomotion(blueprint.unitBlueprintId);
  const climb = computeLocomotionClimbProfile(runtime, blueprint.mass);
  const primaryPhysics = getUnitLocomotionPrimaryPropulsionPhysics(runtime);
  const items: LoadingUnitInfoNode[] = [
    stat('Type', labelCase(runtime.type)),
    stat('Maximum propulsive force', fmt(primaryPhysics.maxPropulsiveForce)),
    node('Route media', labelCase(runtime.type), undefined, [
      stat(
        'Media',
        [
          climb.allowOnGround ? 'on ground' : '',
          climb.allowInWater ? 'in water' : '',
          climb.allowInAir ? 'in air' : '',
        ].filter(Boolean).join(' / ') || 'none',
      ),
      stat('Max slope', climb.maxSlopeDeg === null ? 'any' : `${fmt(climb.maxSlopeDeg)} deg`),
      stat('Standstill normal floor', climb.minStandstillNormalZ === null ? 'any' : fmt(climb.minStandstillNormalZ, 3)),
    ]),
    ...describeLocomotionPhysics(runtime),
  ];
  return { id: 'movement', title: 'Movement', items };
}

function describeRouteMedia(blueprint: UnitBlueprint): string {
  const climb = computeLocomotionClimbProfile(
    getUnitLocomotion(blueprint.unitBlueprintId),
    blueprint.mass,
  );
  return [
    climb.allowOnGround ? 'ground' : '',
    climb.allowInWater ? 'water' : '',
    climb.allowInAir ? 'air' : '',
  ].filter(Boolean).join('+') || 'immobile';
}

function buildCombatSummarySection(
  turrets: readonly Turret[],
  firepower: Firepower,
  longestRange: number,
): LoadingUnitInfoSection {
  const damagingTurrets = turrets.filter((turret) => turret.config.shot && !turret.config.visualOnly);
  const visualOnly = turrets.length - damagingTurrets.length;
  return {
    id: 'combat-summary',
    title: 'Combat',
    items: [
      stat('Turrets', `${turrets.length} total / ${damagingTurrets.length} weapon${plural(damagingTurrets.length)}`),
      stat('Visual systems', visualOnly > 0 ? fmt(visualOnly) : 'none'),
      stat('Alpha strike', firepower.alphaDamage > 0 ? fmt(firepower.alphaDamage, 1) : 'none'),
      stat('Sustained damage', firepower.sustainedDps > 0 ? `${fmt(firepower.sustainedDps, 1)} DPS` : 'none'),
      stat('Longest fire range', longestRange > 0 ? fmt(longestRange) : 'none'),
      stat('Manual weapons', fmt(turrets.filter((turret) => turret.config.isManualFire).length)),
      stat('Host-directed weapons', fmt(turrets.filter((turret) => turret.config.hostDirected).length)),
    ],
  };
}

function buildTurretsSection(turrets: readonly Turret[]): LoadingUnitInfoSection {
  return {
    id: 'turrets',
    title: 'Turrets',
    items: turrets.map((turret, index) => describeTurret(turret, index)),
  };
}

function buildSystemsSection(blueprint: UnitBlueprint): LoadingUnitInfoSection {
  const items: LoadingUnitInfoNode[] = [];
  if (blueprint.builder) {
    items.push(node('Builder', 'construction capable', undefined, [
      stat('Build range', fmt(blueprint.builder.buildRange)),
      stat('Construction rate', `${fmt(getUnitBuilderConstructionRate(blueprint))}/s`),
    ]));
  }
  if (blueprint.dgun) {
    items.push(node('D-gun', blueprint.dgun.turretBlueprintId, undefined, [
      stat('Energy cost', fmt(blueprint.dgun.energyCost)),
    ]));
  }
  if (items.length === 0) items.push(stat('Special systems', 'none'));
  return { id: 'systems', title: 'Systems', items };
}

function describeTurret(turret: Turret, index: number): LoadingUnitInfoNode {
  const config = turret.config;
  const blueprint = getTurretBlueprint(config.turretBlueprintId);
  const firepower = computeTurretFirepower(config);
  const cooldownDuration = getTurretCooldownDuration(config.cooldown);
  const children: LoadingUnitInfoNode[] = [
    stat('Range', `fire ${rangePair(turret.ranges.fire.max)}${turret.ranges.tracking ? ` / track ${rangePair(turret.ranges.tracking)}` : ''}`),
    stat('Cooldown', cooldownDuration > 0 ? ms(cooldownDuration) : 'continuous'),
    stat('Firepower', firepower.sustainedDps > 0 ? `${fmt(firepower.sustainedDps, 1)} DPS` : 'utility'),
    stat('Aim', config.aimStyle.angleType),
    stat('Line of sight', config.requiresNonObstructedLineOfSight ? 'required' : 'not required'),
    stat('Targeting', config.hostDirected ? 'host-directed' : 'autonomous'),
    stat('Fight-move stop', config.requiredEngagedForFightStop ? 'required engaged' : 'not required'),
  ];

  if (config.spread) {
    children.push(stat('Spread', `${config.spread.pelletCount} pellets over ${rad(config.spread.angle)}`));
  }
  if (config.burst) {
    children.push(stat('Burst', `${config.burst.count} shots, ${ms(config.burst.delay)} spacing`));
  }
  if (config.verticalLauncher) children.push(stat('Launcher', 'vertical'));
  if (config.groundAimFraction !== null) {
    children.push(stat('Ground aim', `${fmt(config.groundAimFraction * 100)}% range`));
  }
  if (config.shot) children.push(describeEmission(config.shot, blueprint.emissionBlueprintId));
  const inclusions = describeLockOnInclusions(blueprint);
  if (inclusions.length > 0) children.push(node('Lock-on inclusions', undefined, undefined, inclusions));

  return node(
    `${index + 1}. ${config.turretBlueprintId}`,
    config.visualOnly ? 'visual' : blueprint.emissionBlueprintId ?? 'utility',
    undefined,
    children,
  );
}

function describeEmission(shot: EmissionConfig, blueprintId: string | null): LoadingUnitInfoNode {
  if (isShieldConfig(shot)) {
    return node('Emission', 'shield', undefined, [
      stat('Arc', rad(shot.angle)),
      stat('Transition', ms(shot.transitionTime)),
      ...(shot.barrier ? [
        stat('Barrier outer radius', fmt(shot.barrier.outerRange)),
        stat('Barrier origin offset', fmt(shot.barrier.originOffsetZ)),
      ] : []),
    ]);
  }

  const label = blueprintId ?? getEmissionBlueprintId(shot);
  const children: LoadingUnitInfoNode[] = [stat('Type', shot.type)];
  if (isRayConfig(shot)) {
    children.push(
      stat('DPS', fmt(shot.dps, 1)),
      stat('Width', fmt(shot.width)),
      stat('Trace radius', fmt(shot.radius)),
      stat('Endpoint radius', fmt(shot.damageSphere.radius)),
      stat('Force', fmt(shot.force)),
      stat('Recoil', fmt(shot.recoil)),
    );
    if (shot.type === 'laser') children.push(stat('Duration', ms(shot.duration)));
  } else {
    const shotLocomotion = shot.shotLocomotion;
    const maxLifespanMs = shotLocomotion.maxLifespanMs;
    const maxTurnRate = Math.max(
      shotLocomotion.media.air.turnRate,
      shotLocomotion.media.water.turnRate,
    );
    const maxGuidanceThrust = Math.max(
      shotLocomotion.media.air.guidanceThrust,
      shotLocomotion.media.water.guidanceThrust,
    );
    children.push(
      stat('Mass', fmt(shot.mass)),
      stat('Launch force', fmt(shot.launchForce)),
      stat('Visual radius', fmt(shot.radius.other)),
      stat('Hitbox radius', fmt(shot.radius.hitbox)),
      stat('Collision radius', fmt(shot.radius.collision)),
      stat('Locomotion', `${shotLocomotion.motionModel} (${shotLocomotion.presetId})`),
      stat('TTL', maxLifespanMs === null ? 'impact/ground only' : ms(maxLifespanMs)),
      stat('Detonate on expiry', yesNo(shotLocomotion.terminal.expiry === 'detonate')),
    );
    if (shot.explosion) {
      children.push(node('Explosion', `${fmt(shot.explosion.damage)} damage`, undefined, [
        stat('Radius', fmt(shot.explosion.radius)),
        stat('Force', fmt(shot.explosion.force)),
      ]));
    } else {
      children.push(stat('Explosion', 'none'));
    }
    if (maxTurnRate > 0 || maxGuidanceThrust > 0) {
      children.push(node('Homing', 'guided', undefined, [
        stat('Turn rate', maxTurnRate > 0 ? `${fmt(maxTurnRate, 2)} rad/s` : 'none'),
        stat('Thrust', maxGuidanceThrust > 0 ? fmt(maxGuidanceThrust) : 'none'),
      ]));
    }
    if (shot.submunitions) {
      children.push(node('Submunitions', `${shot.submunitions.count} x ${shot.submunitions.shotBlueprintId}`, undefined, [
        stat('Horizontal spread', fmt(shot.submunitions.randomSpreadSpeedHorizontal)),
        stat('Vertical spread', fmt(shot.submunitions.randomSpreadSpeedVertical)),
        stat('Velocity damper', fmt(shot.submunitions.reflectedVelocityDamper ?? 1, 2)),
      ]));
    }
    if (shot.smokeTrail) {
      children.push(stat('Smoke trail', shot.smokeTrail.useId ?? 'custom'));
    }
  }
  return node('Emission', label, undefined, children);
}

function describeLocomotionPhysics(locomotion: UnitLocomotion): LoadingUnitInfoNode[] {
  const items: LoadingUnitInfoNode[] = [];
  const air = locomotion.physics.air;
  if (
    air.maxPropulsiveForce > 0 ||
    air.resistance.linearDampingRate > 0 ||
    air.lift.buoyancyRatio > 0 ||
    air.lift.surfaceFollowingForceFromGround > 0 ||
    air.lift.surfaceFollowingForceFromWater > 0
  ) {
    const airChildren = [
      stat('Maximum propulsive force', fmt(air.maxPropulsiveForce)),
      stat('Linear damping rate', fmt(air.resistance.linearDampingRate, 2)),
      stat('Angular damping rate', fmt(air.resistance.angularDampingRate, 2)),
    ];
    if (air.lift.buoyancyRatio > 0) {
      airChildren.push(stat('Buoyancy ratio', fmt(air.lift.buoyancyRatio, 2)));
    }
    if (air.lift.surfaceFollowingForceFromGround > 0) {
      airChildren.push(
        stat('Surface-following force from ground', fmt(air.lift.surfaceFollowingForceFromGround)),
      );
    }
    if (air.lift.surfaceFollowingForceFromWater > 0) {
      airChildren.push(
        stat('Surface-following force from water', fmt(air.lift.surfaceFollowingForceFromWater)),
      );
    }
    items.push(node('Air medium', undefined, undefined, airChildren));
  }

  const water = locomotion.physics.water;
  if (
    water.maxPropulsiveForce > 0 ||
    water.resistance.linearDampingRate > 0 ||
    water.lift.buoyancyRatio > 0 ||
    water.lift.surfaceFollowingForceFromGround > 0
  ) {
    const waterChildren = [
      stat('Maximum propulsive force', fmt(water.maxPropulsiveForce)),
      stat('Linear damping rate', fmt(water.resistance.linearDampingRate, 2)),
      stat('Angular damping rate', fmt(water.resistance.angularDampingRate, 2)),
    ];
    if (water.lift.buoyancyRatio > 0) {
      waterChildren.push(stat('Buoyancy ratio', fmt(water.lift.buoyancyRatio, 2)));
    }
    if (water.lift.surfaceFollowingForceFromGround > 0) {
      waterChildren.push(
        stat('Surface-following force from ground', fmt(water.lift.surfaceFollowingForceFromGround)),
      );
    }
    items.push(node('Water medium', undefined, undefined, waterChildren));
  }
  return items;
}

function describeLockOnInclusions(blueprint: ReturnType<typeof getTurretBlueprint>): LoadingUnitInfoNode[] {
  const items: LoadingUnitInfoNode[] = [];
  if (blueprint.includeLockOnLevel0FriendsAndEnemies.length > 0) {
    items.push(stat('Relationships', blueprint.includeLockOnLevel0FriendsAndEnemies.join(', ')));
  }
  if (blueprint.includeLockOnLevel0Entities.length > 0) {
    items.push(stat('Families', blueprint.includeLockOnLevel0Entities.join(', ')));
  }
  if (blueprint.includeLockOnLevel1Buildings.length > 0) {
    items.push(stat('Buildings', blueprint.includeLockOnLevel1Buildings.join(', ')));
  }
  if (blueprint.includeLockOnLevel1Towers.length > 0) {
    items.push(stat('Towers', blueprint.includeLockOnLevel1Towers.join(', ')));
  }
  if (blueprint.includeLockOnLevel1Units.length > 0) {
    items.push(stat('Units', blueprint.includeLockOnLevel1Units.join(', ')));
  }
  if (blueprint.includeLockOnLevel1Turrets.length > 0) {
    items.push(stat('Turrets', blueprint.includeLockOnLevel1Turrets.join(', ')));
  }
  if (blueprint.includeLockOnLevel1Shots.length > 0) {
    items.push(stat('Shots', blueprint.includeLockOnLevel1Shots.join(', ')));
  }
  return items;
}

function computeTurretFirepower(config: TurretConfig): Firepower {
  const shot = config.shot;
  if (!shot) return { alphaDamage: 0, sustainedDps: 0 };
  const pelletCount = config.spread?.pelletCount ?? 1;
  const burstCount = config.burst?.count ?? 1;
  const burstDelay = config.burst?.delay ?? 80;
  if (shot.type === 'beam') {
    return { alphaDamage: shot.dps, sustainedDps: shot.dps };
  }
  const cooldownDuration = getTurretCooldownDuration(config.cooldown);
  if (shot.type === 'laser') {
    const alphaDamage = shot.dps * (shot.duration / 1000) * pelletCount * burstCount;
    const cycleMs = Math.max(shot.duration, cooldownDuration, (burstCount - 1) * burstDelay + shot.duration);
    return {
      alphaDamage,
      sustainedDps: cycleMs > 0 ? (alphaDamage * 1000) / cycleMs : 0,
    };
  }
  if (isProjectileShot(shot)) {
    const alphaDamage = projectileDamageWithSubmunitions(shot) * pelletCount * burstCount;
    const cycleMs = Math.max(cooldownDuration, (burstCount - 1) * burstDelay + 1);
    return {
      alphaDamage,
      sustainedDps: cycleMs > 0 ? (alphaDamage * 1000) / cycleMs : 0,
    };
  }
  return { alphaDamage: 0, sustainedDps: 0 };
}

function projectileDamageWithSubmunitions(shot: ProjectileShot, depth = 0): number {
  let damage = shot.explosion?.damage ?? 0;
  if (shot.submunitions && depth < 2) {
    try {
      const childBlueprint = getShotBlueprint(shot.submunitions.shotBlueprintId);
      const childDamage = projectileBlueprintDamage(childBlueprint, depth + 1);
      damage += shot.submunitions.count * childDamage;
    } catch {
      // Keep loading UI resilient if a hot-reloaded shot reference is invalid.
    }
  }
  return damage;
}

function projectileBlueprintDamage(shot: ShotBlueprint, depth: number): number {
  // base.deathExplosion is the single source of truth for a shot's blast
  // (the runtime `explosion` cache is derived from it in buildShotConfig).
  let damage = shot.base.deathExplosion.radius > 0 ? shot.base.deathExplosion.damage : 0;
  if (shot.submunitions && depth < 2) {
    try {
      damage += shot.submunitions.count * projectileBlueprintDamage(
        getShotBlueprint(shot.submunitions.shotBlueprintId),
        depth + 1,
      );
    } catch {
      // Loading UI should not fail on bad hot-reload data.
    }
  }
  return damage;
}

function summarizeUnitRole(blueprint: UnitBlueprint, weaponCount: number): string {
  if (blueprint.builder) return 'builder / support';
  if (weaponCount === 0) return 'utility';
  if (blueprint.unitLocomotion.type === 'flying' || blueprint.unitLocomotion.type === 'dive') return 'air strike';
  if (blueprint.unitLocomotion.type === 'submarine') return 'underwater assault';
  if (blueprint.unitLocomotion.type === 'hover') return 'hover skirmisher';
  if (blueprint.unitLocomotion.type === 'legs') return 'walker assault';
  if (blueprint.unitLocomotion.type === 'treads') return 'armored assault';
  return 'wheeled combat';
}

function node(
  label: string,
  value?: string,
  detail?: string,
  children?: LoadingUnitInfoNode[],
): LoadingUnitInfoNode {
  return { label, value, detail, children };
}

function stat(label: string, value: string): LoadingUnitInfoNode {
  return { label, value };
}

function fmt(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return 'n/a';
  const fixed = decimals > 0 ? value.toFixed(decimals) : Math.round(value).toString();
  return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function ms(value: number): string {
  return value >= 1000 ? `${fmt(value / 1000, 2)}s` : `${fmt(value)}ms`;
}

function rad(value: number): string {
  return `${fmt(value, 2)} rad`;
}

function rangePair(range: { acquire: number; release: number }): string {
  return `${fmt(range.acquire)}/${fmt(range.release)}`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function labelCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}
