import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getSnappedBuildPosition } from '../input/helpers';
import { BuildGhost3D, resolveBuildAbilitySquarePose } from './BuildGhost3D';
import { OverlayLineSystem } from './OverlayLineSystem';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[build ghost contract] ${message}`);
  }
}

export function runBuildGhost3DContractTest(): void {
  const terrainPose = resolveBuildAbilitySquarePose({
    x: 100,
    y: 200,
  }, 20);
  // A submerged square is still based on the terrain-bed height supplied by
  // the caller; it must never be promoted to the water plane or a prop top.
  const seabedPose = resolveBuildAbilitySquarePose({
    x: 100,
    y: 200,
  }, -80);

  assertContract(terrainPose.fillY > 20, 'terrain squares should sit above terrain');
  assertContract(terrainPose.borderY > terrainPose.fillY, 'terrain borders should sit above fills');
  assertContract(
    Math.abs((seabedPose.fillY + 80) - (terrainPose.fillY - 20)) < 1e-6,
    'seabed and dry-terrain squares must use the same terrain-relative lift',
  );
  assertContract(seabedPose.fillY < 0, 'submerged build squares must remain on the seabed');
  assertContract(seabedPose.borderY > seabedPose.fillY, 'seabed borders should sit above fills');

  // BAR-style placement keeps a retained translucent copy of the canonical
  // building model on the same snapped center as the diagnostic squares.
  const world = new THREE.Group();
  const overlays = new OverlayLineSystem();
  const ghost = new BuildGhost3D(world, overlays, () => 12, () => 40);
  const blueprintId = 'buildingAircraftFabricator';
  const config = getBuildingConfig(blueprintId);
  const pointer = { x: 723, y: 817 };
  ghost.setTarget(blueprintId, pointer.x, pointer.y, null, true, undefined, 0);
  const model = world.getObjectByName('build-ghost-building-model') as THREE.Group | undefined;
  const primary = world.getObjectByName('build-ghost-building-primary') as THREE.Mesh | undefined;
  const snapped = getSnappedBuildPosition(pointer.x, pointer.y, blueprintId, 0);
  assertContract(model !== undefined, 'active build mode must draw the selected building model');
  assertContract(primary !== undefined, 'building ghost must include its canonical primary body');
  assertContract(
    model.position.x === snapped.x && model.position.z === snapped.y,
    'building model and diagnostic grid must share one snapped center',
  );
  assertContract(
    model.position.y === 40,
    'hovering building model must use the highest placement-surface sample',
  );
  assertContract(
    model.userData.localWidth === config.gridWidth * BUILD_GRID_CELL_SIZE &&
      model.userData.localDepth === config.gridHeight * BUILD_GRID_CELL_SIZE,
    'building model must retain its authored, unrotated footprint dimensions',
  );
  const initialYaw = model.rotation.y;

  ghost.setTarget(blueprintId, pointer.x, pointer.y, null, true, undefined, Math.PI / 2);
  const rotatedModel = world.getObjectByName('build-ghost-building-model') as THREE.Group | undefined;
  const rotatedSnap = getSnappedBuildPosition(pointer.x, pointer.y, blueprintId, Math.PI / 2);
  assertContract(rotatedModel === model, 'facing changes must transform the retained model in place');
  assertContract(
    Math.abs((rotatedModel.rotation.y - initialYaw) + Math.PI / 2) < 1e-9,
    'clockwise build facing must rotate the building ghost by one quarter turn',
  );
  assertContract(
    rotatedModel.position.x === rotatedSnap.x && rotatedModel.position.z === rotatedSnap.y,
    'rotated ghost must re-snap with the rotated footprint parity',
  );

  ghost.setTarget(blueprintId, pointer.x, pointer.y, null, false, undefined, Math.PI / 2);
  const coloredMesh = rotatedModel.getObjectByProperty('type', 'Mesh') as THREE.Mesh | undefined;
  const material = coloredMesh?.material as THREE.MeshBasicMaterial | undefined;
  assertContract(
    material?.color.getHex() === COLORS.effects.buildGhost.footprintBad.colorHex,
    'blocked placement must tint the complete building ghost red',
  );

  ghost.setTarget('towerCannon', pointer.x, pointer.y, null, true, undefined, 0);
  const towerModel = world.getObjectByName('build-ghost-building-model') as THREE.Group | undefined;
  assertContract(towerModel !== model, 'changing blueprint must replace the retained model');
  assertContract(
    Number(towerModel?.userData.turretCount ?? 0) > 0,
    'armed building ghosts must include their canonical turret assembly',
  );

  ghost.destroy();
  overlays.dispose();
  assertContract(
    world.getObjectByName('build-ghost-building-model') === undefined,
    'destroy must detach the retained building ghost',
  );
}
