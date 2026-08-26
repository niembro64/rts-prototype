// Full sight crosses the waterline.
//
// Water is a medium, not an occluder: an enemy inside a sensor's full-sight
// radius is seen whichever side of the surface it is on. Every fullSight
// source row therefore authors the same radius for both target columns.
// Before this rule every sensor authored only its same-medium entries, so a
// surface hull touching a submerged enemy (or a wading amphibian touching
// the beach) got a contact dot and never the model — contradicting the
// promise that anything inside team sight is fully visible. Contact sight
// stays per medium (radar above->above, sonar under->under) on purpose.
import rawTurrets from '../sim/blueprints/turrets.json';
import { SnapshotVisibility } from './stateSerializerVisibility';
import { WorldState } from '../sim/WorldState';
import { spatialGrid } from '../sim/SpatialGrid';
import { buildTeamRosterFromSeatCounts } from '../sim/teamRoster';
import { WATER_LEVEL } from '../sim/terrain/terrainConfig';
import { buildTerrainTileMap, setAuthoritativeTerrainTileMap } from '../sim/Terrain';
import { getAuthoritativeTerrainTileMap } from '../sim/terrain/terrainState';
import { stampCombatTargetingPool } from '../sim/combat/targetingInputStamping';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, PlayerId } from '../sim/types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[sensor waterline sight contract] ${message}`);
}

type SensorMatrix = { aboveWater: { aboveWater: number; underwater: number }; underwater: { aboveWater: number; underwater: number } };
type SensorSuite = { fullSight: SensorMatrix; contactSight: SensorMatrix };
type TurretLike = { targeting?: { observation?: { sensors?: SensorSuite } } };

/** Every authored sensor suite: each fullSight row reaches both media alike. */
function assertAuthoredMatrices(): void {
  const turrets = rawTurrets as unknown as Record<string, TurretLike>;
  let suites = 0;
  for (const [id, turret] of Object.entries(turrets)) {
    const sensors = turret.targeting?.observation?.sensors;
    if (sensors === undefined) continue;
    // A suite that only overrides contactSight inherits its fullSight through
    // `$extends`; the parent's own entry carries the check.
    const { fullSight } = sensors;
    if (fullSight === undefined) continue;
    suites++;
    assertContract(
      fullSight.aboveWater.underwater === fullSight.aboveWater.aboveWater,
      `${id}: an above-water source must see underwater targets to its full sight radius (${fullSight.aboveWater.aboveWater}), got ${fullSight.aboveWater.underwater}`,
    );
    assertContract(
      fullSight.underwater.aboveWater === fullSight.underwater.underwater,
      `${id}: an underwater source must see above-water targets to its full sight radius (${fullSight.underwater.underwater}), got ${fullSight.underwater.aboveWater}`,
    );
  }
  assertContract(suites > 40, `expected the full sensor roster, found ${suites} suites`);
}

function createWorld(): WorldState {
  spatialGrid.clear();
  getSimWasm()?.combatTargeting.clear();
  const world = new WorldState(6101, 4096, 4096);
  world.playerCount = 3;
  world.fogOfWarEnabled = true;
  world.setTeamRoster(buildTeamRosterFromSeatCounts(
    [1 as PlayerId, 2 as PlayerId, 3 as PlayerId],
    [2, 1],
  ));
  return world;
}

function spawn(
  world: WorldState,
  x: number,
  y: number,
  z: number,
  playerId: number,
  sensors?: { aa: number; au: number; ua: number; uu: number },
): Entity {
  const entity = world.createUnitFromBlueprint(x, y, playerId as PlayerId, 'unitJackal');
  entity.transform.z = z;
  if (sensors !== undefined) {
    const config = entity.combat!.turrets[0].config.targeting.observation.sensors;
    config.fullSight.aboveWater.aboveWater = sensors.aa;
    config.fullSight.aboveWater.underwater = sensors.au;
    config.fullSight.underwater.aboveWater = sensors.ua;
    config.fullSight.underwater.underwater = sensors.uu;
    config.contactSight.aboveWater.aboveWater = 0;
    config.contactSight.aboveWater.underwater = 0;
    config.contactSight.underwater.aboveWater = 0;
    config.contactSight.underwater.underwater = 0;
    config.detectorRadius = 0;
    config.radarJamRadius = 0;
    config.sonarJamRadius = 0;
  }
  world.addEntity(entity);
  spatialGrid.updateUnit(entity);
  return entity;
}

