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
import {
  isPackedMinimapEntitiesWire,
  packMinimapEntitiesForWire,
  unpackMinimapEntitiesFromWire,
} from './snapshotMinimapWirePack';
import {
  CONTACT_MEDIUM_NONE,
  CONTACT_MEDIUM_AIR,
  CONTACT_MEDIUM_BOTH,
  CONTACT_MEDIUM_WATER,
} from './contactMedium';
import {
  serializeProjectileSnapshot,
  shouldSendBeamPath,
} from './stateSerializerProjectiles';
import { WorldState } from '../sim/WorldState';
import { spatialGrid } from '../sim/SpatialGrid';
import { buildTeamRosterFromSeatCounts } from '../sim/teamRoster';
import { WATER_LEVEL } from '../sim/terrain/terrainConfig';
import {
  buildTerrainTileMap,
  getTerrainRuntimeConfig,
  getTerrainTeamCount,
  setAuthoritativeTerrainTileMap,
  setTerrainRuntimeConfig,
  setTerrainTeamCount,
} from '../sim/Terrain';
import { getAuthoritativeTerrainTileMap } from '../sim/terrain/terrainState';
import {
  getCombatTargetingStateViews,
  stampCombatTargetingPool,
} from '../sim/combat/targetingInputStamping';
import { hasFogOfWarLineOfSight } from '../sim/combat/lineOfSight';
import { forEachEntityTurretSensorSource } from '../sim/sensorCoverage';
import { getSimWasm } from '../sim-wasm/init';
import { createProjectileConfigFromShot } from '../sim/projectileConfigs';
import {
  CONTACT_BLIP_GLYPH,
  CONTACT_BLIP_RADIUS,
  getContactBlipPresentation,
  requireContactBlipId,
  requireContactBlipZ,
} from '../render3d/ContactBlipRenderer3D';
import { ClientMinimapOverrideStore } from './ClientMinimapOverrideStore';
import { ENTITY_LOD_PROXY_GLYPH_CIRCLE } from '../render3d/EntityLod3D';
import { getSensorBoundarySourceRadius } from '../render3d/SightBoundaryRenderer3D';
import type { ProjectileSpawnEvent } from '../sim/combat';
import type { Entity, EntityId, PlayerId } from '../sim/types';

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
    contactEntry.contactMediumMask === CONTACT_MEDIUM_AIR,
    `an above-water radar return must carry only the earned air bit; got ${contactEntry.contactMediumMask}`,
  );
  assertContract(
    contactEntry.contactZ === Math.round(contactOnly.transform.z),
    `a radar contact must carry its observed world z; got ${contactEntry.contactZ}`,
  );
  assertContract(
    allyEntry !== undefined && allyEntry.radarOnly !== true && allyEntry.playerId === 2,
    'a fully visible allied entry keeps its owner for team colouring',
  );
}

