/**
 * Shared multiplayer backend instance for this runtime.
 *
 * The registry keeps the native directory publisher singular: the lobby list
 * and NetworkManager can ask for the same capability without constructing
 * competing publishers. A future shipping transport can replace the
 * implementation here when it actually exists.
 */

import type { MultiplayerBackend } from './MultiplayerBackend';
import { NativeMultiplayerBackend } from './NativeMultiplayerBackend';

let active: MultiplayerBackend | null = null;

export function getMultiplayerBackend(): MultiplayerBackend {
  if (active !== null) return active;
  active = new NativeMultiplayerBackend();
  return active;
}
