import { getSimWasm } from '../sim-wasm/init';
import { BUILD_GRID_CELL_SIZE, type BuildGridChangeBounds } from './buildGrid';
import type { Entity, Unit } from './types';

let clearanceReachWu = -1;

/** World-unit reach within which a building change can alter a route's
 *  legality: the pathfinder's clearance clamp (its own constant, read once)
 *  plus one build cell for the cell quantization of both sides. */
function buildingChangeReachWu(): number {
  if (clearanceReachWu < 0) {
    clearanceReachWu =
      (getSimWasm()!.pathfinder.clearanceReachCells() + 1) * BUILD_GRID_CELL_SIZE;
  }
  return clearanceReachWu;
}

/** True when the unit's remaining route (its position plus the polyline
 *  suffix from the current index) comes within clearance reach of the cells
 *  a building change touched. A route entirely elsewhere cannot have gained
 *  or lost legality from that change, so revalidating it is pure cost — and
 *  on a busy map that cost was every routed unit re-walking its whole
 *  remaining polyline on every building event. */
export function pathPlanSuffixNearBuildingChange(
  entity: Entity,
  plan: NonNullable<Unit['activePath']>,
  change: BuildGridChangeBounds,
  unitRadius: number,
): boolean {
  if (change.count <= 0) return false;
  const reach = buildingChangeReachWu() + unitRadius;
  const changeMinX = change.minGx * BUILD_GRID_CELL_SIZE - reach;
  const changeMinY = change.minGy * BUILD_GRID_CELL_SIZE - reach;
  const changeMaxX = (change.maxGx + 1) * BUILD_GRID_CELL_SIZE + reach;
  const changeMaxY = (change.maxGy + 1) * BUILD_GRID_CELL_SIZE + reach;
  let minX = entity.transform.x;
  let maxX = minX;
  let minY = entity.transform.y;
  let maxY = minY;
  const points = plan.points;
  for (let i = Math.max(0, plan.index); i < points.length; i++) {
    const point = points[i];
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return !(maxX < changeMinX || minX > changeMaxX || maxY < changeMinY || minY > changeMaxY);
}
