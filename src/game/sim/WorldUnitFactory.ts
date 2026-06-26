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
import { cloneUnitLocomotion } from './locomotion';
import { createUnitRuntimeTurrets } from './runtimeTurrets';
import { buildShieldPanelCache } from './shieldPanelCache';
import { cloneUnitSupportSurface } from './unitSupportSurface';
import { createTransportComponentForUnitBlueprint } from './transports';

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
  bodyCenterHeight: number;
  supportSurface: UnitSupportSurface;
  fullVisionRadius: number;
  sensors: SensorCapabilityConfig;
  locomotion: UnitLocomotion;
  mass: number;
  airFrictionPer60HzFrame: number;
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
  bodyCenterHeight,
  supportSurface,
  fullVisionRadius,
  sensors,
  locomotion,
  mass,
  airFrictionPer60HzFrame,
  hp,
  spawnSupport,
}: CreateUnitBaseArgs): Entity {
  const isAirborneLocomotion =
    locomotion.type === 'hover' || locomotion.type === 'flying';
  const spawnCenterHeight = bodyCenterHeight + UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND;

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
      bodyCenterHeight,
      supportSurface: cloneUnitSupportSurface(supportSurface),
      fullVisionRadius,
      sensors: { ...sensors },
      mass,
      airFrictionPer60HzFrame,
      hp,
      maxHp: hp,
      actions: [],
      actionHash: 0,
      repeatQueue: false,
      moveState: 'maneuver',
      wantCloak: false,
      cloaked: false,
      patrolStartIndex: null,
      activePath: null,
      flyingLoiterTargetX: null,
      flyingLoiterTargetY: null,
      flyingLoiterTargetZ: null,
      flyingLoiterTurnSign: null,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      movementAccelX: 0,
      movementAccelY: 0,
      movementAccelZ: 0,
      thrustDirX: 0,
      thrustDirY: 0,
      suspension: null,
      shieldPanels: [],
      shieldBoundRadius: 0,
      surfaceNormal: {
        nx: spawnSupport.normalX,
        ny: spawnSupport.normalY,
        nz: spawnSupport.normalZ,
      },
      orientation: isAirborneLocomotion
        ? { x: 0, y: 0, z: 0, w: 1 }
        : null,
      angularVelocity3: isAirborneLocomotion
        ? { x: 0, y: 0, z: 0 }
        : null,
      angularAcceleration3: isAirborneLocomotion
        ? { x: 0, y: 0, z: 0 }
        : null,
      hoverHeightUpwardForceSmoothed: null,
      swimHeightUpwardForceSmoothed: null,
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
    bodyCenterHeight: bp.bodyCenterHeight,
    supportSurface: cloneUnitSupportSurface(bp.supportSurface),
    fullVisionRadius: bp.fullVisionRadius,
    sensors: { ...bp.sensors },
    locomotion: getUnitLocomotion(unitBlueprintId),
    mass: bp.mass,
    airFrictionPer60HzFrame: bp.airFrictionPer60HzFrame,
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
  entity.unit!.shieldBoundRadius = buildShieldPanelCache(
    bp,
    entity.unit!.shieldPanels,
  );

  if (bp.builder) {
    entity.builder = {
      buildRange: bp.builder.buildRange,
      constructionRate: bp.builder.constructionRate,
      allowedBuildBlueprintIds: [...bp.builder.allowedBuildBlueprintIds],
      currentBuildTarget: NO_ENTITY_ID,
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
