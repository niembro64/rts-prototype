import type { Entity, EntityId, PlayerId } from '../../sim/types';
import { InputControlGroups, type ControlGroupSlotSnapshot } from './InputControlGroups';

const LOCAL_PLAYER: PlayerId = 1;

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[input control groups contract] ${message}`);
  }
}

function unit(id: EntityId, unitBlueprintId: string): Entity {
  return {
    id,
    type: 'unit',
    transform: { x: 0, y: 0, z: 0, rotation: 0, rotCos: null, rotSin: null },
    ownership: { playerId: LOCAL_PLAYER },
    unit: { unitBlueprintId, actions: [], hp: 100, maxHp: 100 } as unknown as Entity['unit'],
    building: null,
    buildingBlueprintId: null,
  } as Entity;
}

function building(id: EntityId, buildingBlueprintId: string): Entity {
  return {
    id,
    type: 'building',
    transform: { x: 0, y: 0, z: 0, rotation: 0, rotCos: null, rotSin: null },
    ownership: { playerId: LOCAL_PLAYER },
    unit: null,
    building: { hp: 100, maxHp: 100 } as Entity['building'],
    buildingBlueprintId,
    factory: { selectedUnitBlueprintId: 'tank' } as Entity['factory'],
  } as Entity;
}

export function runInputControlGroupsContractTest(): void {
  const tankA = unit(1, 'tank');
  const tankB = unit(2, 'tank');
  const scoutA = unit(3, 'scout');
  const scoutB = unit(4, 'scout');
  const units = [tankA, tankB, scoutA];
  const lab = building(10, 'vehicleLab');
  const buildings = [lab];
  let entitySetVersion = 0;
  let unitCollectionReads = 0;
  let selectedUnits: Entity[] = [tankA];
  let selectedBuildings: Entity[] = [];
  const selectionCalls: Array<{ ids: EntityId[]; additive: boolean }> = [];
  let lastGroups: readonly ControlGroupSlotSnapshot[] = [];
  const groups = new InputControlGroups(
    {
      getUnits: () => {
        unitCollectionReads++;
        return units;
      },
      getBuildings: () => buildings,
      getSelectedUnits: () => selectedUnits,
      getSelectedBuildings: () => selectedBuildings,
      getEntity: (id) => units.find((entity) => entity.id === id) ?? buildings.find((entity) => entity.id === id),
      getEntitySetVersion: () => entitySetVersion,
    },
    (entity) => entity?.ownership?.playerId === LOCAL_PLAYER,
    (ids, additive) => selectionCalls.push({ ids, additive }),
  );
  groups.onChange = (nextGroups) => {
    lastGroups = nextGroups;
  };

  groups.setAutoGroupSlot(1);
  assertContract(
    groups.getLiveSlotEntityIds(1).join(',') === '1,2',
    'Alt+number auto-group creation must include all live matching unit types',
  );
  assertContract(
    selectionCalls[0]?.additive === true && selectionCalls[0]?.ids.join(',') === '1,2',
    'Alt+number must additively select every live match like BAR Auto Group',
  );

  units.push(unit(5, 'tank'));
  entitySetVersion++;
  groups.refreshAutoGroups();
  assertContract(
    groups.getLiveSlotEntityIds(1).join(',') === '1,2,5',
    'auto-group refresh must add newly visible matching units',
  );
  assertContract(
    lastGroups[1]?.entityIds.join(',') === '1,2,5' && lastGroups[1]?.auto === true,
    'auto-group refresh must emit updated group ids',
  );
  const readsAfterChangedRefresh = unitCollectionReads;
  groups.refreshAutoGroups();
  assertContract(
    unitCollectionReads === readsAfterChangedRefresh,
    'unchanged entity-set versions must skip the per-frame full-roster auto-group scan',
  );

  groups.removeSelectedFromAutoGroups();
  assertContract(
    groups.getLiveSlotEntityIds(1).length === 0,
    'Alt+Backquote/Alt+Q must remove selected types from auto-groups',
  );

  selectedUnits = [scoutA];
  groups.setAutoGroupSlot(1);
  groups.storeSlot(1);
  units.push(scoutB);
  entitySetVersion++;
  groups.refreshAutoGroups();
  assertContract(
    groups.getLiveSlotEntityIds(1).join(',') === '3,4',
    'manual Ctrl+number store must not delete the separate auto-group type rule',
  );

  groups.setAutoGroupSlot(2);
  const preset = groups.getAutoGroupPresetSnapshot();
  assertContract(
    preset[2]?.unitBlueprintIds.join(',') === 'scout',
    'auto-group preset snapshot must persist selected unit types by blueprint id',
  );

  const restored = new InputControlGroups(
    {
      getUnits: () => units,
      getBuildings: () => buildings,
      getSelectedUnits: () => selectedUnits,
      getSelectedBuildings: () => selectedBuildings,
      getEntity: (id) => units.find((entity) => entity.id === id) ?? buildings.find((entity) => entity.id === id),
    },
    (entity) => entity?.ownership?.playerId === LOCAL_PLAYER,
    () => undefined,
  );
  restored.loadAutoGroupPreset(preset);
  assertContract(
    restored.getLiveSlotEntityIds(2).join(',') === '3,4',
    'auto-group preset load must rebuild matching live units from saved blueprint rules',
  );
  assertContract(
    restored.getSlotSnapshots()[2]?.auto === true,
    'auto-group slot snapshots must mark saved auto-group slots',
  );
  restored.setAutoGroupSlot(1);
  assertContract(
    restored.getLiveGroupedEntityIds().join(',') === '3,4',
    'live grouped ids helper must return unique live ids across manual and auto-group slots',
  );

  selectedUnits = [tankA];
  restored.storeSlot(0);
  restored.addToSlot(1);
  assertContract(
    restored.getLiveSlotEntityIds(0).length === 0 &&
      restored.getLiveSlotEntityIds(1).join(',') === '3,4,1',
    'manual group add must move an entity out of its former BAR/Recoil group',
  );

  selectedUnits = [tankA];
  restored.setAutoGroupSlot(5);
  selectedUnits = [scoutA];
  restored.setAutoGroupSlot(5);
  assertContract(
    restored.getAutoGroupPresetSnapshot()[5]?.unitBlueprintIds.join(',') === 'scout,tank',
    'Alt+number must retain unrelated types already mapped to the target auto group',
  );
  assertContract(
    restored.getAutoGroupPresetSnapshot()[2] === null,
    'assigning a type to a new auto group must remove its former type mapping',
  );

  selectedUnits = [];
  selectedBuildings = [lab];
  restored.setAutoGroupSlot(6);
  const buildingRule = restored.getAutoGroupPresetSnapshot()[6];
  assertContract(
    buildingRule?.buildingBlueprintIds.join(',') === 'vehicleLab' &&
      buildingRule.unitBlueprintIds.length === 0,
    'selected factories must auto-group by their own building type, not their production choice',
  );

  const normalizedPresetGroups = new InputControlGroups(
    {
      getUnits: () => units,
      getBuildings: () => buildings,
      getSelectedUnits: () => selectedUnits,
      getSelectedBuildings: () => selectedBuildings,
      getEntity: (id) => units.find((entity) => entity.id === id) ?? buildings.find((entity) => entity.id === id),
    },
    (entity) => entity?.ownership?.playerId === LOCAL_PLAYER,
    () => undefined,
  );
  normalizedPresetGroups.loadAutoGroupPreset([
    { unitBlueprintIds: ['scout'], buildingBlueprintIds: [] },
    { unitBlueprintIds: ['scout', 'tank'], buildingBlueprintIds: [] },
  ]);
  const normalizedPreset = normalizedPresetGroups.getAutoGroupPresetSnapshot();
  assertContract(
    normalizedPreset[0]?.unitBlueprintIds.join(',') === 'scout' &&
      normalizedPreset[1]?.unitBlueprintIds.join(',') === 'tank',
    'preset hydration must normalize legacy duplicate type mappings to one deterministic BAR group',
  );
}
