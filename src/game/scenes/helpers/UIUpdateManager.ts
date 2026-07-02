// UI Update Manager - handles selection, economy, and minimap data updates

import { COST_MULTIPLIER } from '../../../config';
import type { CombatFireState, Entity, PlayerId, UnitAction, UnitMoveState, WaypointType } from '../../sim/types';
import { getPlayerPrimaryColor } from '../../sim/types';
import { economyManager } from '../../sim/economy';
import { getUnitBlueprint } from '../../sim/blueprints';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { isMetalExtractorBlueprintId } from '../../../types/buildingTypes';
import { isBallisticArcWeapon, isCommander } from '../../sim/combat/combatUtils';
import {
  getFirstActionIntentEnd,
  getQueuedActionIntentCount,
  hasQueuedActionIntents,
} from '../../sim/unitActionIntents';
import {
  buildingBlueprintHasActiveState,
  buildingBlueprintHasBarOnOffCommand,
} from '../../sim/buildingActiveState';
import {
  getActiveSelectedBuilderTypeInfo,
  getBarVisibleSelectedBuilderTypeInfos,
} from '../../sim/builderBuildRoster';
import { getFactoryAllowedUnitBlueprintIds } from '../../sim/factoryProductionRoster';
import { isReclaimableTarget } from '../../sim/reclaim';
import {
  canBuilderUpgradeMetalExtractor,
  isUpgradeableMetalExtractorTarget,
} from '../../sim/metalExtractorUpgrade';
import {
  getBuildFraction,
  isBuildInProgress,
} from '../../sim/buildableHelpers';
import { isClientTransportUnit } from '../../sim/transports';
import {
  entityHasBarAttackCommand,
  entityHasBarAreaAttackCommand,
  entityHasBarFireControlCommand,
  entityHasBarManualLaunchCommand,
  entityHasBarMoveStateCommand,
  entityHasBarTrajectoryCommand,
  entityHasBarCarrierSpawnCommand,
  entityHasBarCaptureCommand,
  entityHasBarBuilderPriorityCommand,
  entityHasBarFactoryGuardCommand,
  entityHasBarSetTargetCommand,
  entityBarTrajectoryCommandKind,
  entityEffectiveBarTrajectoryMode,
  entityHasCloakCommand,
} from '../../sim/unitCommandCapabilities';

const MAX_QUEUE_INSERT_OPTIONS = 24;

function unitLabel(unitBlueprintId: string): string {
  try {
    return getUnitBlueprint(unitBlueprintId).name;
  } catch {
    return unitBlueprintId;
  }
}

function unitShortLabel(unitBlueprintId: string): string {
  try {
    return getUnitBlueprint(unitBlueprintId).shortName;
  } catch {
    return unitBlueprintId.toUpperCase().slice(0, 3);
  }
}

function fmtStat(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 100) return `${Math.round(value)}`;
  if (Math.abs(value) >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function fmtTotalCost(cost: { energy: number; metal: number }): string {
  return fmtStat((cost.energy + cost.metal) * COST_MULTIPLIER);
}

function hpPair(entity: Entity): { hp: number; maxHp: number } | null {
  if (entity.unit !== null) return { hp: entity.unit.hp, maxHp: entity.unit.maxHp };
  if (entity.building !== null) return { hp: entity.building.hp, maxHp: entity.building.maxHp };
  return null;
}

function maxWeaponRange(entity: Entity): number | null {
  const turrets = entity.combat?.turrets;
  if (turrets === undefined || turrets.length === 0) return null;
  let range = 0;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    if (turret.config.visualOnly || turret.config.shot === null) continue;
    range = Math.max(range, turret.config.range);
  }
  return range > 0 ? range : null;
}

function unitActionLabel(action: UnitAction): string {
  switch (action.type) {
    case 'move': return 'Move';
    case 'fight': return 'Fight';
    case 'patrol': return 'Patrol';
    case 'build': return 'Build';
    case 'repair': return 'Repair';
    case 'reclaim': return 'Reclaim';
    case 'capture': return 'Capture';
    case 'resurrect': return 'Resurrect';
    case 'loadTransport': return 'Load';
    case 'unloadTransport': return 'Unload';
    case 'wait': return action.waitGather === true ? 'Gather Wait' : 'Wait';
    case 'attack': return 'Attack';
    case 'attackGround': return 'Attack Ground';
    case 'guard': return 'Guard';
    default: return action.type;
  }
}

function getActiveUnitAction(actions: readonly UnitAction[]): UnitAction | null {
  const activeIntentEnd = getFirstActionIntentEnd(actions);
  return activeIntentEnd >= 0 ? actions[activeIntentEnd] : null;
}

function buildQueueInsertOptions(selectedUnits: readonly Entity[]): SelectionInfo['queueInsertOptions'] {
  let actions: readonly UnitAction[] | null = null;
  for (let i = 0; i < selectedUnits.length; i++) {
    const candidateActions = selectedUnits[i].unit?.actions;
    if (candidateActions !== undefined && hasQueuedActionIntents(candidateActions)) {
      actions = candidateActions;
      break;
    }
  }
  if (actions === null) return [];

  const options: SelectionInfo['queueInsertOptions'] = [];
  for (let i = 0; i < actions.length && options.length < MAX_QUEUE_INSERT_OPTIONS; i++) {
    if (actions[i].isPathExpansion) continue;
    options.push({
      index: i + 1,
      label: `#${i + 1}+`,
    });
  }
  const lastOption = options[options.length - 1];
  if (
    lastOption !== undefined &&
    lastOption.index !== actions.length &&
    options.length < MAX_QUEUE_INSERT_OPTIONS
  ) {
    options.push({
      index: actions.length,
      label: 'End',
    });
  }
  return options;
}