function assertContactMediumProvenanceAndWirePaths(): void {
  const world = createSensorWorld();
  const wet = findSubmergedPair(world, 400);
  spawn(world, wet.x, wet.y, 1, {
    depth: WATER_LEVEL + 100,
    sensors: { contactAA: 1000 },
  });
  spawn(world, wet.x, wet.y + 100, 2, {
    depth: wet.depth,
    sensors: { contactUU: 1000 },
  });
  const straddler = spawn(world, wet.x + 400, wet.y, 3, { depth: WATER_LEVEL });

  stampCombatTargetingPool(world);
  const visibility = SnapshotVisibility.forRecipient(world, 1 as PlayerId);
  assertContract(
    visibility.getEntityContactMediumMask(straddler) === CONTACT_MEDIUM_BOTH,
    'a straddling target covered by allied radar and sonar must retain both earned medium facts',
  );

  const entries = serializeMinimapSnapshotEntities(world, visibility, 'contact-medium-wire');
  assertContract(entries !== undefined, 'dual-medium contact must serialize');
  const entry = entries.find((candidate) => candidate.id === straddler.id);
  assertContract(
    entry?.radarOnly === true &&
      entry.contactMediumMask === CONTACT_MEDIUM_BOTH &&
      entry.contactZ === Math.round(straddler.transform.z),
    `DTO and direct-row generation must retain contact medium and z; got mask=${entry?.contactMediumMask}, z=${entry?.contactZ}`,
  );

  const packed = packMinimapEntitiesForWire(entries);
  assertContract(packed !== undefined, 'dual-medium minimap rows must pack');
  assertContract(
    !isPackedMinimapEntitiesWire({ v: 3, b: packed.b }),
    'obsolete minimap packet versions must be rejected rather than decoded',
  );
  const decoded = unpackMinimapEntitiesFromWire(packed);
  const decodedEntry = decoded?.find((candidate) => candidate.id === straddler.id);
  assertContract(
    decodedEntry?.contactMediumMask === CONTACT_MEDIUM_BOTH &&
      decodedEntry.contactZ === Math.round(straddler.transform.z),
    `packed V4 minimap wire must round-trip contact medium and z; got mask=${decodedEntry?.contactMediumMask}, z=${decodedEntry?.contactZ}`,
  );

  const airOnlyWorld = createSensorWorld();
  spawn(airOnlyWorld, 200, 200, 2, { sensors: { contactAA: 1000 } });
  const airStraddler = spawn(airOnlyWorld, 500, 200, 3, { depth: WATER_LEVEL });
  const airVisibility = SnapshotVisibility.forRecipient(airOnlyWorld, 1 as PlayerId);
  assertContract(
    airVisibility.getEntityContactMediumMask(airStraddler) === CONTACT_MEDIUM_AIR,
    'a straddler found only by allied radar must be an air contact regardless of volume majority',
  );

  const waterOnlyWorld = createSensorWorld();
  const waterPair = findSubmergedPair(waterOnlyWorld, 300);
  spawn(waterOnlyWorld, waterPair.x, waterPair.y, 2, {
    depth: waterPair.depth,
    sensors: { contactUU: 1000 },
  });
  const waterStraddler = spawn(
    waterOnlyWorld,
    waterPair.x + 300,
    waterPair.y,
    3,
    { depth: WATER_LEVEL },
  );
  const waterVisibility = SnapshotVisibility.forRecipient(waterOnlyWorld, 1 as PlayerId);
  assertContract(
    waterVisibility.getEntityContactMediumMask(waterStraddler) === CONTACT_MEDIUM_WATER,
    'a straddler found only by allied sonar must be a water contact regardless of volume majority',
  );
}

function projectileSpawn(
  id: number,
  x: number,
  y: number,
  z: number,
  targetEntityId?: EntityId,
  beam?: ProjectileSpawnEvent['beam'],
): ProjectileSpawnEvent {
  return {
    id: id as EntityId,
    pos: { x, y, z },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: 'plasma',
    turretBlueprintId: 'turretGunLight',
    shotBlueprintId: 'shotPlasmaLight',
    sourceTurretBlueprintId: 'turretGunLight',
    playerId: 3 as PlayerId,
    sourceEntityId: 49999 as EntityId,
    turretIndex: 0,
    barrelIndex: 0,
    targetEntityId,
    beam,
  };
}

/** Projectiles are presentation, not contacts: only exact-medium team sight
 * reveals an ordinary enemy shot. A homing threat aimed at the ally team keeps
 * the existing explicit safety exception. Beam endpoints follow the same
 * policy for spawn, resync, and update rows. */
