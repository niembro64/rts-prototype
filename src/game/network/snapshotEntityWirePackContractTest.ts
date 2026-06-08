import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
} from './NetworkTypes';
import { roundTripEntitiesThroughWire } from './snapshotEntityWirePack';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[snapshot entity wire pack contract] ${message}`);
  }
}

export function runSnapshotEntityWirePackContractTest(): void {
  const factoryEntity: NetworkServerSnapshotEntity = {
    id: 101,
    type: 'building',
    pos: { x: 10, y: 20, z: 0 },
    rotation: 0,
    playerId: 1,
    changedFields: null,
    unit: null,
    building: {
      buildingBlueprintCode: null,
      dim: null,
      hp: null,
      build: null,
      metalExtractionRate: null,
      solar: null,
      turrets: null,
      factory: {
        selectedUnitBlueprintCode: null,
        progress: 0.25,
        producing: true,
        energyRate: 0.75,
        metalRate: 0.5,
        guardTargetId: null,
        rally: { pos: { x: 100, y: 120 }, posZ: null, type: 'fight' },
        route: [
          { pos: { x: 100, y: 120 }, posZ: null, type: 'fight' },
          { pos: { x: 160, y: 220 }, posZ: 32, type: 'patrol' },
        ],
      },
    },
  };
  const snapshot: NetworkServerSnapshot = {
    tick: 1,
    entities: [factoryEntity],
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    shroud: undefined,
    projectiles: undefined,
    gameState: undefined,
    serverMeta: undefined,
    grid: undefined,
    terrain: undefined,
    buildability: undefined,
    isDelta: false,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: undefined,
  };

  const [decoded] = roundTripEntitiesThroughWire(snapshot);
  const decodedRoute = decoded?.building?.factory?.route ?? null;
  if (decodedRoute === null) {
    throw new Error(
      '[snapshot entity wire pack contract] factory route must survive compact entity wire round trip',
    );
  }
  assertContract(decodedRoute.length === 2, 'factory route waypoint count must survive');
  assertContract(decodedRoute[0].type === 'fight', 'factory route first waypoint type must survive');
  assertContract(decodedRoute[1].type === 'patrol', 'factory route second waypoint type must survive');
  assertContract(decodedRoute[1].pos.x === 160, 'factory route waypoint x must survive');
  assertContract(decodedRoute[1].posZ === 32, 'factory route waypoint z must survive');
}
