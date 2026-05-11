// Metal-deposit ownership — the binary "one extractor per deposit"
// claim system. A deposit is FREE (not in `world.depositOwners`) or
// OWNED by exactly one COMPLETED extractor. The claim transitions
// happen at exactly two points:
//
//   1) `claimDepositsForExtractor(world, extractor)` runs when the
//      extractor finishes construction. Every overlapping deposit
//      that is currently free becomes owned by this extractor.
//      Overlapping deposits that are ALREADY owned by some other
//      extractor stay where they are — the new extractor is inert
//      with respect to them and may inherit ownership later if the
//      current owner is destroyed.
//
//   2) `releaseDepositsForExtractor(world, extractor)` runs when a
//      completed extractor is destroyed. Every deposit it currently
//      owns is released; for each released deposit the system then
//      scans surviving completed extractors and promotes the first
//      one whose footprint still overlaps the deposit to the new
//      owner. The promoted extractor's `ownedDepositIds`,
//      `metalExtractionRate`, and the player's metal income are
//      updated in lockstep.
//
// Both helpers maintain the invariants:
//
//   – Every entry in `world.depositOwners` points to a still-alive
//     completed extractor entity.
//   – Every extractor's `ownedDepositIds` matches what
//     `world.depositOwners` says.
//   – `metalExtractionRate = ownedDepositIds.length × baseProduction`.
//
// Visual / wire-format consistency falls out automatically:
// `metalExtractionRate` is wire-serialized and the renderer's
// rotor-spin animator reads from it, so spin = "is there income"
// without any additional state.

import type { WorldState } from './WorldState';
import type { Entity } from './types';
import { economyManager } from './economy';
import { getBuildingConfig } from './buildConfigs';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { ENTITY_CHANGED_BUILDING } from '../../types/network';
import {
  getMetalDepositsOverlappingBuildingFootprint,
  metalDepositOverlapsBuildingFootprint,
} from './metalDeposits';

/** Resolve an extractor's grid-aligned footprint AABB from its world
 *  transform + the extractor building config. The construction system
 *  snaps build positions to cell-aligned tops, so the integer grid
 *  index is `floor((center − halfSize) / cellSize + ε)`. */
function getExtractorFootprintGrid(entity: Entity): {
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
} | null {
  if (entity.buildingType !== 'extractor' || !entity.building) return null;
  const cfg = getBuildingConfig('extractor');
  const halfW = (cfg.gridWidth * BUILD_GRID_CELL_SIZE) / 2;
  const halfH = (cfg.gridHeight * BUILD_GRID_CELL_SIZE) / 2;
  const gridX = Math.floor((entity.transform.x - halfW) / BUILD_GRID_CELL_SIZE + 1e-6);
  const gridY = Math.floor((entity.transform.y - halfH) / BUILD_GRID_CELL_SIZE + 1e-6);
  return { gridX, gridY, gridW: cfg.gridWidth, gridH: cfg.gridHeight };
}

function baseProduction(): number {
  return getBuildingConfig('extractor').metalProduction ?? 0;
}

/** Set the extractor's stored fields to match an `ownedDepositIds`
 *  array. Length 0 → inactive (rate 0). Length N → active at
 *  N × baseProduction. */
function syncExtractorRate(extractor: Entity): void {
  const owned = extractor.ownedDepositIds ?? [];
  extractor.metalExtractionRate = owned.length * baseProduction();
}

/** First-time claim, called from applyCompletedBuildingEffects.
 *  Walks every deposit overlapping the extractor footprint; each one
 *  that's currently free becomes owned by this extractor. Returns
 *  the metal/sec the player's income should grow by (= the new
 *  rate, since the extractor was inactive before this call). */
export function claimDepositsForExtractor(
  world: WorldState,
  extractor: Entity,
): number {
  if (extractor.buildingType !== 'extractor' || !extractor.ownership) return 0;
  const footprint = getExtractorFootprintGrid(extractor);
  if (!footprint) return 0;

  const candidates = getMetalDepositsOverlappingBuildingFootprint(
    world.metalDeposits,
    footprint.gridX,
    footprint.gridY,
    footprint.gridW,
    footprint.gridH,
  );

  const owned: number[] = [];
  for (const deposit of candidates) {
    if (world.depositOwners.has(deposit.id)) continue; // already taken
    world.depositOwners.set(deposit.id, extractor.id);
    owned.push(deposit.id);
  }
  extractor.ownedDepositIds = owned;
  syncExtractorRate(extractor);
  return extractor.metalExtractionRate ?? 0;
}

