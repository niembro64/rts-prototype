/**
 * Which multiplayer backend this runtime uses.
 *
 * One selection point, resolved once, so no caller has to ask "are we on
 * Steam?" — they ask the registry for a backend and use it. Steam wins when
 * it is genuinely available, because a desktop player signed into Steam
 * expects Steam's friends and lobbies rather than a room code; otherwise the
 * native backend, which works everywhere the game runs.
 */

import type { MultiplayerBackend, MultiplayerBackendId } from './MultiplayerBackend';
import { NativeMultiplayerBackend } from './NativeMultiplayerBackend';
import { SteamMultiplayerBackend, type SteamNetworkingApi } from './SteamMultiplayerBackend';

let steamApi: SteamNetworkingApi | null = null;
let active: MultiplayerBackend | null = null;

/**
 * Attach a Steam implementation, before any lobby work begins.
 *
 * Exists so the Steam SDK — which only a desktop build can supply — is
 * injected rather than imported. Nothing in the web build references it, and
 * the registry keeps returning the native backend until this is called.
 */
export function registerSteamNetworkingApi(api: SteamNetworkingApi | null): void {
  steamApi = api;
  // Re-resolve: attaching Steam after the fact must not leave a stale choice.
  active = null;
}

export function getMultiplayerBackend(): MultiplayerBackend {
  if (active !== null) return active;
  const steam = new SteamMultiplayerBackend(steamApi);
  active = steam.isAvailable() ? steam : new NativeMultiplayerBackend();
  return active;
}

export function getMultiplayerBackendId(): MultiplayerBackendId {
  return getMultiplayerBackend().id;
}

/** Test seam — forget the resolved choice. */
export function resetMultiplayerBackend(): void {
  active = null;
}
