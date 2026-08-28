import { resetReusableSimulationStateForDeterministicReplay } from '../architecture/DeterministicReplayHarness';
import { flatWaterWorldConfig } from '../server/flatWaterContractWorld';
import { LOCKSTEP_FIXED_DT_MS } from '../architecture/LockstepFrameScheduler';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';
import type { StartBuildCommand } from '../../types/commands';
import type { EntityId, PlayerId } from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[build approach goal fallback contract] ${message}`);
}

/** Flat land with a water perimeter — the trap below is built from building
 *  footprints, so terrain stays out of the picture. */
const CONFIG = flatWaterWorldConfig(21);

const POCKET_WALL_ENTITY_ID_BASE = 910_001;
/** The full route must land within a small number of ticks: one search that
 *  discovers the stand-off is stranded, then the immediate action-point
 *  retry. 60 ticks (3 s) is generous for both under the per-tick budget. */
const ROUTE_TICK_LIMIT = 60;
/** The doomed stand-off must cost a HANDFUL of unreachable searches, not one
 *  per tick: before the fallback existed this fixture burned ~390 in 400
 *  ticks while the builder never received a route. */
const UNREACHABLE_SEARCH_CEILING = 4;

/**
 * A build/attack order's navigation goal is a DERIVED stand-off (the approach
 * point just outside the footprint toward the builder), and the kernel's goal
 * snapping only requires a PASSABLE cell — not a connected one. A stand-off
 * that lands in a passable pocket (a terrace on a steep rugged face, a walled
 * courtyard) therefore searches to "unreachable" even though the build site
 * itself is perfectly reachable, and before 2026-08-27 that stranded the
 * order forever: the builder stood still, burning an unreachable search per
 * backoff, and no path was ever proposed — while a plain MOVE to the same
 * spot routed instantly (its goal is the authored click point).
 *
 * The contract: one unreachable result for a derived goal immediately re-aims
 * the SAME queued request at the authored action point (which snapping moves
 * to the nearest open ground beside the footprint), so the builder routes and
 * the order proceeds. The fixture builds the exact trap: an extractor site on
 * open ground whose approach cell is walled in on all sides.
 */
export function runBuildApproachGoalFallbackContractTest(): void {
  resetReusableSimulationStateForDeterministicReplay();
  const boot = ServerBootstrap.bootstrap(CONFIG);
  const core = new ServerSimulationCore(boot);
  try {
    const commander = core.world.getCommander(1 as PlayerId);
    assertContract(commander !== undefined, 'player 1 commander present after bootstrap');
    for (let i = 0; i < 4; i++) core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);

    const builder = core.world.createUnitFromBlueprint(
      commander.transform.x + 80,
      commander.transform.y + 80,
      1 as PlayerId,
      'unitAdvancedConstructionBot',
    );
    core.world.addEntity(builder);
    createPhysicsBodyForUnit(core.world, core.physics, builder);
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);

    // The site mirrors the spawn across the map — far beyond the direct-plan
    // gate, so the order must ride the request queue.
    const grid = core.simulation.getConstructionSystem().getGrid();
    const siteCell = grid.worldToGrid(
      core.world.mapWidth - commander.transform.x,
      core.world.mapHeight - commander.transform.y,
    );
    const siteCenter = { x: siteCell.gx * 20 + 50, y: siteCell.gy * 20 + 50 };

    // The trap: wall in the cell the approach stand-off will land on (site
    // center pulled back toward the builder by footprint half-extent +
    // builder radius + arrival radius). A 5x5 ring with a free 3x3 interior
    // keeps the goal cell passable while disconnecting it, and stays clear
    // of the extractor footprint itself.
    const toBuilder = {
      x: builder.transform.x - siteCenter.x,
      y: builder.transform.y - siteCenter.y,
    };
    const toBuilderLength = Math.hypot(toBuilder.x, toBuilder.y);
    const approachCell = grid.worldToGrid(
      siteCenter.x + (toBuilder.x / toBuilderLength) * 117,
      siteCenter.y + (toBuilder.y / toBuilderLength) * 117,
    );
    let pocketWall = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
        grid.place(
          approachCell.gx + dx,
          approachCell.gy + dy,
          1,
          1,
          (POCKET_WALL_ENTITY_ID_BASE + pocketWall++) as EntityId,
          2 as PlayerId,
          true,
        );
      }
    }
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);

    const command: StartBuildCommand = {
      type: 'startBuild',
      tick: core.world.getTick(),
      builderIds: [builder.id],
      buildingBlueprintId: 'buildingExtractor',
      gridX: siteCell.gx,
      gridY: siteCell.gy,
      queue: false,
    };
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, [command]);
    const action = builder.unit!.actions[0];
    assertContract(
      action !== undefined && action.type === 'build',
      'the startBuild command must place the ghost and enqueue the build action',
    );

    let routeTick = -1;
    for (let t = 0; t < ROUTE_TICK_LIMIT; t++) {
      core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);
      const plan = builder.unit!.activePath;
      if (plan !== null && plan.resolution !== 'coarse') {
        routeTick = t + 1;
        break;
      }
    }
    const outcomes = core.simulation.getPathQueryOutcomeStats();
    assertContract(
      routeTick >= 0,
      `a build order whose stand-off approach goal is stranded must fall back ` +
        `to the action point and route; no full route after ${ROUTE_TICK_LIMIT} ticks ` +
        `(unreachable searches: ${outcomes.unreachable})`,
    );
    assertContract(
      outcomes.unreachable <= UNREACHABLE_SEARCH_CEILING,
      `the doomed stand-off must cost at most ${UNREACHABLE_SEARCH_CEILING} unreachable ` +
        `searches before the fallback lands, got ${outcomes.unreachable}`,
    );
  } finally {
    core.dispose();
  }
}
