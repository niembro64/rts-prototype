import type { Entity, UnitAction } from './types';
import { getSimWasm } from '../sim-wasm/init';
import {
  ENTITY_SLOT_FLAG_HAS_BUILDING,
  ENTITY_SLOT_FLAG_HAS_UNIT,
} from './EntitySlotRegistry';
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
  UNIT_ACTION_RANGE_KIND_BUILD,
  UNIT_ACTION_RANGE_KIND_GUARD_SERVICE,
  UNIT_ACTION_RANGE_KIND_LOAD,
  UNIT_ACTION_RANGE_KIND_NONE,
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
import {
  SimulationUnitActionMovementPlanner,
  UNIT_ACTION_MOVEMENT_DECISION_ADVANCE_PATH,
  UNIT_ACTION_MOVEMENT_DECISION_HOLD,
  UNIT_ACTION_MOVEMENT_DECISION_THRUST,
  type UnitActionMovementDecision,
} from './SimulationUnitActionMovementPlanner';

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
  const entity = { id: 1, entitySlotId: 10 } as Entity;
  const serviceTarget = { id: 2 } as Entity;

  const classify = (
    unitAction: UnitAction | undefined,
    flags = 0,
    target: Entity | null = null,
    rangeKind: number = UNIT_ACTION_RANGE_KIND_NONE,
    targetSlot = -1,
    rangeParam = 0,
  ): UnitActionPlanCode => {
    planner.begin(1);
    planner.queue(entity, unitAction, flags, target, rangeKind, targetSlot, rangeParam);
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

  // Native range resolution: the plan batch reads self/target state from
  // the entity-state slab and ORs the in-range bits into the row flags.
  const rangeSim = getSimWasm();
  assertContract(rangeSim !== undefined, 'sim-wasm must be initialized for range contract');
  rangeSim.entityState.clear();
  // Self: builder unit at the origin (slot 10, collision radius 5).
  rangeSim.entityState.setLifecycle(10, 1, 2, 1, 1, ENTITY_SLOT_FLAG_HAS_UNIT);
  rangeSim.entityState.setTransform(10, 0, 0, 0, 0);
  rangeSim.entityState.setStaticShape(10, 5, 5, 5, 5, 5, 5);
  // Building target: 40x20 footprint centered at (100, 0) (slot 11) —
  // closest footprint edge sits 80 from the builder.
  rangeSim.entityState.setLifecycle(11, 2, 1, 2, 2, ENTITY_SLOT_FLAG_HAS_BUILDING);
  rangeSim.entityState.setTransform(11, 100, 0, 0, 0);
  rangeSim.entityState.setStaticShape(11, 15, 15, 20, 20, 10, 8);
  // Unit target: collision radius 10 at (0, 50) (slot 12) — build
  // distance 40, load distance 50 against 5 + 10 + 24 padding = 39.
  rangeSim.entityState.setLifecycle(12, 3, 2, 2, 2, ENTITY_SLOT_FLAG_HAS_UNIT);
  rangeSim.entityState.setTransform(12, 0, 50, 0, 0);
  rangeSim.entityState.setStaticShape(12, 10, 10, 10, 10, 10, 10);

  assertContract(
    classify(action('build', { buildingId: 2 }), 0, null, UNIT_ACTION_RANGE_KIND_BUILD, 11, 90) ===
      UNIT_ACTION_PLAN_BUILD_HOLD,
    'native build range: 80 from the footprint edge inside range 90 holds',
  );
  assertContract(
    (planner.flagsAt(0) & UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE) !== 0,
    'native build range writes the in-range flag back to the row',
  );
  assertContract(
    classify(action('build', { buildingId: 2 }), 0, null, UNIT_ACTION_RANGE_KIND_BUILD, 11, 70) ===
      UNIT_ACTION_PLAN_BUILD_MOVE,
    'native build range: range 70 against distance 80 moves',
  );
  assertContract(
    classify(action('repair', { targetId: 3 }), 0, null, UNIT_ACTION_RANGE_KIND_BUILD, 12, 41) ===
      UNIT_ACTION_PLAN_BUILD_HOLD,
    'native build range vs unit subtracts the target collision radius',
  );
  assertContract(
    classify(action('repair', { targetId: 3 }), 0, null, UNIT_ACTION_RANGE_KIND_BUILD, 12, 39) ===
      UNIT_ACTION_PLAN_BUILD_MOVE,
    'native build range vs unit: range 39 against distance 40 moves',
  );
  assertContract(
    classify(action('build', { buildingId: 9 }), 0, null, UNIT_ACTION_RANGE_KIND_BUILD, -1, 90) ===
      UNIT_ACTION_PLAN_BUILD_MOVE,
    'missing target slot resolves out of range like a vanished target',
  );
  assertContract(
    classify(action('build', { buildingId: 2 }), 0, null, UNIT_ACTION_RANGE_KIND_BUILD, 11, 0) ===
      UNIT_ACTION_PLAN_BUILD_MOVE,
    'zero build range (non-builder) never resolves in range',
  );

  assertContract(
    classify(action('loadTransport', { targetId: 3 }), 0, null, UNIT_ACTION_RANGE_KIND_LOAD, 12, 0) ===
      UNIT_ACTION_PLAN_LOAD_MOVE,
    'native load range: distance 50 beyond radii + padding 39 keeps moving',
  );
  rangeSim.entityState.setTransform(12, 0, 35, 0, 0);
  assertContract(
    classify(action('loadTransport', { targetId: 3 }), 0, null, UNIT_ACTION_RANGE_KIND_LOAD, 12, 0) ===
      UNIT_ACTION_PLAN_LOAD_HOLD,
    'native load range: distance 35 within radii + padding 39 holds',
  );
  assertContract(
    (planner.flagsAt(0) & UNIT_ACTION_FLAG_LOAD_IN_RANGE) !== 0,
    'native load range writes the in-range flag back to the row',
  );

  rangeSim.entityState.setTransform(12, 0, 50, 0, 0);
  assertContract(
    classify(
      action('guard', { targetId: 3 }),
      UNIT_ACTION_FLAG_TARGET_PRESENT |
        UNIT_ACTION_FLAG_GUARD_FRIENDLY |
        UNIT_ACTION_FLAG_GUARD_SERVICE,
      serviceTarget,
      UNIT_ACTION_RANGE_KIND_GUARD_SERVICE,
      12,
      41,
    ) === UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD,
    'native guard service range holds inside build range',
  );
  assertContract(
    (planner.flagsAt(0) & UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE) !== 0,
    'native guard service range writes its own flag bit',
  );
  rangeSim.entityState.clear();

  const sim = getSimWasm();
  assertContract(sim !== undefined, 'sim-wasm must be initialized for movement planner contract');
  sim.entityState.clear();
  sim.entityState.setTransform(3, 10, 20, 0, 0);

  const movementPlanner = new SimulationUnitActionMovementPlanner();
  const classifyMovement = (
    slot: number,
    targetX: number,
    targetY: number,
    threshold: number,
    isFinalActionPoint: boolean,
  ): UnitActionMovementDecision => {
    movementPlanner.begin(1);
    movementPlanner.queue(
      entity,
      action('move'),
      UNIT_ACTION_PLAN_MOVE_COMPLETION,
      slot,
      targetX,
      targetY,
      threshold,
      isFinalActionPoint,
    );
    assertContract(movementPlanner.compute() === 1, 'single queued movement must produce one decision');
    return movementPlanner.decisionAt(0);
  };

  assertContract(
    classifyMovement(3, 14, 23, 3, true) === UNIT_ACTION_MOVEMENT_DECISION_THRUST,
    'movement beyond threshold thrusts from entity-state slot position',
  );
  assertContract(
    movementPlanner.dxAt(0) === 4 && movementPlanner.dyAt(0) === 3 && movementPlanner.distanceAt(0) === 5,
    'movement batch outputs dx/dy/distance from slot position',
  );
  assertContract(
    classifyMovement(3, 11, 20, 3, false) === UNIT_ACTION_MOVEMENT_DECISION_ADVANCE_PATH,
    'movement inside threshold on intermediate path advances path point',
  );
  assertContract(
    classifyMovement(3, 11, 20, 3, true) === UNIT_ACTION_MOVEMENT_DECISION_HOLD,
    'movement inside threshold on final path holds',
  );
  assertContract(
    classifyMovement(-1, 11, 20, 3, true) === UNIT_ACTION_MOVEMENT_DECISION_HOLD,
    'invalid movement slot holds without reading slab memory',
  );
}
