// ── Two-state hysteresis range system ──
// Each weapon has two states: tracking (turret aimed) and engaged (actively firing).
// Each state uses hysteresis: acquire at a tighter range, release at a wider range.
// This prevents state flickering when targets hover near boundaries.

// All type definitions are now centralized in @/types/sim.
// This file re-exports them for backward compatibility and holds runtime constants.

export type {
  HysteresisRange,
  HysteresisRangeMultiplier,
  TurretRanges,
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
  SolarCollectorState,
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

// Number of total players currently in the lobby / game. Drives the
// evenly-spaced hue distribution: with N players slot k lands at hue
// ((k − 1) / N) × 360°, so slot 1 is always red (0°) and slot 1 +
// floor(N/2) sits exactly opposite on the color wheel — "red ↔
// anti-red". Set via setPlayerCountForColors() at game/lobby init.
let _playerCountForColors = 6;

/** Compatibility shim for older callers. Colors are global by player
 *  id now: player 1 is the same color on every browser, player 2 is
 *  the same color on every browser, and so on. */
export function setLocalPlayerForColors(_playerId: PlayerId | undefined): void {
  // Intentionally no-op. Never remap colors per local browser.
}

/** Tell the color helpers how many total players are in the game so
 *  the hue wheel divides evenly. With N players, hues land at
 *  k × 360°/N for k = 0..N−1: slot 1 → 0° (Red), slot 1 + floor(N/2)
 *  → 180° (Cyan, "anti-red"). Calling with a new count invalidates
 *  the slot cache. */
export function setPlayerCountForColors(count: number): void {
  const next = Math.max(1, Math.floor(count));
  if (_playerCountForColors === next) return;
  _playerCountForColors = next;
  _playerColorCache.clear();
}

/** Map a real pid to its display slot. This is intentionally global
 *  and independent of the local viewer so every client agrees. */
function pidToSlot(pid: PlayerId): PlayerId {
  return pid;
}

const _playerColorCache = new Map<PlayerId, PlayerColors>();

/** Map a hue (degrees, 0–360) to the closest canonical color name on a
 *  12-slot wheel. Used so the displayed team name always matches what
 *  the player actually sees on screen, regardless of how many players
 *  are in the lobby (the wheel divides differently each time, so a
 *  hardcoded "slot N → name" table would lie). */
const _HUE_NAMES: ReadonlyArray<readonly [number, string]> = [
  [0,   'Red'],
  [30,  'Orange'],
  [60,  'Yellow'],
  [90,  'Lime'],
  [120, 'Green'],
  [150, 'Mint'],
  [180, 'Cyan'],
  [210, 'Sky'],
  [240, 'Blue'],
  [270, 'Purple'],
  [300, 'Magenta'],
  [330, 'Pink'],
];
function hueToName(hueDeg: number): string {
  const h = ((hueDeg % 360) + 360) % 360;
  let bestName = 'Red';
  let bestDist = 360;
  for (const [target, name] of _HUE_NAMES) {
    const raw = Math.abs(h - target);
    const d = Math.min(raw, 360 - raw);
    if (d < bestDist) {
      bestDist = d;
      bestName = name;
    }
  }
  return bestName;
}

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
 *  Hues are evenly distributed around the color wheel based on the
 *  total player count: with N players, slot k is at hue
 *  ((k − 1) / N) × 360°. Slot 1 = Red (always, regardless of N), and
 *  slot 1 + floor(N/2) sits at "anti-red" (180° = Cyan). Saturation
 *  and lightness are fixed for a cohesive palette. Player ids map
 *  directly to slots so all clients see the same team colors. */
export function getPlayerColors(playerId: PlayerId): PlayerColors {
  const slot = pidToSlot(playerId);
  let cached = _playerColorCache.get(slot);
  if (cached) return cached;
  // Use the larger of "configured player count" and "this slot index"
  // so an out-of-range pid still gets a valid (if slightly off-circle)
  // hue without divide-by-zero or wrap weirdness.
  const total = Math.max(_playerCountForColors, slot);
  const hue = ((slot - 1) / total) * 360;
  cached = {
    primary: hslToHex(hue, 0.65, 0.62),
    secondary: hslToHex(hue, 0.55, 0.45),
    name: hueToName(hue),
  };
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
