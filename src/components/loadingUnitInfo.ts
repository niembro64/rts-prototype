import { COST_MULTIPLIER } from '@/config';
import {
  getShotBlueprint,
  getTurretBlueprint,
  getUnitBlueprint,
  getUnitLocomotion,
} from '@/game/sim/blueprints';
import { createUnitRuntimeTurrets } from '@/game/sim/runtimeTurrets';
import type {
  LocomotionBlueprint,
  ShotBlueprint,
  UnitBlueprint,
} from '@/types/blueprints';
import type {
  ProjectileShot,
  ShotConfig,
  Turret,
  TurretConfig,
} from '@/game/sim/types';
import { isProjectileShot } from '@/game/sim/types';
import type { BuildableUnitBlueprintId } from '@/game/sim/blueprints';

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

export type LoadingUnitInfo = {
  summary: LoadingUnitInfoNode[];
  leftSections: LoadingUnitInfoSection[];
  rightSections: LoadingUnitInfoSection[];
};

type Firepower = {
  alphaDamage: number;
  sustainedDps: number;
};

export function buildLoadingUnitInfo(unitBlueprintId: BuildableUnitBlueprintId): LoadingUnitInfo {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const locomotion = getUnitLocomotion(unitBlueprintId);
  const turrets = createUnitRuntimeTurrets(unitBlueprintId, blueprint.radius.visual);
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
      stat('Mobility', `${labelCase(locomotion.type)} / ${locomotion.pathfinding.terrainMode}`),
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

function buildEconomySection(
  blueprint: UnitBlueprint,
  buildCost: { energy: number; metal: number },
): LoadingUnitInfoSection {
  return {
    id: 'economy',
    title: 'Unit',
    items: [
      stat('Blueprint', blueprint.unitBlueprintId),
      stat('Build cost', `${fmt(buildCost.energy)} energy / ${fmt(buildCost.metal)} metal`),
      stat('Hit points', fmt(blueprint.hp)),
      stat('Mass', fmt(blueprint.mass)),
      stat('Size', fmt(blueprint.radius.visual)),
      stat(
        'Fight-move stop',
        blueprint.fightStopEngagedRatio === null
          ? 'never; keeps moving'
          : `${fmt(blueprint.fightStopEngagedRatio * 100)}% turrets engaged`,
      ),
    ],
  };
}

function buildMovementSection(blueprint: UnitBlueprint): LoadingUnitInfoSection {
  const runtime = getUnitLocomotion(blueprint.unitBlueprintId);
  const locomotion = blueprint.locomotion;
  const items: LoadingUnitInfoNode[] = [
    stat('Type', labelCase(runtime.type)),
    stat('Profile', blueprint.locomotionBlueprintId),
    stat('Drive force', fmt(runtime.driveForce)),
    stat('Traction', fmt(runtime.traction, 2)),
    node('Pathfinding', locomotion.pathfindingBlueprintId, undefined, [
      stat('Terrain mode', runtime.pathfinding.terrainMode),
      stat('Ignores blocking', yesNo(runtime.pathfinding.ignoreTerrainBlocking)),
      stat('Max slope', runtime.pathfinding.maxSlopeDeg === null ? 'any' : `${fmt(runtime.pathfinding.maxSlopeDeg)} deg`),
      stat('Surface normal floor', fmt(runtime.pathfinding.minSurfaceNormalZ, 3)),
    ]),
    ...describeLocomotionConfig(locomotion),
  ];
  if (
    runtime.gravityCounterUpwardForceRatio !== undefined &&
    runtime.hoverHeightUpwardForce !== undefined
  ) {
    const gravityDeficit = 1 - runtime.gravityCounterUpwardForceRatio;
    if (gravityDeficit > 0) {
      items.push(stat('Stable altitude', fmt(runtime.hoverHeightUpwardForce / gravityDeficit)));
    }
  }
  return { id: 'movement', title: 'Movement', items };
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
      stat('Construction rate', `${fmt(blueprint.builder.constructionRate)}/s`),
    ]));
  }
  if (blueprint.dgun) {
    items.push(node('D-gun', blueprint.dgun.turretBlueprintId, undefined, [
      stat('Energy cost', fmt(blueprint.dgun.energyCost)),
    ]));
  }
  if (blueprint.detector) {
    items.push(stat('Detector radius', fmt(blueprint.detector.radius)));
  }
  if (blueprint.cloak) {
    items.push(stat('Cloak', blueprint.cloak.enabled ? 'available' : 'disabled'));
  }
  if (items.length === 0) items.push(stat('Special systems', 'none'));
  return { id: 'systems', title: 'Systems', items };
}

