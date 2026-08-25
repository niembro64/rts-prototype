import type { BuildingBlueprintId, CombatFireState, CombatTrajectoryMode, Entity, TurretConfig, UnitMoveState } from './types';
import { isAttackEmitterConfig } from './emitterKinds';
import {
  getBuildingHostLockOnMasks,
  getUnitHostLockOnMasks,
  type LockOnMasks,
} from './blueprints';
import {
  CT_LOCK_ON_FAM_INCLUDE_BUILDINGS,
  CT_LOCK_ON_FAM_INCLUDE_UNITS,
  CT_LOCK_ON_REL_INCLUDE_ENEMY,
  CT_LOCK_ON_RECIPROCAL_REQUIRE,
} from '../sim-wasm/init';
import { buildingBlueprintIdToCode, unitBlueprintIdToCode } from '../../types/network';
import { emissionMediumAtZ } from './emissionMedium';
import { getEntityMediumOccupancy } from './entityMediumOccupancy';
import { getBuildingCombatCenterZ } from './buildingAnchors';
import { WATER_LEVEL } from './Terrain';
import { lockOnLevel1MaskAllows } from './lockOnLevel1Mask';

type BarTrajectoryCommandKind = 'standardHighLow' | 'smartAutoLowHigh';

const BAR_GROUND_AREA_ATTACK_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR ARM parity: current ground analogue with customParams.canareaattack is armart.
  'unitMongoose',
  'unitClusterArtillery',
]);
const BAR_BOMBER_MOVE_STATE_HIDDEN_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR hides CMD.MOVE_STATE on AircraftBomb bombers. Dragonfly is the current
  // local buildable bomber analogue with a drop-weapon turret.
  'unitDragonfly',
]);
const BAR_BOMBER_DEFAULT_HOLD_FIRE_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR's BombersDefaultHoldFire widget orders AircraftBomb bombers to
  // FIRE_STATE=0 and MOVE_STATE=0 immediately after creation.
  'unitDragonfly',
]);
const BAR_DEFAULT_HOLD_POSITION_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR ARM unitdefs that explicitly author movestate=0 among the current
  // local analogues, plus AircraftBomb bombers adjusted by
  // unit_bombers_default_hold_fire.lua. Explicit Attack overrides this
  // autonomous stance and still pursues an out-of-range target.
  'unitCommander',
  'unitTick',
  'unitJackal',
  'unitMongoose',
  'unitClusterArtillery',
  'unitBadger',
  'unitDragonfly',
]);
const BAR_BOMBER_NO_AIR_TARGET_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR's Bomber No Air Target gadget blocks CMD.ATTACK against VTOL targets
  // for AircraftBomb/TorpedoLauncher bombers.
  'unitDragonfly',
  // armart and armjanus expose ground-to-ground weapons with
  // onlytargetcategory="SURFACE"; their local analogues must not accept air
  // targets even though prototype projectile data still has VTOL damage.
  'unitMongoose',
  'unitClusterArtillery',
  'unitBadger',
  // armkam has onlytargetcategory="SURFACE"; the local Albatross is the
  // current BAR T1 gunship analogue in the armap production slot.
  'unitAlbatros',
]);
const BAR_BOMBER_ATTACK_BUILDING_GROUND_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR's Bomber Attack Building Ground widget rewrites AircraftBomb bomber
  // attacks on buildings to ground attacks at the building position.
  'unitDragonfly',
]);
const BAR_FIGHTER_AIR_TARGET_ONLY_UNIT_BLUEPRINT_IDS = new Set<string>([
  // armfig weapons have canattackground=false and onlytargetcategory="VTOL".
  'unitEagle',
  'unitMissileRover',
]);
const BAR_AIR_TARGET_ONLY_STRUCTURE_BLUEPRINT_IDS = new Set<BuildingBlueprintId>([
  // armrl has canattackground=false and targets VTOL-only categories.
  'towerAntiAir',
  'towerInterceptor',
]);
const BAR_STOP_STRUCTURE_BLUEPRINT_IDS = new Set<BuildingBlueprintId>([
  // armamex sets removewait=true but does not set removestop, so BAR keeps
  // CMD.STOP visible on the advanced metal extractor.
  'buildingExtractorT2',
]);
const BAR_NO_PLAYER_WEAPON_COMMAND_UNIT_BLUEPRINT_IDS = new Set<string>([
  // armpeep has no weapons; the local scout may keep prototype combat
  // behavior, but BAR exposes no Attack/Fire/Set Target command for it.
  'unitBee',
]);
const BAR_AIR_TARGET_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR air-plant analogues in the current local roster.
  'unitBee',
  'unitConstructionDrone',
  'unitAdvancedConstructionDrone',
  'unitDragonfly',
  'unitEagle',
  'unitDuck',
  'unitAlbatros',
  'unitTransport',
  // Local drone-factory aircraft outside the T1 BAR production page still
  // count as air targets for BAR command restrictions when present in a scenario.
  'unitQueenBee',
  'unitRadarScout',
  'unitDetector',
  'unitPetrel',
]);
const BAR_MANUAL_LAUNCH_UNIT_BLUEPRINT_IDS = new Set<string>();
const BAR_CARRIER_SPAWN_UNIT_BLUEPRINT_IDS = new Set<string>();
const BAR_BUILDER_PRIORITY_UNIT_BLUEPRINT_IDS = new Set<string>([
  'unitCommander',
  'unitConstructionDrone',
  'unitConstructionSubmarine',
  'unitConstructionBot',
  'unitConstructionRover',
  'unitAdvancedConstructionBot',
  'unitAdvancedConstructionRover',
  'unitAdvancedConstructionDrone',
  'unitAdvancedConstructionSubmarine',
]);
const BAR_BUILDER_PRIORITY_STRUCTURE_BLUEPRINT_IDS = new Set<string>([
  'towerFabricator',
  'buildingBotFabricator',
  'buildingVehicleFabricator',
  'buildingAircraftFabricator',
  'buildingNavalFabricator',
  'buildingAdvancedUniversalFabricator',
  'buildingAdvancedBotFabricator',
  'buildingAdvancedVehicleFabricator',
  'buildingAdvancedAircraftFabricator',
  'buildingAdvancedNavalFabricator',
  'buildingExperimentalUniversalFabricator',
]);
const BAR_FACTORY_GUARD_STRUCTURE_BLUEPRINT_IDS = new Set<string>([
  'towerFabricator',
  'buildingBotFabricator',
  'buildingVehicleFabricator',
  'buildingAircraftFabricator',
  'buildingNavalFabricator',
  'buildingAdvancedUniversalFabricator',
  'buildingAdvancedBotFabricator',
  'buildingAdvancedVehicleFabricator',
  'buildingAdvancedAircraftFabricator',
  'buildingAdvancedNavalFabricator',
  'buildingExperimentalUniversalFabricator',
]);
const BAR_AIR_PLANT_LAND_AT_STRUCTURE_BLUEPRINT_IDS = new Set<string>([
  'towerFabricator',
  'buildingAircraftFabricator',
  'buildingAdvancedUniversalFabricator',
  'buildingAdvancedAircraftFabricator',
  'buildingExperimentalUniversalFabricator',
]);
const BAR_FACTORY_MOVE_STATE_STRUCTURE_BLUEPRINT_IDS = new Set<string>([
  'towerFabricator',
  'buildingBotFabricator',
  'buildingVehicleFabricator',
  'buildingAircraftFabricator',
  'buildingNavalFabricator',
  'buildingAdvancedUniversalFabricator',
  'buildingAdvancedBotFabricator',
  'buildingAdvancedVehicleFabricator',
  'buildingAdvancedAircraftFabricator',
  'buildingAdvancedNavalFabricator',
  'buildingExperimentalUniversalFabricator',
]);
const BAR_CAPTURE_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR ARM parity: armcom has cancapture=true; current T1 constructors do not.
  'unitCommander',
]);
/** TS mirror of `combat_targeting_lockon_masks_allow_body_entity` for the
 *  two target families a player can name in an attack order. Towers stamp
 *  as BUILDING family, exactly as the kernel sees them. */
