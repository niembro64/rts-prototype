// Migration debt: re-export surface for host-snapshot network types.
// Lockstep command-bundle and manifest types will replace gameplay state
// messages; existing snapshot IDs are not the target protocol.

export type {
  NetworkMessage,
  NetworkPlayerActionMessage,
  NetworkServerSnapshotMessage,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotVelocityUpdate,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotScanPulse,
  NetworkServerSnapshotShroud,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotWorldHash,
  NetworkServerSnapshotWorldHashSample,
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
  BattleManifest,
  BattleManifestSettings,
  BattleManifestPlayerSlot,
  BlueprintVersionStamps,
  NetworkRole,
  BattleHandoff,
} from '@/types/network';

export {
  BATTLE_HANDOFF_PROTOCOL,
  BATTLE_MANIFEST_PROTOCOL,
  BATTLE_MANIFEST_SCHEMA_VERSION,
  COMMAND_SCHEMA_VERSION,
} from '@/types/network';
export type { CommandBundle } from '@/types/network';
