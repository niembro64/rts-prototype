type Destroyable = {
  destroy(): void;
};

type Disposable = {
  dispose(): void;
};

type Clearable = {
  clear(): void;
};

type RtsScene3DRendererResources = {
  inputManager?: Destroyable | null;
  healthBar3D?: Destroyable | null;
  nameLabel3D?: Destroyable | null;
  waypoint3D?: Destroyable | null;
  entityRenderer?: Destroyable | null;
  environmentPropRenderer?: Destroyable | null;
  beamRenderer?: Destroyable | null;
  shieldRenderer?: Destroyable | null;
  terrainTileRenderer?: Destroyable | null;
  worldShade?: Destroyable | null;
  waterRenderer?: Destroyable | null;
  shieldImpactRenderer?: Destroyable | null;
  waterSplashRenderer?: Destroyable | null;
  burnMarkRenderer?: Destroyable | null;
  groundPrintRenderer?: Destroyable | null;
  areaDragRenderer?: Destroyable | null;
  airLiftProbeOverlay?: Destroyable | null;
  lineDragRenderer?: Destroyable | null;
  buildGhostRenderer?: Destroyable | null;
  sprayRenderer?: Destroyable | null;
  pylonTubeFlowRenderer?: Destroyable | null;
  smokeTrailRenderer?: Destroyable | null;
  windParticleFieldRenderer?: Destroyable | null;
  sightBoundaryRenderer?: Destroyable | null;
  radarBoundaryRenderer?: Destroyable | null;
  contactBlipRenderer?: Destroyable | null;
  overlayLineSystem?: Disposable | null;
  cursorGround?: Disposable | null;
  longtaskTracker: Destroyable;
  audioSystem: Clearable;
};

export function teardownRtsScene3DRenderers(
  resources: RtsScene3DRendererResources,
): void {
  resources.inputManager?.destroy();
  resources.healthBar3D?.destroy();
  resources.nameLabel3D?.destroy();
  resources.waypoint3D?.destroy();
  resources.entityRenderer?.destroy();
  resources.environmentPropRenderer?.destroy();
  resources.beamRenderer?.destroy();
  resources.shieldRenderer?.destroy();
  resources.terrainTileRenderer?.destroy();
  // WorldShade3D owns a full-screen WebGLRenderTarget shared by the terrain
  // and water renderers; the rematch path reuses the GL context, so it has
  // to be released here or every rematch leaks another target.
  resources.worldShade?.destroy();
  resources.waterRenderer?.destroy();
  resources.shieldImpactRenderer?.destroy();
  resources.waterSplashRenderer?.destroy();
  resources.burnMarkRenderer?.destroy();
  resources.groundPrintRenderer?.destroy();
  resources.areaDragRenderer?.destroy();
  resources.airLiftProbeOverlay?.destroy();
  resources.lineDragRenderer?.destroy();
  resources.buildGhostRenderer?.destroy();
  resources.sprayRenderer?.destroy();
  resources.pylonTubeFlowRenderer?.destroy();
  resources.smokeTrailRenderer?.destroy();
  resources.windParticleFieldRenderer?.destroy();
  resources.sightBoundaryRenderer?.destroy();
  resources.radarBoundaryRenderer?.destroy();
  resources.contactBlipRenderer?.destroy();
  // overlayLineSystem owns the single shared ScreenSpaceLineMaterial (GL
  // program); cursorGround retains a terrain mesh reference. Both are
  // per-scene and must be released on teardown — the rematch path reuses
  // the same ThreeApp/GL context without app.destroy().
  resources.overlayLineSystem?.dispose();
  resources.cursorGround?.dispose();
  resources.longtaskTracker.destroy();
  resources.audioSystem.clear();
}
