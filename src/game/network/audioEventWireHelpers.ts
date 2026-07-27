import {
  DEATH_HAS_BASE_Z,
  DEATH_HAS_COLLISION_RADIUS,
  DEATH_HAS_ROTATION,
  DEATH_HAS_TURRET_POSES,
  DEATH_HAS_UNIT_TYPE,
  DEATH_HAS_VISUAL_RADIUS,
  EVENT_AUDIO_ONLY_VALUE,
  EVENT_HAS_AUDIO_ONLY,
  EVENT_HAS_DEATH_CONTEXT,
  EVENT_HAS_ENTITY_ID,
  EVENT_HAS_IMPACT_CONTEXT,
  EVENT_HAS_KILLER_PLAYER_ID,
  EVENT_HAS_PLAYER_ID,
  EVENT_HAS_SHIELD_IMPACT,
  EVENT_HAS_SOURCE_KEY,
  EVENT_HAS_SOURCE_TYPE,
  EVENT_HAS_VICTIM_PLAYER_ID,
  EVENT_HAS_WATER_SPLASH_CONTEXT,
} from './audioEventWireFormat';
import type { NetworkServerSnapshotSimEvent } from './NetworkTypes';

type DeathContext =
  NonNullable<NetworkServerSnapshotSimEvent['deathContext']>;

export function getDeathContextWireFlags(context: DeathContext): number {
  let flags = 0;
  if (context.visualRadius !== undefined) flags |= DEATH_HAS_VISUAL_RADIUS;
  if (context.collisionRadius !== undefined) flags |= DEATH_HAS_COLLISION_RADIUS;
  if (context.baseZ !== undefined) flags |= DEATH_HAS_BASE_Z;
  if (context.unitBlueprintId !== undefined) flags |= DEATH_HAS_UNIT_TYPE;
  if (context.rotation !== undefined) flags |= DEATH_HAS_ROTATION;
  if (context.turretPoses !== undefined) flags |= DEATH_HAS_TURRET_POSES;
  return flags;
}

export function getAudioEventWireFlags(
  event: NetworkServerSnapshotSimEvent,
): number {
  let flags = 0;
  if (event.sourceType !== null) flags |= EVENT_HAS_SOURCE_TYPE;
  if (event.sourceKey !== null) flags |= EVENT_HAS_SOURCE_KEY;
  if (event.playerId !== null) flags |= EVENT_HAS_PLAYER_ID;
  if (event.entityId !== null) flags |= EVENT_HAS_ENTITY_ID;
  if (event.shieldImpact !== null) flags |= EVENT_HAS_SHIELD_IMPACT;
  if (event.killerPlayerId !== null) flags |= EVENT_HAS_KILLER_PLAYER_ID;
  if (event.victimPlayerId !== null) flags |= EVENT_HAS_VICTIM_PLAYER_ID;
  if (event.audioOnly !== null) {
    flags |= EVENT_HAS_AUDIO_ONLY;
    if (event.audioOnly) flags |= EVENT_AUDIO_ONLY_VALUE;
  }
  if (event.deathContext !== null) flags |= EVENT_HAS_DEATH_CONTEXT;
  if (event.impactContext !== null) flags |= EVENT_HAS_IMPACT_CONTEXT;
  if (event.waterSplash !== null) flags |= EVENT_HAS_WATER_SPLASH_CONTEXT;
  return flags;
}
