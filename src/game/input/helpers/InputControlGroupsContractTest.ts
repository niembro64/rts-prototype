import type { Entity, EntityId, PlayerId } from '../../sim/types';
import { InputControlGroups } from './InputControlGroups';

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

export function runInputControlGroupsContractTest(): void {
  const tankA = unit(1, 'tank');
  const tankB = unit(2, 'tank');
  const scoutA = unit(3, 'scout');
  const scoutB = unit(4, 'scout');
  const units = [tankA, tankB, scoutA];
  let selectedUnits: Entity[] = [tankA];
  let lastGroups: readonly (readonly EntityId[])[] = [];
  const groups = new InputControlGroups(
    {
      getUnits: () => units,
      getBuildings: () => [],
      getSelectedUnits: () => selectedUnits,
      getSelectedBuildings: () => [],
      getEntity: (id) => units.find((entity) => entity.id === id),
    },
    (entity) => entity?.ownership?.playerId === LOCAL_PLAYER,
    () => undefined,
  );
  groups.onChange = (nextGroups) => {
    lastGroups = nextGroups;
  };

  groups.setAutoGroupSlot(1);
  assertContract(
    groups.getLiveSlotEntityIds(1).join(',') === '1,2',
    'Alt+number auto-group creation must include all live matching unit types',
  );

  units.push(unit(5, 'tank'));
  groups.refreshAutoGroups();
  assertContract(
    groups.getLiveSlotEntityIds(1).join(',') === '1,2,5',
    'auto-group refresh must add newly visible matching units',
  );
  assertContract(
    lastGroups[1]?.join(',') === '1,2,5',
    'auto-group refresh must emit updated group ids',
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
  groups.refreshAutoGroups();
  assertContract(
    groups.getLiveSlotEntityIds(1).join(',') === '3',
    'manual Ctrl+number store must clear the auto-group rule for that slot',
  );
}
