// UI Update Manager - handles selection, economy, and minimap data updates

import type { PlayerId, WaypointType } from '../../sim/types';
import { getPlayerPrimaryColor } from '../../sim/types';
import { economyManager } from '../../sim/economy';
import { getUnitBlueprint } from '../../sim/blueprints';
import { isCommander } from '../../sim/combat/combatUtils';
import { hasQueuedActionIntents } from '../../sim/unitActionIntents';

function unitLabel(unitType: string): string {
  try {
    return getUnitBlueprint(unitType).name;
  } catch {
    return unitType;
  }
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
  // by design_philosophy.html "Selection Menus Are Uniform Per Entity
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
  const dgunner = commander;
  let fireControlCount = 0;
  let allFireEnabled = true;
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
      if (combat.fireEnabled === false) allFireEnabled = false;
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
      if (combat.fireEnabled === false) allFireEnabled = false;
    }
  }

  // The fabricator-class tower hosts production queues (it owns the
  // factory component); shooting towers do not. The factory affordance
  // therefore lives on the tower selection, not the building one.
  const factory = selectedTowers.find(b => b.factory !== null);

  // Get factory queue info if factory is selected
  let factoryQueue: { unitId: string; label: string }[] | undefined;
  let factoryProgress: number | undefined;
  let factoryIsProducing: boolean | undefined;

  if (factory?.factory) {
    const f = factory.factory;
    factoryQueue = f.buildQueue.map(unitType => ({
      unitId: unitType,
      label: unitLabel(unitType),
    }));
    factoryProgress = f.currentBuildProgress;
    factoryIsProducing = f.isProducing;
  }

  return {
    unitCount: selectedUnits.length,
    towerCount: selectedTowers.length,
    buildingCount: selectedBuildings.length,
    hasCommander: commander !== undefined,
    hasBuilder: builder !== undefined,
    hasDGun: dgunner !== undefined,
    hasFireControl: fireControlCount > 0,
    fireEnabled: fireControlCount > 0 && allFireEnabled,
    isWaiting: selectedUnits.length > 0 && waitingCount === selectedUnits.length,
    hasQueuedOrders,
    hasFactory: factory !== undefined,
    factoryId: factory?.id,
    commanderId: commander?.id,
    waypointMode: inputState?.waypointMode ?? 'move' as WaypointType,
    isBuildMode: inputState?.isBuildMode ?? false,
    selectedBuildingType: inputState?.selectedBuildingType ?? null,
    isDGunMode: inputState?.isDGunMode ?? false,
    isRepairAreaMode: inputState?.isRepairAreaMode ?? false,
    isAttackAreaMode: inputState?.isAttackAreaMode ?? false,
    isAttackGroundMode: inputState?.isAttackGroundMode ?? false,
    isGuardMode: inputState?.isGuardMode ?? false,
    isReclaimMode: inputState?.isReclaimMode ?? false,
    isPingMode: inputState?.isPingMode ?? false,
    factoryQueue,
    factoryProgress,
    factoryIsProducing,
    controlGroups: inputState?.controlGroups ?? [],
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
    switch (playerBuildings[i].buildingType) {
      case 'solar': solarCount++; break;
      case 'wind': windCount++; break;
      case 'factory': factoryCount++; break;
      case 'extractor': extractorCount++; break;
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
        e.unit ? 'unit' : 'building',
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