function addMultiSelectionQueueDetails(
  details: SelectionInfo['details'],
  selectedUnits: readonly Entity[],
): void {
  let activeOrderCount = 0;
  let queuedIntentCount = 0;
  for (let i = 0; i < selectedUnits.length; i++) {
    const actions = selectedUnits[i].unit?.actions ?? [];
    if (getActiveUnitAction(actions) !== null) activeOrderCount++;
    queuedIntentCount += getQueuedActionIntentCount(actions);
  }
  if (activeOrderCount > 0) {
    details.push({ label: 'Orders', value: `${activeOrderCount}/${selectedUnits.length}` });
  }
  if (queuedIntentCount > 0) {
    details.push({ label: 'Queued', value: `${queuedIntentCount}` });
  }
}

function isFireControllable(entity: Entity): boolean {
  return entityHasBarFireControlCommand(entity);
}

function isTrajectoryControllable(entity: Entity): boolean {
  const combat = entity.combat;
  if (combat === null) return false;
  for (let i = 0; i < combat.turrets.length; i++) {
    if (isBallisticArcWeapon(combat.turrets[i])) return true;
  }
  return false;
}

function fireStateLabel(entity: Entity): string | null {
  if (!isFireControllable(entity)) return null;
  const fireState = entity.combat?.fireState ??
    (entity.combat?.fireEnabled === false ? 'holdFire' : 'fireAtWill');
  return combatFireStateLabel(fireState);
}

function combatFireStateLabel(fireState: CombatFireState): string {
  switch (fireState) {
    case 'fireAtWill': return 'Fire';
    case 'returnFire': return 'Return';
    case 'holdFire': return 'Hold';
  }
}

function trajectoryStateLabel(entity: Entity): string | null {
  if (!isTrajectoryControllable(entity)) return null;
  const mode = entity.combat?.trajectoryMode ?? 'auto';
  return mode === 'high' ? 'High' : mode === 'low' ? 'Low' : 'Auto';
}

function unitMoveStateLabel(moveState: UnitMoveState): string {
  switch (moveState) {
    case 'holdPosition': return 'Hold';
    case 'roam': return 'Roam';
    case 'maneuver': return 'Maneuver';
  }
}

function cloakStateLabel(entity: Entity): string | null {
  const unit = entity.unit;
  if (unit === null) return null;
  if (unit.cloaked === true) return 'Cloaked';
  return unit.wantCloak === true ? 'Cloaking' : null;
}

function buildingActiveStateLabel(entity: Entity): string | null {
  if (!buildingBlueprintHasActiveState(entity.buildingBlueprintId)) return null;
  const state = entity.building !== null ? entity.building.activeState : null;
  return state?.open === false ? 'Off' : 'On';
}

function addMultiSelectionStateDetails(
  details: SelectionInfo['details'],
  selectedUnits: readonly Entity[],
  selectedTowers: readonly Entity[],
  selectedBuildings: readonly Entity[],
): void {
  let fireControlCount = 0;
  let fireAtWillCount = 0;
  let returnFireCount = 0;
  let holdFireCount = 0;
  for (const entity of selectedUnits) {
    if (!isFireControllable(entity)) continue;
    fireControlCount++;
    const fireState = entity.combat?.fireState ??
      (entity.combat?.fireEnabled === false ? 'holdFire' : 'fireAtWill');
    if (fireState === 'fireAtWill') fireAtWillCount++;
    if (fireState === 'returnFire') returnFireCount++;
    if (fireState === 'holdFire') holdFireCount++;
  }
  for (const entity of selectedTowers) {
    if (!isFireControllable(entity)) continue;
    fireControlCount++;
    const fireState = entity.combat?.fireState ??
      (entity.combat?.fireEnabled === false ? 'holdFire' : 'fireAtWill');
    if (fireState === 'fireAtWill') fireAtWillCount++;
    if (fireState === 'returnFire') returnFireCount++;
    if (fireState === 'holdFire') holdFireCount++;
  }
  if (fireControlCount > 0) {
    const value = fireAtWillCount === fireControlCount
      ? 'Fire'
      : returnFireCount === fireControlCount
        ? 'Return'
        : holdFireCount === fireControlCount
        ? 'Hold'
        : 'Mixed';
    details.push({ label: 'Fire', value });
  }

  let trajectoryControlCount = 0;
  let highTrajectoryCount = 0;
  let lowTrajectoryCount = 0;
  for (const entity of selectedUnits) {
    if (!isTrajectoryControllable(entity)) continue;
    trajectoryControlCount++;
    if (entity.combat?.trajectoryMode === 'high') highTrajectoryCount++;
    if (entity.combat?.trajectoryMode === 'low') lowTrajectoryCount++;
  }
  for (const entity of selectedTowers) {
    if (!isTrajectoryControllable(entity)) continue;
    trajectoryControlCount++;
    if (entity.combat?.trajectoryMode === 'high') highTrajectoryCount++;
    if (entity.combat?.trajectoryMode === 'low') lowTrajectoryCount++;
  }
  if (trajectoryControlCount > 0) {
    const value = highTrajectoryCount === trajectoryControlCount
      ? 'High'
      : lowTrajectoryCount === trajectoryControlCount
        ? 'Low'
        : highTrajectoryCount === 0 && lowTrajectoryCount === 0
          ? 'Auto'
          : 'Mixed';
    details.push({ label: 'Trajectory', value });
  }

  let waitingCount = 0;
  let gatherWaitingCount = 0;
  let repeatCount = 0;
  let holdPositionCount = 0;
  let roamCount = 0;
  let wantCloakCount = 0;
  let cloakedCount = 0;
  for (let i = 0; i < selectedUnits.length; i++) {
    const firstAction = selectedUnits[i].unit?.actions[0];
    if (firstAction?.type === 'wait') {
      waitingCount++;
      if (firstAction.waitGather === true) gatherWaitingCount++;
    }
    if (selectedUnits[i].unit?.repeatQueue === true) repeatCount++;
    if (selectedUnits[i].unit?.moveState === 'holdPosition') holdPositionCount++;
    if (selectedUnits[i].unit?.moveState === 'roam') roamCount++;
    if (selectedUnits[i].unit?.wantCloak === true) wantCloakCount++;
    if (selectedUnits[i].unit?.cloaked === true) cloakedCount++;
  }
  if (waitingCount > 0) {
    details.push({
      label: 'Wait',
      value: waitingCount === selectedUnits.length ? 'On' : `${waitingCount}/${selectedUnits.length}`,
    });
  }
  if (gatherWaitingCount > 0) {
    details.push({
      label: 'Gather Wait',
      value: gatherWaitingCount === selectedUnits.length ? 'On' : `${gatherWaitingCount}/${selectedUnits.length}`,
    });
  }
  if (repeatCount > 0) {
    details.push({
      label: 'Repeat',
      value: repeatCount === selectedUnits.length ? 'On' : `${repeatCount}/${selectedUnits.length}`,
    });
  }
  if (holdPositionCount > 0) {
    details.push({
      label: 'Move State',
      value: holdPositionCount === selectedUnits.length
        ? 'Hold'
        : `${holdPositionCount}/${selectedUnits.length} Hold`,
    });
  } else if (roamCount > 0) {
    details.push({
      label: 'Move State',
      value: roamCount === selectedUnits.length
        ? 'Roam'
        : `${roamCount}/${selectedUnits.length} Roam`,
    });
  }
  if (cloakedCount > 0) {
    details.push({
      label: 'Cloak',
      value: cloakedCount === selectedUnits.length
        ? 'Cloaked'
        : `${cloakedCount}/${selectedUnits.length} Cloaked`,
    });
  } else if (wantCloakCount > 0) {
    details.push({
      label: 'Cloak',
      value: wantCloakCount === selectedUnits.length
        ? 'Cloaking'
        : `${wantCloakCount}/${selectedUnits.length} Cloaking`,
    });
  }

  let activeBuildingCount = 0;
  let openBuildingCount = 0;
  for (const entity of selectedBuildings) {
    const state = buildingActiveStateLabel(entity);
    if (state === null) continue;
    activeBuildingCount++;
    if (state === 'On') openBuildingCount++;
  }
  if (activeBuildingCount > 0) {
    const value = openBuildingCount === activeBuildingCount
      ? 'On'
      : openBuildingCount === 0
        ? 'Off'
        : `${openBuildingCount}/${activeBuildingCount} On`;
    details.push({ label: 'Power', value });
  }
}

