// "Is there water on this map? Is there land?" — two derived answers, asked
// everywhere.
//
// Neither is ever DECLARED. There is no `hasWater` or `hasLand` flag on the
// world, on a preset, on a blueprint, or in a save. Both are CONSEQUENCES of
// the map's authored setup, so every consumer re-derives them here instead of
// reading a stored boolean some other code path forgot to update. When the
// rule for what makes a sea — or what counts as dry ground — changes, it
// changes in this one module and the roster, the demo layout, and the lobby
// readout all move with it.
//
// THE WATER QUESTION — two authored facts decide it, and both must hold:
//
//   1. The terrain has to dig below datum. The four signed BATTLE-bar
//      magnitudes — CENTER, RING, DIVIDERS, PERIMETER — are the entire shape of
//      the generated surface (see terrainConfig.json's pipeline). If none of
//      them is negative, nothing is excavated, the surface never descends past
//      ground level, and the sea floor is never reached.
//   2. The liquid filling those basins has to be water. LIQUID = LAVA pours
//      molten rock into the exact same excavation; LIQUID = NONE exposes the
//      basin floor. Neither is water a torpedo can swim through or sonar can
//      listen through.
//
// THE LAND QUESTION is the mirror, minus the liquid — and under the current
// generation pipeline its answer is ALWAYS yes. The four bars shape features
// on top of a baseline surface that sits at the datum, and even when every
// bar digs, the ground between the basins (and the hand-off annulus around
// each) stays at ground level. A tank always has somewhere to stand, so no
// authored setup may ever strip the ground roster. (An earlier rule declared
// "all four bars negative = landless", which wrongly emptied fabricator
// build lists on dug-everywhere maps that are mostly dry ground.) If an
// all-sea map ever becomes authorable — a flood control, a true ocean
// preset — this function is the one place that decides what landless means.
//
// Deliberately questions about the map's SETUP, not about the baked mesh. The
// answers have to exist in the lobby, before any terrain is generated, so the
// roster and the lobby readout can settle before the battle is built.
//
// The excavation test is `< 0`, not `< WATER_LEVEL`. The waterline sits well
// below datum (floorY * (1 - levelFraction)), so a magnitude between the two
// digs a hollow that never floods — a possibility no authored bar option
// currently reaches, since the shallowest negative rung is far below the
// waterline. Tighten the comparison here if a shallower rung is ever authored;
// nothing else needs to know.

import { getLiquidSurfaceMode } from './worldSurfaceState';
import {
  TERRAIN_CENTER_MAGNITUDE,
  TERRAIN_DIVIDERS_MAGNITUDE,
  TERRAIN_PERIMETER_MAGNITUDE,
  TERRAIN_RING_MAGNITUDE,
} from './terrain/terrainConfig';
import type { LiquidSurfaceMode } from '../../types/worldSurfaceMode';

/** Everything the surface questions consume. Exactly the authored map
 *  settings — no derived heights, no baked mesh, nothing that only exists
 *  mid-battle. */
export type MapSurfaceSetup = {
  /** Signed CENTER dome/dish altitude at the exact map centre. */
  readonly centerMagnitude: number;
  /** Signed RING annulus crest altitude. */
  readonly ringMagnitude: number;
  /** Signed team-divider ridge altitude. */
  readonly dividersMagnitude: number;
  /** Signed map-perimeter ring altitude. */
  readonly perimeterMagnitude: number;
  /** What fills the map below the liquid level. */
  readonly liquidSurfaceMode: LiquidSurfaceMode;
};

/** THE water rule, stated once over plain numbers. Both public forms below
 *  are just two ways of supplying its arguments — neither restates it. */
function liquidBelowDatumIsWater(
  centerMagnitude: number,
  ringMagnitude: number,
  dividersMagnitude: number,
  perimeterMagnitude: number,
  liquidSurfaceMode: LiquidSurfaceMode,
): boolean {
  if (liquidSurfaceMode !== 'water') return false;
  return (
    centerMagnitude < 0 ||
    ringMagnitude < 0 ||
    dividersMagnitude < 0 ||
    perimeterMagnitude < 0
  );
}

/** THE land rule: the generation pipeline's baseline surface sits at the
 *  datum, so standing ground survives every authored bar combination — the
 *  bars carve features INTO ground level, they cannot flood the whole map.
 *  The liquid is irrelevant — lava fills basins, while NONE exposes their
 *  floors, and neither removes the plateaus. The unused magnitude parameters
 *  keep the seam: an authorable all-sea map would decide its answer from
 *  them, right here. */
function baselineLeavesStandingGround(
  _centerMagnitude: number,
  _ringMagnitude: number,
  _dividersMagnitude: number,
  _perimeterMagnitude: number,
): boolean {
  return true;
}

/** Is there water on the map this setup describes?
 *
 *  The explicit-argument form. Callers holding the settings directly — the
 *  lobby, editing a map nothing has generated yet — ask through this one so
 *  they get the same answer the running battle will. */
export function mapHasWaterForSetup(setup: MapSurfaceSetup): boolean {
  return liquidBelowDatumIsWater(
    setup.centerMagnitude,
    setup.ringMagnitude,
    setup.dividersMagnitude,
    setup.perimeterMagnitude,
    setup.liquidSurfaceMode,
  );
}

/** Is there dry ground on the map this setup describes? */
export function mapHasLandForSetup(setup: MapSurfaceSetup): boolean {
  return baselineLeavesStandingGround(
    setup.centerMagnitude,
    setup.ringMagnitude,
    setup.dividersMagnitude,
    setup.perimeterMagnitude,
  );
}

/** Is there water on the map that is installed right now?
 *
 *  Reads the live terrain magnitudes and liquid mode, which the server and every
 *  client install from the same lobby settings before a battle is built, so
 *  every peer derives the same answer on the same tick. Allocation-free: the
 *  magnitudes are live module bindings, not a freshly built config object. */
export function mapHasWater(): boolean {
  return liquidBelowDatumIsWater(
    TERRAIN_CENTER_MAGNITUDE,
    TERRAIN_RING_MAGNITUDE,
    TERRAIN_DIVIDERS_MAGNITUDE,
    TERRAIN_PERIMETER_MAGNITUDE,
    getLiquidSurfaceMode(),
  );
}

/** Is there dry ground on the map that is installed right now? */
export function mapHasLand(): boolean {
  return baselineLeavesStandingGround(
    TERRAIN_CENTER_MAGNITUDE,
    TERRAIN_RING_MAGNITUDE,
    TERRAIN_DIVIDERS_MAGNITUDE,
    TERRAIN_PERIMETER_MAGNITUDE,
  );
}

/** The two answers packed as a 2-bit key — bit 0 water, bit 1 land — so
 *  per-blueprint roster caches can hold one narrowed variant per map kind
 *  without allocating a mediums object on hot paths. */
export const MEDIUM_KEY_WATER = 1;
export const MEDIUM_KEY_LAND = 2;
export const MEDIUM_KEY_BOTH = MEDIUM_KEY_WATER | MEDIUM_KEY_LAND;

export function installedMapMediumKey(): number {
  return (mapHasWater() ? MEDIUM_KEY_WATER : 0) | (mapHasLand() ? MEDIUM_KEY_LAND : 0);
}

export function mapMediumKeyForSetup(setup: MapSurfaceSetup): number {
  return (
    (mapHasWaterForSetup(setup) ? MEDIUM_KEY_WATER : 0) |
    (mapHasLandForSetup(setup) ? MEDIUM_KEY_LAND : 0)
  );
}
