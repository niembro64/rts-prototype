// Network type definitions — re-exported from canonical @/types/network

export type {
  NetworkMessage,
  NetworkLockstepMessage,
  
  LockstepPeerSequenceAck,
  
  LockstepCommandMessage,
  LockstepCommandFrameMessage,
  LockstepCommandFrameBatchFrame,
  LockstepCommandFrameBatchMessage,
  LockstepAckMessage,

  

  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotVelocityUpdate,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotScanPulse,
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
  NetworkServerSnapshotResourceMovement,
  LobbyPlayerInfoPayload,
  LobbySettings,
  LobbyPlayer,
  NetworkRole,
  BattleHandoff,
  GamePhase,
} from '@/types/network';

export { BATTLE_HANDOFF_PROTOCOL, LOCKSTEP_PROTOCOL_VERSION } from '@/types/network';