function lockOnMasksAllowBodyTarget(masks: LockOnMasks, target: Entity): boolean {
  if ((masks.relationship & CT_LOCK_ON_REL_INCLUDE_ENEMY) === 0) return false;
  const unit = target.unit;
  if (unit !== null) {
    return (masks.entityFamily & CT_LOCK_ON_FAM_INCLUDE_UNITS) !== 0 &&
      lockOnLevel1MaskAllows(masks.unit, unitBlueprintIdToCode(unit.unitBlueprintId));
  }
  if (target.building !== null) {
    const buildingBlueprintId = target.buildingBlueprintId;
    return (masks.entityFamily & CT_LOCK_ON_FAM_INCLUDE_BUILDINGS) !== 0 &&
      (buildingBlueprintId === null ||
        lockOnLevel1MaskAllows(masks.building, buildingBlueprintIdToCode(buildingBlueprintId)));
  }
  return false;
}

function getHostLockOnMasksForEntity(entity: Entity): LockOnMasks | null {
  const unitBlueprintId = entity.unit?.unitBlueprintId;
  if (unitBlueprintId !== undefined) return getUnitHostLockOnMasks(unitBlueprintId);
  const buildingBlueprintId = entity.buildingBlueprintId;
  if (buildingBlueprintId !== null && buildingBlueprintId !== undefined) {
    return getBuildingHostLockOnMasks(buildingBlueprintId);
  }
  return null;
}

