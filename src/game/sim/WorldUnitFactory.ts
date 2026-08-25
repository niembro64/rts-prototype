import {
  UNIT_HP_MULTIPLIER,
  UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
} from '../../config';
import {
  createCombatComponent,
  createEmptyEntityComponentSlots,
  createTransform,
} from './types';
import type {
  Entity,
  EntityId,
  PlayerId,
  UnitLocomotion,
  UnitSupportSurface,
} from './types';
import type { WorldSupportSurface } from './supportSurface';
import { getUnitBlueprint, getUnitLocomotion } from './blueprints';
import { PATH_REQUEST_NONE } from './SimulationPathPlanScheduler';
import { cloneUnitLocomotion } from './unitLocomotion';
import {
  createUnitRuntimeTurrets,
  createUnitRuntimeUtilityMounts,
} from './runtimeTurrets';
import { buildShieldPanelCache } from './shieldPanelCache';
import { cloneUnitSupportSurface } from './unitSupportSurface';
import { createTransportComponentForUnitBlueprint } from './transports';
import { REAL_BATTLE_FACTORY_WAYPOINT_TYPE } from '../../config';
import {
  unitBlueprintBarDefaultFireState,
  unitBlueprintBarDefaultMoveState,
} from './unitCommandCapabilities';
import { createRuntimeBuilder } from './runtimeWorkStations';
import { createFactoryComponent } from './factoryComponent';

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
      pathRequestLane: PATH_REQUEST_NONE,
      pathRequestForceLocal: false,
      pathFailureStreak: 0,
      pathRetryAtTick: 0,
      pathFailureActionHash: 0,
      airborneLoiterTargetX: null,
      airborneLoiterTargetY: null,
      airborneLoiterTargetZ: null,
      airborneLoiterTurnSign: null,
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
    locomotion: getUnitLocomotion(unitBlueprintId),
    mass: bp.mass,
    hp: bp.hp * UNIT_HP_MULTIPLIER,
    spawnSupport: context.sampleSupportSurface(x, y),
  });

  entity.unit!.suspension = null;
  entity.combat = createCombatComponent(
    createUnitRuntimeTurrets(
      unitBlueprintId,
      bp.radius.other,
      entity.id,
      entity.id,
      allocateSubEntityIds ? context.generateEntityId : null,
    ),
    createUnitRuntimeUtilityMounts(unitBlueprintId, bp.radius.other),
  );
  entity.unit!.moveState = unitBlueprintBarDefaultMoveState(unitBlueprintId);
  const defaultFireState = unitBlueprintBarDefaultFireState(unitBlueprintId);
  entity.combat.fireState = defaultFireState;
  entity.unit!.shieldBoundRadius = buildShieldPanelCache(
    bp,
    entity.unit!.shieldPanels,
  );

  if (bp.builder) {
    entity.builder = createRuntimeBuilder(unitBlueprintId);
  }

  // A unit with a host-owned production product is a mobile factory. Queens
  // build their bees/ticks this way; no spawn turret participates.
  const producedUnitBlueprintId = bp.factoryProducedUnitBlueprintId ?? null;
  if (producedUnitBlueprintId !== null) {
    entity.factory = createFactoryComponent({
      selectedUnitBlueprintId: producedUnitBlueprintId,
      repeatProduction: true,
      rallyX: x,
      rallyY: y,
      rallyZ: null,
      rallyType: REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
      // Queens continuously build their one authored child by default. The
      // normal factory controls can still disable Repeat or stop production.
      isProducing: true,
    });
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