function assertProjectileMediumVisibility(): void {
  const world = createSensorWorld();
  spawn(world, 200, 200, 1, {
    depth: WATER_LEVEL + 500,
    sensors: { sightAA: 300, contactAA: 3000 },
  });
  const radarContact = spawn(world, 800, 200, 3, { depth: WATER_LEVEL + 500 });
  const alliedTarget = spawn(world, 3000, 200, 2, { depth: WATER_LEVEL + 500 });
  const visibility = SnapshotVisibility.forRecipient(world, 1 as PlayerId);
  assertContract(
    visibility.getEntityContactMediumMask(radarContact) === CONTACT_MEDIUM_AIR &&
      !visibility.isEntityVisible(radarContact),
    'projectile fixture must put the distant lane under radar contact but outside full sight',
  );

  const visibleAirId = 50001;
  const hiddenWaterId = 50002;
  const radarOnlyId = 50003;
  const incomingThreatId = 50004;
  const visibleEndpointBeamId = 50005;
  const hiddenWaterBeamId = 50006;
  const radarOnlyBeamId = 50007;
  const airZ = WATER_LEVEL + 500;
  const waterZ = WATER_LEVEL - 100;
  const projectileConfig = createProjectileConfigFromShot('shotPlasmaLight');
  const incomingMotionProjectile = world.createProjectile(
    2800,
    200,
    0,
    0,
    3 as PlayerId,
    radarContact.id,
    projectileConfig,
  );
  incomingMotionProjectile.transform.z = waterZ;
  incomingMotionProjectile.projectile!.homingTargetId = alliedTarget.id;
  world.addEntity(incomingMotionProjectile);
  const ordinaryRadarMotionProjectile = world.createProjectile(
    800,
    200,
    0,
    0,
    3 as PlayerId,
    radarContact.id,
    projectileConfig,
  );
  ordinaryRadarMotionProjectile.transform.z = airZ;
  world.addEntity(ordinaryRadarMotionProjectile);
  const spawns: ProjectileSpawnEvent[] = [
    projectileSpawn(visibleAirId, 200, 200, airZ),
    projectileSpawn(hiddenWaterId, 200, 200, waterZ),
    projectileSpawn(radarOnlyId, 800, 200, airZ),
    projectileSpawn(incomingThreatId, 2800, 200, waterZ, alliedTarget.id),
    projectileSpawn(visibleEndpointBeamId, 800, 240, airZ, undefined, {
      start: { x: 800, y: 240, z: airZ },
      end: { x: 200, y: 200, z: airZ },
    }),
    projectileSpawn(hiddenWaterBeamId, 800, 280, waterZ, undefined, {
      start: { x: 800, y: 280, z: waterZ },
      end: { x: 200, y: 200, z: waterZ },
    }),
    projectileSpawn(radarOnlyBeamId, 800, 320, airZ, undefined, {
      start: { x: 800, y: 320, z: airZ },
      end: { x: 900, y: 320, z: airZ },
    }),
  ];
  const snapshot = serializeProjectileSnapshot({
    world,
    fullStateResync: false,
    visibility,
    emitBeamUpdates: false,
    projectileSpawns: spawns,
    projectileDespawns: undefined,
    projectileMotionUpdates: [
      {
        id: incomingMotionProjectile.id,
        pos: { x: 2800, y: 200, z: waterZ },
        velocity: { x: 0, y: 0, z: 0 },
        rotation: 0,
        angularVelocity: 0,
        ownerId: 3 as PlayerId,
      },
      {
        id: ordinaryRadarMotionProjectile.id,
        pos: { x: 800, y: 200, z: airZ },
        velocity: { x: 0, y: 0, z: 0 },
        rotation: 0,
        angularVelocity: 0,
        ownerId: 3 as PlayerId,
      },
    ],
  });
  const ids = new Set((snapshot?.spawns ?? []).map((entry) => entry.id));
  assertContract(ids.has(visibleAirId), 'an enemy projectile inside same-medium full sight is visible');
  assertContract(!ids.has(hiddenWaterId), 'air sight must not reveal an underwater projectile at the same xy');
  assertContract(!ids.has(radarOnlyId), 'radar contact must not reveal an ordinary projectile');
  assertContract(ids.has(incomingThreatId), 'an incoming threat aimed at an allied entity remains visible');
  assertContract(ids.has(visibleEndpointBeamId), 'a beam spawn is visible when either exact-medium endpoint is visible');
  assertContract(!ids.has(hiddenWaterBeamId), 'air sight must not reveal underwater beam endpoints');
  assertContract(!ids.has(radarOnlyBeamId), 'radar contact must not reveal an ordinary beam');
  const motionIds = new Set((snapshot?.motionUpdates ?? []).map((entry) => entry.id));
  assertContract(
    motionIds.has(incomingMotionProjectile.id),
    'incoming-threat visibility must continue across stamped in-flight motion rows',
  );
  assertContract(
    !motionIds.has(ordinaryRadarMotionProjectile.id),
    'radar contact must not reveal an ordinary in-flight motion row',
  );
  assertContract(
    !shouldSendBeamPath(3 as PlayerId, visibility, [
      { x: 800, y: 280, z: waterZ },
      { x: 200, y: 200, z: waterZ },
    ]),
    'beam-update filtering uses endpoint z rather than a 2D sight circle',
  );
}

