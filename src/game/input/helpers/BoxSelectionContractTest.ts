import type { Entity, EntityId, PlayerId, UnitAction } from '../../sim/types';
import type { SelectionEntitySource } from './SelectionHelper';
import {
  entityMatchesScreenRectSelectionOptions,
  selectEntitiesInScreenRect,
  type ProjectToScreen,
  type ScreenRect,
} from './BoxSelection';

const LOCAL_PLAYER: PlayerId = 1;
const RECT: ScreenRect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const PROJECT_ENTITY_POSITION: ProjectToScreen = (entity, out) => {
  out.x = entity.transform.x;
  out.y = entity.transform.y;
  out.behind = false;
};

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[box selection contract] ${message}`);
  }
}

function unit(
  id: EntityId,
  x: number,
  y: number,
  unitBlueprintId: string,
  actions: UnitAction[] = [],
): Entity {
  return {
    id,
    type: 'unit',
    transform: { x, y, z: 0, rotation: 0, rotCos: null, rotSin: null },
    ownership: { playerId: LOCAL_PLAYER },
    unit: { unitBlueprintId, actions, hp: 100, maxHp: 100 } as Entity['unit'],
    building: null,
    buildingBlueprintId: null,
  } as Entity;
}

function building(
  id: EntityId,
  x: number,
  y: number,
  buildingBlueprintId: string,
): Entity {
  return {
    id,
    type: 'building',
    transform: { x, y, z: 0, rotation: 0, rotCos: null, rotSin: null },
    ownership: { playerId: LOCAL_PLAYER },
    unit: null,
    building: { hp: 100, maxHp: 100 } as Entity['building'],
    buildingBlueprintId,
  } as Entity;
}

function source(units: Entity[], buildings: Entity[]): SelectionEntitySource {
  return {
    getUnits: () => units,
    getBuildings: () => buildings,
  };
}

function selectIds(
  selectionSource: SelectionEntitySource,
  options: Parameters<typeof selectEntitiesInScreenRect>[4] = {},
): EntityId[] {
  return selectEntitiesInScreenRect(
    selectionSource,
    RECT,
    LOCAL_PLAYER,
    PROJECT_ENTITY_POSITION,
    options,
  );
}

export function runBoxSelectionContractTest(): void {
  const tank = unit(1, 5, 5, 'tank');
  const scout = unit(2, 6, 5, 'scout');
  const busyBuilder = unit(3, 7, 5, 'builder', [{} as UnitAction]);
  const lab = building(10, 8, 5, 'vehicleLab');

  assertContract(
    selectIds(source([tank], [lab])).join(',') === '1',
    'default screen-rect selection must keep unit precedence over buildings',
  );
  assertContract(
    selectIds(source([tank], [lab]), { includeBuildingsWithUnits: true }).join(',') === '1,10',
    'Shift/selectbox_any must include buildings together with units',
  );
  assertContract(
    selectIds(source([], [lab]), { mobileOnly: true }).length === 0,
    'Alt/selectbox_mobile must reject buildings',
  );
  assertContract(
    selectIds(source([tank, busyBuilder], []), { idleOnly: true }).join(',') === '1',
    'Space/selectbox_idle must keep only units without queued actions',
  );
  assertContract(
    selectIds(source([tank, scout], []), { sameTypeOnly: true, previousSelection: [tank] }).join(',') === '1',
    'Z/selectbox_same must keep only unit blueprint ids already selected',
  );
  assertContract(
    selectIds(source([tank], []), { sameTypeOnly: true }).length === 0,
    'Z/selectbox_same without a current type filter must select nothing',
  );
  assertContract(
    !entityMatchesScreenRectSelectionOptions(lab, { mobileOnly: true }),
    'exact-click selection predicate must share the mobile-only building filter',
  );
}