/** A short corridor whose seabed sits well below the surface on the current
 *  terrain, so a submerged fixture is under water rather than inside rock. */
function findSubmergedCorridor(world: WorldState, separation: number): { x: number; y: number; depth: number } {
  const step = 128;
  for (let y = step; y < world.mapHeight - step; y += step) {
    for (let x = step; x < world.mapWidth - step - separation; x += step) {
      let deepest = WATER_LEVEL;
      let submerged = true;
      for (let t = 0; t <= 8; t++) {
        const bed = world.getTerrainBedZ(x + (separation * t) / 8, y);
        if (bed > WATER_LEVEL - 60) { submerged = false; break; }
        deepest = Math.min(deepest, bed);
      }
      if (submerged) return { x, y, depth: Math.max(deepest + 30, WATER_LEVEL - 20) };
    }
  }
  throw new Error('[sensor waterline sight contract] no submerged corridor on the current terrain');
}

function seenBy(world: WorldState, playerId: number, entity: Entity): boolean {
  stampCombatTargetingPool(world);
  return SnapshotVisibility.forRecipient(world, playerId as PlayerId).isEntityVisible(entity);
}

/** The behaviour the rule exists for: a surface observer sees the submerged
 *  enemy alongside it, and a submerged observer sees the surface enemy
 *  alongside it — through the real Jackal sensor suite, with the exact
 *  same-medium-only matrix as the control that used to lose the model. */
function assertWaterlineSight(): void {
  const previousMap = getAuthoritativeTerrainTileMap();
  setAuthoritativeTerrainTileMap(buildTerrainTileMap(4096, 4096));
  try {
    const world = createWorld();
    const corridor = findSubmergedCorridor(world, 200);
    const surfaceZ = WATER_LEVEL + 100;

    // Real blueprint suite: above-water observer, submerged enemy 40 wu away.
    const observer = spawn(world, corridor.x, corridor.y, surfaceZ, 1);
    const submerged = spawn(world, corridor.x + 40, corridor.y, corridor.depth, 3);
    assertContract(
      seenBy(world, 1, submerged),
      'a surface observer must fully see a submerged enemy alongside it',
    );

    // Control: the same observer with the same-medium-only matrix loses it.
    const suite = observer.combat!.turrets[0].config.targeting.observation.sensors;
    const authoredAU = suite.fullSight.aboveWater.underwater;
    suite.fullSight.aboveWater.underwater = 0;
    assertContract(
      !seenBy(world, 1, submerged),
      'with the above->underwater column zeroed the submerged neighbour drops out of sight (the pre-rule symptom)',
    );
    suite.fullSight.aboveWater.underwater = authoredAU;

    // Reverse: submerged observer (periscope row), surface enemy alongside.
    const world2 = createWorld();
    spawn(world2, corridor.x + 120, corridor.y, corridor.depth, 1, { aa: 0, au: 0, ua: 300, uu: 300 });
    const surfaceEnemy = spawn(world2, corridor.x + 160, corridor.y, surfaceZ, 3);
    assertContract(
      seenBy(world2, 1, surfaceEnemy),
      'a submerged observer must fully see a surface enemy alongside it',
    );
  } finally {
    setAuthoritativeTerrainTileMap(previousMap);
    spatialGrid.clear();
  }
}

export function runSensorWaterlineSightContractTest(): void {
  assertAuthoredMatrices();
  assertWaterlineSight();
}
