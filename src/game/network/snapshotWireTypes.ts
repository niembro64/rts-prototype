import type { NetworkServerSnapshot } from './NetworkTypes';
import type { PackedAudioEventsWire } from './snapshotAudioWirePack';
import type { PackedEntitySnapshotWire } from './snapshotEntityWirePack';
import type { PackedMinimapEntitiesWire } from './snapshotMinimapWirePack';
import type { PackedProjectileSnapshotWire } from './snapshotProjectileWirePack';

export type NetworkServerSnapshotWire = Omit<
  NetworkServerSnapshot,
  'audioEvents' | 'entities' | 'minimapEntities' | 'projectiles'
> & {
  audioEvents?: NetworkServerSnapshot['audioEvents'] | PackedAudioEventsWire;
  entities: NetworkServerSnapshot['entities'] | PackedEntitySnapshotWire;
  minimapEntities?: NetworkServerSnapshot['minimapEntities'] | PackedMinimapEntitiesWire;
  projectiles?: NetworkServerSnapshot['projectiles'] | PackedProjectileSnapshotWire;
};
