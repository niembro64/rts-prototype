// ── Two-state hysteresis range system ──
// Each weapon has two states: tracking (turret aimed) and engaged (actively firing).
// Each state uses hysteresis: acquire at a tighter range, release at a wider range.
// This prevents state flickering when targets hover near boundaries.

// All type definitions are now centralized in @/types/sim.
// This file re-exports them for backward compatibility and holds runtime constants.

export type {
  HysteresisRange,
  HysteresisRangeOverride,
  TurretRanges,
  TurretRangeMultipliers,
  TurretRangeOverrides,
  EntityId,
  PlayerId,
  Transform,
  Body,
  Selectable,
  Ownership,
  WaypointType,
  Waypoint,
  ActionType,
  BuildingType,
  UnitAction,
  Unit,
  Building,
  ForceFieldZoneConfig,
  ProjectileShot,
  BeamShot,
  LaserShot,
  LineShot,
  ForceShot,
  ShotConfig,
  TurretConfig,
  TurretState,
  Turret,
  ProjectileType,
  Projectile,
  EconomyState,
  Buildable,
  Builder,
  BuildingConfig,
  UnitBuildConfig,
  Factory,
  Commander,
  DGunProjectile,
  EntityType,
  Entity,
} from '@/types/sim';

export { isLineShot } from '@/types/sim';

import type { PlayerId } from '@/types/sim';

export type PlayerColors = { primary: number; secondary: number; name: string };

// Curated palette for the first six players — balanced ~65% saturation
// and ~70% lightness for a cohesive soft look. Player 1 = red is the
// canonical "host" color; later players get the iconic blue/yellow/etc.
const HARDCODED_PLAYER_COLORS: ReadonlyArray<PlayerColors> = [
  { primary: 0xe05858, secondary: 0xb84040, name: 'Red' },      // Soft coral red
  { primary: 0x5888e0, secondary: 0x4070b8, name: 'Blue' },     // Soft sky blue
  { primary: 0xd8c050, secondary: 0xb0a040, name: 'Yellow' },   // Soft gold yellow
  { primary: 0x58c058, secondary: 0x40a040, name: 'Green' },    // Soft grass green
  { primary: 0xa068d0, secondary: 0x8050b0, name: 'Purple' },   // Soft lavender purple
  { primary: 0xd88050, secondary: 0xb06840, name: 'Orange' },   // Soft peach orange
];

// Slot 1 of the curated palette = Red, and we want the LOCAL CLIENT
// player to always render in red regardless of which raw pid the
// server assigned them. The mapping is: local pid → slot 1; every
// other pid → slot 2..N enumerated in ascending pid order, skipping
// the local pid's own slot. The cache below is keyed by SLOT (not
// pid) so the palette stays stable as long as the local player
// doesn't change mid-session.
let _localPlayerForColors: PlayerId | undefined = undefined;

/** Tell the color helpers which pid is the local viewer's team — that
 *  pid will render in slot 1 (Red) on this client. Other pids slide
 *  into the remaining slots in ascending order. Calling with a new
 *  value invalidates the slot cache (slot mapping changed). Pass
 *  undefined to disable remapping (pid maps directly to slot). */
export function setLocalPlayerForColors(playerId: PlayerId | undefined): void {
  if (_localPlayerForColors === playerId) return;
  _localPlayerForColors = playerId;
  // Old cache reflected the previous remapping — clear it.
  _playerColorCache.clear();
}

/** Map a real pid to its display slot under the current local-player
 *  remapping. Slot 1 is reserved for the local player. */
function pidToSlot(pid: PlayerId): PlayerId {
  const local = _localPlayerForColors;
  if (local === undefined) return pid;
  if (pid === local) return 1 as PlayerId;
  // pids below the local one shift up by one slot to make room for
  // local at slot 1; pids above the local one keep their natural slot.
  return (pid < local ? pid + 1 : pid) as PlayerId;
}

const _playerColorCache = new Map<PlayerId, PlayerColors>();

