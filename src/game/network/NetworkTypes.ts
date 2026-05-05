// Network type definitions — re-exported from canonical @/types/network

export type {
  NetworkMessage,
  NetworkPlayerActionMessage,
  NetworkServerSnapshotMessage,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotVelocityUpdate,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshot,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotTurret,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotEconomy,
  LobbyPlayerInfoPayload,
  LobbySettings,
  LobbyPlayer,
  NetworkRole,
  BattleHandoff,
} from '@/types/network';

export { BATTLE_HANDOFF_PROTOCOL } from '@/types/network';
