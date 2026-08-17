import { CommandQueue } from './commands';
import { Simulation } from './Simulation';
import type { Entity, Unit, UnitAction } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[path plan safety contract] ${message}`);
}

export function runPathPlanSafetyContractTest(): void {
  const world = new WorldState(1, 1_000, 1_000);
  const entity = world.createUnitFromBlueprint(240, 360, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  world.addEntity(entity);
  const action: UnitAction = { type: 'move', x: 900, y: 900, z: 0 };
  const simulation = new Simulation(world, new CommandQueue()) as unknown as {
    ensureActivePathPlan(entity: Entity, action: UnitAction): Unit['activePath'];
    resolveActiveMovementTarget(entity: Entity, action: UnitAction): {
      x: number;
      y: number;
      z?: number;
      isFinalActionPoint: boolean;
      pathAdvanceRadius: number;
    };
  };
  // Isolate the null-plan policy from terrain setup: an exhausted or pending
  // fresh route is exactly the state this private resolver receives.
  simulation.ensureActivePathPlan = () => null;
  const target = simulation.resolveActiveMovementTarget(entity, action);
  assertContract(
    target.x === entity.transform.x && target.y === entity.transform.y,
    'a unit awaiting A* must target its current position, never the raw command point',
  );
  assertContract(
    target.isFinalActionPoint === false && target.pathAdvanceRadius === 0,
    'the hold target cannot complete or consume the durable movement action',
  );
}