function buildSelectionDetails(
  selectedUnits: readonly Entity[],
  selectedTowers: readonly Entity[],
  selectedBuildings: readonly Entity[],
): SelectionInfo['details'] {
  const totalSelected =
    selectedUnits.length + selectedTowers.length + selectedBuildings.length;
  if (totalSelected === 0) return [];
  if (totalSelected === 1) {
    const entity = selectedUnits.length > 0
      ? selectedUnits[0]
      : selectedTowers.length > 0
        ? selectedTowers[0]
        : selectedBuildings[0];
    return buildSingleSelectionDetails(entity);
  }

  let hp = 0;
  let maxHp = 0;
  for (let i = 0; i < selectedUnits.length; i++) {
    const pair = hpPair(selectedUnits[i]);
    if (pair === null) continue;
    hp += pair.hp;
    maxHp += pair.maxHp;
  }
  for (let i = 0; i < selectedTowers.length; i++) {
    const pair = hpPair(selectedTowers[i]);
    if (pair === null) continue;
    hp += pair.hp;
    maxHp += pair.maxHp;
  }
  for (let i = 0; i < selectedBuildings.length; i++) {
    const pair = hpPair(selectedBuildings[i]);
    if (pair === null) continue;
    hp += pair.hp;
    maxHp += pair.maxHp;
  }
  const details: SelectionInfo['details'] = [
    { label: 'Selected', value: `${totalSelected}` },
    { label: 'Types', value: `${selectedUnits.length}U ${selectedTowers.length}T ${selectedBuildings.length}B` },
  ];
  if (maxHp > 0) {
    details.push({ label: 'HP', value: `${fmtStat(hp)}/${fmtStat(maxHp)}` });
    details.push({ label: 'HP Avg', value: `${Math.round((hp / maxHp) * 100)}%` });
  }
  addMultiSelectionStateDetails(details, selectedUnits, selectedTowers, selectedBuildings);
  addMultiSelectionQueueDetails(details, selectedUnits);
  return details;
}

function buildSingleSelectionDetails(entity: Entity): SelectionInfo['details'] {
  if (entity.unit !== null) {
    try {
      const bp = getUnitBlueprint(entity.unit.unitBlueprintId);
      const details: SelectionInfo['details'] = [
        { label: 'Name', value: bp.name },
        { label: 'HP', value: `${fmtStat(entity.unit.hp)}/${fmtStat(entity.unit.maxHp)}` },
        { label: 'Cost', value: fmtTotalCost(bp.cost) },
        { label: 'Mass', value: fmtStat(bp.mass) },
      ];
      const activeAction = getActiveUnitAction(entity.unit.actions);
      if (activeAction !== null) details.push({ label: 'Order', value: unitActionLabel(activeAction) });
      const fire = fireStateLabel(entity);
      if (fire !== null) details.push({ label: 'Fire', value: fire });
      const trajectory = trajectoryStateLabel(entity);
      if (trajectory !== null) details.push({ label: 'Trajectory', value: trajectory });
      const cloak = cloakStateLabel(entity);
      if (cloak !== null) details.push({ label: 'Cloak', value: cloak });
      const firstAction = entity.unit.actions[0];
      if (firstAction?.type === 'wait') {
        details.push({ label: firstAction.waitGather === true ? 'Gather Wait' : 'Wait', value: 'On' });
      }
      if (entity.unit.repeatQueue === true) details.push({ label: 'Repeat', value: 'On' });
      if (entity.unit.moveState !== 'maneuver') {
        details.push({ label: 'Move State', value: unitMoveStateLabel(entity.unit.moveState) });
      }
      const queuedIntentCount = getQueuedActionIntentCount(entity.unit.actions);
      if (queuedIntentCount > 0) details.push({ label: 'Queued', value: `${queuedIntentCount}` });
      details.push({ label: 'Move', value: bp.locomotion.type });
      const range = maxWeaponRange(entity);
      if (range !== null) details.push({ label: 'Range', value: fmtStat(range) });
      return details;
    } catch {
      return [
        { label: 'Name', value: entity.unit.unitBlueprintId },
        { label: 'HP', value: `${fmtStat(entity.unit.hp)}/${fmtStat(entity.unit.maxHp)}` },
      ];
    }
  }
  if (entity.building !== null && entity.buildingBlueprintId !== null) {
    try {
      const bp = getBuildingConfig(entity.buildingBlueprintId);
      const details: SelectionInfo['details'] = [
        { label: 'Name', value: bp.name },
        { label: 'HP', value: `${fmtStat(entity.building.hp)}/${fmtStat(entity.building.maxHp)}` },
        { label: 'Cost', value: fmtTotalCost(bp.cost) },
      ];
      if (bp.energyProduction !== null) details.push({ label: 'Energy', value: `+${fmtStat(bp.energyProduction)}/s` });
      if (bp.metalProduction !== null) {
        details.push({ label: 'Metal', value: `+${fmtStat(entity.metalExtractionRate ?? 0)}/s` });
      }
      const activeState = buildingActiveStateLabel(entity);
      if (activeState !== null) details.push({ label: 'Power', value: activeState });
      const fire = fireStateLabel(entity);
      if (fire !== null) details.push({ label: 'Fire', value: fire });
      const trajectory = trajectoryStateLabel(entity);
      if (trajectory !== null) details.push({ label: 'Trajectory', value: trajectory });
      if (bp.sensors.radarRadius > 0) details.push({ label: 'Radar', value: fmtStat(bp.sensors.radarRadius) });
      if (entity.factory !== null) details.push({ label: 'Factory', value: entity.factory.isProducing ? 'Producing' : 'Idle' });
      if (entity.factory?.guardTargetId !== null && entity.factory?.guardTargetId !== undefined) {
        details.push({ label: 'Factory Guard', value: `#${entity.factory.guardTargetId}` });
      }
      return details;
    } catch {
      return [
        { label: 'Name', value: entity.buildingBlueprintId },
        { label: 'HP', value: `${fmtStat(entity.building.hp)}/${fmtStat(entity.building.maxHp)}` },
      ];
    }
  }
  return [];
}

