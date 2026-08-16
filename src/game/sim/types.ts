// ── Two-state hysteresis range system ──
// Each weapon has two states: tracking (turret aimed) and engaged (actively firing).
// Each state uses hysteresis: acquire at a tighter range, release at a wider range.
// This prevents state flickering when targets hover near boundaries.

// All type definitions are now centralized in @/types/sim.
// This file re-exports them for backward compatibility and holds runtime constants.

import { linearToSrgbByte } from '../math/ColorMath';

export type {
  HysteresisRange,
  
  TurretRanges,
  
  EntityId,
  PlayerId,
  
  
  
  
  WaypointType,
  
  ActionType,
  BuildingBlueprintId,
  BuildingRenderProfile,
  BuildingAnchorProfile,
  BuildingPlacementType,
  BuildingHoveringType,
  BuildingSupportSurface,
  StructureBlueprintId,
  SensorCapabilityConfig,
  UnitSupportSurface,
  UnitAction,
  UnitPathPoint,
  UnitLocomotion,
  UnitAirIdleState,
  UnitMoveState,
  CombatFireState,
  CombatTrajectoryMode,
  
  BuildingActiveState,
  Unit,
  
  ShieldBarrierConfig,
  CombatComponent,
  MountedCapabilityBase,
  SensorMountCapability,
  ResourceFlowMountCapability,
  UtilityMountCapability,
  ProjectileShot,
  BeamRay,
  LaserRay,
  
  ActiveProjectileShot,
  ShieldConfig,
  EmissionConfig,
  ShotConfig,
  ShotLocomotion,
  ShotLocomotionMedia,
  ShotLocomotionMediumPhysics,
  ShotLocomotionMotionModel,
  ShotLocomotionTerminalOutcome,
  ShotLocomotionTerminalPolicy,
  ShotLocomotionTransitionOutcome,
  ShotLocomotionTransitions,
  ShotRuntimeProfile,
  ShotVisualProfile,
  ShotProfile,
  TurretCooldownConfig,
  TurretConfig,
  ProjectileConfig,
  TurretState,
  Turret,
  TurretTask,
  TurretEntityTask,
  TurretEntityTaskOperation,
  TurretPointTask,
  ProjectileType,
  ShotSource,
  BeamReflectorKind,
  BeamPoint,
  BeamPulsePlan,
  Projectile,
  EconomyState,
  ConstructionPieceKind,
  ConstructionPieceBuildRecord,
  ResourceCost,
  Buildable,
  Builder,
  BuilderWorkStationRuntime,
  
  Transport,
  EntityHold,
  EntityHoldKind,
  BuildingConfig,
  BuildingPlacementFootprint,
  BuildingPlacementFootprintCell,
  UnitBuildConfig,
  FactoryDefaultWaypoint,
  
  EntityMeta,
  RecentAggression,
  EntityMetaBlueprintKind,
  EntityMetaKind,
  EntityType,
  Entity,
} from '@/types/sim';

export { isRayConfig, isRayType, isShieldConfig, isProjectileShot, isRocketLikeShot,  getEmissionBlueprintId, getShotMaxLifespan, NO_ENTITY_ID, PROJECTILE_ABSENCE_SLOTS } from '@/types/sim';
export { createCombatComponent, createEmptyEntityComponentSlots, createTransform } from '@/types/sim';

import type { PlayerId } from '@/types/sim';
import { COLORS } from '@/colorsConfig';

/**
 * Identity colors for one seat. FOUR colors, because a seat has two
 * identities and an entity shows both:
 *
 *   colorTeamNormal / colorTeamDark     the SIDE this seat plays on
 *   colorPlayerNormal / colorPlayerDark the seat itself
 *
 * `primary` / `secondary` stay as aliases of the PLAYER pair so existing
 * callers keep working unchanged.
 */
type PlayerColors = {
  primary: number;
  secondary: number;
  colorPlayerNormal: number;
  colorPlayerDark: number;
  colorTeamNormal: number;
  colorTeamDark: number;
  name: string;
};

/**
 * Hue nests two levels deep, mirroring the team model (see
 * src/game/sim/teamRoster.ts and budget_design_philosophy.html):
 *
 *   1. The wheel splits evenly by TEAM count. A team's color is the
 *      MIDDLE of its slice, at hue k x 360/N - so team 1 is always red.
 *   2. That slice splits evenly by how many players the team holds. A
 *      player's color is the MIDDLE of its sub-slice.
 *
 * COLLISIONS ARE EXPECTED, NOT SPECIAL CASES. Whenever a team holds an
 * ODD number of players, its MIDDLE seat lands exactly on the team hue,
 * so that seat's player color and team color are the same value:
 *
 *     hue(middle of P seats) = teamHue - W/2 + ((P-1)/2 + 0.5) * (W/P)
 *                            = teamHue - W/2 + W/2
 *                            = teamHue
 *
 * A one-player team is just the smallest case of that, and a three-player
 * team does it to its second seat. Nothing branches on it: the formula
 * produces the coincidence on its own, and a seat whose two colors match
 * simply wears one color. Free-for-all is the same story at scale, which
 * is why it reproduces the pre-team wheel exactly - six seats over six
 * sides still land on 0/60/120/180/240/300.
 */
type ColorTeamLayout = {
  sideIndexByPlayer: Map<PlayerId, number>;
  seatIndexByPlayer: Map<PlayerId, number>;
  seatCountByPlayer: Map<PlayerId, number>;
  sideCount: number;
};

