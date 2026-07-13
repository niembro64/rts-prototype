import type { FootprintBounds } from '../ViewportFootprint';
import {
  CLIENT_RENDER_ENTITY_KIND_BUILDING,
  CLIENT_RENDER_ENTITY_KIND_NONE,
  CLIENT_RENDER_ENTITY_KIND_UNIT,
  type ClientRenderEntityStateViews,
} from '../render3d/ClientRenderEntityStateSlab';
import { ClientRenderSpatialIndex } from './ClientRenderSpatialIndex';

function assertContract(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`[client render spatial index contract] ${message}`);
  }
}

function createViews(capacity: number): ClientRenderEntityStateViews {
  return {
    kind: new Uint8Array(capacity),
    entityIds: new Float64Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    renderScopePadding: new Float32Array(capacity),
  } as unknown as ClientRenderEntityStateViews;
}

function bounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): FootprintBounds {
  return { minX, minY, maxX, maxY };
}

function writeSlot(
  views: ClientRenderEntityStateViews,
  slot: number,
  id: number,
  kind: number,
  x: number,
  y: number,
  padding = 0,
): void {
  views.entityIds[slot] = id;
  views.kind[slot] = kind;
  views.x[slot] = x;
  views.y[slot] = y;
  views.renderScopePadding[slot] = padding;
}

export function runClientRenderSpatialIndexContractTest(): void {
  const index = new ClientRenderSpatialIndex();
  const views = createViews(8);
  const unitSlots: number[] = [];
  const buildingSlots: number[] = [];

  writeSlot(views, 1, 101, CLIENT_RENDER_ENTITY_KIND_UNIT, 100, 100, 20);
  writeSlot(views, 2, 202, CLIENT_RENDER_ENTITY_KIND_BUILDING, 140, 160, 30);
  index.updateSlot(views, 1);
  index.updateSlot(views, 2);
  assertContract(index.getMaxEntityPadding() === 128, 'default padding floor must be stable');

  index.queryFilteredSlots(bounds(0, 0, 200, 200), unitSlots, buildingSlots);
  assertContract(unitSlots.length === 1 && unitSlots[0] === 1, 'unit slot must query in scope');
  assertContract(
    buildingSlots.length === 1 && buildingSlots[0] === 2,
    'building slot must query in scope',
  );

  index.queryFilteredSlots(
    bounds(0, 0, 200, 200),
    unitSlots,
    buildingSlots,
    (slot) => slot !== 1,
  );
  assertContract(unitSlots.length === 0, 'includeSlot must filter unit entries');
  assertContract(buildingSlots.length === 1 && buildingSlots[0] === 2, 'filter must keep building entry');

  writeSlot(views, 1, 101, CLIENT_RENDER_ENTITY_KIND_UNIT, 1800, 100, 20);
  index.updateSlot(views, 1);
  index.queryFilteredSlots(bounds(0, 0, 200, 200), unitSlots, buildingSlots);
  assertContract(unitSlots.length === 0, 'moved unit must leave old cell query');
  index.queryFilteredSlots(bounds(1700, 0, 1900, 200), unitSlots, buildingSlots);
  assertContract(unitSlots.length === 1 && unitSlots[0] === 1, 'moved unit must enter new cell query');

  index.remove(202);
  index.queryFilteredSlots(bounds(0, 0, 200, 200), unitSlots, buildingSlots);
  assertContract(buildingSlots.length === 0, 'removed building must leave query results');
  assertContract(index.getMaxEntityPadding() === 128, 'default-padding removal must keep padding floor');

  writeSlot(views, 5, 505, CLIENT_RENDER_ENTITY_KIND_BUILDING, 256, 256, 900);
  index.updateSlot(views, 5);
  assertContract(index.getMaxEntityPadding() === 900, 'large padding entry must raise max padding');
  index.remove(505);
  assertContract(index.getMaxEntityPadding() === 128, 'large padding removal must recompute max padding');

  writeSlot(views, 3, 303, CLIENT_RENDER_ENTITY_KIND_UNIT, 64, 64);
  writeSlot(views, 4, 404, CLIENT_RENDER_ENTITY_KIND_UNIT, 96, 96);
  index.updateSlot(views, 3);
  index.updateSlot(views, 4);
  index.remove(303);
  index.queryFilteredSlots(bounds(0, 0, 128, 128), unitSlots, buildingSlots);
  assertContract(unitSlots.length === 1 && unitSlots[0] === 4, 'same-bucket swap removal must preserve moved entry');

  views.kind[4] = CLIENT_RENDER_ENTITY_KIND_NONE;
  index.updateSlot(views, 4);
  index.queryFilteredSlots(bounds(0, 0, 128, 128), unitSlots, buildingSlots);
  assertContract(unitSlots.length === 0, 'none-kind slot update must remove entry');
}
