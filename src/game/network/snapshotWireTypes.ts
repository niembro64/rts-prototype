import type { NetworkServerSnapshot } from './NetworkTypes';
import type { PackedAudioEventsWire } from './snapshotAudioWirePack';
import type { PackedMinimapEntitiesWire } from './snapshotMinimapWirePack';
import type { PackedProjectileSnapshotWire } from './snapshotProjectileWirePack';

export type NetworkServerSnapshotWire = Omit<
  NetworkServerSnapshot,
  'audioEvents' | 'minimapEntities' | 'projectiles'
> & {
  audioEvents?: NetworkServerSnapshot['audioEvents'] | PackedAudioEventsWire;
  minimapEntities?: NetworkServerSnapshot['minimapEntities'] | PackedMinimapEntitiesWire;
  projectiles?: NetworkServerSnapshot['projectiles'] | PackedProjectileSnapshotWire;
};
