// Pins the audio/visual event fog rule in getAudioVisibilityDecision:
// an emission's terminal event (hit / projectileExpire / waterSplash) is
// delivered IN FULL to the side that fired it wherever it lands, exactly
// like the projectile itself (stateSerializerProjectiles
// shouldSendProjectileAtPoint). Enemy terminals keep the earshot-audio
// demotion and the beyond-earshot drop, and shieldImpact — whose playerId
// is the shield owner, not the shooter — is not an emission terminal.

import type { SimEvent } from '../sim/combat';
import type { PlayerId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { spatialGrid } from '../sim/SpatialGrid';
import { buildTeamRosterFromSeatCounts } from '../sim/teamRoster';
import { WATER_LEVEL } from '../sim/Terrain';
import { SnapshotVisibility } from './stateSerializerVisibility';
import { serializeAudioEvents, writeAudioEventWireRowsDirect } from './stateSerializerAudio';
import type { NetworkServerSnapshotSimEvent } from './NetworkManager';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[audio event visibility] ${message}`);
  }
}

const OBSERVER_X = 512;
const OBSERVER_Y = 512;
const VISION_RADIUS = 1200;
/** Inside the FOW-09 earshot pad (vision + 600) but outside vision. */
const EARSHOT_X = OBSERVER_X + VISION_RADIUS + 300;
/** Beyond vision and earshot. */
const FOG_X = 3800;
const FOG_Y = 3800;

function terminalEvent(
  type: 'hit' | 'projectileExpire' | 'waterSplash',
  playerId: PlayerId,
  x: number,
  y: number,
): SimEvent {
  const event: SimEvent = {
    type,
    turretBlueprintId: 'shotPlasma',
    sourceType: 'turret',
    sourceKey: 'turretPlasma',
    pos: { x, y, z: WATER_LEVEL + 40 },
    playerId,
    entityId: 4242,
  };
  if (type === 'waterSplash') {
    event.waterSplash = { velocity: { x: 0, y: 0, z: -120 }, mass: 4 };
  } else {
    event.impactContext = {
      radiusCollision: 3,
      deathExplosionRadius: 24,
      projectile: { pos: { x, y }, vel: { x: 200, y: 0 } },
      entity: { vel: { x: 0, y: 0 }, radiusCollision: 0 },
      penetrationDir: { x: 1, y: 0 },
    };
  }
  return event;
}

function shieldImpactEvent(shieldOwner: PlayerId, x: number, y: number): SimEvent {
  return {
    type: 'shieldImpact',
    turretBlueprintId: 'shotPlasma',
    pos: { x, y, z: WATER_LEVEL + 40 },
    playerId: shieldOwner,
    shieldImpact: { normal: { x: 0, y: 0, z: 1 }, playerId: shieldOwner },
  };
}

type Delivered = ReadonlyMap<string, NetworkServerSnapshotSimEvent>;

function deliveredByLabel(
  labelled: readonly (readonly [string, SimEvent])[],
  visibility: SnapshotVisibility,
): Delivered {
  const events = labelled.map(([, event]) => event);
  const out = serializeAudioEvents(events, visibility, 'audio-event-visibility-contract');
  const delivered = new Map<string, NetworkServerSnapshotSimEvent>();
  if (out === undefined) return delivered;
  // The serializer preserves order and only drops, so walk both lists.
  let cursor = 0;
  for (const [label, source] of labelled) {
    const candidate = out[cursor];
    if (
      candidate !== undefined &&
      candidate.type === source.type &&
      candidate.pos.x === source.pos.x &&
      candidate.pos.y === source.pos.y
    ) {
      delivered.set(label, candidate);
      cursor++;
    }
  }
  assertContract(cursor === out.length, 'every delivered event maps back to exactly one source');
  return delivered;
}

export function runAudioEventVisibilityContractTest(): void {
  spatialGrid.clear();
  try {
    const world = new WorldState(6102, 4096, 4096);
    world.playerCount = 3;
    world.fogOfWarEnabled = true;
    // Players 1 and 2 share a side; player 3 is the enemy.
    world.setTeamRoster(
      buildTeamRosterFromSeatCounts([1 as PlayerId, 2 as PlayerId, 3 as PlayerId], [2, 1]),
    );
    assertContract(world.arePlayersAllied(1 as PlayerId, 2 as PlayerId), 'fixture: 1 and 2 are allies');
    assertContract(!world.arePlayersAllied(1 as PlayerId, 3 as PlayerId), 'fixture: 3 is the enemy');

    const observer = world.createUnitFromBlueprint(OBSERVER_X, OBSERVER_Y, 1 as PlayerId, 'unitJackal');
    observer.transform.z = WATER_LEVEL + 100;
    const sensors = observer.combat!.turrets[0].config.targeting.observation.sensors;
    sensors.visionRadius = VISION_RADIUS;
    sensors.radarRadius = 0;
    world.addEntity(observer);
    spatialGrid.updateUnit(observer);

    const visibility = SnapshotVisibility.forRecipient(world, 1 as PlayerId);
    assertContract(visibility.isFiltered, 'fixture: recipient is fog-filtered');

    const own = 1 as PlayerId;
    const ally = 2 as PlayerId;
    const enemy = 3 as PlayerId;
    const labelled: (readonly [string, SimEvent])[] = [
      ['ownHitFog', terminalEvent('hit', own, FOG_X, FOG_Y)],
      ['ownExpireFog', terminalEvent('projectileExpire', own, FOG_X, FOG_Y)],
      ['ownSplashFog', terminalEvent('waterSplash', own, FOG_X, FOG_Y)],
      ['allyHitFog', terminalEvent('hit', ally, FOG_X, FOG_Y)],
      ['enemyHitFog', terminalEvent('hit', enemy, FOG_X, FOG_Y)],
      ['enemySplashFog', terminalEvent('waterSplash', enemy, FOG_X, FOG_Y)],
      ['ownHitEarshot', terminalEvent('hit', own, EARSHOT_X, OBSERVER_Y)],
      ['enemyHitEarshot', terminalEvent('hit', enemy, EARSHOT_X, OBSERVER_Y)],
      ['enemyHitSeen', terminalEvent('hit', enemy, OBSERVER_X + 200, OBSERVER_Y)],
      ['ownShieldImpactFog', shieldImpactEvent(own, FOG_X, FOG_Y)],
    ];

    const delivered = deliveredByLabel(labelled, visibility);
    const fullVisual = (label: string): void => {
      const event = delivered.get(label);
      assertContract(event !== undefined, `${label} must be delivered`);
      assertContract(
        event.audioOnly !== true,
        `${label} must carry its visual (audioOnly must not be set)`,
      );
    };
    const dropped = (label: string): void => {
      assertContract(!delivered.has(label), `${label} must be dropped`);
    };

    // The side that fired always sees where its shot landed.
    fullVisual('ownHitFog');
    fullVisual('ownExpireFog');
    fullVisual('ownSplashFog');
    fullVisual('allyHitFog');
    fullVisual('ownHitEarshot');
    // Enemy terminals keep the fog rules: earshot demotes to audio,
    // beyond earshot drops, and in-vision delivers in full.
    dropped('enemyHitFog');
    dropped('enemySplashFog');
    const enemyEarshot = delivered.get('enemyHitEarshot');
    assertContract(enemyEarshot !== undefined, 'enemy hit inside earshot must still be heard');
    assertContract(enemyEarshot.audioOnly === true, 'enemy hit inside earshot stays audio-only');
    fullVisual('enemyHitSeen');
    // A shield impact's playerId is the shield owner; it is not an
    // emission terminal and earns no authored exemption.
    dropped('ownShieldImpactFog');

    // The direct wire-row writer shares the decision function.
    const rows: NetworkServerSnapshotSimEvent[] = [];
    const direct = writeAudioEventWireRowsDirect(
      labelled.map(([, event]) => event),
      visibility,
      rows,
    );
    assertContract(
      direct !== undefined && direct.length === delivered.size,
      `direct wire path delivers the same count (${direct?.length ?? 0} vs ${delivered.size})`,
    );
  } finally {
    spatialGrid.clear();
  }
}
