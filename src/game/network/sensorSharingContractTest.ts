// Shared sight / radar / sonar, and the information tier each one earns.
//
// Beyond All Reason keeps line of sight per ALLY TEAM, so sight, radar and
// sonar are shared across an ally team by construction rather than by an
// explicit sharing feature, and an allied unit is never fogged from you. Its
// modrules then add the rules this file pins down: `separateJammers = true`
// (a jammer covers its own side rather than blanketing the map) and
// `requireSonarUnderWater = true` (a submerged target is found by sonar, sight
// alone will not reach it).
//
// Our extension is the source-medium x target-medium matrix: BAR has one LOS
// lane plus radar (air) and sonar (water), while every suite here authors
// above->above, above->under, under->above and under->under separately for
// both the full-sight and the contact tier. The lane separation is the part
// worth protecting, so it gets its own cases below.
//
// The tiers, from budget_design_philosophy.html "Sight, radar, sonar, and
// contacts are separate information tiers":
//
//   full sight   -> identity, private detail, the main snapshot row, and
//                   contact-level location for free
//   contact only -> position only. No blueprint, no health, no orders, and no
//                   owner: it reaches the client as a generic blip
//   neither      -> the entity is absent from the recipient's snapshot
//
// Everything here drives the real SnapshotVisibility used by the publisher.

import { SnapshotVisibility } from './stateSerializerVisibility';
import { serializeMinimapSnapshotEntities } from './stateSerializerMinimap';
import { WorldState } from '../sim/WorldState';
import { spatialGrid } from '../sim/SpatialGrid';
import { buildTeamRosterFromSeatCounts } from '../sim/teamRoster';
import { WATER_LEVEL } from '../sim/terrain/terrainConfig';
import { stampCombatTargetingPool } from '../sim/combat/targetingInputStamping';
import type { Entity, PlayerId } from '../sim/types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[sensor sharing contract] ${message}`);
  }
}

type SensorSpec = {
  sightAA?: number; sightAU?: number; sightUA?: number; sightUU?: number;
  contactAA?: number; contactAU?: number; contactUA?: number; contactUU?: number;
  detector?: number; radarJam?: number; sonarJam?: number;
};

/** Players 1 and 2 share an ally team; player 3 is the enemy ally team. */
function createSensorWorld(): WorldState {
  spatialGrid.clear();
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
  playerId: number,
  options: { underwater?: boolean; depth?: number; sensors?: SensorSpec; cloaked?: boolean } = {},
): Entity {
  const entity = world.createUnitFromBlueprint(x, y, playerId as PlayerId, 'unitJackal');
  entity.transform.z = options.depth !== undefined
    ? options.depth
    : (options.underwater === true ? WATER_LEVEL - 100 : WATER_LEVEL + 100);
  const spec = options.sensors ?? {};
  const sensors = entity.combat!.turrets[0].config.targeting.observation.sensors;
  sensors.fullSight.aboveWater.aboveWater = spec.sightAA ?? 0;
  sensors.fullSight.aboveWater.underwater = spec.sightAU ?? 0;
  sensors.fullSight.underwater.aboveWater = spec.sightUA ?? 0;
  sensors.fullSight.underwater.underwater = spec.sightUU ?? 0;
  sensors.contactSight.aboveWater.aboveWater = spec.contactAA ?? 0;
  sensors.contactSight.aboveWater.underwater = spec.contactAU ?? 0;
  sensors.contactSight.underwater.aboveWater = spec.contactUA ?? 0;
  sensors.contactSight.underwater.underwater = spec.contactUU ?? 0;
  sensors.detectorRadius = spec.detector ?? 0;
  sensors.radarJamRadius = spec.radarJam ?? 0;
  sensors.sonarJamRadius = spec.sonarJam ?? 0;
  if (options.cloaked === true && entity.unit !== null) entity.unit.cloaked = true;
  world.addEntity(entity);
  spatialGrid.updateUnit(entity);
  return entity;
}

/** Ask the per-entity predicates rather than the id buffers. The buffers are
 *  filled by a serialization walk and live in reused module-level storage, so
 *  reading them straight off a fresh instance can answer with whatever the
 *  running battle left behind. isEntityVisible/isEntityOnRadar are the same
 *  answers the publisher acts on, computed for the world in hand. */
type Intel = { visible: (entity: Entity) => boolean; contact: (entity: Entity) => boolean };

function intelFor(world: WorldState, playerId: number): Intel {
  const visibility = SnapshotVisibility.forRecipient(world, playerId as PlayerId);
  return {
    visible: (entity) => visibility.isEntityVisible(entity),
    contact: (entity) => visibility.isEntityOnRadar(entity),
  };
}