/** Release ownership and try to transfer each deposit to a surviving
 *  completed extractor. Called from removeCompletedBuildingEffects.
 *  The `extractor` parameter is the one being destroyed; it's already
 *  excluded from candidate scans (we look for OTHER extractors).
 *
 *  Side effects per released deposit, in order:
 *    1. Remove from `world.depositOwners`.
 *    2. Subtract one base-rate from the destroyed extractor's owner's
 *       income (unless that's already been done by the caller — we
 *       handle the full rate diff here).
 *    3. Pick a successor: the first OTHER completed extractor whose
 *       footprint still overlaps this deposit. If found, promote it:
 *       set `world.depositOwners`, push to its `ownedDepositIds`,
 *       resync its rate, and add the income delta.
 *
 *  Returns the metal/sec the destroyed extractor's owner's income
 *  should shrink by (= the rate the extractor had right before the
 *  release; new owners' income changes are applied directly via
 *  economyManager). */
export function releaseDepositsForExtractor(
  world: WorldState,
  extractor: Entity,
): number {
  if (extractor.buildingType !== 'extractor' || !extractor.ownership) return 0;
  const owned = extractor.ownedDepositIds ?? [];
  if (owned.length === 0) {
    extractor.metalExtractionRate = 0;
    return 0;
  }
  const lostIncome = extractor.metalExtractionRate ?? owned.length * baseProduction();
  const ownerId = extractor.ownership.playerId;
  const cfg = getBuildingConfig('extractor');
  const perDeposit = cfg.metalProduction ?? 0;

  // Surviving completed extractor candidates — built once, scanned
  // per released deposit. We exclude this extractor (it's about to be
  // gone) and any non-extractor / incomplete entries.
  const successors: Entity[] = [];
  for (const b of world.getBuildings()) {
    if (b === extractor) continue;
    if (b.buildingType !== 'extractor') continue;
    if (!b.building || b.building.hp <= 0) continue;
    if (b.buildable && !b.buildable.isComplete) continue;
    successors.push(b);
  }

  for (const depositId of owned) {
    world.depositOwners.delete(depositId);
    // Find a surviving extractor whose footprint covers this deposit.
    const deposit = world.metalDeposits[depositId];
    if (!deposit) continue;
    let promoted: Entity | null = null;
    for (const candidate of successors) {
      // Skip candidates that already own this deposit (shouldn't
      // happen given the invariant, but cheap to check) or that
      // already have it in their owned list from a previous pass.
      if (candidate.ownedDepositIds?.includes(depositId)) {
        promoted = candidate;
        break;
      }
      const fp = getExtractorFootprintGrid(candidate);
      if (!fp) continue;
      if (!metalDepositOverlapsBuildingFootprint(deposit, fp.gridX, fp.gridY, fp.gridW, fp.gridH)) {
        continue;
      }
      promoted = candidate;
      break;
    }
    if (promoted && promoted.ownership) {
      world.depositOwners.set(depositId, promoted.id);
      const list = promoted.ownedDepositIds ?? (promoted.ownedDepositIds = []);
      if (!list.includes(depositId)) list.push(depositId);
      // Promoted extractor gains exactly one deposit's worth of
      // income. Update both its stored rate and the player's tally.
      syncExtractorRate(promoted);
      world.markSnapshotDirty(promoted.id, ENTITY_CHANGED_BUILDING);
      economyManager.addMetalExtraction(promoted.ownership.playerId, perDeposit);
    }
  }

  extractor.ownedDepositIds = [];
  extractor.metalExtractionRate = 0;
  // Caller subtracts `lostIncome` from the destroyed extractor's
  // owner's metal extraction tally (mirrors what addMetalExtraction
  // did when the extractor first claimed).
  void ownerId;
  return lostIncome;
}
