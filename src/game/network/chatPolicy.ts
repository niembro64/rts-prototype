/**
 * One bounded chat policy for every frontend room: HOME global chat, the
 * lobby room, and the battle console. The production HOME backend enforces
 * the same numbers independently at its trust boundary.
 */
export const CHAT_MESSAGES_PER_ROOM = 10;
export const CHAT_MESSAGE_MAX_LENGTH = 220;

/** Collapse chat onto one readable line and enforce the wire/UI ceiling. */
export function sanitizeChatMessageText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return null;
  return compact.slice(0, CHAT_MESSAGE_MAX_LENGTH);
}

/** Append without allowing a room's client-side history to become a log. */
export function appendRecentChatMessages<T>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  if (incoming.length >= CHAT_MESSAGES_PER_ROOM) {
    return incoming.slice(-CHAT_MESSAGES_PER_ROOM);
  }
  return [...current.slice(-(CHAT_MESSAGES_PER_ROOM - incoming.length)), ...incoming];
}