/** Is this a turret an explicit player attack order can ride? Passive and
 *  shield emitters never take orders (the Loris reflector), and neither do
 *  reciprocal-lock turrets — those engage only what already locks them. */
function isPlayerOrderableAttackTurretConfig(config: TurretConfig): boolean {
  const shot = config.shot;
  return (
    isAttackEmitterConfig(config) &&
    !config.passive &&
    shot !== null &&
    shot !== undefined &&
    shot.type !== 'shield' &&
    config.targeting.engagement.range > 10 &&
    config.lockOnRequiresTargetLockedOntoSelfMode !== CT_LOCK_ON_RECIPROCAL_REQUIRE
  );
}

export function entityHasBarSetTargetCommand(entity: Entity): boolean {
  const unitBlueprintId = entity.unit?.unitBlueprintId;
  if (
    unitBlueprintId !== undefined &&
    BAR_NO_PLAYER_WEAPON_COMMAND_UNIT_BLUEPRINT_IDS.has(unitBlueprintId)
  ) {
    return false;
  }
  // A host whose own lock-on masks admit no body targets never honors an
  // explicit player target in the kernel. That covers both `targets: "none"`
  // hosts (the queens) and projectile-only point defense (the Interceptor):
  // neither should expose an Attack/Set Target button that can only no-op.
  const hostMasks = getHostLockOnMasksForEntity(entity);
  const bodyFamilyMask = CT_LOCK_ON_FAM_INCLUDE_UNITS | CT_LOCK_ON_FAM_INCLUDE_BUILDINGS;
  if (hostMasks === null || (hostMasks.entityFamily & bodyFamilyMask) === 0) return false;
  const turrets = entity.combat?.turrets ?? [];
  for (let i = 0; i < turrets.length; i++) {
    if (isPlayerOrderableAttackTurretConfig(turrets[i].config)) return true;
  }
  return false;
}

export function entityHasBarAttackCommand(entity: Entity): boolean {
  return entityHasBarSetTargetCommand(entity);
}

/** Intentional TA-style departure from BAR: every player-orderable weapon
 * can be aimed at an arbitrary world point. Entity-target category masks
 * remain unchanged; the weapon/trajectory solver still decides whether a
 * particular point can actually be reached. */
export function entityCanAttackPoint(entity: Entity): boolean {
  return entityHasBarAttackCommand(entity);
}

export function entityMatchesBarLegacyGroundWeaponSelection(entity: Entity): boolean {
  return entityHasBarAttackCommand(entity) && !entityIsBarAirTarget(entity);
}

export function entityHasBarFireControlCommand(entity: Entity): boolean {
  return entityHasBarSetTargetCommand(entity);
}

export function buildingBlueprintHasBarStopCommand(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  return buildingBlueprintId !== null &&
    buildingBlueprintId !== undefined &&
    BAR_STOP_STRUCTURE_BLUEPRINT_IDS.has(buildingBlueprintId);
}

export function entityHasBarStopCommand(entity: Entity): boolean {
  if ((entity.unit ?? null) !== null) return true;
  if (entity.type === 'building' && entityHasBarSetTargetCommand(entity)) return true;
  return buildingBlueprintHasBarStopCommand(entity.buildingBlueprintId);
}

function unitBlueprintHasBarGroundAreaAttackCommand(unitBlueprintId: string): boolean {
  return BAR_GROUND_AREA_ATTACK_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function entityHasBarAreaAttackCommand(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null) return false;
  return unitBlueprintHasBarGroundAreaAttackCommand(unit.unitBlueprintId);
}

export function unitBlueprintHasBarAreaAttackCommand(unitBlueprintId: string): boolean {
  return unitBlueprintHasBarGroundAreaAttackCommand(unitBlueprintId);
}

