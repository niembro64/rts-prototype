import {
  BUILDABLE_UNIT_BLUEPRINT_IDS,
  getBuildingBlueprint,
  getUnitBlueprint,
} from '@/game/sim/blueprints';
import {
  BUILDING_BLUEPRINT_IDS,
  type UnitBlueprintId,
  type StructureBlueprintId,
} from '@/types/blueprintIds';
import type { LoadingEntityBlueprintId, LoadingPreviewKind } from './loadingUnitPreviewScene';

type LoadingUnitPreviewSelection = {
  kind: LoadingPreviewKind;
  id: LoadingEntityBlueprintId;
  name: string;
};

/** Pick a random host to show on loading surfaces. Chooses units or
 *  buildings uniformly first, then a blueprint within that host kind. */
export function pickRandomLoadingEntity(): LoadingUnitPreviewSelection {
  const pools = ([
    { kind: 'unit', ids: BUILDABLE_UNIT_BLUEPRINT_IDS },
    { kind: 'building', ids: BUILDING_BLUEPRINT_IDS },
  ] as { kind: LoadingPreviewKind; ids: readonly LoadingEntityBlueprintId[] }[])
    .filter((pool) => pool.ids.length > 0);
  const pool = pools[Math.floor(Math.random() * pools.length)] ?? pools[0];
  const id = pool.ids[Math.floor(Math.random() * pool.ids.length)] ?? pool.ids[0];
  return { kind: pool.kind, id, name: loadingEntityName(pool.kind, id) };
}

function loadingEntityName(kind: LoadingPreviewKind, id: LoadingEntityBlueprintId): string {
  return kind === 'unit'
    ? getUnitBlueprint(id as UnitBlueprintId).name
    : getBuildingBlueprint(id as StructureBlueprintId).name;
}
