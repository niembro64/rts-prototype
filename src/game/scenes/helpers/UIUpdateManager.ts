// UI Update Manager - handles selection, economy, and minimap data updates

import type { Entity, PlayerId, EntityId, WaypointType } from '../../sim/types';
import { PLAYER_COLORS } from '../../sim/types';
import { economyManager } from '../../sim/economy';

// Unit type to display label
const UNIT_LABELS: Record<string, string> = {
  jackal: 'Jackal',
  lynx: 'Lynx',
  daddy: 'Daddy',
  badger: 'Badger',
  scorpion: 'Scorpion',
  viper: 'Viper',
  mammoth: 'Mammoth',
  widow: 'Widow',
  tarantula: 'Tarantula',
  commander: 'Commander',
};

// Entity source interface for UI updates
export interface UIEntitySource {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  getSelectedUnits(): Entity[];
  getSelectedBuildings(): Entity[];
  getBuildingsByPlayer(playerId: PlayerId): Entity[];
  getUnitsByPlayer(playerId: PlayerId): Entity[];
}

// Selection info passed to UI callback
export interface SelectionInfo {
  unitCount: number;
  hasCommander: boolean;
  hasFactory: boolean;
  factoryId?: EntityId;
  commanderId?: EntityId;
  waypointMode: WaypointType;
  isBuildMode: boolean;
  selectedBuildingType: string | null;
  isDGunMode: boolean;
  factoryQueue?: { weaponId: string; label: string }[];
  factoryProgress?: number;
  factoryIsProducing?: boolean;
}

// Economy info passed to UI callback
export interface EconomyInfo {
  stockpile: number;
  maxStockpile: number;
  income: number;
  baseIncome: number;
  production: number;
  expenditure: number;
  netFlow: number;
  solarCount: number;
  factoryCount: number;
  unitCount: number;
  unitCap: number;
}

// Minimap entity data
export interface MinimapEntity {
  x: number;
  y: number;
  type: 'unit' | 'building';
  color: string;
  isSelected?: boolean;
}

// Minimap data passed to UI callback
export interface MinimapData {
  mapWidth: number;
  mapHeight: number;
  entities: MinimapEntity[];
  cameraX: number;
  cameraY: number;
  cameraWidth: number;
  cameraHeight: number;
}

// Input state interface for selection info
export interface InputState {
  waypointMode: WaypointType;
  isBuildMode: boolean;
  selectedBuildingType: string | null;
  isDGunMode: boolean;
}

// Build selection info from entity source and input state
export function buildSelectionInfo(
  entitySource: UIEntitySource,
  inputState: InputState | undefined
): SelectionInfo {
  const selectedUnits = entitySource.getSelectedUnits();
  const selectedBuildings = entitySource.getSelectedBuildings();

  // Check for commander
  const commander = selectedUnits.find(u => u.commander !== undefined);

  // Check for factory
  const factory = selectedBuildings.find(b => b.factory !== undefined);

  // Get factory queue info if factory is selected
  let factoryQueue: { weaponId: string; label: string }[] | undefined;
  let factoryProgress: number | undefined;
  let factoryIsProducing: boolean | undefined;

  if (factory?.factory) {
    const f = factory.factory;
    factoryQueue = f.buildQueue.map(unitType => ({
      weaponId: unitType, // Field name kept for compatibility
      label: UNIT_LABELS[unitType] ?? unitType,
    }));
    factoryProgress = f.currentBuildProgress;
    factoryIsProducing = f.isProducing;
  }

  return {
    unitCount: selectedUnits.length,
    hasCommander: commander !== undefined,
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
  const factoryCount = playerBuildings.filter(b => b.buildingType === 'factory').length;

  // Count units for this player
  const unitCount = entitySource.getUnitsByPlayer(playerId).length;

  const income = economy.baseIncome + economy.production;
  const netFlow = income - economy.expenditure;

  return {
    stockpile: economy.stockpile,
    maxStockpile: economy.maxStockpile,
    income,
    baseIncome: economy.baseIncome,
    production: economy.production,
    expenditure: economy.expenditure,
    netFlow,
    solarCount,
    factoryCount,
    unitCount,
    unitCap,
  };
}

// Build minimap data from entities
export function buildMinimapData(
  entitySource: UIEntitySource,
  mapWidth: number,
  mapHeight: number,
  cameraX: number,
  cameraY: number,
  cameraWidth: number,
  cameraHeight: number
): MinimapData {
  const entities: MinimapEntity[] = [];

  // Add units to minimap
  for (const unit of entitySource.getUnits()) {
    const playerId = unit.ownership?.playerId;
    const color = playerId ? PLAYER_COLORS[playerId]?.primary : 0x888888;
    const colorHex = '#' + (color ?? 0x888888).toString(16).padStart(6, '0');

    entities.push({
      x: unit.transform.x,
      y: unit.transform.y,
      type: 'unit',
      color: colorHex,
      isSelected: unit.selectable?.selected,
    });
  }

  // Add buildings to minimap
  for (const building of entitySource.getBuildings()) {
    const playerId = building.ownership?.playerId;
    const color = playerId ? PLAYER_COLORS[playerId]?.primary : 0x888888;
    const colorHex = '#' + (color ?? 0x888888).toString(16).padStart(6, '0');

    entities.push({
      x: building.transform.x,
      y: building.transform.y,
      type: 'building',
      color: colorHex,
      isSelected: building.selectable?.selected,
    });
  }

  return {
    mapWidth,
    mapHeight,
    entities,
    cameraX,
    cameraY,
    cameraWidth,
    cameraHeight,
  };
}
