type Destroyable = {
  destroy(): void;
};

type Disposable = {
  dispose(): void;
};

type Clearable = {
  clear(): void;
};

export type RtsScene3DRendererResources = {
  inputManager?: Destroyable | null;
  healthBar3D?: Destroyable | null;
  nameLabel3D?: Destroyable | null;
  waypoint3D?: Destroyable | null;
  lodShellGround3D?: Destroyable | null;
  lodGridCells2D?: Destroyable | null;
  entityRenderer?: Destroyable | null;
  metalDepositRenderer?: Disposable | null;
  environmentPropRenderer?: Destroyable | null;
  contactShadowRenderer?: Disposable | null;
  beamRenderer?: Destroyable | null;
  forceFieldRenderer?: Destroyable | null;
  captureTileRenderer?: Destroyable | null;
  waterRenderer?: Destroyable | null;
  explosionRenderer?: Destroyable | null;
  forceFieldImpactRenderer?: Destroyable | null;
  debrisRenderer?: Destroyable | null;
  burnMarkRenderer?: Destroyable | null;
  groundPrintRenderer?: Destroyable | null;
  lineDragRenderer?: Destroyable | null;
  pingRenderer?: Destroyable | null;
  buildGhostRenderer?: Destroyable | null;
  sprayRenderer?: Destroyable | null;
  smokeTrailRenderer?: Destroyable | null;
  fogOfWarShroudRenderer?: Destroyable | null;
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
  resources.lodShellGround3D?.destroy();
  resources.lodGridCells2D?.destroy();
  resources.entityRenderer?.destroy();
  resources.metalDepositRenderer?.dispose();
  resources.environmentPropRenderer?.destroy();
  resources.contactShadowRenderer?.dispose();
  resources.beamRenderer?.destroy();
  resources.forceFieldRenderer?.destroy();
  resources.captureTileRenderer?.destroy();
  resources.waterRenderer?.destroy();
  resources.explosionRenderer?.destroy();
  resources.forceFieldImpactRenderer?.destroy();
  resources.debrisRenderer?.destroy();
  resources.burnMarkRenderer?.destroy();
  resources.groundPrintRenderer?.destroy();
  resources.lineDragRenderer?.destroy();
  resources.pingRenderer?.destroy();
  resources.buildGhostRenderer?.destroy();
  resources.sprayRenderer?.destroy();
  resources.smokeTrailRenderer?.destroy();
  resources.fogOfWarShroudRenderer?.destroy();
  resources.longtaskTracker.destroy();
  resources.audioSystem.clear();
}