/** Convert HSL (h ∈ [0, 360), s/l ∈ [0, 1]) to a 0xRRGGBB hex int. */
function hslToHex(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if      (hp < 1) { r = c; g = x; b = 0; }
  else if (hp < 2) { r = x; g = c; b = 0; }
  else if (hp < 3) { r = 0; g = c; b = x; }
  else if (hp < 4) { r = 0; g = x; b = c; }
  else if (hp < 5) { r = x; g = 0; b = c; }
  else             { r = c; g = 0; b = x; }
  const m = l - c / 2;
  const ri = Math.max(0, Math.min(255, Math.round((r + m) * 255)));
  const gi = Math.max(0, Math.min(255, Math.round((g + m) * 255)));
  const bi = Math.max(0, Math.min(255, Math.round((b + m) * 255)));
  return (ri << 16) | (gi << 8) | bi;
}

/** Resolve a player's color triplet (primary / secondary / display name).
 *  First six SLOTS use the hardcoded curated palette to keep the iconic
 *  team look (red / blue / yellow / green / purple / orange). Beyond
 *  six, slots are spaced via the golden angle (~137.5°) so consecutive
 *  slots land far apart on the color wheel — any number of teams stays
 *  visually distinct without clustering. The pid → slot remapping
 *  (see setLocalPlayerForColors) puts the local viewer's team at slot
 *  1 = Red so RED is always "you". Cached by slot so repeat lookups
 *  are free. */
export function getPlayerColors(playerId: PlayerId): PlayerColors {
  const slot = pidToSlot(playerId);
  let cached = _playerColorCache.get(slot);
  if (cached) return cached;
  if (slot >= 1 && slot <= HARDCODED_PLAYER_COLORS.length) {
    cached = HARDCODED_PLAYER_COLORS[slot - 1];
  } else {
    // Golden-angle hue stepping. (slot − 1) so slot=1 lands at hue 0.
    const hue = ((slot - 1) * 137.50776405003785) % 360;
    cached = {
      primary: hslToHex(hue, 0.65, 0.62),
      secondary: hslToHex(hue, 0.55, 0.45),
      name: `Team ${playerId}`,
    };
  }
  _playerColorCache.set(slot, cached);
  return cached;
}

/** Indexable-record view over the player-color cache. `PLAYER_COLORS[pid]`
 *  resolves through getPlayerColors() and auto-fills the cache. Iterating
 *  the proxy (Object.entries / for…in / Object.values) yields only the
 *  pids that have been seen so far — useful for "what teams are in play
 *  right now?" lookups but it is NOT a static list of "all possible
 *  players". Renderers that pre-create per-team resources should create
 *  them lazily on first sighting per pid (see Render3DEntities for the
 *  pattern). */
export const PLAYER_COLORS: Record<PlayerId, PlayerColors> = new Proxy(
  {} as Record<PlayerId, PlayerColors>,
  {
    get(_target, prop: string | symbol) {
      if (typeof prop === 'string') {
        const pid = Number(prop);
        if (Number.isFinite(pid) && pid >= 1) {
          return getPlayerColors(pid as PlayerId);
        }
      }
      return undefined;
    },
    ownKeys() {
      return Array.from(_playerColorCache.keys()).map(String);
    },
    getOwnPropertyDescriptor(_target, prop: string | symbol) {
      if (typeof prop === 'string') {
        const pid = Number(prop);
        if (Number.isFinite(pid) && _playerColorCache.has(pid as PlayerId)) {
          return {
            enumerable: true, configurable: true,
            value: getPlayerColors(pid as PlayerId),
          };
        }
      }
      return undefined;
    },
  },
);

/** Neutral fallback color for "no player" / unknown-playerId display.
 *  Soft gray so it reads as "ownerless" regardless of background. */
export const NEUTRAL_PLAYER_COLOR = 0x888888;

/** Resolve a player's primary display color. Returns NEUTRAL_PLAYER_COLOR
 *  for undefined player IDs — the single canonical source of truth for
 *  this lookup, used by the sim, 2D renderer, 3D renderer, and UI. */
export function getPlayerPrimaryColor(playerId: PlayerId | undefined): number {
  if (playerId === undefined) return NEUTRAL_PLAYER_COLOR;
  return getPlayerColors(playerId).primary;
}

/** Resolve a player's secondary (darker) display color. */
export function getPlayerSecondaryColor(playerId: PlayerId | undefined): number {
  if (playerId === undefined) return NEUTRAL_PLAYER_COLOR;
  return getPlayerColors(playerId).secondary;
}
