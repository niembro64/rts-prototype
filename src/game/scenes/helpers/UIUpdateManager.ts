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
    buildings: { solar: solarCount, factory: factoryCount },
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
  captureTiles: readonly MinimapCaptureTile[],
  captureCellSize: number,
  gridOverlayIntensity: number,
): MinimapData {
  const entities: MinimapEntity[] = [];

  // Add units to minimap
  for (const unit of entitySource.getUnits()) {
    const color = getPlayerPrimaryColor(unit.ownership?.playerId);
    entities.push({
      pos: { x: unit.transform.x, y: unit.transform.y },
      type: 'unit',
      color: '#' + color.toString(16).padStart(6, '0'),
      isSelected: unit.selectable?.selected,
    });
  }

  // Add buildings to minimap
  for (const building of entitySource.getBuildings()) {
    const color = getPlayerPrimaryColor(building.ownership?.playerId);
    entities.push({
      pos: { x: building.transform.x, y: building.transform.y },
      type: 'building',
      color: '#' + color.toString(16).padStart(6, '0'),
      isSelected: building.selectable?.selected,
    });
  }

  return {
    mapWidth,
    mapHeight,
    entities,
    cameraQuad,
    captureTiles,
    captureCellSize,
    gridOverlayIntensity,
  };
}
