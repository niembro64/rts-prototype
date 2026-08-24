/**
 * Client for the games.niemo.io global chat — the HOME screen's room.
 *
 * A player on the home screen is connected to nobody: no host, no peers,
 * nothing to relay a word through. The backend holds one conversation per
 * game (web_games_backend /api/chat) and this polls it, the same way the
 * lobby directory is polled and under the same rule: **chat is never allowed
 * to break anything else.** Every call is best-effort — a backend that is
 * down, slow, or absent degrades to a quiet room, not an error.
 */

import { lobbyApiBaseUrl } from './LobbyDirectory';
import { sanitizeChatMessageText } from './chatPolicy';

const GLOBAL_CHAT_GAME_ID = 'budget-annihilation';

/** Fallback cadence until a read advertises the server's own. */
const DEFAULT_POLL_INTERVAL_MS = 4000;

/** Ceiling for the failure backoff. An absent backend is the ordinary local
 *  dev state, and knocking every four seconds on a door nobody answers just
 *  fills the dev server's log — so unanswered polls stretch toward this,
 *  and the first answered one snaps back to the advertised cadence. */
const MAX_FAILURE_BACKOFF_MS = 60000;

const REQUEST_TIMEOUT_MS = 6000;

export type GlobalChatMessage = {
  readonly seq: number;
  readonly name: string;
  readonly text: string;
  readonly atMs: number;
};

function readMessage(raw: unknown): GlobalChatMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const seq = Math.floor(Number(value.seq));
  if (!Number.isFinite(seq) || seq <= 0) return null;
  const name = typeof value.name === 'string' ? value.name : '';
  const text = sanitizeChatMessageText(value.text);
  if (name === '' || text === null) return null;
  const atMs = Math.floor(Number(value.atMs));
  return { seq, name, text, atMs: Number.isFinite(atMs) ? atMs : 0 };
}

async function requestJson(
  path: string,
  init: RequestInit = {},
): Promise<unknown | null> {
  if (typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${lobbyApiBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Polls the room while started and posts on demand. One instance per screen
 * that shows the room; stop() when the screen goes away.
 */
export class GlobalChatClient {
  private latestSeq = 0;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private consecutiveFailures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private onMessages: ((messages: readonly GlobalChatMessage[]) => void) | null = null;

  start(onMessages: (messages: readonly GlobalChatMessage[]) => void): void {
    this.onMessages = onMessages;
    if (this.timer !== null) return;
    // A fresh arrival deserves a fresh first knock, whatever the backoff
    // said before the player left the surface.
    this.consecutiveFailures = 0;
    // First read fetches the whole kept ring, so a player arriving at home
    // sees the conversation already in progress.
    void this.poll();
  }

  stop(): void {
    this.onMessages = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Say something. Resolves false when the backend refused or was away;
   *  the message simply does not appear, which is honest. */
  async send(name: string, text: string): Promise<boolean> {
    const sanitizedText = sanitizeChatMessageText(text);
    if (sanitizedText === null) return false;
    const body = await requestJson(`/chat/${encodeURIComponent(GLOBAL_CHAT_GAME_ID)}`, {
      method: 'POST',
      body: JSON.stringify({ name, text: sanitizedText }),
    });
    if (body === null) return false;
    // Show the room immediately rather than waiting out the poll timer.
    void this.poll();
    return true;
  }

  private async poll(): Promise<void> {
    if (this.inFlight || this.onMessages === null) return;
    this.inFlight = true;
    try {
      const body = await requestJson(
        `/chat/${encodeURIComponent(GLOBAL_CHAT_GAME_ID)}?after=${this.latestSeq}`,
      );
      const handler = this.onMessages;
      if (body === null) {
        this.consecutiveFailures++;
      } else if (handler !== null) {
        this.consecutiveFailures = 0;
        const value = body as Record<string, unknown>;
        const interval = Math.floor(Number(value.pollIntervalMs));
        if (Number.isFinite(interval) && interval >= 1000) this.pollIntervalMs = interval;
        const raw = Array.isArray(value.messages) ? value.messages : [];
        const messages: GlobalChatMessage[] = [];
        for (const entry of raw) {
          const message = readMessage(entry);
          if (message !== null) messages.push(message);
        }
        if (messages.length > 0) {
          this.latestSeq = messages[messages.length - 1].seq;
          handler(messages);
        }
      }
    } finally {
      this.inFlight = false;
      if (this.onMessages !== null) {
        const delay = this.consecutiveFailures === 0
          ? this.pollIntervalMs
          : Math.min(
              MAX_FAILURE_BACKOFF_MS,
              this.pollIntervalMs * 2 ** this.consecutiveFailures,
            );
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.poll();
        }, delay);
      }
    }
  }
}
