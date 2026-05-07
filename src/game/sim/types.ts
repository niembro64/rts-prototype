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
  BuildingRenderProfile,
  BuildingAnchorProfile,
  UnitAction,
  UnitLocomotion,
  SolarCollectorState,
  Unit,
  Building,
  ForceFieldBarrierConfig,
  ProjectileShot,
  BeamShot,
  LaserShot,
  LineShot,
  LineShotType,
  ActiveProjectileShot,
  ForceShot,
  BuildSprayShot,
  ShotConfig,
  ShotRuntimeProfile,
  ShotVisualProfile,
  ShotProfile,
  TurretConfig,
  ProjectileConfig,
  TurretState,
  Turret,
  ProjectileType,
  BeamPoint,
  Projectile,
  EconomyState,
  ResourceCost,
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

export { isLineShot, isLineShotType, isProjectileShot, isRocketLikeShot, getShotMaxLifespan } from '@/types/sim';

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

/** OKLCH → linear sRGB. Björn Ottosson's OKLab matrices, polar form
 *  (`a = C·cos(H)`, `b = C·sin(H)`). Output is linear-light sRGB; the
 *  caller still has to gamma-encode and clamp to 8-bit. */
function oklchToLinearRgb(L: number, C: number, hueDeg: number): { r: number; g: number; b: number } {
  const hRad = hueDeg * (Math.PI / 180);
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  // OKLab → LMS' (cube-root LMS).
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548  * b;
  // Cube to true LMS, then mix into linear sRGB.
  const lms_l = l_ * l_ * l_;
  const lms_m = m_ * m_ * m_;
  const lms_s = s_ * s_ * s_;
  return {
    r:  4.0767416621 * lms_l - 3.3077115913 * lms_m + 0.2309699292 * lms_s,
    g: -1.2684380046 * lms_l + 2.6097574011 * lms_m - 0.3413193965 * lms_s,
    b: -0.0041960863 * lms_l - 0.7034186147 * lms_m + 1.7076147010 * lms_s,
  };
}

/** Linear-light sRGB component → gamma-encoded sRGB byte (0..255). */
function linearToSrgbByte(c: number): number {
  const clipped = c <= 0 ? 0 : c >= 1 ? 1 : c;
  const gamma = clipped <= 0.0031308
    ? clipped * 12.92
    : 1.055 * Math.pow(clipped, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(gamma * 255)));
}

/** Convert OKLCH (L ∈ [0, 1], C ≥ 0, hueDeg ∈ [0, 360)) to a 0xRRGGBB
 *  hex int. Out-of-gamut values get clamped per channel — at the
 *  L/C used for player colors below, every hue stays comfortably
 *  inside sRGB so clamping is rare and visually invisible. */
function oklchToHex(L: number, C: number, hueDeg: number): number {
  const lin = oklchToLinearRgb(L, C, hueDeg);
  const ri = linearToSrgbByte(lin.r);
  const gi = linearToSrgbByte(lin.g);
  const bi = linearToSrgbByte(lin.b);
  return (ri << 16) | (gi << 8) | bi;
}

/** Format a 0xRRGGBB int as a `#RRGGBB` upper-case hex string. */
function hexToHashString(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0').toUpperCase();
}

/** Perceptual lightness used for the primary player color. OKLab L is
 *  perceptually uniform: every hue looks equally bright at this value,
 *  which the old HSL path couldn't do (yellow at L=0.62 looks far
 *  brighter than blue at the same L). 0.72 = bright but readable. */
const PLAYER_PRIMARY_OKLCH_L = 0.5;
/** Chroma (= colorfulness in OKLab). Low enough that every hue stays
 *  inside sRGB without gamut clipping at the chosen lightness. */
const PLAYER_PRIMARY_OKLCH_C = 0.12;
const PLAYER_SECONDARY_OKLCH_L = 0.3;
const PLAYER_SECONDARY_OKLCH_C = 0.05;

/** Resolve a player's color triplet (primary / secondary / display
 *  name). Hues are evenly distributed around the color wheel based
 *  on the total player count: with N players, slot k lands at hue
 *  ((k − 1) / N) × 360°. The wheel divides for ANY N — there's no
 *  hardcoded slot table, so a 10-player or 20-player lobby works
 *  the same way a 6-player lobby does.
 *
 *  The primary/secondary pair uses OKLCH at fixed L and C, varying
 *  only hue, so every player has the SAME perceptual brightness and
 *  saturation regardless of which slot they got. Player names are
 *  the primary color's hex string (`#RRGGBB`) so the name always
 *  matches exactly what's on screen. */
export function getPlayerColors(playerId: PlayerId): PlayerColors {
  const slot = pidToSlot(playerId);
  let cached = _playerColorCache.get(slot);
  if (cached) return cached;
  // Use the larger of "configured player count" and "this slot index"
  // so an out-of-range pid still gets a valid (if slightly off-circle)
  // hue without divide-by-zero or wrap weirdness.
  const total = Math.max(_playerCountForColors, slot);
  const hue = ((slot - 1) / total) * 360;
  const primary = oklchToHex(PLAYER_PRIMARY_OKLCH_L, PLAYER_PRIMARY_OKLCH_C, hue);
  const secondary = oklchToHex(PLAYER_SECONDARY_OKLCH_L, PLAYER_SECONDARY_OKLCH_C, hue);
  cached = { primary, secondary, name: hexToHashString(primary) };
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
