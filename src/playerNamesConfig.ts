// Player-name system — single source of truth for:
//   1. The "funny names" pool used to seed every demo-battle player and
//      to give a brand-new real-battle joiner an identity before they
//      pick their own.
//   2. localStorage persistence of the LOCAL real-battle player's
//      username — once typed, it survives reloads.
//   3. The seat-resolution policy ("how do we pick a name for player N
//      right now?") used both on the host (NetworkManager seeding the
//      lobby roster) and on the client (TopBar / GameCanvas display).
//
// Designed extensibly: per-entity names (future "rename your factory")
// route through the same module — see entityNameOverride / setEntityName
// helpers in @/game/render3d/EntityName.
import playerNamesConfig from './playerNamesConfig.json';

const STORAGE_KEY = playerNamesConfig.storageKey;

/** The 20 names. Pattern: title + silly noun, rank-and-file military
 *  flavour with a wink — fits the RTS silhouette without picking a
 *  fight with anyone in particular. The list is `as const` so callers
 *  see exact union types and IDEs autocomplete the values. */
const FUNNY_DEMO_NAMES = playerNamesConfig.funnyDemoNames;

type FunnyName = typeof FUNNY_DEMO_NAMES[number];

/** Deterministic name pick from the pool, keyed by an integer seed.
 *  Same seed → same name across host and clients, so multiplayer rosters
 *  agree on what to call "player 3" without a round-trip. */
function pickFunnyName(seed: number): FunnyName {
  const idx = ((seed % FUNNY_DEMO_NAMES.length) + FUNNY_DEMO_NAMES.length)
    % FUNNY_DEMO_NAMES.length;
  return FUNNY_DEMO_NAMES[idx];
}

/** Random pick from the pool. Use for "I want surprise on every page
 *  refresh" callsites — first-time real-battle joiners and any code
 *  path that doesn't have a stable seed handy. */
function pickRandomFunnyName(): FunnyName {
  return pickFunnyName(Math.floor(Math.random() * FUNNY_DEMO_NAMES.length));
}

/** Read the local player's persisted username from localStorage. Returns
 *  null when nothing is stored (first-ever load, or storage unavailable
 *  in a sandboxed iframe). Trim + length-cap protects against pathologic
 *  values stuck in storage from older builds. */
export function loadStoredUsername(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Write the local player's chosen username to localStorage. No-ops when
 *  storage is unavailable. Trims + caps the value to keep round-tripped
 *  data sane. Empty / whitespace-only input clears the stored value so
 *  the next load falls back to a random funny pick. */
export function saveUsername(name: string): void {
  if (typeof localStorage === 'undefined') return;
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  try {
    if (trimmed.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, trimmed);
    }
  } catch {
    /* storage quota / sandbox failure — silently drop */
  }
}

/** What name should the LOCAL player see for themselves at game start?
 *  localStorage wins; otherwise pick a random funny name and persist it
 *  immediately so subsequent loads are stable until the user edits. */
export function getInitialLocalUsername(): string {
  const stored = loadStoredUsername();
  if (stored !== null) return stored;
  const seeded = pickRandomFunnyName();
  saveUsername(seeded);
  return seeded;
}

/** What name should we assign to a peer / AI seat at lobby-seed time?
 *  Deterministic by playerId so every viewer agrees without a sync
 *  round-trip. Real human peers overwrite their own seat with their
 *  persisted username via the existing playerInfoUpdate broadcast — this
 *  function only seeds the FALLBACK / DEMO BATTLE / pre-edit value. */
export function getDefaultPlayerName(playerId: number): string {
  return pickFunnyName(playerId);
}

/** Soft cap on persisted/edited usernames — protects the HUD layout and
 *  keeps the canvas-texture name labels from blowing past their texture
 *  width. The TopBar input enforces this too. */
export const MAX_NAME_LENGTH = playerNamesConfig.maxNameLength;
