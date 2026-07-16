import { getAllUnitBlueprints, getUnitLocomotion } from './blueprints';
import { computeLocomotionClimbProfile } from './pathfindingMobility';

/** Derive every authored unit's immutable route-capability profile once after
 *  authoritative WASM is available. Later path queries are cache lookups. */
export function warmPathfindingMobilityCache(): void {
  for (const blueprint of getAllUnitBlueprints()) {
    computeLocomotionClimbProfile(
      getUnitLocomotion(blueprint.unitBlueprintId),
      blueprint.mass,
    );
  }
}