const _minimapColorCache = new Map<number, string>();

function minimapColor(color: number): string {
  let cached = _minimapColorCache.get(color);
  if (!cached) {
    cached = '#' + color.toString(16).padStart(6, '0');
    _minimapColorCache.set(color, cached);
  }
  return cached;
}

function writeMinimapEntity(
  entities: MinimapEntity[],
  index: number,
  x: number,
  y: number,
  type: MinimapEntity['type'],
  color: string,
  isSelected: boolean | undefined,
  radarOnly: boolean | undefined,
): number {
  let entity = entities[index];
  if (!entity) {
    entity = { pos: { x: 0, y: 0 }, type, color };
    entities[index] = entity;
  }
  entity.pos.x = x;
  entity.pos.y = y;
  entity.type = type;
  entity.color = color;
  entity.isSelected = isSelected;
  entity.radarOnly = radarOnly;
  return index + 1;
}
export type {
  
  SelectionInfo,
  EconomyInfo,
  
  MinimapData,
} from '@/types/ui';
import type { CameraViewBasis, UIEntitySource, SelectionInfo, EconomyInfo, MinimapEntity, MinimapData, UIInputState as InputState } from '@/types/ui';

const DEFAULT_CAMERA_VIEW_BASIS: CameraViewBasis = {
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 },
  towardCamera: { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 },
};

function cloneCameraViewBasis(source: CameraViewBasis): CameraViewBasis {
  return {
    right: { ...source.right },
    up: { ...source.up },
    towardCamera: { ...source.towardCamera },
  };
}

function assignCameraViewBasis(target: CameraViewBasis, source: CameraViewBasis): void {
  target.right.x = source.right.x;
  target.right.y = source.right.y;
  target.right.z = source.right.z;
  target.up.x = source.up.x;
  target.up.y = source.up.y;
  target.up.z = source.up.z;
  target.towardCamera.x = source.towardCamera.x;
  target.towardCamera.y = source.towardCamera.y;
  target.towardCamera.z = source.towardCamera.z;
}