let _playerCountForColors = 6;
let _colorTeamLayout: ColorTeamLayout | null = null;

/** Legacy entry point: N seats, each its own side (free-for-all). */
export function setPlayerCountForColors(count: number): void {
  const next = Math.max(1, Math.floor(count));
  if (_colorTeamLayout === null && _playerCountForColors === next) return;
  _playerCountForColors = next;
  _colorTeamLayout = null;
  _playerColorCache.clear();
}

/**
 * Install the match's real sides so team hues divide the wheel and player
 * hues divide their own team's slice. `playersBySide` is one entry per
 * side, each listing that side's seats in roster order.
 *
 * Presentation only - colors never enter the simulation hash. Every client
 * must still derive from the SAME roster so a unit is the same color on
 * every screen, which is why this takes the roster's own grouping rather
 * than re-deriving one.
 */
export function setTeamLayoutForColors(
  playersBySide: readonly (readonly PlayerId[])[],
): void {
  const sides = playersBySide.filter((side) => side.length > 0);
  if (sides.length === 0) {
    _colorTeamLayout = null;
    _playerColorCache.clear();
    return;
  }
  const sideIndexByPlayer = new Map<PlayerId, number>();
  const seatIndexByPlayer = new Map<PlayerId, number>();
  const seatCountByPlayer = new Map<PlayerId, number>();
  let total = 0;
  for (let side = 0; side < sides.length; side++) {
    const seats = sides[side];
    for (let seat = 0; seat < seats.length; seat++) {
      sideIndexByPlayer.set(seats[seat], side);
      seatIndexByPlayer.set(seats[seat], seat);
      seatCountByPlayer.set(seats[seat], seats.length);
    }
    total += seats.length;
  }
  _colorTeamLayout = {
    sideIndexByPlayer,
    seatIndexByPlayer,
    seatCountByPlayer,
    sideCount: sides.length,
  };
  _playerCountForColors = Math.max(1, total);
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

/**
 * Resolve a seat's four identity colors plus its display name.
 *
 * Hue nests: the wheel splits by TEAM, and a team's slice splits by its
 * own player count (see ColorTeamLayout above). Every color uses OKLCH at
 * fixed L and C and varies only hue, so no seat is perceptually brighter
 * than another whichever slice it landed in.
 *
 * `primary` / `secondary` alias the PLAYER pair, which is what they always
 * were - in a free-for-all the player hue IS the team hue, so nothing
 * about the old wheel changes.
 */
export function getPlayerColors(playerId: PlayerId): PlayerColors {
  const slot = pidToSlot(playerId);
  let cached = _playerColorCache.get(slot);
  if (cached) return cached;

  const layout = _colorTeamLayout;
  let teamHue: number;
  let playerHue: number;
  if (layout !== null && layout.sideIndexByPlayer.has(slot)) {
    const sideCount = Math.max(1, layout.sideCount);
    const sideIndex = layout.sideIndexByPlayer.get(slot) as number;
    const seatIndex = layout.seatIndexByPlayer.get(slot) ?? 0;
    const seatCount = Math.max(1, layout.seatCountByPlayer.get(slot) ?? 1);
    // Team color is the MIDDLE of its wheel slice, so team 0 is red.
    const sliceWidth = 360 / sideCount;
    teamHue = sideIndex * sliceWidth;
    // Player color is the MIDDLE of its sub-slice of that team slice. A
    // lone seat lands back on the team hue, which is why single-player
    // teams come out with player == team for free.
    const subSlice = sliceWidth / seatCount;
    playerHue = teamHue - sliceWidth * 0.5 + (seatIndex + 0.5) * subSlice;
  } else {
    // No roster installed (lobby before assignment, tests, an out-of-range
    // pid): fall back to the flat per-seat wheel. Use the larger of
    // "configured count" and this slot so an unknown pid still gets a
    // valid hue instead of a divide-by-zero or a wrap.
    const total = Math.max(_playerCountForColors, slot);
    playerHue = ((slot - 1) / total) * 360;
    teamHue = playerHue;
  }

  const colorPlayerNormal =
    oklchToHex(PLAYER_PRIMARY_OKLCH_L, PLAYER_PRIMARY_OKLCH_C, playerHue);
  const colorPlayerDark =
    oklchToHex(PLAYER_SECONDARY_OKLCH_L, PLAYER_SECONDARY_OKLCH_C, playerHue);
  const colorTeamNormal =
    oklchToHex(PLAYER_PRIMARY_OKLCH_L, PLAYER_PRIMARY_OKLCH_C, teamHue);
  const colorTeamDark =
    oklchToHex(PLAYER_SECONDARY_OKLCH_L, PLAYER_SECONDARY_OKLCH_C, teamHue);
  cached = {
    primary: colorPlayerNormal,
    secondary: colorPlayerDark,
    colorPlayerNormal,
    colorPlayerDark,
    colorTeamNormal,
    colorTeamDark,
    name: hexToHashString(colorPlayerNormal),
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
export const NEUTRAL_PLAYER_COLOR = COLORS.units.neutral.colorHex;

/** Resolve a player's primary display color. Returns NEUTRAL_PLAYER_COLOR
 *  for undefined player IDs — the single canonical source of truth for
 *  this lookup, used by the sim, 2D renderer, 3D renderer, and UI. */
export function getPlayerPrimaryColor(playerId: PlayerId | undefined): number {
  if (playerId === undefined) return NEUTRAL_PLAYER_COLOR;
  return getPlayerColors(playerId).primary;
}

