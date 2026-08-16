import type { Entity, EntityId, PlayerId, UnitAction } from '../../sim/types';
import type { SelectionEntitySource } from './SelectionHelper';
import {
  entityMatchesScreenRectSelectionOptions,
  isBarSameTypeSelectionDoubleClick,
  resolveScreenRectSelectionModifiers,
  selectEntitiesInScreenRect,
  selectBoxHeldModifierForKeyCode,
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
    builder: null,
    combat: null,
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
  tank.combat = {
    turrets: [{
      config: {
        kind: 'attack',
        passive: false,
        shot: { type: 'projectile' },
        targeting: { engagement: { range: 100 } },
      },
    }],
  } as unknown as Entity['combat'];
  const scout = unit(2, 6, 5, 'scout');
  const busyBuilder = unit(3, 7, 5, 'builder', [{} as UnitAction]);
  busyBuilder.builder = {} as Entity['builder'];
  const idleBuilder = unit(4, 7.5, 5, 'builder');
  idleBuilder.builder = {} as Entity['builder'];
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
    selectIds(source([tank, scout, idleBuilder], []), { mobileOnly: true }).join(',') === '1',
    'Alt/selectbox_mobile must keep armed non-builders rather than every mobile unit',
  );
  assertContract(
    selectIds(source([tank, idleBuilder], [])).join(',') === '1',
    'ordinary BAR smart selection must prefer non-builders in a mixed box',
  );
  assertContract(
    selectIds(source([idleBuilder], [])).join(',') === '4',
    'ordinary BAR smart selection must fall back when every boxed unit is a builder',
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
    selectBoxHeldModifierForKeyCode('KeyZ') === 'sameType',
    'BAR Any+sc_z must resolve as the held same-type selectbox modifier',
  );
  const mergedModifiers = resolveScreenRectSelectionModifiers({
    shiftKey: true,
    ctrlKey: true,
    altKey: true,
    selectBoxSameTypeHeld: true,
    previousSelection: [tank],
  });
  assertContract(
    mergedModifiers.subtractive &&
      !mergedModifiers.additive &&
      mergedModifiers.options.includeBuildingsWithUnits === true &&
      mergedModifiers.options.mobileOnly === false &&
      mergedModifiers.options.sameTypeOnly === false,
    'BAR Ctrl/selectbox_deselect must use raw candidates even when Shift, Alt, or Z are also held',
  );
  assertContract(
    selectIds(source([tank], []), { sameTypeOnly: true }).join(',') === '1',
    'Z/selectbox_same without a current type filter must leave ordinary selection unfiltered',
  );
  const subtractiveModifiers = resolveScreenRectSelectionModifiers({ ctrlKey: true });
  assertContract(
    subtractiveModifiers.options.includeBuildingsWithUnits === true,
    'Ctrl/selectbox_deselect must expose the raw unit-and-building box contents',
  );
  assertContract(
    !entityMatchesScreenRectSelectionOptions(lab, { mobileOnly: true }),
    'exact-click selection predicate must share the mobile-only building filter',
  );

  const firstTankTap = { typeKey: 'unit:tank', timeMs: 1000, clientX: 20, clientY: 30 };
  assertContract(
    isBarSameTypeSelectionDoubleClick(firstTankTap, {
      typeKey: 'unit:tank',
      timeMs: 1200,
      clientX: 27,
      clientY: 35,
    }),
    'same-type double click must accept BAR/Recoil 200 ms and 12-Manhattan-pixel boundaries',
  );
  assertContract(
    !isBarSameTypeSelectionDoubleClick(firstTankTap, {
      typeKey: 'unit:tank',
      timeMs: 1201,
      clientX: 20,
      clientY: 30,
    }) &&
      !isBarSameTypeSelectionDoubleClick(firstTankTap, {
        typeKey: 'unit:tank',
        timeMs: 1200,
        clientX: 28,
        clientY: 35,
      }) &&
      !isBarSameTypeSelectionDoubleClick(firstTankTap, {
        typeKey: 'unit:scout',
        timeMs: 1200,
        clientX: 20,
        clientY: 30,
      }),
    'same-type double click must reject late, distant, and different-type second taps',
  );
}
