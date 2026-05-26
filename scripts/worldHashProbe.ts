import { computeSimulationWorldHash } from '../src/game/sim/worldHash';

type WorldHashInput = Parameters<typeof computeSimulationWorldHash>[0];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function makeEntity(id: number, x: number): { id: number; type: string; [key: string]: unknown } {
  return {
    id,
    type: 'unit',
    transform: { x, y: 64, z: 8, rotation: 0, rotCos: 1, rotSin: 0 },
    body: {
      physicsBody: {
        slot: id,
        shape: 'sphere',
        mass: 25,
        isStatic: false,
        label: `unit-${id}`,
        entityId: id,
        x,
        y: 64,
        z: 8,
        vx: 1,
        vy: 0,
        vz: 0,
        ax: 0,
        ay: 0,
        az: 0,
        groundLaunchAx: 0,
        groundLaunchAy: 0,
        groundLaunchAz: 0,
        surfaceNormalX: 0,
        surfaceNormalY: 0,
        surfaceNormalZ: 1,
        radius: 12,
        halfX: 0,
        halfY: 0,
        halfZ: 0,
        invMass: 1 / 25,
        restitution: 0.2,
        groundOffset: 0,
        sleepTicks: 0,
        sleeping: false,
        upwardSurfaceContact: true,
      },
    },
    selectable: { selected: false },
    ownership: { playerId: id },
    cloak: null,
    detector: { radius: 80 },
    unit: {
      unitType: 'probe',
      hp: 100,
      maxHp: 100,
      actions: [{ type: 'move', x: 200, y: 200, z: 0, queue: false }],
      velocityX: 1,
      velocityY: 0,
      velocityZ: 0,
    },
    building: null,
    combat: null,
    projectile: null,
    buildable: null,
    builder: null,
    factory: null,
    commander: null,
    dgunProjectile: null,
    buildingType: null,
    coveredDepositIds: null,
    metalExtractionRate: null,
    _cachedFullVisionRadius: -1,
  };
}

function makeScenario(reverseEntities = false): WorldHashInput {
  const entities = [makeEntity(2, 140), makeEntity(1, 100)];
  const orderedEntities = reverseEntities ? entities.slice().reverse() : entities;
  return {
    world: {
      getHashMetadata: () => ({
        tick: 12,
        nextEntityId: 3,
        buildingVersion: 0,
        unitSetVersion: 2,
        maxTargetableRadius: 16,
        rngSeed: 123456,
        activePlayerId: 1,
        playerCount: 2,
        mapWidth: 512,
        mapHeight: 512,
        thrustMultiplier: 8,
        maxTotalUnits: 500,
        mirrorsEnabled: true,
        forceFieldsEnabled: true,
        forceFieldsObstructSight: true,
        forceFieldReflectionMode: 'all',
        fogOfWarEnabled: true,
        converterTax: 0,
        alliesByPlayer: [{ playerId: 1, allies: [2] }, { playerId: 2, allies: [1] }],
        scanPulses: [{ playerId: 1, x: 256, y: 256, z: 0, radius: 120, expiresAtTick: 60 }],
        pendingDeathCheckIds: [],
        metalDeposits: [],
      }),
      getAllEntities: () => orderedEntities,
    },
    commandQueue: {
      getHashState: () => ({
        nextSequence: 1,
        commands: [{
          sequence: 0,
          command: {
            type: 'move',
            tick: 18,
            entityIds: [1, 2],
            targetX: 220,
            targetY: 240,
            targetZ: 0,
            waypointType: 'move',
            queue: false,
          },
        }],
      }),
    },
    simulationState: {
      gamePhase: 'battle',
      simElapsedMs: 200,
      windState: { x: 0.5, y: 0.25, speed: 0.75, angle: 0.2 },
    },
    economyState: [
      { playerId: 1, state: { stockpile: { curr: 500, max: 1000 }, income: { base: 10, production: 2 }, expenditure: 1 } },
      { playerId: 2, state: { stockpile: { curr: 500, max: 1000 }, income: { base: 10, production: 2 }, expenditure: 1 } },
    ],
  };
}

const baseline = makeScenario();
const first = computeSimulationWorldHash(baseline);
const second = computeSimulationWorldHash(makeScenario(true));
assert(first === second, `entity order changed hash: ${first} !== ${second}`);

const mutated = makeScenario();
const firstEntity = mutated.world.getAllEntities()[0] as unknown as { unit: { hp: number } };
firstEntity.unit.hp -= 1;
const changed = computeSimulationWorldHash(mutated);
assert(changed !== first, 'future-affecting mutation did not change hash');

console.log(`world hash probe ok: ${first} -> ${changed}`);
