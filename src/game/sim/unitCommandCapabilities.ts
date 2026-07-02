import type { BuildingBlueprintId, CombatTrajectoryMode, Entity } from './types';

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
const BAR_CAPTURE_UNIT_BLUEPRINT_IDS = new Set<string>([
  // BAR ARM parity: armcom has cancapture=true; current T1 constructors do not.
  'unitCommander',
]);

export function entityHasBarSetTargetCommand(entity: Entity): boolean {
  const turrets = entity.combat?.turrets ?? [];
  for (let i = 0; i < turrets.length; i++) {
    const config = turrets[i].config;
    const shot = config.shot;
    if (
      !config.visualOnly &&
      !config.passive &&
      shot !== null &&
      shot !== undefined &&
      shot.type !== 'shield' &&
      config.range > 10
    ) {
      return true;
    }
  }
  return false;
}

export function entityHasBarAttackCommand(entity: Entity): boolean {
  return entity.unit !== null && entityHasBarSetTargetCommand(entity);
}

export function entityHasBarFireControlCommand(entity: Entity): boolean {
  return entityHasBarSetTargetCommand(entity);
}

function unitBlueprintHasBarGroundAreaAttackCommand(unitBlueprintId: string): boolean {
  return BAR_GROUND_AREA_ATTACK_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function entityHasBarAreaAttackCommand(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null) return false;
  if (unitBlueprintHasBarGroundAreaAttackCommand(unit.unitBlueprintId)) return true;
  if (
    (unit.locomotion.type === 'hover' || unit.locomotion.type === 'flying') &&
    entityHasBarSetTargetCommand(entity)
  ) {
    return true;
  }
  return false;
}

export function unitBlueprintHasBarAreaAttackCommand(unitBlueprintId: string): boolean {
  return unitBlueprintHasBarGroundAreaAttackCommand(unitBlueprintId);
}

export function unitBlueprintHasBarMoveStateCommand(unitBlueprintId: string): boolean {
  return !BAR_BOMBER_MOVE_STATE_HIDDEN_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function entityHasBarMoveStateCommand(entity: Entity): boolean {
  const unit = entity.unit;
  return unit !== null && unitBlueprintHasBarMoveStateCommand(unit.unitBlueprintId);
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
