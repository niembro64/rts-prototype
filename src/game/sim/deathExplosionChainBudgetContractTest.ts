import { resetReusableSimulationStateForDeterministicReplay } from '../architecture/DeterministicReplayHarness';
import { LOCKSTEP_FIXED_DT_MS } from '../architecture/LockstepFrameScheduler';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';
import { ENTITY_CHANGED_HP } from '@/types/network';
import type { GameServerConfig } from '../../types/game';
import { MAX_DEATH_EXPLOSIONS_PER_TICK } from '../../config';
import type { Entity, PlayerId } from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[death explosion chain budget contract] ${message}`);
}

const CONFIG: GameServerConfig = {
  playerIds: [1 as PlayerId, 2 as PlayerId],
  centerMagnitude: 0,
  ringMagnitude: 0,
  dividersMagnitude: 0,
  perimeterMagnitude: -800,
  terrainPrecedence: 'perimeter-precedence',
  terrainDTerrain: 0,
  plateauWallSlopeDegrees: 89,
  metalDepositStep: 0,
  terrainDetail: 1,
  mapWidthLandCells: 13,
  mapLengthLandCells: 13,
  converterTax: 0,
};

/** More bodies than one tick may detonate, packed inside each other's blast
 *  radius with one hit point each, so a single death chains through all. */
const CLUSTER_SIZE = 150;
const CLUSTER_COLUMNS = 15;
/** A Hippo's death blast reaches 1.4x its 27 wu hitbox (37.8 wu of centre
 *  distance); 24 wu spacing puts every neighbour inside it so one death
 *  chains through far more bodies than one tick may detonate. Knockback and
 *  contact resolution fling the survivors apart as the chain runs, so the
 *  contract is about the queue, not about total annihilation. */
const CLUSTER_SPACING_WU = 24;
const SETTLE_TICK_LIMIT = 40;

/**
 * Every death is an explosion, and an explosion may kill more bodies whose
 * deaths explode in turn. The chain is a queue drained at most
 * MAX_DEATH_EXPLOSIONS_PER_TICK blasts per fixed tick; the remainder — already
 * resolved while the dying bodies still existed — is carried into the next
 * tick in the same order. A packed base therefore detonates across a few
 * ticks instead of resolving an unbounded cascade inside one.
 */
export function runDeathExplosionChainBudgetContractTest(): void {
  resetReusableSimulationStateForDeterministicReplay();
  const boot = ServerBootstrap.bootstrap(CONFIG);
  const core = new ServerSimulationCore(boot);
  try {
    const commander = core.world.getCommander(1 as PlayerId);
    assertContract(commander !== undefined, 'player 1 commander present after bootstrap');
    for (let i = 0; i < 2; i++) core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);

    const cluster: Entity[] = [];
    // Centre the lattice on the map, well inside the perimeter water ring.
    const originX = core.world.mapWidth / 2 - (CLUSTER_COLUMNS - 1) * CLUSTER_SPACING_WU / 2;
    const originY = core.world.mapHeight / 2 -
      (Math.ceil(CLUSTER_SIZE / CLUSTER_COLUMNS) - 1) * CLUSTER_SPACING_WU / 2;
    for (let i = 0; i < CLUSTER_SIZE; i++) {
      const unit = core.world.createUnitFromBlueprint(
        originX + (i % CLUSTER_COLUMNS) * CLUSTER_SPACING_WU,
        originY + Math.floor(i / CLUSTER_COLUMNS) * CLUSTER_SPACING_WU,
        1 as PlayerId,
        'unitHippo',
      );
      core.world.addEntity(unit);
      createPhysicsBodyForUnit(core.world, core.physics, unit);
      // The damage kernel classifies from the entity-state slab; an HP write
      // on the component must be published to it like any gameplay write.
      unit.unit!.hp = 1;
      core.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_HP);
      cluster.push(unit);
    }
    // Light the fuse: one body dies this tick.
    const first = cluster[0];
    first.unit!.hp = 0;
    core.world.markSnapshotDirty(first.id, ENTITY_CHANGED_HP);

    const cap = MAX_DEATH_EXPLOSIONS_PER_TICK;
    let ticksWithDetonations = 0;
    let worstTick = 0;
    let totalDetonations = 0;
    let carriedAtSomePoint = false;
    let pending = 0;
    let quietTicks = 0;
    let ticks = 0;
    for (; ticks < SETTLE_TICK_LIMIT; ticks++) {
      core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);
      const stats = core.simulation.getDeathExplosionPlannerStats();
      totalDetonations += stats.detonationsThisTick;
      if (stats.detonationsThisTick > 0) ticksWithDetonations++;
      if (stats.detonationsThisTick > worstTick) worstTick = stats.detonationsThisTick;
      if (stats.pendingBlasts > 0) carriedAtSomePoint = true;
      pending = stats.pendingBlasts;
      assertContract(
        stats.detonationsThisTick <= cap,
        `tick ${ticks + 1} detonated ${stats.detonationsThisTick} blasts; the cap is ${cap}`,
      );
      quietTicks = stats.detonationsThisTick === 0 && pending === 0 ? quietTicks + 1 : 0;
      if (quietTicks >= 3) break;
    }
    let dead = 0;
    for (let i = 0; i < cluster.length; i++) {
      if (core.world.getEntity(cluster[i].id) === undefined) dead++;
    }
    assertContract(
      dead > cap,
      `the chain killed only ${dead} bodies, not enough to exceed one tick's cap of ${cap}`,
    );
    assertContract(
      carriedAtSomePoint && ticksWithDetonations >= 2,
      `${dead} chained deaths must be carried across ticks under a cap of ${cap} ` +
        `(worst tick ${worstTick}, ${ticksWithDetonations} ticks with detonations)`,
    );
    // Every death detonates exactly once, on whichever tick its turn comes:
    // a carried blast is never dropped and never doubled.
    assertContract(
      pending === 0 && totalDetonations === dead,
      `${dead} bodies died but ${totalDetonations} blasts detonated with ${pending} still carried`,
    );
  } finally {
    core.dispose();
  }
}
