/**
 * Area-mex membership is BAR's rule: a deposit is inside the drag circle when
 * its ORIGIN is inside the circle, and nothing else counts.
 *
 * The regression this guards: membership used to be widened by
 * `deposit.placementRadius`, which is the connected-growth wander cap rather
 * than the ore's size. The titanic dead-center deposit's cap exceeds the whole
 * playable map, so every area-mex drag, anywhere, of any size, "contained" the
 * deposit at map center and queued an extractor far outside the drawn circle.
 */

import { Input3DBuildPlacementState } from './Input3DBuildPlacementState';
import { generateMetalDeposits, type MetalDeposit } from '../../metalDepositConfig';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[area mex contract] ${message}`);
}

/** Snap can move a placement off the deposit origin by a couple of build
 *  cells; membership itself must not be looser than the drawn circle. */
const SNAP_SLACK = 60;

export function runAreaMexPlacementContractTest(): void {
  // The authored default map: 53 land cells of 200 world units per side.
  const mapSize = 53 * 200;
  const deposits = generateMetalDeposits(mapSize, mapSize, 2);
  assertContract(deposits.length > 2, 'the generated map must hold deposits to test against');

  const centerX = mapSize / 2;
  const centerY = mapSize / 2;
  let centerDeposit: MetalDeposit = deposits[0];
  let farDeposit: MetalDeposit = deposits[0];
  const distToCenter = (d: MetalDeposit): number => Math.hypot(d.x - centerX, d.y - centerY);
  for (const deposit of deposits) {
    if (distToCenter(deposit) < distToCenter(centerDeposit)) centerDeposit = deposit;
    if (distToCenter(deposit) > distToCenter(farDeposit)) farDeposit = deposit;
  }
  assertContract(
    distToCenter(farDeposit) > 1000,
    'the map must hold a deposit well away from center for this test to mean anything',
  );

  const state = new Input3DBuildPlacementState();
  state.setMapBounds(mapSize, mapSize, 2, deposits);
  const entitySource = { getBuildings: () => [] };

  // A circle drawn around a far-from-center deposit plans that deposit...
  const radius = 300;
  const plan = state.planMetalExtractorPlacementsInArea(
    farDeposit.x, farDeposit.y, radius, entitySource,
  );
  assertContract(plan.length >= 1, 'a circle around a free deposit must plan an extractor on it');
  for (const placement of plan) {
    // ...and nothing outside the drawn circle — dead center most of all.
    assertContract(
      Math.hypot(placement.x - farDeposit.x, placement.y - farDeposit.y) <= radius + SNAP_SLACK,
      `a planned extractor at ${placement.x},${placement.y} sits outside the drawn circle`,
    );
    assertContract(
      Math.hypot(placement.x - centerDeposit.x, placement.y - centerDeposit.y) > SNAP_SLACK,
      'the map-center deposit must never ride along on a drag drawn elsewhere',
    );
  }

  // A small circle over empty ground plans nothing at all. Walk outward from
  // the far corner until a probe point clears every deposit origin.
  const emptyRadius = 120;
  let emptyX: number | null = null;
  let emptyY: number | null = null;
  for (let y = 400; y < mapSize && emptyX === null; y += 160) {
    for (let x = 400; x < mapSize; x += 160) {
      let clear = true;
      for (const deposit of deposits) {
        if (Math.hypot(deposit.x - x, deposit.y - y) <= emptyRadius + SNAP_SLACK) {
          clear = false;
          break;
        }
      }
      if (clear) {
        emptyX = x;
        emptyY = y;
        break;
      }
    }
  }
  assertContract(emptyX !== null && emptyY !== null, 'the map must hold some empty ground');
  const emptyPlan = state.planMetalExtractorPlacementsInArea(
    emptyX as number, emptyY as number, emptyRadius, entitySource,
  );
  assertContract(
    emptyPlan.length === 0,
    'a circle over empty ground must plan nothing — before the fix it always planned dead center',
  );

  console.log('[contract] area mex placement OK');
}
