import { BuildingGrid } from './buildGrid';
import type { EntityId, PlayerId } from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[build grid change log contract] ${message}`);
}

/**
 * The build grid remembers WHERE each recent version change landed, so a
 * routed unit can skip revalidating a path nowhere near a building event
 * instead of every routed unit re-walking its polyline map-wide.
 */
export function runBuildGridChangeLogContractTest(): void {
  const grid = new BuildingGrid(2000, 2000);
  const v0 = grid.getVersion();
  const none = grid.changedBoundsSince(v0);
  assertContract(none !== null && none.count === 0, 'no changes since the current version');

  grid.place(10, 20, 3, 2, 1 as EntityId, 1 as PlayerId, true);
  const v1 = grid.getVersion();
  const one = grid.changedBoundsSince(v0);
  assertContract(
    one !== null && one.count === 6 && one.minGx === 10 && one.minGy === 20 && one.maxGx === 12 && one.maxGy === 21,
    `one placement reports its own cells, got ${JSON.stringify(one)}`,
  );

  grid.place(60, 70, 2, 2, 2 as EntityId, 1 as PlayerId, true);
  const both = grid.changedBoundsSince(v0);
  assertContract(
    both !== null && both.count === 10 && both.minGx === 10 && both.maxGx === 61 && both.maxGy === 71,
    `two placements union their bounds, got ${JSON.stringify(both)}`,
  );
  const second = grid.changedBoundsSince(v1);
  assertContract(
    second !== null && second.count === 4 && second.minGx === 60 && second.minGy === 70,
    `asking from the later version reports only the later change, got ${JSON.stringify(second)}`,
  );

  grid.removeByEntityId(1 as EntityId);
  const removal = grid.changedBoundsSince(grid.getVersion() - 1);
  assertContract(
    removal !== null && removal.count === 6 && removal.minGx === 10 && removal.maxGy === 21,
    `a removal reports the cells it freed, got ${JSON.stringify(removal)}`,
  );

  // History is bounded: a plan older than what the log retains gets null
  // ("unknown"), never a too-small answer.
  const before = grid.getVersion();
  for (let i = 0; i < 300; i++) {
    grid.place(1 + (i % 50), 1 + Math.floor(i / 50), 1, 1, (100 + i) as EntityId, 1 as PlayerId, true);
  }
  assertContract(grid.changedBoundsSince(before) === null, 'history older than the retained log is unknown, not understated');
  const recent = grid.changedBoundsSince(grid.getVersion() - 5);
  assertContract(recent !== null && recent.count === 5, `the recent tail is still exact, got ${JSON.stringify(recent)}`);
}
