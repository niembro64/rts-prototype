import type { ClientViewState } from '../../network/ClientViewState';
import { AreaDrag3D } from '../../render3d/AreaDrag3D';
import { BeamRenderer3D } from '../../render3d/BeamRenderer3D';
import { BuildGhost3D } from '../../render3d/BuildGhost3D';
import { BurnMark3D } from '../../render3d/BurnMark3D';
import { ContactShadowRenderer3D } from '../../render3d/ContactShadowRenderer3D';
import { CursorGround } from '../../render3d/CursorGround';
import { Debris3D } from '../../render3d/Debris3D';
import { EnvironmentPropRenderer3D } from '../../render3d/EnvironmentPropRenderer3D';
import { Explosion3D } from '../../render3d/Explosion3D';
import { FogOfWarFog3D } from '../../render3d/FogOfWarFog3D';
import { GroundPrint3D } from '../../render3d/GroundPrint3D';
import { LegInstancedRenderer } from '../../render3d/LegInstancedRenderer';
import { LineDrag3D } from '../../render3d/LineDrag3D';
import { getLocomotionSurfaceHeight } from '../../render3d/LocomotionTerrainSampler';
import { MetalDepositRenderer3D } from '../../render3d/MetalDepositRenderer3D';
import { PylonTubeFlowRenderer } from '../../render3d/PylonTubeFlowRenderer';
import { Render3DEntities } from '../../render3d/Render3DEntities';
import { ShieldImpactRenderer3D } from '../../render3d/ShieldImpactRenderer3D';
import { ShieldRenderer3D } from '../../render3d/ShieldRenderer3D';
import { SightBoundaryRenderer3D } from '../../render3d/SightBoundaryRenderer3D';
import { SmokeTrail3D } from '../../render3d/SmokeTrail3D';
import { SprayRenderer3D } from '../../render3d/SprayRenderer3D';
import { TerrainTileRenderer3D } from '../../render3d/TerrainTileRenderer3D';
import type { ThreeApp } from '../../render3d/ThreeApp';
import { WaterRenderer3D } from '../../render3d/WaterRenderer3D';
import { WaterSplash3D } from '../../render3d/WaterSplash3D';
import type { ViewportFootprint } from '../../ViewportFootprint';
import { LAND_CELL_SIZE } from '../../../config';
import type { MetalDeposit } from '../../../metalDepositConfig';
import {
  getSurfaceHeight,
  getTerrainMeshHeight,
} from '../../sim/Terrain';
import type { RtsScene3DCameraFramingSystem } from './RtsScene3DCameraFramingSystem';

type RtsScene3DRendererBootstrapOptions = {
  threeApp: ThreeApp;
  clientViewState: ClientViewState;
  renderScope: ViewportFootprint;
  cameraFramingSystem: RtsScene3DCameraFramingSystem;
  mapWidth: number;
  mapHeight: number;
  playerCount: number;
  metalDeposits: readonly MetalDeposit[];
};

type RtsScene3DRendererBootstrapResult = {
  entityRenderer: Render3DEntities;
  beamRenderer: BeamRenderer3D;
  shieldRenderer: ShieldRenderer3D;
  terrainTileRenderer: TerrainTileRenderer3D;
  metalDepositRenderer: MetalDepositRenderer3D;
  environmentPropRenderer: EnvironmentPropRenderer3D;
  contactShadowRenderer: ContactShadowRenderer3D;
  waterRenderer: WaterRenderer3D;
  cursorGround: CursorGround;
  explosionRenderer: Explosion3D;
  shieldImpactRenderer: ShieldImpactRenderer3D;
  waterSplashRenderer: WaterSplash3D;
  debrisRenderer: Debris3D;
  burnMarkRenderer: BurnMark3D;
  groundPrintRenderer: GroundPrint3D;
  areaDragRenderer: AreaDrag3D;
  lineDragRenderer: LineDrag3D;
  buildGhostRenderer: BuildGhost3D;
  sprayRenderer: SprayRenderer3D;
  pylonTubeFlowRenderer: PylonTubeFlowRenderer;
  smokeTrailRenderer: SmokeTrail3D;
  fogOfWarFogRenderer: FogOfWarFog3D;
  sightBoundaryRenderer: SightBoundaryRenderer3D;
  radarBoundaryRenderer: SightBoundaryRenderer3D;
};

