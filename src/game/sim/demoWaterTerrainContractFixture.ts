import { getModeDefaultPreset, type BattlePreset } from '../../components/battlePresets';
import { DEMO_CONFIG } from '../../demoConfig';
import { getMetalDepositFlatZones } from './terrain/terrainFlatZones';
import { getAuthoritativeTerrainTileMap } from './terrain/terrainState';
import {
  getTerrainRuntimeConfig,
  getTerrainTeamCount,
  setAuthoritativeTerrainTileMap,
  setMetalDepositFlatZones,
  setTerrainRuntimeConfig,
  setTerrainTeamCount,
} from './Terrain';
import { getLiquidSurfaceMode, setLiquidSurfaceMode } from './worldSurfaceState';

/** A deep enough perimeter ocean that every seat has an offshore band. */
export const CONTRACT_WATER_PERIMETER_MAGNITUDE = -800;

/** Install the mode-default DEMO world with a guaranteed water perimeter —
 *  the shared fixture for contracts that assert offshore/base placement on
 *  the map the demo actually boots.
 *
 *  Procedural test fixtures must not inherit the live/background battle's
 *  installed terrain mesh or divider count: an authoritative tile map wins
 *  over runtime magnitudes, which otherwise makes a contract depend on
 *  whichever map-oriented test happened to run immediately before it.
 *  Deposit pads are another process-wide layer of terrain truth — the
 *  lobby's long-running background battle may have installed pads for a
 *  different map by the time a late contract starts, and those pads must
 *  not flatten the procedural water search the fixtures rely on.
 *
 *  The perimeter is forced wet (see the constant above) so the offshore
 *  assertions exercise the authored layout even if the current demo preset
 *  has deliberately selected a dry perimeter. Call `restore` in a
 *  `finally` to put every captured layer back. */
export function installDemoWaterTerrainFixture(): {
  preset: BattlePreset;
  restore: () => void;
} {
  const preset = getModeDefaultPreset('demo');
  const previousRuntimeConfig = getTerrainRuntimeConfig();
  const previousTeamCount = getTerrainTeamCount();
  const previousTerrain = getAuthoritativeTerrainTileMap();
  const previousLiquidSurfaceMode = getLiquidSurfaceMode();
  const previousMetalDepositFlatZones = getMetalDepositFlatZones();
  setAuthoritativeTerrainTileMap(null);
  setMetalDepositFlatZones([], false);
  setTerrainTeamCount(DEMO_CONFIG.allyTeamSeats.length);
  setLiquidSurfaceMode(preset.liquidSurfaceMode);
  setTerrainRuntimeConfig({
    centerMagnitude: preset.centerMagnitude,
    ringMagnitude: preset.ringMagnitude,
    dividersMagnitude: preset.dividersMagnitude,
    perimeterMagnitude: CONTRACT_WATER_PERIMETER_MAGNITUDE,
    terrainPrecedence: preset.terrainPrecedence,
    terrainDTerrain: preset.terrainDTerrain,
    plateauWallSlopeDegrees: preset.plateauWallSlopeDegrees,
    metalDepositStep: preset.metalDepositStep,
    terrainDetail: preset.terrainDetail,
  });
  return {
    preset,
    restore: () => {
      setMetalDepositFlatZones(previousMetalDepositFlatZones, false);
      setTerrainRuntimeConfig(previousRuntimeConfig);
      setTerrainTeamCount(previousTeamCount);
      setAuthoritativeTerrainTileMap(previousTerrain);
      setLiquidSurfaceMode(previousLiquidSurfaceMode);
    },
  };
}