function describeTurret(turret: Turret, index: number): LoadingUnitInfoNode {
  const config = turret.config;
  const blueprint = getTurretBlueprint(config.turretBlueprintId);
  const firepower = computeTurretFirepower(config);
  const children: LoadingUnitInfoNode[] = [
    stat('Range', `fire ${rangePair(turret.ranges.fire.max)}${turret.ranges.tracking ? ` / track ${rangePair(turret.ranges.tracking)}` : ''}`),
    stat('Cooldown', config.cooldown > 0 ? ms(config.cooldown) : 'continuous'),
    stat('Firepower', firepower.sustainedDps > 0 ? `${fmt(firepower.sustainedDps, 1)} DPS` : 'utility'),
    stat('Aim', `${config.aimStyle.angleType}, ${config.aimStyle.lockOnType}`),
    stat('Line of sight', config.requiresNonObstructedLineOfSight ? 'required' : 'not required'),
    stat('Targeting', config.hostDirected ? 'host-directed' : 'autonomous'),
  ];

  if (config.spread) {
    children.push(stat('Spread', `${config.spread.pelletCount} pellets over ${rad(config.spread.angle)}`));
  }
  if (config.burst) {
    children.push(stat('Burst', `${config.burst.count} shots, ${ms(config.burst.delay)} spacing`));
  }
  if (config.verticalLauncher) children.push(stat('Launcher', 'vertical'));
  if (config.groundAimFraction !== undefined) {
    children.push(stat('Ground aim', `${fmt(config.groundAimFraction * 100)}% range`));
  }
  if (config.shot) children.push(describeShot(config.shot, blueprint.shotBlueprintId));
  const inclusions = describeLockOnInclusions(blueprint);
  if (inclusions.length > 0) children.push(node('Lock-on inclusions', undefined, undefined, inclusions));

  return node(
    `${index + 1}. ${config.turretBlueprintId}`,
    config.visualOnly ? 'visual' : blueprint.shotBlueprintId ?? 'utility',
    undefined,
    children,
  );
}

function describeShot(shot: ShotConfig, shotBlueprintId: string | null): LoadingUnitInfoNode {
  if (shot.type === 'forceField') {
    return node('Shot', 'force field', undefined, [
      stat('Arc', rad(shot.angle)),
      stat('Transition', ms(shot.transitionTime)),
      ...(shot.barrier ? [
        stat('Barrier outer radius', fmt(shot.barrier.outerRange)),
        stat('Barrier origin offset', fmt(shot.barrier.originOffsetZ)),
      ] : []),
    ]);
  }

  const label = shotBlueprintId ?? shot.shotBlueprintId;
  const children: LoadingUnitInfoNode[] = [stat('Type', shot.type)];
  if (shot.type === 'beam' || shot.type === 'laser') {
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
    children.push(
      stat('Mass', fmt(shot.mass)),
      stat('Launch force', fmt(shot.launchForce)),
      stat('Visual radius', fmt(shot.radius.visual)),
      stat('Hitbox radius', fmt(shot.radius.hitbox)),
      stat('Collision radius', fmt(shot.radius.collision)),
      stat('TTL', shot.maxLifespan === undefined ? 'impact/ground only' : ms(shot.maxLifespan)),
      stat('Detonate on expiry', yesNo(shot.detonateOnExpiry === true)),
    );
    if (shot.explosion) {
      children.push(node('Explosion', `${fmt(shot.explosion.damage)} damage`, undefined, [
        stat('Radius', fmt(shot.explosion.radius)),
        stat('Force', fmt(shot.explosion.force)),
      ]));
    } else {
      children.push(stat('Explosion', 'none'));
    }
    if (shot.homingTurnRate !== undefined || shot.homingThrust !== undefined) {
      children.push(node('Homing', 'guided', undefined, [
        stat('Turn rate', shot.homingTurnRate === undefined ? 'none' : `${fmt(shot.homingTurnRate, 2)} rad/s`),
        stat('Thrust', shot.homingThrust === undefined ? 'none' : fmt(shot.homingThrust)),
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
  return node('Shot', label, undefined, children);
}

function describeLocomotionConfig(locomotion: LocomotionBlueprint): LoadingUnitInfoNode[] {
  if (locomotion.type === 'hover' || locomotion.type === 'flying') {
    const config = locomotion.config;
    return [
      stat('Counter-gravity', `${fmt(config.gravityCounterUpwardForceRatio * 100)}%`),
      stat('Ground-effect lift', fmt(config.hoverHeightUpwardForce)),
    ];
  }
  return [];
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
  if (blueprint.includeLockOnLevel1Locomotions.length > 0) {
    items.push(stat('Locomotions', blueprint.includeLockOnLevel1Locomotions.join(', ')));
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
  if (shot.type === 'laser') {
    const alphaDamage = shot.dps * (shot.duration / 1000) * pelletCount * burstCount;
    const cycleMs = Math.max(shot.duration, config.cooldown, (burstCount - 1) * burstDelay + shot.duration);
    return {
      alphaDamage,
      sustainedDps: cycleMs > 0 ? (alphaDamage * 1000) / cycleMs : 0,
    };
  }
  if (isProjectileShot(shot)) {
    const alphaDamage = projectileDamageWithSubmunitions(shot) * pelletCount * burstCount;
    const cycleMs = Math.max(config.cooldown, (burstCount - 1) * burstDelay + 1);
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
  if (shot.type === 'beam') return shot.dps;
  if (shot.type === 'laser') return shot.dps * (shot.duration / 1000);
  if (shot.type === 'forceField') return 0;
  let damage = shot.explosion?.damage ?? 0;
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
  if (blueprint.locomotion.type === 'flying') return 'air strike';
  if (blueprint.locomotion.type === 'hover') return 'hover skirmisher';
  if (blueprint.locomotion.type === 'legs') return 'walker assault';
  if (blueprint.locomotion.type === 'treads') return 'armored assault';
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
