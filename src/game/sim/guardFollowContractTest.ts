import { CommandQueue } from './commands';
import { ConstructionSystem } from './construction';
import { executeCommand, type CommandContext } from './commandExecution';
import { Simulation } from './Simulation';
import { WorldState } from './WorldState';
import { PhysicsEngine3D } from '../server/PhysicsEngine3D';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[guard follow contract] ${message}`);
}

/** Regression for the real default-command path: a Sea Turtle guards a
 * Commander that is already walking away. The guard host must immediately
 * apply follow thrust; its mounted gun and move state are independent. */
export function runGuardFollowContractTest(): void {
  const world = new WorldState(17, 512, 512);
  const seaTurtle = world.createUnitFromBlueprint(80, 180, 1, 'unitSeaTurtle', {
    allocateSubEntityIds: false,
  });
  const commander = world.createUnitFromBlueprint(190, 180, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  world.addEntity(seaTurtle);
  world.addEntity(commander);

  const physics = new PhysicsEngine3D(world.mapWidth, world.mapHeight);
  physics.setGroundLookup(
    (x, y) => world.getGroundZ(x, y),
    (x, y) => world.getCachedSurfaceNormal(x, y),
  );
  assertContract(
    createPhysicsBodyForUnit(world, physics, seaTurtle) !== undefined &&
      createPhysicsBodyForUnit(world, physics, commander) !== undefined,
    'guard and target physics bodies must exist for the movement pass',
  );

  const context: CommandContext = {
    world,
    constructionSystem: new ConstructionSystem(world.mapWidth, world.mapHeight),
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  executeCommand(context, {
    type: 'move',
    tick: 1,
    entityIds: [commander.id],
    targetX: 400,
    targetY: 180,
    waypointType: 'move',
    queue: false,
  });
  executeCommand(context, {
    type: 'guard',
    tick: 1,
    entityIds: [seaTurtle.id],
    targetId: commander.id,
    queue: false,
  });

  try {
    const simulation = new Simulation(world, new CommandQueue());
    simulation.update(16);
    assertContract(
      simulation.getMovingUnits().includes(seaTurtle),
      'a distant Sea Turtle must apply guard-follow thrust while its Commander target moves away',
    );
  } finally {
    physics.dispose();
  }
}
