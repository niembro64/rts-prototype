// "Is there water on this map?" — one derived answer, asked everywhere.
//
// Water is never DECLARED. There is no `hasWater` flag on the world, on a
// preset, on a blueprint, or in a save. Water is a CONSEQUENCE of the map's
// authored setup, so every consumer re-derives it here instead of reading a
// stored boolean that some other code path forgot to update. When the rule for
// what makes a sea changes, it changes in this one function and the roster, the
// demo layout, and the lobby readout all move with it.
//
// Two authored facts decide it, and both must hold:
//
//   1. The terrain has to dig below datum. The four signed BATTLE-bar
//      magnitudes — CENTER, RING, DIVIDERS, PERIMETER — are the entire shape of
//      the generated surface (see terrainConfig.json's pipeline). If none of
//      them is negative, nothing is excavated, the surface never descends past
//      ground level, and the sea floor is never reached.
//   2. The liquid filling those basins has to be water. LIQUID = LAVA pours
//      molten rock into the exact same excavation. It is a surface a torpedo
//      cannot swim through and a sonar cannot listen through, so for every
//      question this module answers it is not water.
//
// Deliberately a question about the map's SETUP, not about the baked mesh. The
// answer has to exist in the lobby, before any terrain is generated, so the
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

/** Everything the water question consumes. Exactly the authored map settings —
 *  no derived heights, no baked mesh, nothing that only exists mid-battle. */
export type MapWaterSetup = {
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

/** THE rule, stated once over plain numbers. Both public forms below are just
 *  two ways of supplying its arguments — neither restates it. */
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

/** Is there water on the map this setup describes?
 *
 *  The explicit-argument form. Callers holding the settings directly — the
 *  lobby, editing a map nothing has generated yet — ask through this one so
 *  they get the same answer the running battle will. */
export function mapHasWaterForSetup(setup: MapWaterSetup): boolean {
  return liquidBelowDatumIsWater(
    setup.centerMagnitude,
    setup.ringMagnitude,
    setup.dividersMagnitude,
    setup.perimeterMagnitude,
    setup.liquidSurfaceMode,
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