function assertTier(
  intel: Intel,
  entity: Entity,
  tier: 'full' | 'contact' | 'hidden',
  message: string,
): void {
  const visible = intel.visible(entity);
  const contact = intel.contact(entity);
  if (tier === 'full') {
    assertContract(visible && contact, `${message}: expected full sight, got visible=${visible} contact=${contact}`);
    return;
  }
  if (tier === 'contact') {
    assertContract(!visible && contact, `${message}: expected contact only, got visible=${visible} contact=${contact}`);
    return;
  }
  assertContract(!visible && !contact, `${message}: expected hidden, got visible=${visible} contact=${contact}`);
}

/** BAR keeps LOS per ally team, so an ally's sensors are yours and an ally's
 *  units are never fogged from you. */
function assertAllyTeamSharing(): void {
  const world = createSensorWorld();
  spawn(world, 200, 200, 1, { sensors: { sightAA: 10, contactAA: 10 } });
  const allyScout = spawn(world, 3000, 200, 2, { sensors: { sightAA: 400, contactAA: 400 } });
  const allyRadar = spawn(world, 3000, 1000, 2, { sensors: { contactAA: 900 } });
  const seenByAlly = spawn(world, 3200, 200, 3);
  const contactedByAlly = spawn(world, 3300, 1000, 3);
  const unobserved = spawn(world, 100, 3800, 3);

  const intel = intelFor(world, 1);
  assertTier(intel, seenByAlly, 'full', "an ally's full sight is shared");
  assertTier(intel, contactedByAlly, 'contact', "an ally's radar shares position without identity");
  assertTier(intel, unobserved, 'hidden', 'an enemy nobody observes stays out of the snapshot');
  assertContract(
    intel.visible(allyScout) && intel.visible(allyRadar),
    'allied units are always fully visible regardless of who can see them',
  );
  // Full sight is the stronger tier and must imply contact-level location.
  assertContract(
    intel.contact(seenByAlly),
    'full sight must also register as contact-level location',
  );
}

/** A pair of points that are genuinely under water on the CURRENT terrain, far
 *  enough apart to exercise a real sensor radius and with the seabed below the
 *  whole corridor between them. Placing a "submerged" fixture at a fixed depth
 *  without checking the bed buries it inside the terrain, and then the sight
 *  lane fails on line of sight rather than on the medium rule under test. */
function findSubmergedPair(
  world: WorldState,
  separation: number,
): { x: number; y: number; depth: number } {
  const step = 128;
  for (let y = step; y < world.mapHeight - step; y += step) {
    for (let x = step; x < world.mapWidth - step - separation; x += step) {
      let deepest = WATER_LEVEL;
      let submerged = true;
      for (let t = 0; t <= 8; t++) {
        const sampleX = x + (separation * t) / 8;
        const bed = world.getTerrainBedZ(sampleX, y);
        if (bed > WATER_LEVEL - 60) { submerged = false; break; }
        deepest = Math.min(deepest, bed);
      }
      // Sit just under the surface, clear of the deepest bed in the corridor.
      if (submerged) return { x, y, depth: Math.max(deepest + 30, WATER_LEVEL - 20) };
    }
  }
  throw new Error('[sensor sharing contract] no submerged corridor on the current terrain');
}

/** The medium extension: radar is the above->above contact lane, sonar the
 *  under->under one, and neither reaches across. */
function assertSensorMediumLanes(): void {
  const surfaceWorld = createSensorWorld();
  spawn(surfaceWorld, 200, 200, 1, { sensors: { sightAA: 900, contactAA: 900 } });
  const submerged = spawn(surfaceWorld, 600, 200, 3, { underwater: true });
  const airborne = spawn(surfaceWorld, 700, 200, 3);
  const surfaceIntel = intelFor(surfaceWorld, 1);
  assertTier(surfaceIntel, airborne, 'full', 'above-water sight reveals an above-water target');
  assertTier(
    surfaceIntel,
    submerged,
    'hidden',
    'radar and above-water sight must not reach a submerged target (BAR requireSonarUnderWater)',
  );

  const sonarWorld = createSensorWorld();
  const deep = findSubmergedPair(sonarWorld, 400);
  spawn(sonarWorld, deep.x, deep.y, 1, {
    depth: deep.depth,
    sensors: { sightUU: 900, contactUU: 900 },
  });
  const submergedTarget = spawn(sonarWorld, deep.x + 400, deep.y, 3, { depth: deep.depth });
  const airborneTarget = spawn(sonarWorld, deep.x + 500, deep.y, 3);
  const sonarIntel = intelFor(sonarWorld, 1);
  assertTier(sonarIntel, submergedTarget, 'full', 'underwater sight reveals a submerged target');
  assertTier(sonarIntel, airborneTarget, 'hidden', 'sonar must not reach an above-water target');
}

/** BAR's separateJammers: a jammer denies the ENEMY's contact sensors over its
 *  own side, and never touches real sight. */
