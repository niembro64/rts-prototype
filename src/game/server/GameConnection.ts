// Migration debt: uniform interface for the host-snapshot prototype.
// Lockstep replaces this with peer-session/runtime contracts, not a
// host/remote gameplay authority split.

export type {
  GameConnection,
  SnapshotCallback,
  SimEventCallback,
  GameOverCallback,
} from '@/types/game';
