import {
  BUILDING_TYPE_IDS,
  SHOT_IDS,
  TURRET_IDS,
  UNIT_TYPE_IDS,
} from '@/types/blueprintIds';
import type { BlueprintVersionStamps } from '@/types/network';
import { canonicalHashValue } from '../../canonicalData';
import buildingBlueprints from './buildings.json';
import fallbackBlueprints from './fallbacks.json';
import locomotionBlueprints from './locomotion.json';
import pathfindingBlueprints from './pathfindingConfig.json';
import shotBlueprints from './shots.json';
import turretBlueprints from './turrets.json';
import unitRoster from './unitRoster.json';
import unitBlueprints from './units.json';

export function buildBlueprintVersionStamps(): BlueprintVersionStamps {
  return {
    ids: canonicalHashValue({
      buildingTypeIds: BUILDING_TYPE_IDS,
      shotIds: SHOT_IDS,
      turretIds: TURRET_IDS,
      unitTypeIds: UNIT_TYPE_IDS,
    }),
    units: canonicalHashValue(unitBlueprints),
    buildings: canonicalHashValue(buildingBlueprints),
    turrets: canonicalHashValue(turretBlueprints),
    shots: canonicalHashValue(shotBlueprints),
    locomotion: canonicalHashValue(locomotionBlueprints),
    pathfinding: canonicalHashValue(pathfindingBlueprints),
    unitRoster: canonicalHashValue(unitRoster),
    fallbacks: canonicalHashValue(fallbackBlueprints),
  };
}
