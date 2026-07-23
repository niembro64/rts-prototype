import {
  UNIT_HP_MULTIPLIER,
  UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
} from '../../config';
import {
  createCombatComponent,
  createEmptyEntityComponentSlots,
  createTransform,
  NO_ENTITY_ID,
} from './types';
import type {
  Entity,
  EntityId,
  PlayerId,
  SensorCapabilityConfig,
  UnitLocomotion,
  UnitSupportSurface,
} from './types';
import type { WorldSupportSurface } from './supportSurface';
import { getUnitBlueprint, getUnitLocomotion } from './blueprints';
import { cloneUnitLocomotion } from './unitLocomotion';
import { createUnitRuntimeTurrets } from './runtimeTurrets';
import { buildShieldPanelCache } from './shieldPanelCache';
import { cloneUnitSupportSurface } from './unitSupportSurface';
import { createTransportComponentForUnitBlueprint } from './transports';
import { REAL_BATTLE_FACTORY_WAYPOINT_TYPE } from '../../config';
import {
  unitBlueprintBarDefaultFireState,
  unitBlueprintBarDefaultMoveState,
} from './unitCommandCapabilities';
import { cloneSensorCapabilityConfig } from './sensorConfig';

export type CreateUnitFromBlueprintOptions = {
  allocateSubEntityIds?: boolean;
};

type CreateUnitFromBlueprintContext = {
  generateEntityId: () => EntityId;
  sampleSupportSurface: (x: number, y: number) => WorldSupportSurface;
};

type UnitRadius = {
  other: number;
  hitbox: number;
  collision: number;
};

type CreateUnitBaseArgs = {
  id: EntityId;
  x: number;
  y: number;
  playerId: PlayerId;
  unitBlueprintId: string;
  radius: UnitRadius;
  supportPointOffsetZ: number;
  supportSurface: UnitSupportSurface;
  sensors: SensorCapabilityConfig;
  locomotion: UnitLocomotion;
  mass: number;
  hp: number;
  spawnSupport: WorldSupportSurface;
};

function createUnitBaseEntity({
  id,
  x,
  y,
  playerId,
  unitBlueprintId,
  radius,
  supportPointOffsetZ,
  supportSurface,
  sensors,
  locomotion,
  mass,
  hp,
  spawnSupport,
}: CreateUnitBaseArgs): Entity {
  const spawnCenterHeight = supportPointOffsetZ + UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND;

  return {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(x, y, spawnSupport.groundZ + spawnCenterHeight, 0),
    selectable: { selected: false },
    ownership: { playerId },
    unit: {
      unitBlueprintId,
      locomotion: cloneUnitLocomotion(locomotion),
      radius: { ...radius },
      supportPointOffsetZ,
      supportSurface: cloneUnitSupportSurface(supportSurface),
      sensors: cloneSensorCapabilityConfig(sensors),
      mass,
      hp,
      maxHp: hp,
      actions: [],
      actionHash: 0,
      repeatQueue: false,
      moveState: 'maneuver',
      wantCloak: false,
      cloaked: false,
      cloakRestoreFireState: null,
      patrolStartIndex: null,
      activePath: null,
      flyingLoiterTargetX: null,
      flyingLoiterTargetY: null,
      flyingLoiterTargetZ: null,
      flyingLoiterTurnSign: null,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      thrustDirX: 0,
      thrustDirY: 0,
      headingDirX: 0,
      headingDirY: 0,
      suspension: null,
      shieldPanels: [],
      shieldBoundRadius: 0,
      surfaceNormal: {
        nx: spawnSupport.normalX,
        ny: spawnSupport.normalY,
        nz: spawnSupport.normalZ,
      },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      angularVelocity3: { x: 0, y: 0, z: 0 },
      stuckTicks: 0,
    },
  };
}

export function createUnitFromBlueprintEntity(
  context: CreateUnitFromBlueprintContext,
  x: number,
  y: number,
  playerId: PlayerId,
  unitBlueprintId: string,
  options: CreateUnitFromBlueprintOptions = {},
): Entity {
  const bp = getUnitBlueprint(unitBlueprintId);
  const allocateSubEntityIds = options.allocateSubEntityIds !== false;
  const entity = createUnitBaseEntity({
    id: context.generateEntityId(),
    x,
    y,
    playerId,
    unitBlueprintId,
    radius: bp.radius,
    supportPointOffsetZ: bp.supportPointOffsetZ,
    supportSurface: cloneUnitSupportSurface(bp.supportSurface),
    sensors: cloneSensorCapabilityConfig(bp.sensors),
    locomotion: getUnitLocomotion(unitBlueprintId),
    mass: bp.mass,
    hp: bp.hp * UNIT_HP_MULTIPLIER,
    spawnSupport: context.sampleSupportSurface(x, y),
  });

  entity.unit!.suspension = null;
  entity.combat = createCombatComponent(createUnitRuntimeTurrets(
    unitBlueprintId,
    bp.radius.other,
    entity.id,
    entity.id,
    allocateSubEntityIds ? context.generateEntityId : null,
  ));
  entity.unit!.moveState = unitBlueprintBarDefaultMoveState(unitBlueprintId);
  const defaultFireState = unitBlueprintBarDefaultFireState(unitBlueprintId);
  entity.combat.fireState = defaultFireState;
  entity.combat.fireEnabled = defaultFireState !== 'holdFire';
  entity.unit!.shieldBoundRadius = buildShieldPanelCache(
    bp,
    entity.unit!.shieldPanels,
  );

  if (bp.builder) {
    entity.builder = {
      buildRange: bp.builder.buildRange,
      lowPriority: false,
      currentBuildTarget: NO_ENTITY_ID,
    };
  }

  // A unit whose spawn turret declares a produced unit is a mobile factory. The
  // production system resolves that mount through the generic EntityHold
  // relation while the shell is being built. Queens build their bees / ticks
  // this way. The factory is derived from the turret — there is no authored
  // factory block on the unit blueprint.
  const spawnMount = bp.turrets.find((m) => m.producedBlueprintId != null);
  if (spawnMount !== undefined && spawnMount.producedBlueprintId != null) {
      entity.factory = {
        selectedUnitBlueprintId: spawnMount.producedBlueprintId,
        lowPriority: false,
        carrierSpawnEnabled: true,
        moveState: 'maneuver',
        airIdleState: 'fly',
        repeatProduction: true,
      paused: false,
      productionQueue: [],
      productionQuotas: {},
      productionQuotaCounts: {},
      resumeRepeatUnitBlueprintId: null,
      currentShellId: null,
      currentBuildProgress: 0,
      defaultWaypoints: null,
      rallyX: x,
      rallyY: y,
      rallyZ: null,
      rallyType: REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
      guardTargetId: null,
      // A queen is a continuous spawn-turret producer:
      // it builds its bee/tick from spawn, funded over time, with no player
      // queue command -- unlike a fabricator, which a player toggles on.
      isProducing: true,
      energyRateFraction: 0,
      metalRateFraction: 0,
    };
  }

  if (bp.dgun) {
    entity.commander = {
      isDGunActive: false,
      dgunEnergyCost: bp.dgun.energyCost,
    };
  }

  entity.transport = createTransportComponentForUnitBlueprint(unitBlueprintId);

  return entity;
}
