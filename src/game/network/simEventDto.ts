import type { NetworkServerSnapshotSimEvent } from './NetworkTypes';

export function createSimEventDto(): NetworkServerSnapshotSimEvent {
  return {
    type: 'fire',
    turretBlueprintId: '',
    sourceType: null,
    sourceKey: null,
    pos: { x: 0, y: 0, z: 0 },
    playerId: null,
    entityId: null,
    deathContext: null,
    impactContext: null,
    waterSplash: null,
    shieldImpact: null,
    killerPlayerId: null,
    victimPlayerId: null,
    audioOnly: null,
  };
}

export function copySimEventInto(
  source: NetworkServerSnapshotSimEvent,
  target: NetworkServerSnapshotSimEvent,
): NetworkServerSnapshotSimEvent {
  target.type = source.type;
  target.turretBlueprintId = source.turretBlueprintId;
  target.sourceType = source.sourceType;
  target.sourceKey = source.sourceKey;
  target.pos.x = source.pos.x;
  target.pos.y = source.pos.y;
  target.pos.z = source.pos.z;
  target.playerId = source.playerId;
  target.entityId = source.entityId;
  // Simulation event contexts are immutable once emitted, so these large
  // structures can be shared by queued/snapshot DTOs.
  target.deathContext = source.deathContext;
  target.impactContext = source.impactContext;

  if (source.waterSplash === null) {
    target.waterSplash = null;
  } else if (target.waterSplash === null) {
    target.waterSplash = {
      velocity: {
        x: source.waterSplash.velocity.x,
        y: source.waterSplash.velocity.y,
        z: source.waterSplash.velocity.z,
      },
      mass: source.waterSplash.mass,
    };
  } else {
    target.waterSplash.velocity.x = source.waterSplash.velocity.x;
    target.waterSplash.velocity.y = source.waterSplash.velocity.y;
    target.waterSplash.velocity.z = source.waterSplash.velocity.z;
    target.waterSplash.mass = source.waterSplash.mass;
  }

  if (source.shieldImpact === null) {
    target.shieldImpact = null;
  } else if (target.shieldImpact === null) {
    target.shieldImpact = {
      normal: {
        x: source.shieldImpact.normal.x,
        y: source.shieldImpact.normal.y,
        z: source.shieldImpact.normal.z,
      },
      playerId: source.shieldImpact.playerId,
    };
  } else {
    target.shieldImpact.normal.x = source.shieldImpact.normal.x;
    target.shieldImpact.normal.y = source.shieldImpact.normal.y;
    target.shieldImpact.normal.z = source.shieldImpact.normal.z;
    target.shieldImpact.playerId = source.shieldImpact.playerId;
  }

  target.killerPlayerId = source.killerPlayerId;
  target.victimPlayerId = source.victimPlayerId;
  target.audioOnly = source.audioOnly;
  return target;
}