// Build selection info from entity source and input state
export function buildSelectionInfo(
  entitySource: UIEntitySource,
  inputState: InputState | undefined
): SelectionInfo {
  const selectedUnits = entitySource.getSelectedUnits();
  // getSelectedBuildings returns selected entities whose type is
  // 'building' OR 'tower' (both are cached together). Split them here
  // so the panel can render the uniform per-type action set required
  // by budget_design_philosophy.html "Selection Menus Are Uniform Per Entity
  // Type".
  const selectedStatic = entitySource.getSelectedBuildings();
  const selectedTowers: typeof selectedStatic = [];
  const selectedBuildings: typeof selectedStatic = [];
  for (let i = 0; i < selectedStatic.length; i++) {
    const e = selectedStatic[i];
    if (e.type === 'tower') selectedTowers.push(e);
    else if (e.type === 'building') selectedBuildings.push(e);
  }

  // Check for capabilities. Every commander has a d-gun, so the
  // commander unit IS the dgunner — no second find call needed.
  let commander: typeof selectedUnits[number] | undefined;
  let hasTransport = false;
  let canUpgradeMetalExtractors = false;
  for (let i = 0; i < selectedUnits.length; i++) {
    const unit = selectedUnits[i];
    if (commander === undefined && isCommander(unit)) commander = unit;
    if (!hasTransport && isClientTransportUnit(unit)) hasTransport = true;
    if (!canUpgradeMetalExtractors && canBuilderUpgradeMetalExtractor(unit)) {
      canUpgradeMetalExtractors = true;
    }
  }
  const builderTypeInfos = getBarVisibleSelectedBuilderTypeInfos(selectedUnits);
  const activeBuilderType = getActiveSelectedBuilderTypeInfo(
    selectedUnits,
    inputState?.activeBuilderUnitBlueprintId,
  );
  const activeBuilderUnitBlueprintId = activeBuilderType?.unitBlueprintId ?? null;
  const selectedBuilderTypes = builderTypeInfos.map((builderType) => ({
    unitBlueprintId: builderType.unitBlueprintId,
    label: unitLabel(builderType.unitBlueprintId),
    shortName: unitShortLabel(builderType.unitBlueprintId),
    count: builderType.count,
    active: builderType.unitBlueprintId === activeBuilderUnitBlueprintId,
  }));
  const allowedBuildBlueprintIds = activeBuilderType?.allowedBuildBlueprintIds ?? [];
  const selectedPlayerId = selectedUnits[0]?.ownership?.playerId ?? selectedStatic[0]?.ownership?.playerId;
  let hasOwnedMetalExtractorUpgradeBuilder = false;
  if (selectedPlayerId !== undefined) {
    const playerUnits = entitySource.getUnitsByPlayer(selectedPlayerId);
    for (let i = 0; i < playerUnits.length; i++) {
      if (!canBuilderUpgradeMetalExtractor(playerUnits[i])) continue;
      hasOwnedMetalExtractorUpgradeBuilder = true;
      break;
    }
  }
  let hasUpgradeableMetalExtractor = false;
  if (hasOwnedMetalExtractorUpgradeBuilder) {
    for (let i = 0; i < selectedBuildings.length; i++) {
      const entity = selectedBuildings[i];
      if (!isUpgradeableMetalExtractorTarget(entity, entity.ownership?.playerId)) continue;
      hasUpgradeableMetalExtractor = true;
      break;
    }
  }
  const dgunner = commander;
  let fireControlCount = 0;
  let trajectoryControlCount = 0;
  let highTrajectoryCount = 0;
  let lowTrajectoryCount = 0;
  let barTrajectoryControlCount = 0;
  let barHighTrajectoryCount = 0;
  let barLowTrajectoryCount = 0;
  let barSmartTrajectoryControlCount = 0;
  let targetControlCount = 0;
  let manualLaunchControlCount = 0;
  let barAttackControlCount = 0;
  let barCaptureControlCount = 0;
  let barAreaAttackControlCount = 0;
  let fireAtWillCount = 0;
  let returnFireCount = 0;
  let holdFireCount = 0;
  let hasPriorityTarget = false;
  let waitingCount = 0;
  let gatherWaitingCount = 0;
  let repeatCount = 0;
  let moveStateControlCount = 0;
  let holdPositionCount = 0;
  let maneuverCount = 0;
  let roamCount = 0;
  let cloakControlCount = 0;
  let wantCloakCount = 0;
  let cloakedCount = 0;
  let builderPriorityControlCount = 0;
  let builderLowPriorityCount = 0;
  let carrierSpawnControlCount = 0;
  let carrierSpawnEnabledCount = 0;
  let hasQueuedOrders = false;
  for (let i = 0; i < selectedUnits.length; i++) {
    const selectedUnit = selectedUnits[i];
    const actions = selectedUnit.unit?.actions;
    if (actions?.[0]?.type === 'wait') {
      waitingCount++;
      if (actions[0].waitGather === true) gatherWaitingCount++;
    }
    if (selectedUnit.unit?.repeatQueue === true) repeatCount++;
    if (entityHasBarAttackCommand(selectedUnit)) barAttackControlCount++;
    if (entityHasBarMoveStateCommand(selectedUnit)) {
      moveStateControlCount++;
      if (selectedUnit.unit?.moveState === 'holdPosition') holdPositionCount++;
      if (selectedUnit.unit?.moveState === 'roam') roamCount++;
      if (selectedUnit.unit?.moveState === 'maneuver') maneuverCount++;
    }
    if (entityHasBarAreaAttackCommand(selectedUnit)) barAreaAttackControlCount++;
    if (entityHasBarCaptureCommand(selectedUnit)) barCaptureControlCount++;
    if (entityHasCloakCommand(selectedUnit)) {
      cloakControlCount++;
      if (selectedUnit.unit?.wantCloak === true) wantCloakCount++;
      if (selectedUnit.unit?.cloaked === true) cloakedCount++;
    }
    if (entityHasBarBuilderPriorityCommand(selectedUnit)) {
      builderPriorityControlCount++;
      if (
        (selectedUnit.builder === null || selectedUnit.builder.lowPriority === true) &&
        (selectedUnit.factory === null || selectedUnit.factory.lowPriority === true)
      ) {
        builderLowPriorityCount++;
      }
    }
    if (selectedUnit.factory !== null && entityHasBarCarrierSpawnCommand(selectedUnit)) {
      carrierSpawnControlCount++;
      if (selectedUnit.factory.carrierSpawnEnabled === true) carrierSpawnEnabledCount++;
    }
    if (actions && hasQueuedActionIntents(actions)) hasQueuedOrders = true;
    const combat = selectedUnit.combat;
    if (combat && isFireControllable(selectedUnit)) {
      fireControlCount++;
      if (entityHasBarSetTargetCommand(selectedUnit)) targetControlCount++;
      if (entityHasBarManualLaunchCommand(selectedUnit)) manualLaunchControlCount++;
      const fireState = combat.fireState ?? (combat.fireEnabled === false ? 'holdFire' : 'fireAtWill');
      if (fireState === 'fireAtWill') fireAtWillCount++;
      if (fireState === 'returnFire') returnFireCount++;
      if (fireState === 'holdFire') holdFireCount++;
      if (combat.priorityTargetId !== null || combat.priorityTargetPoint !== null) hasPriorityTarget = true;
      if (isTrajectoryControllable(selectedUnit)) {
        trajectoryControlCount++;
        if (combat.trajectoryMode === 'high') highTrajectoryCount++;
        if (combat.trajectoryMode === 'low') lowTrajectoryCount++;
      }
      if (entityHasBarTrajectoryCommand(selectedUnit) && isTrajectoryControllable(selectedUnit)) {
        const barTrajectoryMode = entityEffectiveBarTrajectoryMode(selectedUnit);
        barTrajectoryControlCount++;
        if (entityBarTrajectoryCommandKind(selectedUnit) === 'smartAutoLowHigh') barSmartTrajectoryControlCount++;
        if (barTrajectoryMode === 'high') barHighTrajectoryCount++;
        if (barTrajectoryMode === 'low') barLowTrajectoryCount++;
      }
    }
  }
  // Towers carry the same combat/fire-control contract as units.
  // Count their host-fire state into the same flags so the panel
  // can toggle hold-fire on a tower selection the same way it does
  // for a unit selection.
  for (let i = 0; i < selectedTowers.length; i++) {
    const selectedTower = selectedTowers[i];
    if (entityHasBarBuilderPriorityCommand(selectedTower)) {
      builderPriorityControlCount++;
      if (
        (selectedTower.builder === null || selectedTower.builder.lowPriority === true) &&
        (selectedTower.factory === null || selectedTower.factory.lowPriority === true)
      ) {
        builderLowPriorityCount++;
      }
    }
    const combat = selectedTower.combat;
    if (combat && isFireControllable(selectedTower)) {
      fireControlCount++;
      if (entityHasBarSetTargetCommand(selectedTower)) targetControlCount++;
      if (entityHasBarManualLaunchCommand(selectedTower)) manualLaunchControlCount++;
      const fireState = combat.fireState ?? (combat.fireEnabled === false ? 'holdFire' : 'fireAtWill');
      if (fireState === 'fireAtWill') fireAtWillCount++;
      if (fireState === 'returnFire') returnFireCount++;
      if (fireState === 'holdFire') holdFireCount++;
      if (combat.priorityTargetId !== null || combat.priorityTargetPoint !== null) hasPriorityTarget = true;
      if (isTrajectoryControllable(selectedTower)) {
        trajectoryControlCount++;
        if (combat.trajectoryMode === 'high') highTrajectoryCount++;
        if (combat.trajectoryMode === 'low') lowTrajectoryCount++;
      }
      if (entityHasBarTrajectoryCommand(selectedTower) && isTrajectoryControllable(selectedTower)) {
        const barTrajectoryMode = entityEffectiveBarTrajectoryMode(selectedTower);
        barTrajectoryControlCount++;
        if (entityBarTrajectoryCommandKind(selectedTower) === 'smartAutoLowHigh') barSmartTrajectoryControlCount++;
        if (barTrajectoryMode === 'high') barHighTrajectoryCount++;
        if (barTrajectoryMode === 'low') barLowTrajectoryCount++;
      }
    }
  }

  // The fabricator-class tower hosts production queues (it owns the
  // factory component); shooting towers do not. The factory affordance
  // therefore lives on the tower selection, not the building one.
  let factory: typeof selectedTowers[number] | undefined;
  for (let i = 0; i < selectedTowers.length; i++) {
    const tower = selectedTowers[i];
    if (tower.factory === null) continue;
    factory = tower;
    break;
  }

  // Building ON/OFF (Producer Buildings Are ON/OFF in budget_design_philosophy.html).
  // Prototype active-state covers the full local mechanic; BAR-visible on/off is
  // narrower and follows BAR unit defs with onoffable=true.
  let activeBuildingCount = 0;
  let allBuildingsOpen = true;
  let barActiveBuildingCount = 0;
  let allBarBuildingsOpen = true;
  for (let i = 0; i < selectedBuildings.length; i++) {
    const b = selectedBuildings[i];
    if (!buildingBlueprintHasActiveState(b.buildingBlueprintId)) continue;
    activeBuildingCount++;
    const state = b.building !== null ? b.building.activeState : null;
    if (state === null || state.open === false) allBuildingsOpen = false;
    if (buildingBlueprintHasBarOnOffCommand(b.buildingBlueprintId)) {
      barActiveBuildingCount++;
      if (state === null || state.open === false) allBarBuildingsOpen = false;
    }
  }

  // Self-destruct is available whenever any selected entity (unit,
  // tower, or building) is alive. The command itself only applies to
  // entities with a unit/building hp slot, which is exactly the same
  // set the panel can list.
  const hasSelfDestructable =
    selectedUnits.length > 0
    || selectedTowers.length > 0
    || selectedBuildings.length > 0;
  let hasReclaimableSelection = false;
  for (let i = 0; i < selectedUnits.length; i++) {
    const unit = selectedUnits[i];
    if (!isCommander(unit) && isReclaimableTarget(unit)) {
      hasReclaimableSelection = true;
      break;
    }
  }
  if (!hasReclaimableSelection) {
    for (let i = 0; i < selectedStatic.length; i++) {
      if (isReclaimableTarget(selectedStatic[i])) {
        hasReclaimableSelection = true;
        break;
      }
    }
  }

  // Get factory production selection if a factory is selected.
  let factorySelectedUnit: { unitBlueprintId: string; label: string } | null | undefined;
  let factoryProgress: number | undefined;
  let factoryIsProducing: boolean | undefined;
  let factoryUnderConstruction: boolean | undefined;
  let factoryConstructionProgress: number | undefined;
  let factoryRepeatsProduction: boolean | undefined;
  let factoryProductionQueue: { unitBlueprintId: string; label: string }[] | undefined;
  let factoryProductionQuotas: { unitBlueprintId: string; label: string; current: number; quota: number }[] | undefined;
  let hasFactoryGuardControl = false;
  let factoryGuardTargetId: number | null | undefined;

  if (factory?.factory) {
    const f = factory.factory;
    hasFactoryGuardControl = entityHasBarFactoryGuardCommand(factory);
    const factoryBuildable = factory.buildable;
    if (isBuildInProgress(factoryBuildable)) {
      factoryUnderConstruction = true;
      factoryConstructionProgress = getBuildFraction(factoryBuildable);
    } else {
      factoryUnderConstruction = false;
      factoryConstructionProgress = 1;
    }
    factorySelectedUnit = f.selectedUnitBlueprintId === null
      ? null
      : {
          unitBlueprintId: f.selectedUnitBlueprintId,
          label: unitLabel(f.selectedUnitBlueprintId),
    };
    factoryProgress = f.currentBuildProgress;
    factoryIsProducing = f.isProducing;
    factoryRepeatsProduction = f.repeatProduction;
    factoryProductionQueue = new Array(f.productionQueue.length);
    for (let i = 0; i < f.productionQueue.length; i++) {
      const unitBlueprintId = f.productionQueue[i];
      factoryProductionQueue[i] = {
        unitBlueprintId,
        label: unitLabel(unitBlueprintId),
      };
    }
    const quotaEntries = Object.entries(f.productionQuotas);
    factoryProductionQuotas = [];
    for (let i = 0; i < quotaEntries.length; i++) {
      const [unitBlueprintId, quota] = quotaEntries[i];
      if (!Number.isFinite(quota) || quota <= 0) continue;
      factoryProductionQuotas.push({
        unitBlueprintId,
        label: unitLabel(unitBlueprintId),
        current: Math.max(0, Math.floor(f.productionQuotaCounts[unitBlueprintId] ?? 0)),
        quota: Math.floor(quota),
      });
    }
    factoryGuardTargetId = f.guardTargetId;
  }

  return {
    unitCount: selectedUnits.length,
    towerCount: selectedTowers.length,
    buildingCount: selectedBuildings.length,
    hasCommander: commander !== undefined,
    hasBuilder: activeBuilderType !== null,
    activeBuilderUnitBlueprintId,
    selectedBuilderTypes,
    hasTransport,
    allowedBuildBlueprintIds,
    canUpgradeMetalExtractors,
    hasUpgradeableMetalExtractor,
    hasDGun: dgunner !== undefined,
    hasBarAttackControl: barAttackControlCount > 0,
    hasBarCaptureControl: barCaptureControlCount > 0,
    hasBarAreaAttackControl: barAreaAttackControlCount > 0,
    hasMoveStateControl: moveStateControlCount > 0,
    hasFireControl:
      fireControlCount > 0
      && fireControlCount === selectedUnits.length + selectedTowers.length
      && selectedBuildings.length === 0,
    fireEnabled: fireControlCount > 0 && fireAtWillCount === fireControlCount,
    fireState: fireControlCount === 0
      ? 'fireAtWill'
      : fireAtWillCount === fireControlCount
        ? 'fireAtWill'
        : returnFireCount === fireControlCount
          ? 'returnFire'
          : holdFireCount === fireControlCount
            ? 'holdFire'
            : 'mixed',
    hasTrajectoryControl: trajectoryControlCount > 0,
    trajectoryMode: highTrajectoryCount === trajectoryControlCount
      ? 'high'
      : lowTrajectoryCount === trajectoryControlCount
        ? 'low'
        : 'auto',
    hasBarTrajectoryControl: barTrajectoryControlCount > 0,
    barTrajectoryMode: barTrajectoryControlCount === 0
      ? 'auto'
      : barHighTrajectoryCount === barTrajectoryControlCount
      ? 'high'
      : barLowTrajectoryCount === barTrajectoryControlCount
        ? 'low'
        : 'auto',
    barTrajectoryStateCount: barSmartTrajectoryControlCount > 0 ? 3 : 2,
    hasCloakControl: cloakControlCount > 0 && selectedTowers.length === 0 && selectedBuildings.length === 0,
    wantsCloak: cloakControlCount > 0 && wantCloakCount === cloakControlCount,
    isCloaked: cloakControlCount > 0 && cloakedCount === cloakControlCount,
    hasBuilderPriorityControl: builderPriorityControlCount > 0,
    builderPriorityLow: builderPriorityControlCount > 0 && builderLowPriorityCount === builderPriorityControlCount,
    hasCarrierSpawnControl: carrierSpawnControlCount > 0,
    carrierSpawnEnabled: carrierSpawnControlCount > 0 && carrierSpawnEnabledCount === carrierSpawnControlCount,
    hasBuildingActiveControl: activeBuildingCount > 0,
    buildingsActive: activeBuildingCount > 0 && allBuildingsOpen,
    hasBarBuildingActiveControl: barActiveBuildingCount > 0,
    barBuildingsActive: barActiveBuildingCount > 0 && allBarBuildingsOpen,
    hasSelfDestructable,
    hasReclaimableSelection: activeBuilderType !== null && hasReclaimableSelection,
    hasTowerTargetControl: targetControlCount > 0,
    hasManualLaunchControl: manualLaunchControlCount > 0,
    hasTowerTargetActive: hasPriorityTarget,
    isTowerTargetMode: inputState?.isTowerTargetMode ?? false,
    isTowerTargetNoGroundMode: inputState?.isTowerTargetNoGroundMode ?? false,
    isWaiting: selectedUnits.length > 0 && waitingCount === selectedUnits.length,
    isGatherWaiting: selectedUnits.length > 0 && gatherWaitingCount === selectedUnits.length,
    isRepeatQueue: selectedUnits.length > 0 && repeatCount === selectedUnits.length,
    isHoldPosition: moveStateControlCount > 0 && holdPositionCount === moveStateControlCount,
    unitMoveState: moveStateControlCount === 0
      ? 'maneuver'
      : holdPositionCount === moveStateControlCount
        ? 'holdPosition'
        : roamCount === moveStateControlCount
          ? 'roam'
          : maneuverCount === moveStateControlCount
            ? 'maneuver'
            : 'mixed',
    hasQueuedOrders,
    queueInsertIndex: inputState?.queueInsertIndex ?? null,
    queueInsertOptions: buildQueueInsertOptions(selectedUnits),
    hasFactory: factory !== undefined,
    factoryAllowedUnitBlueprintIds: getFactoryAllowedUnitBlueprintIds(factory),
    factoryId: factory?.id,
    factoryPresetOverlayVisible: inputState?.factoryPresetOverlayVisible ?? false,
    commanderId: commander?.id,
    waypointMode: inputState?.waypointMode ?? 'move' as WaypointType,
    buildGridCategory: inputState?.buildGridCategory ?? null,
    buildGridPage: inputState?.buildGridPage ?? 0,
    factoryGridPage: inputState?.factoryGridPage ?? 0,
    factoryQueueMode: inputState?.factoryQueueMode ?? false,
    isBuildMode: inputState?.isBuildMode ?? false,
    selectedBuildingBlueprintId: inputState?.selectedBuildingBlueprintId ?? null,
    buildLineSpacingMultiplier: inputState?.buildLineSpacingMultiplier ?? 1,
    buildFacingDegrees: inputState?.buildFacingDegrees ?? 0,
    isDGunMode: inputState?.isDGunMode ?? false,
    isRepairAreaMode: inputState?.isRepairAreaMode ?? false,
    isFormationAssumeMode: inputState?.isFormationAssumeMode ?? false,
    isFormationMoveMode: inputState?.isFormationMoveMode ?? false,
    isAttackMode: inputState?.isAttackMode ?? false,
    isAttackAreaMode: inputState?.isAttackAreaMode ?? false,
    isAttackGroundMode: inputState?.isAttackGroundMode ?? false,
    isManualLaunchMode: inputState?.isManualLaunchMode ?? false,
    isGuardMode: inputState?.isGuardMode ?? false,
    isReclaimMode: inputState?.isReclaimMode ?? false,
    isCaptureMode: inputState?.isCaptureMode ?? false,
    isResurrectMode: inputState?.isResurrectMode ?? false,
    isResurrectAreaMode: inputState?.isResurrectAreaMode ?? false,
    isLoadTransportMode: inputState?.isLoadTransportMode ?? false,
    isUnloadTransportMode: inputState?.isUnloadTransportMode ?? false,
    isMexUpgradeMode: inputState?.isMexUpgradeMode ?? false,
    isPingMode: inputState?.isPingMode ?? false,
    factorySelectedUnit,
    factoryProgress,
    factoryIsProducing,
    factoryUnderConstruction,
    factoryConstructionProgress,
    factoryRepeatsProduction,
    factoryProductionQueue,
    factoryProductionQuotas,
    hasFactoryGuardControl,
    factoryGuardTargetId,
    controlGroups: inputState?.controlGroups ?? [],
    details: buildSelectionDetails(selectedUnits, selectedTowers, selectedBuildings),
  };
}

