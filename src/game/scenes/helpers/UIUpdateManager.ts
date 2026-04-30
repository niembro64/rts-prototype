// UI Update Manager - handles selection, economy, and minimap data updates

import type { PlayerId, WaypointType } from '../../sim/types';
import { getPlayerPrimaryColor } from '../../sim/types';
import { economyManager } from '../../sim/economy';
import { getUnitBlueprint } from '../../sim/blueprints';

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
  return index + 1;
}
export type {
  UIEntitySource,
  SelectionInfo,
  EconomyInfo,
  MinimapEntity,
  MinimapData,
  MinimapCaptureTile,
  UIInputState as InputState,
} from '@/types/ui';
import type { UIEntitySource, SelectionInfo, EconomyInfo, MinimapEntity, MinimapData, MinimapCaptureTile, UIInputState as InputState } from '@/types/ui';

// Build selection info from entity source and input state
export function buildSelectionInfo(
  entitySource: UIEntitySource,
  inputState: InputState | undefined
): SelectionInfo {
  const selectedUnits = entitySource.getSelectedUnits();
  const selectedBuildings = entitySource.getSelectedBuildings();

  // Check for capabilities
  const commander = selectedUnits.find(u => u.commander !== undefined);
  const builder = selectedUnits.find(u => u.builder !== undefined);
  const dgunner = selectedUnits.find(u => u.commander !== undefined);

  // Check for factory
  const factory = selectedBuildings.find(b => b.factory !== undefined);

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
    hasCommander: commander !== undefined,
    hasBuilder: builder !== undefined,
    hasDGun: dgunner !== undefined,
    hasFactory: factory !== undefined,
    factoryId: factory?.id,
    commanderId: commander?.id,
    waypointMode: inputState?.waypointMode ?? 'move' as WaypointType,
    isBuildMode: inputState?.isBuildMode ?? false,
    selectedBuildingType: inputState?.selectedBuildingType ?? null,
    isDGunMode: inputState?.isDGunMode ?? false,
    factoryQueue,
    factoryProgress,
    factoryIsProducing,
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
  const solarCount = playerBuildings.filter(b => b.buildingType === 'solar').length;
  const windCount = playerBuildings.filter(b => b.buildingType === 'wind').length;
  const factoryCount = playerBuildings.filter(b => b.buildingType === 'factory').length;

  // Count units for this player
  const unitCount = entitySource.getUnitsByPlayer(playerId).length;

  const total = economy.income.base + economy.income.production;
  const netFlow = total - economy.expenditure;

  const manaTotal = economy.mana.income.base + economy.mana.income.territory;
  const manaNetFlow = manaTotal - economy.mana.expenditure;

  return {
    stockpile: { curr: economy.stockpile.curr, max: economy.stockpile.max },
    income: { base: economy.income.base, production: economy.income.production, total },
    expenditure: economy.expenditure,
    netFlow,
    mana: {
      stockpile: { curr: economy.mana.stockpile.curr, max: economy.mana.stockpile.max },
      income: { base: economy.mana.income.base, territory: economy.mana.income.territory, total: manaTotal },
      expenditure: economy.mana.expenditure,
      netFlow: manaNetFlow,
    },
    units: { count: unitCount, cap: unitCap },
    buildings: { solar: solarCount, wind: windCount, factory: factoryCount },
  };
}

// Build minimap data from entities. captureTiles + captureCellSize +
// gridOverlayIntensity flow straight through to Minimap.vue so the
// minimap can paint the same per-team color overlay (with the same
// blend math) the 3D CaptureTileRenderer3D paints. When intensity is
// 0 (GRID overlay = off) the minimap renderer skips the overlay
// entirely — one switch ties minimap brightness to 3D brightness.
export function buildMinimapData(
  entitySource: UIEntitySource,
  mapWidth: number,
  mapHeight: number,
  cameraQuad: MinimapData['cameraQuad'],
  cameraYaw: number,
  captureTiles: readonly MinimapCaptureTile[],
  captureCellSize: number,
  gridOverlayIntensity: number,
  showTerrain: boolean,
  wind?: { x: number; y: number; speed: number },
  out?: MinimapData,
): MinimapData {
  const data = out ?? {
    contentVersion: 0,
    mapWidth,
    mapHeight,
    entities: [],
    cameraQuad,
    cameraYaw,
    captureTiles,
    captureCellSize,
    gridOverlayIntensity,
    showTerrain,
    wind,
  };
  const entities = data.entities;
  let entityCount = 0;

  // Add units to minimap
  for (const unit of entitySource.getUnits()) {
    entityCount = writeMinimapEntity(
      entities,
      entityCount,
      unit.transform.x,
      unit.transform.y,
      'unit',
      minimapColor(getPlayerPrimaryColor(unit.ownership?.playerId)),
      unit.selectable?.selected,
    );
  }

  // Add buildings to minimap
  for (const building of entitySource.getBuildings()) {
    entityCount = writeMinimapEntity(
      entities,
      entityCount,
      building.transform.x,
      building.transform.y,
      'building',
      minimapColor(getPlayerPrimaryColor(building.ownership?.playerId)),
      building.selectable?.selected,
    );
  }
  entities.length = entityCount;

  data.mapWidth = mapWidth;
  data.mapHeight = mapHeight;
  data.contentVersion += 1;
  data.cameraQuad = cameraQuad;
  data.cameraYaw = cameraYaw;
  data.captureTiles = captureTiles;
  data.captureCellSize = captureCellSize;
  data.gridOverlayIntensity = gridOverlayIntensity;
  data.showTerrain = showTerrain;
  data.wind = wind;
  return data;
}
