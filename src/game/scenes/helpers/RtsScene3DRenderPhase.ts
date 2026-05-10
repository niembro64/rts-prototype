import * as THREE from 'three';
import {
  getGridOverlay,
  getGridOverlayIntensity,
  getLodGridBorders,
  getLodShellRings,
} from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { SprayTarget } from '@/types/ui';
import type { ClientViewState } from '../../network/ClientViewState';
import type { Entity, PlayerId } from '../../sim/types';
import { getDefaultPlayerName } from '@/playerNamesConfig';
import type { ThreeApp } from '../../render3d/ThreeApp';
import type { Render3DEntities } from '../../render3d/Render3DEntities';
import type { Input3DManager } from '../../render3d/Input3DManager';
import type { BeamRenderer3D } from '../../render3d/BeamRenderer3D';
import type { ForceFieldRenderer3D } from '../../render3d/ForceFieldRenderer3D';
import type { CaptureTileRenderer3D } from '../../render3d/CaptureTileRenderer3D';
import type { MetalDepositRenderer3D } from '../../render3d/MetalDepositRenderer3D';
import type { EnvironmentPropRenderer3D } from '../../render3d/EnvironmentPropRenderer3D';
import type { WaterRenderer3D } from '../../render3d/WaterRenderer3D';
import type { Explosion3D } from '../../render3d/Explosion3D';
import type { ForceFieldImpactRenderer3D } from '../../render3d/ForceFieldImpactRenderer3D';
import type { Debris3D } from '../../render3d/Debris3D';
import type { BurnMark3D } from '../../render3d/BurnMark3D';
import type { GroundPrint3D } from '../../render3d/GroundPrint3D';
import type { LineDrag3D } from '../../render3d/LineDrag3D';
import type { SprayRenderer3D } from '../../render3d/SprayRenderer3D';
import type { SmokeTrail3D } from '../../render3d/SmokeTrail3D';
import type { ContactShadowRenderer3D } from '../../render3d/ContactShadowRenderer3D';
import type { HealthBar3D } from '../../render3d/HealthBar3D';
import type { NameLabel3D } from '../../render3d/NameLabel3D';
import type { Waypoint3D } from '../../render3d/Waypoint3D';
import { resolveEntityDisplayName } from '../../render3d/EntityName';
import type { LodGridCells2D } from '../../render3d/LodGridCells2D';
import type { LodShellGround3D } from '../../render3d/LodShellGround3D';
import type { Lod3DState } from '../../render3d/Lod3D';
import type { RenderLodGrid } from '../../render3d/RenderLodGrid';
import { getRenderObjectLodShellDistances } from '../../render3d/RenderObjectLod';
import type { FootprintQuad } from '../../ViewportFootprint';
import type { ViewportFootprint } from '../../ViewportFootprint';
import type { RtsScene3DCameraFootprintSystem } from './RtsScene3DCameraFootprintSystem';
import type { RtsScene3DSelectionSystem } from './RtsScene3DSelectionSystem';
import type { RtsScene3DSnapshotIntake } from './RtsScene3DSnapshotIntake';

export type RtsScene3DRenderPhaseResources = {
  entityRenderer: Render3DEntities;
  beamRenderer: BeamRenderer3D;
  forceFieldRenderer: ForceFieldRenderer3D;
  captureTileRenderer: CaptureTileRenderer3D;
  metalDepositRenderer: MetalDepositRenderer3D | null;
  environmentPropRenderer: EnvironmentPropRenderer3D | null;
  contactShadowRenderer: ContactShadowRenderer3D | null;
  waterRenderer: WaterRenderer3D;
  explosionRenderer: Explosion3D;
  forceFieldImpactRenderer: ForceFieldImpactRenderer3D;
  debrisRenderer: Debris3D;
  burnMarkRenderer: BurnMark3D;
  groundPrintRenderer: GroundPrint3D;
  lineDragRenderer: LineDrag3D;
  sprayRenderer: SprayRenderer3D;
  smokeTrailRenderer: SmokeTrail3D;
  healthBar3D: HealthBar3D | null;
  nameLabel3D: NameLabel3D | null;
  waypoint3D: Waypoint3D | null;
  lodShellGround3D: LodShellGround3D | null;
  lodGridCells2D: LodGridCells2D | null;
};

export type RtsScene3DRenderPhaseResult = {
  cameraQuad: FootprintQuad;
  renderMs: number;
};