export function bootstrapRtsScene3DRenderers(
  options: RtsScene3DRendererBootstrapOptions,
): RtsScene3DRendererBootstrapResult {
  const {
    threeApp,
    clientViewState,
    renderScope,
    cameraFramingSystem,
    mapWidth,
    mapHeight,
    playerCount,
    metalDeposits,
  } = options;

  const legInstancedRenderer = new LegInstancedRenderer(threeApp.world);
  const entityRenderer = new Render3DEntities(
    threeApp.world,
    clientViewState,
    renderScope,
    legInstancedRenderer,
    threeApp.camera,
    () => threeApp.renderer.domElement.clientHeight,
    metalDeposits,
    threeApp.renderer.domElement,
  );
  const beamRenderer = new BeamRenderer3D(threeApp.world, renderScope);
  const shieldRenderer = new ShieldRenderer3D(
    threeApp.world,
    renderScope,
    threeApp.camera,
    (eid) => entityRenderer.getUnitYawGroup(eid),
  );
  const terrainTileRenderer = new TerrainTileRenderer3D(
    threeApp.world,
    clientViewState,
    mapWidth,
    mapHeight,
    metalDeposits,
  );
  const metalDepositRenderer = new MetalDepositRenderer3D(
    threeApp.world,
    metalDeposits,
    terrainTileRenderer.getBuildGridOverlayUniforms(),
  );
  const environmentPropRenderer = new EnvironmentPropRenderer3D(
    threeApp.world,
    {
      mapWidth,
      mapHeight,
      playerCount,
      metalDeposits,
      renderScope,
      sampleTerrainHeight: (x, z) => getTerrainMeshHeight(x, z, mapWidth, mapHeight),
    },
  );
  const contactShadowRenderer = new ContactShadowRenderer3D(
    threeApp.world,
    mapWidth,
    mapHeight,
  );
  const waterRenderer = new WaterRenderer3D(
    threeApp.world,
    mapWidth,
    mapHeight,
  );
  const cursorGround = new CursorGround(
    threeApp.camera,
    threeApp.renderer.domElement,
    mapWidth,
    mapHeight,
    terrainTileRenderer.getMesh(),
  );
  threeApp.orbit.setCursorPicker((cx, cy, terrainMode) =>
    cursorGround.pickWorld(cx, cy, terrainMode)
  );
  threeApp.orbit.setTerrainSampler((x, z) =>
    getTerrainMeshHeight(x, z, mapWidth, mapHeight)
  );
  cameraFramingSystem.seedInitialCamera();

  const explosionRenderer = new Explosion3D(threeApp.world);
  const shieldImpactRenderer = new ShieldImpactRenderer3D(threeApp.world);
  const waterSplashRenderer = new WaterSplash3D(threeApp.world);
  const debrisRenderer = new Debris3D(
    threeApp.world,
    (x, z) => getTerrainMeshHeight(x, z, mapWidth, mapHeight),
  );
  const burnMarkRenderer = new BurnMark3D(
    threeApp.world,
    renderScope,
    (x, y) => getSurfaceHeight(x, y, mapWidth, mapHeight, LAND_CELL_SIZE),
  );
  const groundPrintRenderer = new GroundPrint3D(
    threeApp.world,
    renderScope,
    (x, z) => getLocomotionSurfaceHeight(x, z, mapWidth, mapHeight),
  );
  const areaDragRenderer = new AreaDrag3D(threeApp.world);
  const lineDragRenderer = new LineDrag3D(threeApp.world);
  const buildGhostRenderer = new BuildGhost3D(
    threeApp.world,
    (x, y) => getTerrainMeshHeight(x, y, mapWidth, mapHeight),
    metalDeposits,
  );
  const sprayRenderer = new SprayRenderer3D(threeApp.world);
  const pylonTubeFlowRenderer = new PylonTubeFlowRenderer(threeApp.world);
  const smokeTrailRenderer = new SmokeTrail3D(threeApp.world);
  const fogOfWarFogRenderer = new FogOfWarFog3D(
    threeApp.world,
    mapWidth,
    mapHeight,
  );
  const sightBoundaryRenderer = new SightBoundaryRenderer3D(
    threeApp.world,
    (x, y) => getTerrainMeshHeight(x, y, mapWidth, mapHeight),
  );
  const radarBoundaryRenderer = new SightBoundaryRenderer3D(
    threeApp.world,
    (x, y) => getTerrainMeshHeight(x, y, mapWidth, mapHeight),
    { mode: 'radar' },
  );

  return {
    entityRenderer,
    beamRenderer,
    shieldRenderer,
    terrainTileRenderer,
    metalDepositRenderer,
    environmentPropRenderer,
    contactShadowRenderer,
    waterRenderer,
    cursorGround,
    explosionRenderer,
    shieldImpactRenderer,
    waterSplashRenderer,
    debrisRenderer,
    burnMarkRenderer,
    groundPrintRenderer,
    areaDragRenderer,
    lineDragRenderer,
    buildGhostRenderer,
    sprayRenderer,
    pylonTubeFlowRenderer,
    smokeTrailRenderer,
    fogOfWarFogRenderer,
    sightBoundaryRenderer,
    radarBoundaryRenderer,
  };
}
