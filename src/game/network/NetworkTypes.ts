// Network type definitions — re-exported from canonical @/types/network

import type {
  NetworkLockstepMessage as NetworkLockstepMessageType,
  NetworkMessage as NetworkMessageType,
} from '@/types/network';

export type {
  NetworkMessage,
  NetworkLockstepMessage,
  
  LockstepPeerSequenceAck,
  
  LockstepCommandMessage,
  LockstepCommandFrameMessage,
  LockstepCommandFrameBatchFrame,
  LockstepCommandFrameBatchMessage,
  LockstepAckMessage,
  LockstepPeerFrame,
  LockstepResumeGrantMessage,

  

  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotMotionUpdate,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotScanPulse,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshot,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotTurret,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotResourceMovement,
  LobbyMember,
  LobbyMemberRole,
  LobbySettings,
  LobbyPlayer,
  NetworkRole,
  BattleHandoff,
  GamePhase,
} from '@/types/network';

export { BATTLE_HANDOFF_PROTOCOL, LOCKSTEP_PROTOCOL_VERSION } from '@/types/network';

// Single source of truth for which message types are lockstep traffic.
// Both the lockstep transport (routing) and the send budget
// (classification) consume this predicate, so the case list must stay
// in lockstep with the NetworkLockstepMessage union above.
export function isNetworkLockstepMessage(
  message: NetworkMessageType,
): message is NetworkLockstepMessageType {
  switch (message.type) {
    case 'lockstepHello':
    case 'lockstepReady':
    case 'lockstepCommand':
    case 'lockstepCommandFrame':
    case 'lockstepCommandFrameBatch':
    case 'lockstepAck':
    case 'lockstepPeerFrames':
    case 'lockstepChecksum':
    case 'lockstepPause':
    case 'lockstepResume':
    case 'lockstepDesync':
    case 'lockstepResyncRequest':
    case 'lockstepResumeRequest':
    case 'lockstepResumeGrant':
    case 'lockstepHistory':
      return true;
    default:
      return false;
  }
}