// Build economy info for a player
export function buildEconomyInfo(
  entitySource: UIEntitySource,
  playerId: PlayerId,
  unitCap: number
): EconomyInfo | null {
  const economy = economyManager.getEconomy(playerId);
  if (!economy) return null;

  // Count buildings for this player
  const playerBuildings = entitySource.getBuildingsByPlayer(playerId);
  let solarCount = 0;
  let windCount = 0;
  let factoryCount = 0;
  let extractorCount = 0;
  for (let i = 0; i < playerBuildings.length; i++) {
    const buildingBlueprintId = playerBuildings[i].buildingBlueprintId;
    if (isMetalExtractorBlueprintId(buildingBlueprintId)) {
      extractorCount++;
      continue;
    }
    switch (buildingBlueprintId) {
      case 'buildingSolar': solarCount++; break;
      case 'buildingWind': windCount++; break;
      case 'towerFabricator': factoryCount++; break;
    }
  }

  // Count units for this player
  const unitCount = entitySource.getUnitsByPlayer(playerId).length;

  const total = economy.income.base + economy.income.production;
  const netFlow = total - economy.expenditure;

  const metalTotal = economy.metal.income.base + economy.metal.income.extraction;
  const metalNetFlow = metalTotal - economy.metal.expenditure;

  return {
    stockpile: { curr: economy.stockpile.curr, max: economy.stockpile.max },
    income: { base: economy.income.base, production: economy.income.production, total },
    expenditure: economy.expenditure,
    netFlow,
    metal: {
      stockpile: { curr: economy.metal.stockpile.curr, max: economy.metal.stockpile.max },
      income: { base: economy.metal.income.base, extraction: economy.metal.income.extraction, total: metalTotal },
      expenditure: economy.metal.expenditure,
      netFlow: metalNetFlow,
    },
    units: { count: unitCount, cap: unitCap },
    buildings: { solar: solarCount, wind: windCount, factory: factoryCount, extractor: extractorCount },
  };
}