export function unitBlueprintHasBarMoveStateCommand(unitBlueprintId: string): boolean {
  return !BAR_BOMBER_MOVE_STATE_HIDDEN_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function unitBlueprintBarDefaultMoveState(unitBlueprintId: string): UnitMoveState {
  return BAR_DEFAULT_HOLD_POSITION_UNIT_BLUEPRINT_IDS.has(unitBlueprintId)
    ? 'holdPosition'
    : 'maneuver';
}

export function unitBlueprintBarDefaultFireState(unitBlueprintId: string): CombatFireState {
  return BAR_BOMBER_DEFAULT_HOLD_FIRE_UNIT_BLUEPRINT_IDS.has(unitBlueprintId)
    ? 'holdFire'
    : 'fireAtWill';
}

export function unitBlueprintHasBarBomberNoAirTargetRule(unitBlueprintId: string): boolean {
  return BAR_BOMBER_NO_AIR_TARGET_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function unitBlueprintHasBarBomberAttackBuildingGroundRule(unitBlueprintId: string): boolean {
  return BAR_BOMBER_ATTACK_BUILDING_GROUND_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function unitBlueprintHasBarFighterAirTargetOnlyRule(unitBlueprintId: string): boolean {
  return BAR_FIGHTER_AIR_TARGET_ONLY_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function buildingBlueprintHasBarAirTargetOnlyRule(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  return buildingBlueprintId !== null &&
    buildingBlueprintId !== undefined &&
    BAR_AIR_TARGET_ONLY_STRUCTURE_BLUEPRINT_IDS.has(buildingBlueprintId);
}

export function unitBlueprintIsBarAirTarget(unitBlueprintId: string): boolean {
  return BAR_AIR_TARGET_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

function entityIsBarAirTarget(entity: Entity | null | undefined): boolean {
  const unitBlueprintId = entity?.unit?.unitBlueprintId;
  return unitBlueprintId !== undefined && unitBlueprintIsBarAirTarget(unitBlueprintId);
}

/** "May this host be ORDERED onto that target?" — the symmetric rule: an
 *  order is accepted exactly when the targeting kernel will honor it. That
 *  is BAR's model (AllowCommand consults the same per-weapon TestTarget
 *  predicate the engine auto-acquires with), restated over this repo's
 *  authored lock-on masks and emission-medium routes:
 *    1. the HOST's lock-on masks must admit the target's family + name
 *       (the kernel's `combat_targeting_entity_may_lock_entity_slot`);
 *    2. SOME player-orderable turret's masks must admit it AND its shot
 *       must have an emission route from the host's current medium to the
 *       target's (the kernel's per-turret gate) — a torpedo tube cannot be
 *       ordered onto a land tank, a cannon cannot be ordered onto a
 *       submerged submarine;
 *    3. BAR's bomber gadget rule stays as the one hand-authored overlay:
 *       drop-weapon hosts refuse air targets even though their prototype
 *       projectile data could nick a flyer.
 *  Fighters and AA towers need no hand rule any more — their air-only
 *  lock-on lists ARE the rule, so orders follow the masks exactly. */
export function entityCanBarAttackTarget(source: Entity, target: Entity | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  const unitBlueprintId = source.unit?.unitBlueprintId;
  if (
    unitBlueprintId !== undefined &&
    unitBlueprintHasBarBomberNoAirTargetRule(unitBlueprintId) &&
    entityIsBarAirTarget(target)
  ) {
    return false;
  }
  const hostMasks = getHostLockOnMasksForEntity(source);
  if (hostMasks === null || !lockOnMasksAllowBodyTarget(hostMasks, target)) return false;
  // Buildings' transform.z is the ground-centered box (it can sit below
  // the waterline on shore ground); combat consumers must read the
  // combat center, per the building z-model.
  const sourceZ = source.building !== null
    ? getBuildingCombatCenterZ(source)
    : source.transform.z;
  const sourceMedium = emissionMediumAtZ(sourceZ, WATER_LEVEL);
  // KERNEL PARITY: the auto-targeting kernel tests the target's BODY
  // VOLUME against the water plane (top above / bottom below), never its
  // center point — a floating ship's submerged hull is a legal torpedo
  // target and a surfaced conning tower is a legal cannon target. Using
  // the center here refused explicit orders the kernel happily
  // auto-engaged (the orca could fire at a ship but not be TOLD to).
  const targetOccupancy = getEntityMediumOccupancy(target);
  const targetAbove = targetOccupancy.aboveWater > 0;
  const targetUnder = targetOccupancy.underwater > 0;
  const turrets = source.combat?.turrets ?? [];
  for (let i = 0; i < turrets.length; i++) {
    const config = turrets[i].config;
    if (!isPlayerOrderableAttackTurretConfig(config)) continue;
    const turretMasks: LockOnMasks = {
      relationship: config.lockOnRelationshipIncludeMask,
      entityFamily: config.lockOnEntityFamilyIncludeMask,
      building: config.lockOnBuildingIncludeMask,
      tower: config.lockOnTowerIncludeMask,
      unit: config.lockOnUnitIncludeMask,
      turret: config.lockOnTurretIncludeMask,
      shot: config.lockOnShotIncludeMask,
      reciprocal: config.lockOnRequiresTargetLockedOntoSelfMode,
    };
    if (!lockOnMasksAllowBodyTarget(turretMasks, target)) continue;
    const matrix = config.shot?.mediumTrajectory;
    if (matrix !== undefined && matrix !== null) {
      const row = matrix[sourceMedium];
      if (!((targetAbove && row.aboveWater) || (targetUnder && row.underwater))) continue;
    }
    return true;
  }
  return false;
}

function buildingBlueprintHasBarFactoryMoveStateCommand(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  return buildingBlueprintId !== null &&
    buildingBlueprintId !== undefined &&
    BAR_FACTORY_MOVE_STATE_STRUCTURE_BLUEPRINT_IDS.has(buildingBlueprintId);
}

export function entityHasBarMoveStateCommand(entity: Entity): boolean {
  const unit = entity.unit ?? null;
  if (unit !== null) return unitBlueprintHasBarMoveStateCommand(unit.unitBlueprintId);
  if ((entity.factory ?? null) === null) return false;
  return buildingBlueprintHasBarFactoryMoveStateCommand(entity.buildingBlueprintId);
}

export function unitBlueprintHasCloakCommand(unitBlueprintId: string): boolean {
  return unitBlueprintId === 'unitCommander' || unitBlueprintId === 'unitStealthScout';
}

export function entityHasCloakCommand(entity: Entity): boolean {
  const unit = entity.unit;
  return unit !== null && unitBlueprintHasCloakCommand(unit.unitBlueprintId);
}

export function unitBlueprintHasBarTrajectoryCommand(unitBlueprintId: string): boolean {
  return unitBlueprintId === 'unitMongoose' || unitBlueprintId === 'unitClusterArtillery';
}

export function buildingBlueprintHasBarTrajectoryCommand(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  void buildingBlueprintId;
  // The current BAR build roster maps towerCannon into the ARM T1 light
  // ground-defense slot (armllt), not the advanced armguard artillery slot.
  // Keep its local ballistic trajectory controls in prototype presets, but do
  // not expose a BAR trajectory state command until a distinct armguard analogue
  // exists in the local roster.
  return false;
}

function unitBlueprintBarTrajectoryCommandKind(unitBlueprintId: string): BarTrajectoryCommandKind | null {
  return unitBlueprintHasBarTrajectoryCommand(unitBlueprintId) ? 'standardHighLow' : null;
}

function buildingBlueprintBarTrajectoryCommandKind(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): BarTrajectoryCommandKind | null {
  return buildingBlueprintHasBarTrajectoryCommand(buildingBlueprintId) ? 'smartAutoLowHigh' : null;
}

export function unitBlueprintBarTrajectoryDefaultMode(unitBlueprintId: string): CombatTrajectoryMode | null {
  // armart has unit + weapon hightrajectory=1, so its untouched state is high.
  return unitBlueprintHasBarTrajectoryCommand(unitBlueprintId) ? 'high' : null;
}

function buildingBlueprintBarTrajectoryDefaultMode(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): CombatTrajectoryMode | null {
  return buildingBlueprintHasBarTrajectoryCommand(buildingBlueprintId) ? 'auto' : null;
}

export function entityHasBarTrajectoryCommand(entity: Entity): boolean {
  const unit = entity.unit ?? null;
  return unit !== null
    ? unitBlueprintHasBarTrajectoryCommand(unit.unitBlueprintId)
    : buildingBlueprintHasBarTrajectoryCommand(entity.buildingBlueprintId);
}

export function entityBarTrajectoryCommandKind(entity: Entity): BarTrajectoryCommandKind | null {
  const unit = entity.unit ?? null;
  return unit !== null
    ? unitBlueprintBarTrajectoryCommandKind(unit.unitBlueprintId)
    : buildingBlueprintBarTrajectoryCommandKind(entity.buildingBlueprintId);
}

export function entityEffectiveBarTrajectoryMode(entity: Entity): CombatTrajectoryMode {
  const mode = entity.combat?.trajectoryMode ?? 'auto';
  if (mode !== 'auto') return mode;
  const unit = entity.unit ?? null;
  return unit === null
    ? buildingBlueprintBarTrajectoryDefaultMode(entity.buildingBlueprintId) ?? 'auto'
    : unitBlueprintBarTrajectoryDefaultMode(unit.unitBlueprintId) ?? 'auto';
}

export function unitBlueprintHasBarManualLaunchCommand(unitBlueprintId: string): boolean {
  // BAR ARM parity: current non-commander analogues do not expose commandfire.
  // armcom's canmanualfire is surfaced through the dedicated D-Gun command.
  return BAR_MANUAL_LAUNCH_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function entityHasBarManualLaunchCommand(entity: Entity): boolean {
  const unit = entity.unit;
  return unit !== null && unitBlueprintHasBarManualLaunchCommand(unit.unitBlueprintId);
}

export function unitBlueprintHasBarCarrierSpawnCommand(unitBlueprintId: string): boolean {
  void unitBlueprintId;
  // BAR adds GameCMD.CARRIER_SPAWN_ONOFF only to units with carrier-spawner
  // weapon metadata such as ARM T2 naval drone carriers. The current local
  // roster has prototype queen mobile factories, but no BAR ARM carrier
  // analogue, so keep their spawn toggle out of BAR command surfaces.
  return BAR_CARRIER_SPAWN_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function entityHasBarCarrierSpawnCommand(entity: Entity): boolean {
  const unit = entity.unit ?? null;
  return unit !== null && unitBlueprintHasBarCarrierSpawnCommand(unit.unitBlueprintId);
}

export function unitBlueprintHasBarCaptureCommand(unitBlueprintId: string): boolean {
  return BAR_CAPTURE_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function entityHasBarCaptureCommand(entity: Entity): boolean {
  const unit = entity.unit ?? null;
  return unit !== null && unitBlueprintHasBarCaptureCommand(unit.unitBlueprintId);
}

export function unitBlueprintHasBarBuilderPriorityCommand(unitBlueprintId: string): boolean {
  // BAR's Builder Priority gadget inserts GameCMD.PRIORITY on build-speed
  // units that can assist or have build options: commanders/constructors and
  // labs/nanos. Current local unit coverage is commander plus the T1
  // constructor analogue; prototype queen spawners intentionally do not count.
  return BAR_BUILDER_PRIORITY_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function buildingBlueprintHasBarBuilderPriorityCommand(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  return buildingBlueprintId !== null &&
    buildingBlueprintId !== undefined &&
    BAR_BUILDER_PRIORITY_STRUCTURE_BLUEPRINT_IDS.has(buildingBlueprintId);
}

export function entityHasBarBuilderPriorityCommand(entity: Entity): boolean {
  const unit = entity.unit ?? null;
  return unit !== null
    ? unitBlueprintHasBarBuilderPriorityCommand(unit.unitBlueprintId)
    : buildingBlueprintHasBarBuilderPriorityCommand(entity.buildingBlueprintId);
}

export function buildingBlueprintHasBarFactoryGuardCommand(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  return buildingBlueprintId !== null &&
    buildingBlueprintId !== undefined &&
    BAR_FACTORY_GUARD_STRUCTURE_BLUEPRINT_IDS.has(buildingBlueprintId);
}

export function entityHasBarFactoryGuardCommand(entity: Entity): boolean {
  const unit = entity.unit ?? null;
  if (unit !== null) return false;
  return buildingBlueprintHasBarFactoryGuardCommand(entity.buildingBlueprintId);
}

export function buildingBlueprintHasBarAirPlantLandAtCommand(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  return buildingBlueprintId !== null &&
    buildingBlueprintId !== undefined &&
    BAR_AIR_PLANT_LAND_AT_STRUCTURE_BLUEPRINT_IDS.has(buildingBlueprintId);
}

export function entityHasBarAirPlantLandAtCommand(entity: Entity): boolean {
  const unit = entity.unit ?? null;
  if (unit !== null || entity.factory === null) return false;
  return buildingBlueprintHasBarAirPlantLandAtCommand(entity.buildingBlueprintId);
}
