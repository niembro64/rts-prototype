import type { NetworkServerSnapshotSimEvent } from './NetworkTypes';

export const EVENT_HAS_SOURCE_TYPE = 0x001;
export const EVENT_HAS_SOURCE_KEY = 0x002;
export const EVENT_HAS_PLAYER_ID = 0x004;
export const EVENT_HAS_ENTITY_ID = 0x008;
export const EVENT_HAS_SHIELD_IMPACT = 0x010;
export const EVENT_HAS_KILLER_PLAYER_ID = 0x020;
export const EVENT_HAS_VICTIM_PLAYER_ID = 0x040;
export const EVENT_HAS_AUDIO_ONLY = 0x080;
export const EVENT_AUDIO_ONLY_VALUE = 0x100;
export const EVENT_HAS_DEATH_CONTEXT = 0x200;
export const EVENT_HAS_IMPACT_CONTEXT = 0x400;
export const EVENT_HAS_WATER_SPLASH_CONTEXT = 0x800;

export const DEATH_HAS_VISUAL_RADIUS = 0x01;
export const DEATH_HAS_COLLISION_RADIUS = 0x02;
export const DEATH_HAS_BASE_Z = 0x04;
export const DEATH_HAS_UNIT_TYPE = 0x08;
export const DEATH_HAS_ROTATION = 0x10;
export const DEATH_HAS_TURRET_POSES = 0x20;

export const AUDIO_EVENT_TYPE_CODES: Record<NetworkServerSnapshotSimEvent['type'], number> = {
  fire: 0,
  hit: 1,
  death: 2,
  laserStart: 3,
  laserStop: 4,
  shieldStart: 5,
  shieldStop: 6,
  shieldImpact: 7,
  ping: 8,
  attackAlert: 9,
  projectileExpire: 10,
  waterSplash: 11,
};

export const AUDIO_EVENT_SOURCE_TYPE_CODES: Record<string, number> = {
  turret: 0,
  unit: 1,
  building: 2,
  system: 3,
};
