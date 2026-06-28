import type { Entity, UnitAction } from './types';
import {
  SimulationUnitActionPlanner,
  UNIT_ACTION_FLAG_COMBAT_STOP_ANY,
  UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT,
  UNIT_ACTION_FLAG_GUARD_FRIENDLY,
  UNIT_ACTION_FLAG_GUARD_SERVICE,
  UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE,
  UNIT_ACTION_FLAG_LOAD_IN_RANGE,
  UNIT_ACTION_FLAG_MOVE_STATE_HOLD,
  UNIT_ACTION_FLAG_TARGET_PRESENT,
  UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE,
  UNIT_ACTION_FLAG_TRANSPORT_EMPTY,
  UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD,
  UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE,
  UNIT_ACTION_PLAN_ATTACK_HOLD,
  UNIT_ACTION_PLAN_ATTACK_MOVE,
  UNIT_ACTION_PLAN_BUILD_HOLD,
  UNIT_ACTION_PLAN_BUILD_MOVE,
  UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD,
  UNIT_ACTION_PLAN_GUARD_ADVANCE,
  UNIT_ACTION_PLAN_GUARD_FOLLOW,
  UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD,
  UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE,
  UNIT_ACTION_PLAN_IDLE_LOITER,
  UNIT_ACTION_PLAN_LOAD_HOLD,
  UNIT_ACTION_PLAN_LOAD_MOVE,
  UNIT_ACTION_PLAN_MOVE_COMPLETION,
  UNIT_ACTION_PLAN_UNLOAD_ADVANCE,
  UNIT_ACTION_PLAN_UNLOAD_MOVE,
  UNIT_ACTION_PLAN_WAIT_LOITER,
  type UnitActionPlanCode,
} from './SimulationUnitActionPlanner';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[simulation unit action planner contract] ${message}`);
  }
}

function action(type: UnitAction['type'], extra: Partial<UnitAction> = {}): UnitAction {
  return {
    type,
    x: 100,
    y: 200,
    ...extra,
  };
}

export function runSimulationUnitActionPlannerContractTest(): void {
  const planner = new SimulationUnitActionPlanner();
  const entity = { id: 1 } as Entity;
  const serviceTarget = { id: 2 } as Entity;

  const classify = (
    unitAction: UnitAction | undefined,
    flags = 0,
    target: Entity | null = null,
  ): UnitActionPlanCode => {
    planner.begin(1);
    planner.queue(entity, unitAction, flags, target);
    assertContract(planner.compute() === 1, 'single queued action must produce one plan');
    assertContract(planner.entityAt(0) === entity, 'planner keeps entity row identity');
    assertContract(planner.actionAt(0) === unitAction, 'planner keeps action row identity');
    return planner.planAt(0);
  };

  assertContract(classify(undefined) === UNIT_ACTION_PLAN_IDLE_LOITER, 'missing action idles/loiters');
  assertContract(classify(action('wait')) === UNIT_ACTION_PLAN_WAIT_LOITER, 'wait action loiters');

  assertContract(
    classify(action('loadTransport')) === UNIT_ACTION_PLAN_LOAD_MOVE,
    'load transport outside range moves',
  );
  assertContract(
    classify(action('loadTransport'), UNIT_ACTION_FLAG_LOAD_IN_RANGE) === UNIT_ACTION_PLAN_LOAD_HOLD,
    'load transport in range holds',
  );

  assertContract(
    classify(action('unloadTransport')) === UNIT_ACTION_PLAN_UNLOAD_MOVE,
    'loaded transport moves to unload point',
  );
  assertContract(
    classify(action('unloadTransport'), UNIT_ACTION_FLAG_TRANSPORT_EMPTY) === UNIT_ACTION_PLAN_UNLOAD_ADVANCE,
    'empty transport advances unload action',
  );

  assertContract(classify(action('build')) === UNIT_ACTION_PLAN_BUILD_MOVE, 'build outside range moves');
  assertContract(
    classify(action('repair'), UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE) === UNIT_ACTION_PLAN_BUILD_HOLD,
    'build-like action in range holds',
  );

  assertContract(
    classify(action('attack')) === UNIT_ACTION_PLAN_MOVE_COMPLETION,
    'attack without target uses generic movement completion',
  );
  assertContract(
    classify(action('attack', { targetId: 5 }), UNIT_ACTION_FLAG_TARGET_PRESENT) === UNIT_ACTION_PLAN_ATTACK_MOVE,
    'attack with target moves when not halted',
  );
  assertContract(
    classify(
      action('attack', { targetId: 5 }),
      UNIT_ACTION_FLAG_TARGET_PRESENT | UNIT_ACTION_FLAG_COMBAT_STOP_ANY,
    ) === UNIT_ACTION_PLAN_ATTACK_HOLD,
    'attack with engaged combat holds',
  );

  assertContract(
    classify(action('attackGround')) === UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE,
    'attack-ground moves when not halted',
  );
  assertContract(
    classify(action('attackGround'), UNIT_ACTION_FLAG_MOVE_STATE_HOLD) === UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD,
    'attack-ground hold-position holds',
  );

  assertContract(
    classify(action('guard')) === UNIT_ACTION_PLAN_MOVE_COMPLETION,
    'guard without target uses generic movement completion',
  );
  assertContract(
    classify(action('guard', { targetId: 7 }), UNIT_ACTION_FLAG_TARGET_PRESENT) === UNIT_ACTION_PLAN_GUARD_ADVANCE,
    'guard with non-friendly target advances action',
  );
  assertContract(
    classify(
      action('guard', { targetId: 7 }),
      UNIT_ACTION_FLAG_TARGET_PRESENT | UNIT_ACTION_FLAG_GUARD_FRIENDLY,
    ) === UNIT_ACTION_PLAN_GUARD_FOLLOW,
    'friendly guard follows',
  );
  assertContract(
    classify(
      action('guard', { targetId: 7 }),
      UNIT_ACTION_FLAG_TARGET_PRESENT |
        UNIT_ACTION_FLAG_GUARD_FRIENDLY |
        UNIT_ACTION_FLAG_GUARD_SERVICE,
      serviceTarget,
    ) === UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE,
    'builder guard service outside range moves',
  );
  assertContract(
    planner.serviceTargetAt(0) === serviceTarget,
    'planner keeps guard service target row identity',
  );
  assertContract(
    classify(
      action('guard', { targetId: 7 }),
      UNIT_ACTION_FLAG_TARGET_PRESENT |
        UNIT_ACTION_FLAG_GUARD_FRIENDLY |
        UNIT_ACTION_FLAG_GUARD_SERVICE |
        UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE,
    ) === UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD,
    'builder guard service in range holds',
  );

  assertContract(
    classify(action('fight'), UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT) === UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD,
    'fight action holds on fight-specific combat halt',
  );
  assertContract(classify(action('patrol')) === UNIT_ACTION_PLAN_MOVE_COMPLETION, 'patrol otherwise moves');
  assertContract(classify(action('move')) === UNIT_ACTION_PLAN_MOVE_COMPLETION, 'move uses completion batch');
}
