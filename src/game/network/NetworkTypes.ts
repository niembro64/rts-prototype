// Network type definitions — re-exported from canonical @/types/network

export type {
  NetworkMessage,
  NetworkPlayerActionMessage,
  NetworkServerSnapshotMessage,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotVelocityUpdate,
  NetworkServerSnapshotBeamReflection,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotUnitTypeStats,
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshot,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotTurret,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotEconomy,
  LobbyPlayer,
  NetworkRole,
  BattleHandoff,
} from '@/types/network';

export { BATTLE_HANDOFF_PROTOCOL } from '@/types/network';