// Build minimap data from entities and the terrain background.
export function buildMinimapData(
  entitySource: UIEntitySource,
  mapWidth: number,
  mapHeight: number,
  cameraQuad: MinimapData['cameraQuad'],
  cameraYaw: number,
  cameraPitch: number,
  cameraView: CameraViewBasis | undefined,
  showTerrain: boolean,
  wind?: { x: number; y: number; z: number; speed: number },
  entityOverride?: readonly MinimapEntity[] | null,
  out?: MinimapData,
): MinimapData {
  const resolvedCameraView = cameraView ?? out?.cameraView ?? DEFAULT_CAMERA_VIEW_BASIS;
  const data = out ?? {
    contentVersion: 0,
    mapWidth,
    mapHeight,
    entities: [],
    cameraQuad,
    cameraYaw,
    cameraPitch,
    cameraView: cloneCameraViewBasis(resolvedCameraView),
    directionVersion: 0,
    showTerrain,
    wind,
  };
  const entities = data.entities;
  let entityCount = 0;

  if (entityOverride) {
    for (let i = 0; i < entityOverride.length; i++) {
      const e = entityOverride[i];
      entityCount = writeMinimapEntity(
        entities,
        entityCount,
        e.pos.x,
        e.pos.y,
        e.type,
        e.color,
        e.isSelected,
        e.radarOnly,
      );
    }
  } else {
    // Single iteration over units + buildings — branch on entity kind
    // inline. Avoids the back-to-back getUnits()/getBuildings() pair the
    // minimap used to do every frame.
    for (const e of entitySource.getUnitsAndBuildings()) {
      entityCount = writeMinimapEntity(
        entities,
        entityCount,
        e.transform.x,
        e.transform.y,
        e.type === 'unit' ? 'unit' : e.type === 'tower' ? 'tower' : 'building',
        minimapColor(getPlayerPrimaryColor(e.ownership?.playerId)),
        e.selectable?.selected,
        undefined,
      );
    }
  }
  entities.length = entityCount;

  data.mapWidth = mapWidth;
  data.mapHeight = mapHeight;
  data.contentVersion += 1;
  data.cameraQuad = cameraQuad;
  data.cameraYaw = cameraYaw;
  data.cameraPitch = cameraPitch;
  assignCameraViewBasis(data.cameraView, resolvedCameraView);
  data.directionVersion += 1;
  data.showTerrain = showTerrain;
  data.wind = wind;
  return data;
}
