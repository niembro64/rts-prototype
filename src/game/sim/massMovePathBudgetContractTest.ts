import { resetReusableSimulationStateForDeterministicReplay } from '../architecture/DeterministicReplayHarness';
import { flatWaterWorldConfig } from '../server/flatWaterContractWorld';
import { LOCKSTEP_FIXED_DT_MS } from '../architecture/LockstepFrameScheduler';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';
import type { MoveCommand, WaypointTarget } from '../../types/commands';
import { PATHFINDING_A_STAR_EXPANSIONS_PER_TICK } from './pathfindingTuning';
import { PATH_REQUEST_NONE } from './SimulationPathPlanScheduler';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, EntityId, PlayerId } from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[mass move path budget contract] ${message}`);
}

/** Flat land: a wall of grounded building footprints is raised across the
 *  middle of the map below (see WALL_*), leaving one gap at the far side.
 *  Every route from the spawn arc to its mirrored goal stays reachable but
 *  can never take the free direct-segment shortcut, so each one is a real
 *  hierarchical search. (A terrain dome high enough to block the line also
 *  disconnects the two arcs, and an unreachable goal is a different, far
 *  more expensive search.) */
const CONFIG = flatWaterWorldConfig(21);

/** Enough units that their routes cannot all be searched inside one tick's
 *  work budget, so the only way the command tick stays cheap is by queueing. */
const ARMY_SIZE = 320;
/** A slice may overshoot the ceiling by at most the step it was inside when
 *  the budget ran out (one HPA row, one cluster build); two ceilings is a
 *  generous bound that still fails by orders of magnitude when a command
 *  searches every unit's route synchronously. */
const PER_TICK_EXPANSION_CEILING = PATHFINDING_A_STAR_EXPANSIONS_PER_TICK * 2;
const DRAIN_TICK_LIMIT = 1200;
/** Wall geometry in build-grid cells: four cells thick, spanning the whole
 *  map width except one gap well off the spawn-to-goal axis (the map edge is
 *  a water ring, so an edge gap would leave the arcs disconnected). */
const WALL_THICKNESS_CELLS = 4;
const WALL_GAP_START_CELL = 150;
const WALL_GAP_CELLS = 30;
const WALL_BLOCK_WIDTH_CELLS = 10;
const WALL_ENTITY_ID_BASE = 900_001;
/** Routes across a 21-cell map cost hundreds of work units each, so 320 of
 *  them cannot fit in two budgets; a correct scheduler needs several ticks. */
const MIN_DRAIN_TICKS = 2;
/** The second player's lone request must be moving (a validated first leg or
 *  a full route) within this many ticks of the command, and hold its full
 *  route within RIVAL_FULL_ROUTE_TICK_LIMIT, however deep the flood is. */
const RIVAL_FIRST_MOTION_TICK_LIMIT = 2;
/** The rival's full route (a cold hierarchical search shared with the army's
 *  class graph) lands no later than the FIRST army route plus this slack, and
 *  within an absolute bound however cold the graph is. */
const RIVAL_FULL_ROUTE_SLACK_TICKS = 2;
const RIVAL_FULL_ROUTE_TICK_LIMIT = 60;

/**
 * Pathfinding is a queued, budgeted, resumable job — never a burst inside the
 * tick that issued the order. This is the third time that rule has been
 * broken (2026-06-08 line-move slot snapping searched every unit's route
 * synchronously; it survived the 2026-07-24 scheduler and the 2026-08-17
 * synchronous escape hatch beside the slice API, and froze production under
 * whole-army line moves after the 2026-08-25 overhaul made each search far
 * more expensive). The contract, in the order a player experiences it:
 *
 *   1. The tick that APPLIES a whole-army move performs at most one tick's
 *      worth of search work, no matter how many units it addresses.
 *   2. The requests it could not serve are still queued when that tick ends.
 *   3. Every later tick stays under the same ceiling while the queue drains.
 *   4. The queue does drain: every unit ends up with an authoritative route.
 *   5. Queues are per PLAYER: another player's single request, issued in the
 *      same tick as the flood, gets its first motion within a tick and its
 *      full route within a few — it never waits behind the army.
 */
export function runMassMovePathBudgetContractTest(): void {
  resetReusableSimulationStateForDeterministicReplay();
  const boot = ServerBootstrap.bootstrap(CONFIG);
  const core = new ServerSimulationCore(boot);
  try {
    const commander = core.world.getCommander(1 as PlayerId);
    assertContract(commander !== undefined, 'player 1 commander present after bootstrap');
    // Let the bootstrap settle (bodies on the ground, caches warm) so the
    // command tick measures the command, not the spawn.
    for (let i = 0; i < 4; i++) core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);

    const army: Entity[] = [];
    const columns = 16;
    for (let i = 0; i < ARMY_SIZE; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const unit = core.world.createUnitFromBlueprint(
        commander.transform.x - 255 + col * 34,
        commander.transform.y - 323 + row * 34,
        1 as PlayerId,
        'unitJackal',
      );
      core.world.addEntity(unit);
      createPhysicsBodyForUnit(core.world, core.physics, unit);
      army.push(unit);
    }
    // The rival: one unit of the OTHER player, whose request is issued in the
    // very same tick as the flood.
    const rivalCommander = core.world.getCommander(2 as PlayerId);
    assertContract(rivalCommander !== undefined, 'player 2 commander present after bootstrap');
    const rival = core.world.createUnitFromBlueprint(
      rivalCommander.transform.x + 120,
      rivalCommander.transform.y + 120,
      2 as PlayerId,
      'unitJackal',
    );
    core.world.addEntity(rival);
    createPhysicsBodyForUnit(core.world, core.physics, rival);
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);

    // Raise the wall halfway between the two arcs. Grounded footprints on the
    // build grid are exactly what the pathfinder's occupancy layer reads.
    const grid = core.simulation.getConstructionSystem().getGrid();
    const wallRow = grid.worldToGrid(0, core.world.mapHeight / 2).gy;
    const mapEndCell = grid.worldToGrid(core.world.mapWidth, 0).gx;
    let wallBlock = 0;
    const placeWallSpan = (fromCell: number, toCell: number): void => {
      for (let gx = fromCell; gx < toCell; gx += WALL_BLOCK_WIDTH_CELLS) {
        grid.place(
          gx,
          wallRow,
          Math.min(WALL_BLOCK_WIDTH_CELLS, toCell - gx),
          WALL_THICKNESS_CELLS,
          (WALL_ENTITY_ID_BASE + wallBlock++) as EntityId,
          2 as PlayerId,
          true,
        );
      }
    };
    placeWallSpan(0, WALL_GAP_START_CELL);
    placeWallSpan(WALL_GAP_START_CELL + WALL_GAP_CELLS, mapEndCell);
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);

    // A drag line-move across the whole map: every target is far beyond the
    // direct-segment distance, so every unit needs a real hierarchical search.
    const goalX = core.world.mapWidth - commander.transform.x;
    const goalY = core.world.mapHeight - commander.transform.y;
    const entityIds: EntityId[] = [];
    const individualTargets: WaypointTarget[] = [];
    for (let i = 0; i < army.length; i++) {
      entityIds.push(army[i].id);
      const x = goalX - 255 + (i % columns) * 34;
      const y = goalY - 323 + Math.floor(i / columns) * 34;
      individualTargets.push({ x, y, z: core.world.getTerrainBedZ(x, y) });
    }
    const command: MoveCommand = {
      type: 'move',
      tick: core.world.getTick(),
      entityIds,
      individualTargets,
      waypointType: 'move',
      queue: false,
    };
    const rivalGoalX = core.world.mapWidth - rivalCommander.transform.x;
    const rivalGoalY = core.world.mapHeight - rivalCommander.transform.y;
    const rivalCommand: MoveCommand = {
      type: 'move',
      tick: core.world.getTick(),
      entityIds: [rival.id],
      individualTargets: [{ x: rivalGoalX, y: rivalGoalY, z: core.world.getTerrainBedZ(rivalGoalX, rivalGoalY) }],
      waypointType: 'move',
      queue: false,
    };

    // The WASM counter sees EVERY search, whichever API ran it. The scheduler's
    // own expansionsUsed cannot stand in for it: a synchronous search bypasses
    // the scheduler and would leave that number untouched — exactly how the
    // 2026-06..08 regression stayed invisible to the scheduler's statistics.
    const totalWorkUnits = (): number => getSimWasm()!.pathfinder.totalWorkUnits();
    const workBefore = totalWorkUnits();
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, [command, rivalCommand]);
    const commandTickExpansions = totalWorkUnits() - workBefore;
    assertContract(
      commandTickExpansions <= PER_TICK_EXPANSION_CEILING,
      `the command tick searched ${commandTickExpansions} work units for ${ARMY_SIZE} units; ` +
        `the ceiling is ${PER_TICK_EXPANSION_CEILING} — routes must queue, not burst`,
    );
    let queuedAfterCommandTick = 0;
    for (let i = 0; i < army.length; i++) {
      if (army[i].unit!.pathRequestLane !== PATH_REQUEST_NONE) queuedAfterCommandTick++;
    }
    assertContract(
      queuedAfterCommandTick > 0,
      `${ARMY_SIZE} far routes cannot all resolve inside one budget; ` +
        'expected requests still queued after the command tick',
    );

    let worstTickExpansions = commandTickExpansions;
    let drainTicks = 0;
    // A unit that was routed early may already have ARRIVED (its plan is
    // cleared on completion), so success is "every unit received a route at
    // some point", tracked as a sticky set, not "every unit holds one now".
    // A coarse first leg is motion, not a route: it does not count here.
    const everRouted = new Set<EntityId>();
    let routed = 0;
    let rivalFirstMotionTick = rival.unit!.activePath !== null ? 0 : -1;
    let rivalFullRouteTick = -1;
    let pendingWhenRivalRouted = -1;
    let firstArmyRouteTick = -1;
    for (; drainTicks < DRAIN_TICK_LIMIT; drainTicks++) {
      const before = totalWorkUnits();
      core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);
      const used = totalWorkUnits() - before;
      if (used > worstTickExpansions) worstTickExpansions = used;
      assertContract(
        used <= PER_TICK_EXPANSION_CEILING,
        `tick ${drainTicks + 1} after the command searched ${used} work units; ` +
          `ceiling ${PER_TICK_EXPANSION_CEILING}`,
      );
      let pending = 0;
      for (let i = 0; i < army.length; i++) {
        const unit = army[i].unit!;
        if (unit.activePath !== null && unit.activePath.resolution !== 'coarse') {
          everRouted.add(army[i].id);
        }
        if (unit.pathRequestLane !== PATH_REQUEST_NONE) pending++;
      }
      const rivalPlan = rival.unit!.activePath;
      if (rivalPlan !== null && rivalFirstMotionTick < 0) rivalFirstMotionTick = drainTicks + 1;
      if (rivalPlan !== null && rivalPlan.resolution !== 'coarse' && rivalFullRouteTick < 0) {
        rivalFullRouteTick = drainTicks + 1;
        pendingWhenRivalRouted = pending;
      }
      routed = everRouted.size;
      if (routed > 0 && firstArmyRouteTick < 0) firstArmyRouteTick = drainTicks + 1;
      if (pending === 0 && routed === army.length) break;
    }
    assertContract(
      rivalFirstMotionTick >= 0 && rivalFirstMotionTick <= RIVAL_FIRST_MOTION_TICK_LIMIT,
      `the other player's unit must be moving within ${RIVAL_FIRST_MOTION_TICK_LIMIT} ticks of ` +
        `the flood, got ${rivalFirstMotionTick < 0 ? 'never' : rivalFirstMotionTick}`,
    );
    assertContract(
      rivalFullRouteTick >= 0 && rivalFullRouteTick <= RIVAL_FULL_ROUTE_TICK_LIMIT &&
        rivalFullRouteTick <= firstArmyRouteTick + RIVAL_FULL_ROUTE_SLACK_TICKS,
      `the other player's unit must hold its full route no later than the flood's first route ` +
        `(+${RIVAL_FULL_ROUTE_SLACK_TICKS} ticks) and within ${RIVAL_FULL_ROUTE_TICK_LIMIT} ticks; ` +
        `got rival ${rivalFullRouteTick < 0 ? 'never' : rivalFullRouteTick}, army ${firstArmyRouteTick} ` +
        `(army still pending then: ${pendingWhenRivalRouted})`,
    );
    assertContract(
      routed === army.length,
      `only ${routed}/${ARMY_SIZE} units ever received an authoritative route after ${drainTicks} ticks`,
    );
    // A blob of identical bodies leaving one cluster for one goal cluster
    // shares routes: most of the army must have adopted a cached route
    // instead of searching (the shared cache is what makes a thousand-unit
    // order a few dozen searches).
    const outcomes = core.simulation.getPathQueryOutcomeStats();
    assertContract(
      outcomes.sharedRouteHits >= ARMY_SIZE / 4,
      `only ${outcomes.sharedRouteHits} of ${ARMY_SIZE} routes came from the shared route cache`,
    );
    assertContract(
      drainTicks >= MIN_DRAIN_TICKS,
      `a whole-army order must drain across ticks, not inside the tick that issued it ` +
        `(routed ${routed} units after ${drainTicks} drain ticks; worst tick ${worstTickExpansions})`,
    );
  } finally {
    core.dispose();
  }
}
