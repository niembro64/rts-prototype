import * as THREE from 'three';

/**
 * Buildings do not wear the unit rail-and-rib kit. Each structure authors
 * team-coloured geometry that belongs to its own machine: petal inlays on a
 * collector, clamps on a fabricator, a dish rim on radar, and so on.
 *
 * The tag is intentionally semantic rather than material-based. Materials
 * change when a structure is captured, visibility changes with the Team Trim
 * toggle, and animated ornaments can be nested several levels below their
 * building-detail root. A stable tag lets the renderer find all of them after
 * the finished building assembly has been composed.
 */
export type BuildingTeamOrnamentKind =
  | 'solarPetalInlay'
  | 'windNacelleBand'
  | 'fabricatorClamps'
  | 'botFabricatorClamps'
  | 'vehicleFabricatorClamps'
  | 'aircraftFabricatorClamps'
  | 'navalFabricatorClamps'
  | 'advancedUniversalFabricatorClamps'
  | 'advancedBotFabricatorClamps'
  | 'advancedVehicleFabricatorClamps'
  | 'advancedAircraftFabricatorClamps'
  | 'advancedNavalFabricatorClamps'
  | 'extractorIntakeSeam'
  | 'extractorRotorPlate'
  | 'radarDishRim'
  | 'sonarBuoyCollar'
  | 'converterPylonBridge'
  | 'beamEmitterCrown'
  | 'beamPairedCrowns'
  | 'cannonYoke'
  | 'heliosYoke'
  | 'antiAirPedestalBrace'
  | 'interceptorGuidanceBrace'
  | 'tidalGeneratorBand'
  | 'torpedoWaterlineBand'
  | 'targetingSpireHalo'
  | 'shieldForgeCrest'
  | 'precisionGimbalRing'
  | 'radarJammerCoil'
  | 'sonarJammerBaffle'
  | 'metalStorageBrace'
  | 'energyStorageBusbar';

const BUILDING_TEAM_ORNAMENT_KIND = 'buildingTeamOrnamentKind';

export function markBuildingTeamOrnament<T extends THREE.Mesh>(
  mesh: T,
  kind: BuildingTeamOrnamentKind,
): T {
  mesh.userData[BUILDING_TEAM_ORNAMENT_KIND] = kind;
  return mesh;
}

export function buildingTeamOrnamentKind(
  object: THREE.Object3D,
): BuildingTeamOrnamentKind | null {
  const kind = object.userData[BUILDING_TEAM_ORNAMENT_KIND] as
    | BuildingTeamOrnamentKind
    | undefined;
  return kind ?? null;
}

/** Collect every authored ornament, including pieces nested under animation
 * roots such as wind rotors, extractor blades, and radar dishes. */
export function collectBuildingTeamOrnaments(root: THREE.Object3D): THREE.Mesh[] {
  const ornaments: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && buildingTeamOrnamentKind(object) !== null) {
      ornaments.push(object);
    }
  });
  return ornaments;
}