export class RtsScene3DRenderPhase {
  private renderFrameIndex = 0;
  private lastEffectsTickMs = 0;
  private fireExplosionAccumMs = 0;
  private debrisAccumMs = 0;
  private burnMarkAccumMs = 0;
  private groundPrintAccumMs = 0;
  private smokeTrailAccumMs = 0;
  private sprayAccumMs = 0;
  private readonly combinedSprayTargets: SprayTarget[] = [];
  private readonly lineProjectilesScratch: Entity[] = [];
  private readonly burnMarkProjectilesScratch: Entity[] = [];
  private readonly smokeTrailProjectilesScratch: Entity[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private precompileFramesRemaining = 60;

  constructor(
    private readonly threeApp: ThreeApp,
    private readonly clientViewState: ClientViewState,
    private readonly renderScope: ViewportFootprint,
    private readonly cameraFootprintSystem: RtsScene3DCameraFootprintSystem,
    private readonly snapshotIntake: RtsScene3DSnapshotIntake,
    private readonly selectionSystem: RtsScene3DSelectionSystem,
    private readonly resources: RtsScene3DRenderPhaseResources,
    private readonly getInputManager: () => Input3DManager | null,
    private readonly lookupPlayerName: (id: PlayerId) => string | null,
    private readonly getCameraQuadUpdate: () => (((quad: FootprintQuad, cameraYaw: number) => void) | undefined),
  ) {}

  beginEnabledFrame(): void {
    this.resources.explosionRenderer.beginFrame();
    this.resources.debrisRenderer.beginFrame();
  }

  resetEffectAccumulators(): void {
    this.fireExplosionAccumMs = 0;
    this.debrisAccumMs = 0;
    this.burnMarkAccumMs = 0;
    this.groundPrintAccumMs = 0;
    this.smokeTrailAccumMs = 0;
    this.sprayAccumMs = 0;
  }

  beginRenderFrame(): { effectDtMs: number } {
    this.renderFrameIndex = (this.renderFrameIndex + 1) & 0x3fffffff;
    const effectNow = performance.now();
    const effectDtMs = this.lastEffectsTickMs === 0
      ? 0
      : Math.min(effectNow - this.lastEffectsTickMs, 100);
    this.lastEffectsTickMs = effectNow;
    return { effectDtMs };
  }

  run(options: {
    deltaMs: number;
    effectDtMs: number;
    graphicsConfig: GraphicsConfig;
    renderLod: Lod3DState;
    renderLodGrid: RenderLodGrid;
  }): RtsScene3DRenderPhaseResult {
    const { deltaMs, effectDtMs, graphicsConfig, renderLod, renderLodGrid } = options;
    const renderStart = performance.now();
    const {
      entityRenderer,
      beamRenderer,
      forceFieldRenderer,
      captureTileRenderer,
      metalDepositRenderer,
      environmentPropRenderer,
      contactShadowRenderer,
      waterRenderer,
      explosionRenderer,
      forceFieldImpactRenderer,
      debrisRenderer,
      burnMarkRenderer,
      groundPrintRenderer,
      lineDragRenderer,
      sprayRenderer,
      smokeTrailRenderer,
      healthBar3D,
      nameLabel3D,
      waypoint3D,
      lodShellGround3D,
      lodGridCells2D,
    } = this.resources;

    const lodShells = getRenderObjectLodShellDistances(graphicsConfig);
    lodShellGround3D?.update(
      this.threeApp.camera,
      [
        { tier: 'rich', distance: lodShells.rich },
        { tier: 'simple', distance: lodShells.simple },
        { tier: 'mass', distance: lodShells.mass },
        { tier: 'impostor', distance: lodShells.impostor },
      ],
      getLodShellRings(),
    );
    const gridMode = getGridOverlay();
    const gridOverlayIntensity = gridMode !== 'off' ? getGridOverlayIntensity() : 0;
    lodGridCells2D?.update(
      graphicsConfig.objectLodCellSize,
      getLodGridBorders(),
      gridMode !== 'off',
      gridOverlayIntensity,
    );
    metalDepositRenderer?.update(
      graphicsConfig,
      renderLod,
      renderLodGrid,
    );
    const hudFrameStride = Math.max(1, graphicsConfig.hudFrameStride | 0);
    const effectFrameStride = Math.max(1, graphicsConfig.effectFrameStride | 0);
    const updateHudThisFrame = hudFrameStride <= 1 || this.renderFrameIndex % hudFrameStride === 0;
    const updateEffectsThisFrame = effectFrameStride <= 1 || this.renderFrameIndex % effectFrameStride === 0;

    const cameraFootprint = this.cameraFootprintSystem.update(
      this.threeApp.camera,
      deltaMs,
    );
    const cameraQuad = cameraFootprint.quad;
    this.renderScope.setQuad(
      cameraQuad,
      cameraFootprint.bounds,
    );
    environmentPropRenderer?.update(
      graphicsConfig,
      renderLod,
      renderLodGrid,
    );
    this.getCameraQuadUpdate()?.(cameraQuad, this.threeApp.orbit.yaw);

    const serverMeta = this.clientViewState.getServerMeta();
    entityRenderer.update(
      renderLod,
      renderLodGrid,
      { mirrorsEnabled: serverMeta?.mirrorsEnabled ?? true },
    );
    contactShadowRenderer?.update(
      this.clientViewState.getUnits(),
      this.clientViewState.getBuildings(),
      graphicsConfig,
      this.renderFrameIndex,
      this.renderScope,
    );
    captureTileRenderer.update(
      graphicsConfig,
      renderLod,
      renderLodGrid,
    );
    this.snapshotIntake.markClientReadyAfterRender();

    const lineProjectiles = this.clientViewState.collectLineProjectiles(this.lineProjectilesScratch);
    const smokeTrailProjectiles = updateEffectsThisFrame
      ? this.clientViewState.collectSmokeTrailProjectiles(this.smokeTrailProjectilesScratch)
      : this.smokeTrailProjectilesScratch;
    beamRenderer.update(
      lineProjectiles,
      graphicsConfig,
      renderLod,
      renderLodGrid,
      this.clientViewState.getLineProjectileRenderVersion(),
    );

    waterRenderer.update(
      effectDtMs / 1000,
      graphicsConfig,
      renderLod,
      renderLodGrid,
    );
    this.fireExplosionAccumMs += effectDtMs;
    this.debrisAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      explosionRenderer.update(this.fireExplosionAccumMs);
      debrisRenderer.update(this.debrisAccumMs);
      this.fireExplosionAccumMs = 0;
      this.debrisAccumMs = 0;
    }
    forceFieldImpactRenderer.update(effectDtMs, lineProjectiles);
    this.burnMarkAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      const burnMarkProjectiles = this.clientViewState.collectBurnMarkProjectiles(this.burnMarkProjectilesScratch);
      burnMarkRenderer.update(burnMarkProjectiles, this.burnMarkAccumMs);
      this.burnMarkAccumMs = 0;
    }

