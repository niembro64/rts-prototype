import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { ClientViewState } from '../network/ClientViewState';
import { applyBuildingBlueprintRuntime } from '../sim/buildingEntityRuntime';
import { getBuildingConfig } from '../sim/buildConfigs';
import { TURRET_BLUEPRINTS } from '../sim/blueprints';
import { WATER_LEVEL } from '../sim/Terrain';
import type { Entity } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import {
  buildSensorSignatureRig3D,
  disposeSensorSignatureRig3DResources,
  syncSensorSignatureRig3D,
} from './SensorSignatureRig3D';
import type { EntityMesh } from './EntityMesh3D';
import { OverlayLineSystem } from './OverlayLineSystem';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[sensor signature contract] ${message}`);
}

function completedBuilding(
  world: WorldState,
  blueprintId: 'buildingRadar' | 'buildingRadarJammer' | 'towerTorpedo',
  z: number,
): Entity {
  const config = getBuildingConfig(blueprintId);
  const entity = world.createBuilding(
    300,
    300,
    config.gridWidth * 20,
    config.gridHeight * 20,
    config.gridDepth * 20,
    1,
  );
  applyBuildingBlueprintRuntime(entity, blueprintId);
  assertContract(entity.building !== null, `${blueprintId} needs a building component`);
  entity.buildable = null;
  entity.building.hp = config.hp;
  entity.building.maxHp = config.hp;
  if (entity.building.activeState !== null) {
    entity.building.activeState.open = true;
    entity.building.activeState.wantOpen = true;
  }
  entity.transform.z = z;
  return entity;
}

function overlayMesh(entity: Entity): EntityMesh {
  return {
    group: new THREE.Group(),
    turrets: [],
    bodyShapeKey: '',
    geometryKey: `sensor-contract-${entity.id}`,
  } as unknown as EntityMesh;
}

export function runSensorSignatureRig3DContractTest(): void {
  const commanderSensors =
    TURRET_BLUEPRINTS.turretSensorUnitCommander.targeting.observation.sensors;
  assertContract(
    commanderSensors.radarRadius === 800 && commanderSensors.jammingRadius === 0,
    'the commander must carry small radar and no jamming capability',
  );
  assertContract(
    COLORS.effects.sensorSignature.radarPulse.colorHex === 0x50ff78 &&
      COLORS.effects.sensorSignature.jammerPulse.colorHex === 0xff3b32,
    'shared contact hardware must pulse green and every jammer must pulse red',
  );

  const world = new WorldState(7418, 1024, 1024);
  const commander = world.createUnitFromBlueprint(200, 200, 1, 'unitCommander');
  commander.transform.z = WATER_LEVEL + 100;
  const radarRig = buildSensorSignatureRig3D(commander, {
    hostRadius: commander.unit!.radius.other,
    mountY: 30,
  });
  assertContract(
    radarRig !== undefined &&
      radarRig.channels.length === 1 &&
      radarRig.channels[0] === 'radar' &&
      radarRig.radarHardware !== null &&
      radarRig.radarPulses !== null &&
      radarRig.jammerHardware === null &&
      radarRig.jammerPulses === null,
    'a radar-only mobile host must carry the shared dish and green pulse only',
  );

  const duck = world.createUnitFromBlueprint(240, 200, 1, 'unitDuck');
  duck.transform.z = WATER_LEVEL + 20;
  const mixedRig = buildSensorSignatureRig3D(duck, {
    hostRadius: duck.unit!.radius.other,
    mountY: 20,
  });
  assertContract(
    mixedRig !== undefined &&
      mixedRig.channels.includes('radar') &&
      mixedRig.channels.includes('jamming') &&
      mixedRig.radarHardware !== null &&
      mixedRig.jammerHardware !== null &&
      mixedRig.radarPulses !== null &&
      mixedRig.jammerPulses !== null,
    'a mixed radar/jammer host must expose both common hardware languages',
  );

  const radarBuilding = completedBuilding(
    world,
    'buildingRadar',
    WATER_LEVEL + 100,
  );
  const dedicatedRig = buildSensorSignatureRig3D(radarBuilding, {
    hostRadius: 50,
    mountY: 80,
    includeHardware: false,
  });
  assertContract(
    dedicatedRig !== undefined &&
      dedicatedRig.radarHardware === null &&
      dedicatedRig.radarPulses !== null,
    'a dedicated radar building must keep its bespoke dish and gain the common pulse without duplicate hardware',
  );
  assertContract(dedicatedRig.radarPulses.visible, 'an open completed radar must pulse');
  assertContract(
    radarBuilding.building?.activeState !== null &&
      radarBuilding.building?.activeState !== undefined,
    'the radar building must expose its powered state',
  );
  radarBuilding.building!.activeState!.open = false;
  syncSensorSignatureRig3D(dedicatedRig, radarBuilding);
  assertContract(
    !dedicatedRig.radarPulses.visible,
    'closing powered radar must stop its pulse while retaining its authored hardware',
  );

  const torpedoTower = completedBuilding(
    world,
    'towerTorpedo',
    WATER_LEVEL - 100,
  );
  const sonarRig = buildSensorSignatureRig3D(torpedoTower, {
    hostRadius: 40,
    mountY: 30,
  });
  assertContract(
    sonarRig !== undefined &&
      sonarRig.channels.includes('sonar') &&
      sonarRig.radarHardware?.userData.sensorSignatureHardware === 'sonar',
    'every incidental sonar producer, including Torpedo Tower, must gain the shared downward dish',
  );

  const jammer = completedBuilding(
    world,
    'buildingRadarJammer',
    WATER_LEVEL + 100,
  );
  const selectedIds = new Set<number>();
  const overlayLines = new OverlayLineSystem();
  const sphereSource = createPrimitiveSphereGeometry('debug', 'close');
  const sphereWireframe = new THREE.WireframeGeometry(sphereSource);
  const overlayRenderer = new SelectionOverlayRenderer3D({
    world: new THREE.Group(),
    clientViewState: {
      getMapWidth: () => 1024,
      getMapHeight: () => 1024,
      getSelectedIds: () => selectedIds,
    } as unknown as ClientViewState,
    radiusSphereGeom: sphereWireframe,
    overlayLines,
  });
  const commanderMesh = overlayMesh(commander);
  const jammerMesh = overlayMesh(jammer);
  try {
    overlayRenderer.beginFrame({ hoveredEntityId: commander.id });
    overlayRenderer.updateRangeRings(commanderMesh, commander);
    assertContract(
      commanderMesh.radarRing !== undefined && commanderMesh.jammerRing === undefined,
      'hovering radar capability must show its radar reach and no jammer reach',
    );
    overlayRenderer.beginFrame({ hoveredEntityId: jammer.id });
    overlayRenderer.updateRangeRings(commanderMesh, commander);
    overlayRenderer.updateRangeRings(jammerMesh, jammer);
    assertContract(
      jammerMesh.jammerRing !== undefined && jammerMesh.radarRing === undefined,
      'hovering jamming capability must show its independent denial reach',
    );
  } finally {
    overlayRenderer.removeWorldParentedOverlays(commanderMesh);
    overlayRenderer.removeWorldParentedOverlays(jammerMesh);
    overlayRenderer.dispose();
    overlayLines.dispose();
    sphereWireframe.dispose();
    sphereSource.dispose();
    disposeSensorSignatureRig3DResources();
  }
}