type BlockedRadarFixture = {
  sourceX: number;
  sourceY: number;
  sourceZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
};

/** Finds an actual ridge on the seeded contract map using the mounted sensor
 * eye, so this protects terrain behavior without depending on hand-authored
 * terrain coordinates or an approximation of the turret mount height. */
function findBlockedRadarFixture(
  world: WorldState,
  source: Entity,
): BlockedRadarFixture {
  const fixture: BlockedRadarFixture = {
    sourceX: 0,
    sourceY: 0,
    sourceZ: 0,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
  };
  const mount = { x: 0, y: 0, z: 0 };
  for (let sy = 256; sy < world.mapHeight - 256; sy += 512) {
    for (let sx = 256; sx < world.mapWidth - 256; sx += 512) {
      source.transform.x = sx;
      source.transform.y = sy;
      source.transform.z = Math.max(WATER_LEVEL + 40, world.getTerrainBedZ(sx, sy) + 40);
      let foundMount = false;
      forEachEntityTurretSensorSource(source, ({ position }) => {
        if (foundMount) return;
        mount.x = position.x;
        mount.y = position.y;
        mount.z = position.z;
        foundMount = true;
      });
      if (!foundMount) continue;
      for (let ty = 256; ty < world.mapHeight - 256; ty += 384) {
        for (let tx = 256; tx < world.mapWidth - 256; tx += 384) {
          const dx = tx - mount.x;
          const dy = ty - mount.y;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq < 700 * 700 || distanceSq > 3200 * 3200) continue;
          const tz = Math.max(WATER_LEVEL + 40, world.getTerrainBedZ(tx, ty) + 40);
          if (hasFogOfWarLineOfSight(world, mount.x, mount.y, mount.z, tx, ty, tz)) continue;
          fixture.sourceX = sx;
          fixture.sourceY = sy;
          fixture.sourceZ = source.transform.z;
          fixture.targetX = tx;
          fixture.targetY = ty;
          fixture.targetZ = tz;
          return fixture;
        }
      }
    }
  }
  throw new Error('[sensor sharing contract] no terrain-blocked radar pair on the seeded map');
}

function assertTerrainBlockedRadarParity(): void {
  const previousConfig = getTerrainRuntimeConfig();
  const previousTeamCount = getTerrainTeamCount();
  const previousMap = getAuthoritativeTerrainTileMap();
  setTerrainRuntimeConfig({
    ...previousConfig,
    centerMagnitude: 1400,
    dividersMagnitude: 1200,
    perimeterMagnitude: 0,
    terrainDTerrain: 0,
    terrainDetail: 1,
  });
  setTerrainTeamCount(2);
  setAuthoritativeTerrainTileMap(buildTerrainTileMap(4096, 4096));
  try {
    const world = createSensorWorld();
    const radar = spawn(world, 200, 200, 1, {
      sensors: { contactAA: 3500 },
    });
    const target = spawn(world, 800, 200, 3);
    const blocked = findBlockedRadarFixture(world, radar);
    radar.transform.x = blocked.sourceX;
    radar.transform.y = blocked.sourceY;
    radar.transform.z = blocked.sourceZ;
    target.transform.x = blocked.targetX;
    target.transform.y = blocked.targetY;
    target.transform.z = blocked.targetZ;
    spatialGrid.updateUnit(radar);
    spatialGrid.updateUnit(target);

    stampCombatTargetingPool(world);
    const sim = getSimWasm();
    assertContract(sim !== undefined, 'sim-wasm must be initialized for native radar parity');
    const targetSlot = target.entitySlotId;
    assertContract(targetSlot >= 0, 'terrain-blocked radar target must own a native slot');
    const nativeAirRadarMask = getCombatTargetingStateViews(sim).teamAirRadarMask[targetSlot];
    assertContract(
      (nativeAirRadarMask & 1) === 0,
      'authoritative native air-radar mask must remove a radius hit blocked by terrain',
    );
    const visibility = SnapshotVisibility.forRecipient(world, 1 as PlayerId);
    assertContract(
      visibility.getEntityContactMediumMask(target) === CONTACT_MEDIUM_NONE,
      'snapshot visibility must agree that terrain blocks the above-water radar contact',
    );
  } finally {
    setTerrainRuntimeConfig(previousConfig);
    setTerrainTeamCount(previousTeamCount);
    setAuthoritativeTerrainTileMap(previousMap);
  }
}