    this.groundPrintAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      groundPrintRenderer.update(
        this.clientViewState.getUnits(),
        (e) => entityRenderer.getLocomotionMesh(e.id),
        this.groundPrintAccumMs,
      );
      this.groundPrintAccumMs = 0;
    }

    this.sprayAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      const commanderSprays = this.clientViewState.getSprayTargets();
      const factorySprays = entityRenderer.getFactorySprayTargets();
      if (factorySprays.length > 0) {
        this.combinedSprayTargets.length = 0;
        for (const spray of commanderSprays) this.combinedSprayTargets.push(spray);
        for (const spray of factorySprays) this.combinedSprayTargets.push(spray);
        sprayRenderer.update(this.combinedSprayTargets, this.sprayAccumMs);
      } else {
        sprayRenderer.update(commanderSprays, this.sprayAccumMs);
      }
      this.sprayAccumMs = 0;
    }

    this.smokeTrailAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      smokeTrailRenderer.update(
        smokeTrailProjectiles,
        this.smokeTrailAccumMs,
        this.renderFrameIndex,
        this.renderScope,
      );
      this.smokeTrailAccumMs = 0;
    }

    const inputManager = this.getInputManager();
    if (inputManager) {
      lineDragRenderer.update(inputManager.getLineDragState());
    }

    const cam = this.threeApp.camera;
    this.frustumMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    const hudFrustum = this.renderScope.getMode() === 'all' ? undefined : this.frustum;

    forceFieldRenderer.beginFrame(graphicsConfig);
    if (this.clientViewState.getServerMeta()?.forceFieldsEnabled ?? true) {
      for (const u of this.clientViewState.getForceFieldUnits()) {
        forceFieldRenderer.perUnit(u);
      }
    }
    forceFieldRenderer.endFrame();

    const hoveredEntity = inputManager?.getHoveredEntity() ?? null;
    if (healthBar3D) {
      healthBar3D.beginFrame(hudFrustum);
      const damagedUnits = this.clientViewState.getDamagedUnits();
      for (const u of damagedUnits) {
        healthBar3D.perUnit(u);
      }
      const healthBarBuildings = this.clientViewState.getHealthBarBuildings();
      for (const b of healthBarBuildings) {
        healthBar3D.perBuilding(b);
      }
      if (hoveredEntity?.unit) {
        healthBar3D.perUnit(hoveredEntity, true);
      } else if (hoveredEntity?.building) {
        healthBar3D.perBuilding(hoveredEntity, true);
      }
      healthBar3D.endFrame();
    }

    if (nameLabel3D) {
      nameLabel3D.beginFrame(hudFrustum);
      const lookup = (pid: PlayerId): string | null =>
        this.lookupPlayerName(pid) ?? getDefaultPlayerName(pid);
      for (const e of this.clientViewState.getUnitsAndBuildings()) {
        const name = resolveEntityDisplayName(e, lookup);
        if (name !== null) nameLabel3D.perEntity(e, name);
      }
      nameLabel3D.endFrame();
    }

    if (updateHudThisFrame) {
      waypoint3D?.update(
        this.selectionSystem.getSelectedUnits(),
        this.selectionSystem.getSelectedBuildings(),
      );
    }

    if (this.precompileFramesRemaining > 0) {
      this.threeApp.precompileShaders();
      this.precompileFramesRemaining--;
    }

    return {
      cameraQuad,
      renderMs: performance.now() - renderStart,
    };
  }
}
