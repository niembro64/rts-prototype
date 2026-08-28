import { resetReusableSimulationStateForDeterministicReplay } from '../architecture/DeterministicReplayHarness';
import { flatWaterWorldConfig } from '../server/flatWaterContractWorld';
import { LOCKSTEP_FIXED_DT_MS } from '../architecture/LockstepFrameScheduler';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';
import { getSimWasm } from '../sim-wasm/init';
import { getCombatTargetingStateViews } from './combat/targetingInputStamping';
import { TARGETING_ACQUISITION_SCANS_PER_TICK } from '../../config';
import type { Entity, EntityId, PlayerId } from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[targeting acquisition budget contract] ${message}`);
}

const CONFIG = flatWaterWorldConfig(13);

/** Two armed lines facing each other inside weapon range (the light gun
 *  acquires at 190 wu): 32 columns by 5 rows a side, rows 20 wu apart with
 *  a 60 wu no-man's-land, so the deepest row still has an enemy within 140
 *  wu. Every host wants a candidate scan on the same tick — far more than
 *  one tick's budget. */
const ARMY_PER_SIDE = 160;
const ARMY_COLUMNS = 32;
const ARMY_COLUMN_SPACING_WU = 40;
const ARMY_ROW_SPACING_WU = 20;
const FRONT_GAP_WU = 60;
const OBSERVE_TICKS = 40;

/**
 * Target acquisition is a budgeted, rotating job: the scheduler runs at
 * most targetingAcquisitionScansPerTick candidate scans per fixed tick, a
 * host past the budget keeps its locks and firing and retries next tick,
 * and the batch starts from the first deferred host so the tail is never
 * starved. Before this the 16-tick phase shard was the only limit, and every
 * host with FSM work bypassed it — a big engagement scanned every host every
 * tick.
 */
export function runTargetingAcquisitionBudgetContractTest(): void {
  const budget = TARGETING_ACQUISITION_SCANS_PER_TICK;
  assertContract(budget > 0 && budget < ARMY_PER_SIDE * 2, `budget ${budget} must be smaller than the armies to be observable`);
  resetReusableSimulationStateForDeterministicReplay();
  const boot = ServerBootstrap.bootstrap(CONFIG);
  const core = new ServerSimulationCore(boot);
  try {
    for (let i = 0; i < 2; i++) core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);
    const armies: Entity[] = [];
    const centerX = core.world.mapWidth / 2;
    const centerY = core.world.mapHeight / 2;
    const spawnLine = (playerId: PlayerId, sideSign: number): void => {
      for (let i = 0; i < ARMY_PER_SIDE; i++) {
        const col = i % ARMY_COLUMNS;
        const row = Math.floor(i / ARMY_COLUMNS);
        const unit = core.world.createUnitFromBlueprint(
          centerX + sideSign * (FRONT_GAP_WU / 2 + row * ARMY_ROW_SPACING_WU),
          centerY + (col - (ARMY_COLUMNS - 1) / 2) * ARMY_COLUMN_SPACING_WU,
          playerId,
          'unitJackal',
        );
        core.world.addEntity(unit);
        createPhysicsBodyForUnit(core.world, core.physics, unit);
        armies.push(unit);
      }
    };
    spawnLine(1 as PlayerId, -1);
    spawnLine(2 as PlayerId, 1);
    assertContract(ARMY_COLUMNS * ARMY_COLUMN_SPACING_WU < core.world.mapHeight - 800, 'armies fit inside the land');

    const targeting = getSimWasm()!.combatTargeting;
    const everLocked = new Set<EntityId>();
    let worstTickScans = 0;
    let deferredTotal = 0;
    for (let tick = 0; tick < OBSERVE_TICKS; tick++) {
      const scansBefore = targeting.acquisitionScansTotal();
      const deferralsBefore = targeting.acquisitionDeferralsTotal();
      core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);
      const scans = targeting.acquisitionScansTotal() - scansBefore;
      deferredTotal += targeting.acquisitionDeferralsTotal() - deferralsBefore;
      if (scans > worstTickScans) worstTickScans = scans;
      assertContract(
        scans <= budget,
        `tick ${tick + 1} ran ${scans} acquisition scans; the budget is ${budget}`,
      );
      // Locks live in the targeting slab (the TS turret.target field is a
      // snapshot-time mirror); read the authoritative rows.
      const views = getCombatTargetingStateViews(getSimWasm()!);
      const stride = views.entityId.length > 0 ? views.targetId.length / views.entityId.length : 0;
      for (let i = 0; i < armies.length; i++) {
        const slot = armies[i].entitySlotId;
        if (slot < 0 || armies[i].combat === null) continue;
        for (let t = 0; t < stride; t++) {
          if (views.targetId[slot * stride + t] >= 0) {
            everLocked.add(armies[i].id);
            break;
          }
        }
      }
    }
    assertContract(
      deferredTotal > 0,
      `${ARMY_PER_SIDE * 2} hosts wanting a scan under a budget of ${budget} must defer some ` +
        `(worst tick ${worstTickScans} scans)`,
    );
    // The first tick can serve at most one budget of scans; hosts locked
    // beyond that number prove deferred hosts were retried and served.
    assertContract(
      everLocked.size > budget,
      `only ${everLocked.size}/${armies.length} hosts ever acquired a target in ${OBSERVE_TICKS} ticks ` +
        `(budget ${budget}) — a deferred host must be retried, not forgotten (worst tick ${worstTickScans} scans)`,
    );
  } finally {
    core.dispose();
  }
}