function assertSensorPresentationSemantics(): void {
  const world = createSensorWorld();
  const sensor = spawn(world, 200, 200, 1);
  const sensors = sensor.combat!.turrets[0].config.targeting.observation.sensors;
  sensors.fullSight.aboveWater.aboveWater = 111;
  sensors.fullSight.aboveWater.underwater = 222;
  sensors.contactSight.underwater.aboveWater = 333;
  sensors.contactSight.underwater.underwater = 444;
  assertContract(
    getSensorBoundarySourceRadius(sensors, 'fullSight', 'aboveWater', 'aboveWater') === 111 &&
      getSensorBoundarySourceRadius(sensors, 'fullSight', 'aboveWater', 'underwater') === 222,
    'sight boundaries preserve independent target-medium cells rather than taking their maximum',
  );
  assertContract(
    getSensorBoundarySourceRadius(sensors, 'contactSight', 'underwater', 'aboveWater') === 333 &&
      getSensorBoundarySourceRadius(sensors, 'contactSight', 'underwater', 'underwater') === 444,
    'radar/sonar boundaries preserve independent target-medium cells rather than taking their maximum',
  );

  const radar = getContactBlipPresentation(CONTACT_MEDIUM_AIR);
  const sonar = getContactBlipPresentation(CONTACT_MEDIUM_WATER);
  const dual = getContactBlipPresentation(CONTACT_MEDIUM_BOTH);
  assertContract(radar.kind === 'radar' && radar.surface === 'terrain', 'air contacts use the radar treatment');
  assertContract(sonar.kind === 'sonar' && sonar.surface === 'water', 'water contacts use the sonar treatment');
  assertContract(dual.kind === 'dual' && dual.surface === 'water', 'dual-medium contacts have an explicit treatment');
  assertContract(
    requireContactBlipZ(WATER_LEVEL + 700) === WATER_LEVEL + 700,
    'an airborne radar return renders at its transmitted altitude rather than on terrain',
  );
  assertContract(
    requireContactBlipZ(WATER_LEVEL - 140) === WATER_LEVEL - 140,
    'a sonar return renders at its transmitted underwater altitude rather than on the water plane',
  );
  let missingAltitudeRejected = false;
  try {
    requireContactBlipZ(undefined);
  } catch {
    missingAltitudeRejected = true;
  }
  assertContract(missingAltitudeRejected, 'a contact without z must fail instead of using a surface fallback');
  let missingContactIdRejected = false;
  try {
    requireContactBlipId(undefined);
  } catch {
    missingContactIdRejected = true;
  }
  assertContract(
    missingContactIdRejected,
    'a contact without an id must fail instead of losing its shared entity-pose lookup',
  );
  assertContract(
    radar.colorHex !== sonar.colorHex && dual.colorHex !== radar.colorHex && dual.colorHex !== sonar.colorHex,
    'radar, sonar, and dual contacts are visually distinguishable without identity color',
  );
  assertContract(
    CONTACT_BLIP_GLYPH === ENTITY_LOD_PROXY_GLYPH_CIRCLE && CONTACT_BLIP_RADIUS > 0,
    'all contact kinds reuse one fixed neutral LOD-proxy glyph and radius',
  );
  // Snapshot cadence owns only contact membership. Position is resolved from
  // the entity presentation history every render frame.
  const contactSnapshots = new ClientMinimapOverrideStore({ isSelected: () => false });
  contactSnapshots.applySnapshot(undefined);
  const firstSequence = contactSnapshots.getSequence();
  contactSnapshots.applySnapshot(undefined);
  assertContract(
    contactSnapshots.getSequence() !== firstSequence,
    'a new contact snapshot advances membership without creating a second position clock',
  );
}

export function runSensorSharingContractTest(): void {
  assertAllyTeamSharing();
  assertSensorMediumLanes();
  assertJamming();
  assertCloakAndDetection();
  assertContactTierCarriesNoIdentity();
  assertContactMediumProvenanceAndWirePaths();
  assertProjectileMediumVisibility();
  assertTerrainBlockedRadarParity();
  assertSensorPresentationSemantics();
}