function assertJamming(): void {
  const world = createSensorWorld();
  spawn(world, 200, 200, 1, { sensors: { sightAA: 300, contactAA: 3000 } });
  const jammed = spawn(world, 2000, 200, 3);
  spawn(world, 2000, 260, 3, { sensors: { radarJam: 500, sightAA: 100 } });
  assertTier(intelFor(world, 1), jammed, 'hidden', 'an enemy jammer denies radar contact over its own side');

  // A mount whose ONLY sensor channel is jamming still jams. It used to be
  // dropped by the source walk and silently did nothing; both jammers in the
  // current roster carry sight too, which is why the hole stayed invisible.
  const pureWorld = createSensorWorld();
  spawn(pureWorld, 200, 200, 1, { sensors: { sightAA: 300, contactAA: 3000 } });
  const jammedByPure = spawn(pureWorld, 2000, 200, 3);
  spawn(pureWorld, 2000, 260, 3, { sensors: { radarJam: 500 } });
  assertTier(
    intelFor(pureWorld, 1),
    jammedByPure,
    'hidden',
    'a mount whose only sensor channel is jamming must still jam',
  );

  const sightWorld = createSensorWorld();
  spawn(sightWorld, 200, 200, 1, { sensors: { sightAA: 3000, contactAA: 3000 } });
  const jammedInSight = spawn(sightWorld, 2000, 200, 3);
  spawn(sightWorld, 2000, 260, 3, { sensors: { radarJam: 500, sightAA: 100 } });
  assertTier(
    intelFor(sightWorld, 1),
    jammedInSight,
    'full',
    'jamming denies contact sensors only; real sight still sees plainly',
  );
}

/** Cloak is defeated by a detector, and a detector locates nothing on its own:
 *  its reach is clamped to the same mount's full-sight radius. */
function assertCloakAndDetection(): void {
  const bareWorld = createSensorWorld();
  spawn(bareWorld, 200, 200, 1, { sensors: { sightAA: 3000, contactAA: 3000 } });
  const cloaked = spawn(bareWorld, 1000, 200, 3, { cloaked: true });
  assertTier(intelFor(bareWorld, 1), cloaked, 'hidden', 'a cloaked enemy is hidden without a detector');

  const detectorWorld = createSensorWorld();
  spawn(detectorWorld, 200, 200, 1, { sensors: { sightAA: 3000, contactAA: 3000, detector: 3000 } });
  const detected = spawn(detectorWorld, 1000, 200, 3, { cloaked: true });
  assertTier(
    intelFor(detectorWorld, 1),
    detected,
    'full',
    'a detector covering a cloaked enemy inside its own sight reveals it',
  );

  const reachWorld = createSensorWorld();
  spawn(reachWorld, 200, 200, 1, { sensors: { sightAA: 300, contactAA: 3000, detector: 3000 } });
  const beyondSight = spawn(reachWorld, 1000, 200, 3, { cloaked: true });
  assertTier(
    intelFor(reachWorld, 1),
    beyondSight,
    'hidden',
    'a detector reaching past its own sight must not locate a cloaked enemy by itself',
  );
}

/** A contact reaches the client as a blip: position and coarse kind, with no
 *  owner. Anything more is identity the recipient did not earn. */
function assertContactTierCarriesNoIdentity(): void {
  const world = createSensorWorld();
  spawn(world, 200, 200, 1, { sensors: { sightAA: 300, contactAA: 3000 } });
  const contactOnly = spawn(world, 2000, 200, 3);
  const ally = spawn(world, 240, 200, 2);

  assertTier(intelFor(world, 1), contactOnly, 'contact', 'a distant enemy under radar is contact-only');

  // The id buffers behind minimap serialization come from the NATIVE
  // observation mask when WASM is up, which reads the combat-targeting pool
  // rather than walking the world. Stamp it, or the serializer answers for
  // whatever world was stamped last.
  stampCombatTargetingPool(world);
  const visibility = SnapshotVisibility.forRecipient(world, 1 as PlayerId);

  const entries = serializeMinimapSnapshotEntities(world, visibility, 'sensor-sharing-contract');
  assertContract(entries !== undefined, 'minimap serialization must produce entries');
  const contactEntry = entries.find((entry) => entry.id === contactOnly.id);
  const allyEntry = entries.find((entry) => entry.id === ally.id);
  assertContract(
    contactEntry !== undefined && contactEntry.radarOnly === true,
    'a contact-only enemy must reach the minimap flagged radarOnly',
  );
  assertContract(
    contactEntry.playerId === 0,
    `a contact-only entry must not carry its owner; got playerId=${contactEntry.playerId}`,
  );
  assertContract(
    contactEntry.type === 'unit',
    'a contact keeps the coarse unit/building kind BAR also distinguishes',
  );
  assertContract(
    allyEntry !== undefined && allyEntry.radarOnly !== true && allyEntry.playerId === 2,
    'a fully visible allied entry keeps its owner for team colouring',
  );
}

export function runSensorSharingContractTest(): void {
  assertAllyTeamSharing();
  assertSensorMediumLanes();
  assertJamming();
  assertCloakAndDetection();
  assertContactTierCarriesNoIdentity();
}
