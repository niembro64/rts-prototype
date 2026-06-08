// UI Update Manager - handles selection, economy, and minimap data updates

import { COST_MULTIPLIER } from '../../../config';
import type { Entity, PlayerId, WaypointType } from '../../sim/types';
import { getPlayerPrimaryColor } from '../../sim/types';
import { economyManager } from '../../sim/economy';
import { getUnitBlueprint } from '../../sim/blueprints';
import { getBuildingConfig } from '../../sim/buildConfigs';
import { isCommander } from '../../sim/combat/combatUtils';
import { hasQueuedActionIntents } from '../../sim/unitActionIntents';
import { buildingBlueprintHasActiveState } from '../../sim/buildingActiveState';
import { getSelectedBuilderAllowedBuildBlueprintIds } from '../../sim/builderBuildRoster';
import { isReclaimableTarget } from '../../sim/reclaim';

function unitLabel(unitBlueprintId: string): string {
  try {
    return getUnitBlueprint(unitBlueprintId).name;
  } catch {
    return unitBlueprintId;
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

function buildSelectionDetails(
  selectedUnits: readonly Entity[],
  selectedTowers: readonly Entity[],
  selectedBuildings: readonly Entity[],
): SelectionInfo['details'] {
  const all = [...selectedUnits, ...selectedTowers, ...selectedBuildings];
  if (all.length === 0) return [];
  if (all.length === 1) return buildSingleSelectionDetails(all[0]);

  let hp = 0;
  let maxHp = 0;
  for (let i = 0; i < all.length; i++) {
    const pair = hpPair(all[i]);
    if (pair === null) continue;
    hp += pair.hp;
    maxHp += pair.maxHp;
  }
  const details: SelectionInfo['details'] = [
    { label: 'Selected', value: `${all.length}` },
    { label: 'Types', value: `${selectedUnits.length}U ${selectedTowers.length}T ${selectedBuildings.length}B` },
  ];
  if (maxHp > 0) {
    details.push({ label: 'HP', value: `${fmtStat(hp)}/${fmtStat(maxHp)}` });
    details.push({ label: 'HP Avg', value: `${Math.round((hp / maxHp) * 100)}%` });
  }
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
      if (bp.sensors.radarRadius > 0) details.push({ label: 'Radar', value: fmtStat(bp.sensors.radarRadius) });
      if (entity.factory !== null) details.push({ label: 'Factory', value: entity.factory.isProducing ? 'Producing' : 'Idle' });
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
  UIEntitySource,
  SelectionInfo,
  EconomyInfo,
  MinimapEntity,
  MinimapData,
  UIInputState as InputState,
} from '@/types/ui';
import type { UIEntitySource, SelectionInfo, EconomyInfo, MinimapEntity, MinimapData, UIInputState as InputState } from '@/types/ui';

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
  const commander = selectedUnits.find(isCommander);
  const builder = selectedUnits.find(u => u.builder !== null);
  const allowedBuildBlueprintIds = getSelectedBuilderAllowedBuildBlueprintIds(selectedUnits);
  const dgunner = commander;
  let fireControlCount = 0;
  let targetControlCount = 0;
  let allFireEnabled = true;
  let hasPriorityTarget = false;
  let waitingCount = 0;
  let hasQueuedOrders = false;
  for (let i = 0; i < selectedUnits.length; i++) {
    const selectedUnit = selectedUnits[i];
    const actions = selectedUnit.unit?.actions;
    if (actions?.[0]?.type === 'wait') waitingCount++;
    if (actions && hasQueuedActionIntents(actions)) hasQueuedOrders = true;
    const combat = selectedUnit.combat;
    if (combat && combat.turrets.length > 0) {
      fireControlCount++;
      targetControlCount++;
      if (combat.fireEnabled === false) allFireEnabled = false;
      if (combat.priorityTargetId !== null) hasPriorityTarget = true;
    }
  }
  // Towers carry the same combat/fire-control contract as units.
  // Count their host-fire state into the same flags so the panel
  // can toggle hold-fire on a tower selection the same way it does
  // for a unit selection.
  for (let i = 0; i < selectedTowers.length; i++) {
    const combat = selectedTowers[i].combat;
    if (combat && combat.turrets.length > 0) {
      fireControlCount++;
      targetControlCount++;
      if (combat.fireEnabled === false) allFireEnabled = false;
      if (combat.priorityTargetId !== null) hasPriorityTarget = true;
    }
  }

  // The fabricator-class tower hosts production queues (it owns the
  // factory component); shooting towers do not. The factory affordance
  // therefore lives on the tower selection, not the building one.
  const factory = selectedTowers.find(b => b.factory !== null);

  // Building ON/OFF (Producer Buildings Are ON/OFF in budget_design_philosophy.html).
  // Only solar/wind/extractor expose a player-toggleable active state;
  // radar/converter do not. The button is gated to selections that
  // contain at least one of those buildings.
  let activeBuildingCount = 0;
  let allBuildingsOpen = true;
  for (let i = 0; i < selectedBuildings.length; i++) {
    const b = selectedBuildings[i];
    if (!buildingBlueprintHasActiveState(b.buildingBlueprintId)) continue;
    activeBuildingCount++;
    const state = b.building !== null ? b.building.activeState : null;
    if (state === null || state.open === false) allBuildingsOpen = false;
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

  // Get factory repeat-build selection if a factory is selected.
  let factorySelectedUnit: { unitBlueprintId: string; label: string } | null | undefined;
  let factoryProgress: number | undefined;
  let factoryIsProducing: boolean | undefined;

  if (factory?.factory) {
    const f = factory.factory;
    factorySelectedUnit = f.selectedUnitBlueprintId === null
      ? null
      : {
          unitBlueprintId: f.selectedUnitBlueprintId,
          label: unitLabel(f.selectedUnitBlueprintId),
        };
    factoryProgress = f.currentBuildProgress;
    factoryIsProducing = f.isProducing;
  }

  return {
    unitCount: selectedUnits.length,
    towerCount: selectedTowers.length,
    buildingCount: selectedBuildings.length,
    hasCommander: commander !== undefined,
    hasBuilder: builder !== undefined,
    allowedBuildBlueprintIds,
    hasDGun: dgunner !== undefined,
    hasFireControl:
      fireControlCount > 0
      && fireControlCount === selectedUnits.length + selectedTowers.length
      && selectedBuildings.length === 0,
    fireEnabled: fireControlCount > 0 && allFireEnabled,
    hasBuildingActiveControl: activeBuildingCount > 0,
    buildingsActive: activeBuildingCount > 0 && allBuildingsOpen,
    hasSelfDestructable,
    hasReclaimableSelection: commander !== undefined && hasReclaimableSelection,
    hasTowerTargetControl: targetControlCount > 0,
    hasTowerTargetActive: hasPriorityTarget,
    isTowerTargetMode: inputState?.isTowerTargetMode ?? false,
    isWaiting: selectedUnits.length > 0 && waitingCount === selectedUnits.length,
    hasQueuedOrders,
    hasFactory: factory !== undefined,
    factoryId: factory?.id,
    commanderId: commander?.id,
    waypointMode: inputState?.waypointMode ?? 'move' as WaypointType,
    isBuildMode: inputState?.isBuildMode ?? false,
    selectedBuildingBlueprintId: inputState?.selectedBuildingBlueprintId ?? null,
    isDGunMode: inputState?.isDGunMode ?? false,
    isRepairAreaMode: inputState?.isRepairAreaMode ?? false,
    isAttackMode: inputState?.isAttackMode ?? false,
    isAttackAreaMode: inputState?.isAttackAreaMode ?? false,
    isAttackGroundMode: inputState?.isAttackGroundMode ?? false,
    isGuardMode: inputState?.isGuardMode ?? false,
    isReclaimMode: inputState?.isReclaimMode ?? false,
    isPingMode: inputState?.isPingMode ?? false,
    factorySelectedUnit,
    factoryProgress,
    factoryIsProducing,
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
    switch (playerBuildings[i].buildingBlueprintId) {
      case 'buildingSolar': solarCount++; break;
      case 'buildingWind': windCount++; break;
      case 'towerFabricator': factoryCount++; break;
      case 'buildingExtractor': extractorCount++; break;
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
  showTerrain: boolean,
  wind?: { x: number; y: number; speed: number },
  entityOverride?: readonly MinimapEntity[] | null,
  out?: MinimapData,
): MinimapData {
  const data = out ?? {
    contentVersion: 0,
    mapWidth,
    mapHeight,
    entities: [],
    cameraQuad,
    cameraYaw,
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
  data.showTerrain = showTerrain;
  data.wind = wind;
  return data;
}
