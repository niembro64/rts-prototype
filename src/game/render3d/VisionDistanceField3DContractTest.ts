import { spatialGrid } from '../sim/SpatialGrid';
import { WorldState } from '../sim/WorldState';
import { WATER_LEVEL } from '../sim/Terrain';
import type { Entity, PlayerId } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import { CONTACT_MEDIUM_AIR, CONTACT_MEDIUM_WATER } from '../network/contactMedium';
import { VisionDistanceField3D } from './VisionDistanceField3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[vision distance field contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  assertContract(
    Math.abs(actual - expected) <= 1e-6,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

type Sensors = {
  sightAA?: number; sightAU?: number; sightUU?: number;
  contactAA?: number; contactUU?: number;
};

function spawnSensor(
  world: WorldState,
  x: number,
  y: number,
  playerId: PlayerId,
  sensors: Sensors,
): Entity {
  const entity = world.createUnitFromBlueprint(x, y, playerId, 'unitJackal');
  entity.transform.z = WATER_LEVEL + 100;
  const config = entity.combat!.turrets[0].config.targeting.observation.sensors;
  config.fullSight.aboveWater.aboveWater = sensors.sightAA ?? 0;
  config.fullSight.aboveWater.underwater = sensors.sightAU ?? 0;
  config.fullSight.underwater.aboveWater = 0;
  config.fullSight.underwater.underwater = sensors.sightUU ?? 0;
  config.contactSight.aboveWater.aboveWater = sensors.contactAA ?? 0;
  config.contactSight.aboveWater.underwater = sensors.contactUU ?? 0;
  config.contactSight.underwater.aboveWater = 0;
  config.contactSight.underwater.underwater = 0;
  config.detectorRadius = 0;
  config.radarJamRadius = 0;
  config.sonarJamRadius = 0;
  world.addEntity(entity);
  spatialGrid.updateUnit(entity);
  return entity;
}

/** The field only reads the vision roster, entity lists, pulses, tick and
 *  entity-set version from the client view; a duck-typed stand-in over a
 *  WorldState keeps the test independent of the network layer. */
function viewOver(world: WorldState, state: { tick: number; version: number }): ClientViewState {
  return {
    getTick: () => state.tick,
    getEntitySetVersion: () => state.version,
    getVisionPlayerIds: (localPlayerId: PlayerId) => localPlayerId === 1 ? [1, 2] : [localPlayerId],
    getUnitsByPlayer: (playerId: PlayerId) => world.getUnitsByPlayer(playerId),
    getBuildingsByPlayer: (playerId: PlayerId) => world.getBuildingsByPlayer(playerId),
    getScanPulses: () => [],
  } as unknown as ClientViewState;
}

export function runVisionDistanceField3DContractTest(): void {
  spatialGrid.clear();
  const world = new WorldState(6101, 4096, 4096);
  world.playerCount = 3;
  const state = { tick: 10, version: 1 };
  const view = viewOver(world, state);
  const field = new VisionDistanceField3D();

  assertNear(field.sightAlphaAt(100, 100, 0, 64), 1, 'an inactive field never fades anything');

  // Own sight disc r=400 at (1000,1000); an ALLY's radar r=1000 at (2500,1000).
  spawnSensor(world, 1000, 1000, 1 as PlayerId, { sightAA: 400 });
  spawnSensor(world, 2500, 1000, 2 as PlayerId, { contactAA: 1000 });
  // An ENEMY sight disc that must not count.
  spawnSensor(world, 3500, 3500, 3 as PlayerId, { sightAA: 1000 });
  field.sync(view, 1 as PlayerId, world.mapWidth);
  assertContract(field.isActive, 'sync activates the field');

  assertContract(field.isVisionOwner(1 as PlayerId) && field.isVisionOwner(2 as PlayerId), 'own and allied owners are vision owners');
  assertContract(!field.isVisionOwner(3 as PlayerId), 'an enemy owner is not a vision owner');
  assertContract(field.isVisionOwner(undefined), 'an ownerless entity is never faded');

  const z = WATER_LEVEL + 100;
  assertNear(field.sightAlphaAt(1000, 1000, z, 64), 1, 'the disc centre is fully opaque');
  assertNear(field.sightAlphaAt(1300, 1000, z, 64), 1, 'well inside the band the alpha is 1 (100 wu inside, band 64)');
  assertNear(field.sightAlphaAt(1368, 1000, z, 64), 0.5, 'halfway through the band the alpha is 0.5');
  assertNear(field.sightAlphaAt(1400, 1000, z, 64), 0, 'the authoritative edge is fully transparent');
  assertNear(field.sightAlphaAt(1401, 1000, z, 64), 0, 'outside every disc the alpha is 0');
  assertNear(field.sightAlphaAt(1300, 1000, z, 200), 0.5, 'a wider band ramps earlier (100 wu inside, band 200)');
  assertNear(field.sightAlphaAt(1000, 1000, WATER_LEVEL - 50, 64), 0, 'an above-water-only disc does not light the underwater lane');
  assertNear(field.sightAlphaAt(3500, 3500, z, 64), 0, 'an enemy sensor never contributes to the local team field');

  assertNear(field.contactAlphaAt(2500, 1000, CONTACT_MEDIUM_AIR, 192), 1, 'the allied radar disc centre is fully opaque for a radar contact');
  assertNear(field.contactAlphaAt(3404, 1000, CONTACT_MEDIUM_AIR, 192), 0.5, 'halfway through the contact band the blip alpha is 0.5');
  assertNear(field.contactAlphaAt(2500, 1000, CONTACT_MEDIUM_WATER, 192), 0, 'a radar disc does not light a sonar contact');
  assertNear(field.contactAlphaAt(2500, 1000, CONTACT_MEDIUM_AIR | CONTACT_MEDIUM_WATER, 192), 1, 'a straddling contact takes the better lane');
  assertNear(field.sightAlphaAt(2500, 1000, z, 64), 0, 'a radar disc grants no full-sight alpha');

  // Overlap: a second own disc r=400 at (1500,1000) makes (1380,1000) deep inside it.
  spawnSensor(world, 1500, 1000, 1 as PlayerId, { sightAA: 400 });
  state.version += 1;
  field.sync(view, 1 as PlayerId, world.mapWidth);
  assertNear(field.sightAlphaAt(1380, 1000, z, 64), 1, 'overlapping discs take the deepest (union, not average)');

  // Same tick + version: sync is a no-op; the field stays active.
  field.sync(view, 1 as PlayerId, world.mapWidth);
  assertContract(field.isActive, 'a redundant sync keeps the field active');

  field.clear();
  assertContract(!field.isActive, 'clear() deactivates the field');
  assertNear(field.sightAlphaAt(1400, 1000, z, 64), 1, 'a cleared field answers fully visible');
  assertNear(field.contactAlphaAt(9999, 9999, CONTACT_MEDIUM_AIR, 192), 1, 'a cleared field answers fully visible for contacts');
  spatialGrid.clear();
}
