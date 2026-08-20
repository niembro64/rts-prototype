/**
 * What a lobby is called.
 *
 * One rule in one place because three surfaces read it and they must agree:
 * the host types it, the settings contract carries it to every client, and
 * the public directory lists it. An unnamed lobby is not an error — most
 * hosts never type anything — so the fallback ("<host>'s game") lives here
 * too rather than being re-derived at each display site.
 */

/** Long enough for a real title, short enough that a directory row stays one
 *  line at the sidebar's width. */
export const MAX_LOBBY_NAME_LENGTH = 32;

export function normalizeLobbyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_LOBBY_NAME_LENGTH);
}

/** The name to SHOW for a lobby, given whatever the host typed and whoever
 *  is hosting. Never empty: a row with no text is worse than a generic one. */
export function resolveLobbyDisplayName(
  lobbyName: string,
  hostName: string,
): string {
  const named = normalizeLobbyName(lobbyName);
  if (named !== '') return named;
  const host = hostName.trim();
  return host === '' ? 'Open lobby' : `${host}'s game`;
}
