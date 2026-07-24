import type { BuildingBlueprintId, CombatFireState, CombatTrajectoryMode, Entity, UnitMoveState } from './types';
import { isAttackEmitterConfig } from './emitterKinds';

export type BarTrajectoryCommandKind = 'standardHighLow' | 'smartAutoLowHigh';

const BAR_GROUND_AREA_ATTACK_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR ARM parity: current ground analogue with customParams.canareaattack is armart.
  'unitMongoose',
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
]);
const BAR_AIR_TARGET_ONLY_STRUCTURE_BLUEPRINT_IDS = new Set<BuildingBlueprintId>([
  // armrl has canattackground=false and targets VTOL-only categories.
  'towerAntiAir',
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
  'unitDragonfly',
  'unitEagle',
  'unitDuck',
  'unitAlbatros',
  'unitTransport',
  // Local flying factory aircraft outside the T1 BAR production page still
  // count as air targets for BAR command restrictions when present in a scenario.
  'unitQueenBee',
  'unitQueenTick',
]);
const BAR_MANUAL_LAUNCH_UNIT_BLUEPRINT_IDS = new Set<string>();
const BAR_CARRIER_SPAWN_UNIT_BLUEPRINT_IDS = new Set<string>();
const BAR_BUILDER_PRIORITY_UNIT_BLUEPRINT_IDS = new Set<string>([
  'unitCommander',
  'unitConstructionDrone',
]);
const BAR_BUILDER_PRIORITY_STRUCTURE_BLUEPRINT_IDS = new Set<string>([
  'towerFabricator',
]);
const BAR_FACTORY_GUARD_STRUCTURE_BLUEPRINT_IDS = new Set<string>([
  'towerFabricator',
]);
const BAR_AIR_PLANT_LAND_AT_STRUCTURE_BLUEPRINT_IDS = new Set<string>([
  'towerFabricator',
]);
const BAR_FACTORY_MOVE_STATE_STRUCTURE_BLUEPRINT_IDS = new Set<string>([
  'towerFabricator',
]);
const BAR_CAPTURE_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR ARM parity: armcom has cancapture=true; current T1 constructors do not.
  'unitCommander',
]);
// BAR ARM parity: armrectr is the T1 bot-lab resurrector, but the current
// local roster has no armrectr analogue. unitConstructionDrone maps to the
// build-option constructor slots instead.
const BAR_RESURRECT_UNIT_BLUEPRINT_IDS = new Set<string>();

export function entityHasBarSetTargetCommand(entity: Entity): boolean {
  const unitBlueprintId = entity.unit?.unitBlueprintId;
  if (
    unitBlueprintId !== undefined &&
    BAR_NO_PLAYER_WEAPON_COMMAND_UNIT_BLUEPRINT_IDS.has(unitBlueprintId)
  ) {
    return false;
  }
  const turrets = entity.combat?.turrets ?? [];
  for (let i = 0; i < turrets.length; i++) {
    const config = turrets[i].config;
    const shot = config.shot;
    if (
      isAttackEmitterConfig(config) &&
      !config.passive &&
      shot !== null &&
      shot !== undefined &&
      shot.type !== 'shield' &&
      config.turretRange.range > 10
    ) {
      return true;
    }
  }
  return false;
}

export function entityHasBarAttackCommand(entity: Entity): boolean {
  return entityHasBarSetTargetCommand(entity);
}

/** Recoil's Attack command is unit-or-map, but weapons authored with
 *  canattackground=false must not receive the map-point form. */
export function entityCanBarAttackGround(entity: Entity): boolean {
  const unitBlueprintId = entity.unit?.unitBlueprintId;
  if (!entityHasBarAttackCommand(entity)) return false;
  if (unitBlueprintId !== undefined) {
    return !unitBlueprintHasBarFighterAirTargetOnlyRule(unitBlueprintId);
  }
  return !buildingBlueprintHasBarAirTargetOnlyRule(entity.buildingBlueprintId);
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

export function entityIsBarAirTarget(entity: Entity | null | undefined): boolean {
  const unitBlueprintId = entity?.unit?.unitBlueprintId;
  return unitBlueprintId !== undefined && unitBlueprintIsBarAirTarget(unitBlueprintId);
}

export function entityCanBarAttackTarget(source: Entity, target: Entity | null | undefined): boolean {
  const unitBlueprintId = source.unit?.unitBlueprintId;
  if (unitBlueprintId === undefined) {
    return !buildingBlueprintHasBarAirTargetOnlyRule(source.buildingBlueprintId) ||
      entityIsBarAirTarget(target);
  }
  if (unitBlueprintHasBarFighterAirTargetOnlyRule(unitBlueprintId)) return entityIsBarAirTarget(target);
  return !unitBlueprintHasBarBomberNoAirTargetRule(unitBlueprintId) || !entityIsBarAirTarget(target);
}

export function buildingBlueprintHasBarFactoryMoveStateCommand(
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
  // BAR ARM parity: among the current prototype analogues, only armcom has cancloak=true.
  return unitBlueprintId === 'unitCommander';
}

export function entityHasCloakCommand(entity: Entity): boolean {
  const unit = entity.unit;
  return unit !== null && unitBlueprintHasCloakCommand(unit.unitBlueprintId);
}

export function unitBlueprintHasBarTrajectoryCommand(unitBlueprintId: string): boolean {
  // BAR ARM parity: current buildable analogue with hightrajectory is armart.
  return unitBlueprintId === 'unitMongoose';
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

export function unitBlueprintBarTrajectoryCommandKind(unitBlueprintId: string): BarTrajectoryCommandKind | null {
  return unitBlueprintHasBarTrajectoryCommand(unitBlueprintId) ? 'standardHighLow' : null;
}

export function buildingBlueprintBarTrajectoryCommandKind(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): BarTrajectoryCommandKind | null {
  return buildingBlueprintHasBarTrajectoryCommand(buildingBlueprintId) ? 'smartAutoLowHigh' : null;
}

export function unitBlueprintBarTrajectoryDefaultMode(unitBlueprintId: string): CombatTrajectoryMode | null {
  // armart has unit + weapon hightrajectory=1, so its untouched state is high.
  return unitBlueprintHasBarTrajectoryCommand(unitBlueprintId) ? 'high' : null;
}

export function buildingBlueprintBarTrajectoryDefaultMode(
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

export function unitBlueprintHasBarResurrectCommand(unitBlueprintId: string): boolean {
  return BAR_RESURRECT_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function entityHasBarResurrectCommand(entity: Entity): boolean {
  const unit = entity.unit ?? null;
  return unit !== null && unitBlueprintHasBarResurrectCommand(unit.unitBlueprintId);
}

export function entityCanIssueResurrectCommand(entity: Entity | null | undefined): entity is Entity {
  if (entity === null || entity === undefined || entity.unit === null || entity.builder === null) return false;
  return entity.commander !== null || entityHasBarResurrectCommand(entity);
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
