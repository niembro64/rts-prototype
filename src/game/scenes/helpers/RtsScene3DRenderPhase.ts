import * as THREE from 'three';
import {
  getFogClouds,
  getFogShade,
  getMaterialExplosions,
  getRadarBoundary,
  getSightBoundary,
  getEntityHudToggle,
  getSelectionHudMode,
} from '@/clientBarConfig';
import type { SelectionHudMode } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { CameraViewBasis, SprayTarget } from '@/types/ui';
import type { ClientViewState } from '../../network/ClientViewState';
import type { ClientProjectileRenderLists } from '../../network/ClientProjectileStore';
import type { Entity, EntityId, PlayerId } from '../../sim/types';
import type { ThreeApp } from '../../render3d/ThreeApp';
import type { Render3DEntities } from '../../render3d/Render3DEntities';
import type { Input3DManager } from '../../render3d/Input3DManager';
import type { BeamRenderer3D } from '../../render3d/BeamRenderer3D';
import {
  ShieldRenderPacket3D,
  type ShieldRenderer3D,
} from '../../render3d/ShieldRenderer3D';
import type { TerrainTileRenderer3D } from '../../render3d/TerrainTileRenderer3D';
import type { BuildGhost3D } from '../../render3d/BuildGhost3D';
import type { MetalDepositRenderer3D } from '../../render3d/MetalDepositRenderer3D';
import type { EnvironmentPropRenderer3D } from '../../render3d/EnvironmentPropRenderer3D';
import type { WaterRenderer3D } from '../../render3d/WaterRenderer3D';
import type { Explosion3D } from '../../render3d/Explosion3D';
import type { ShieldImpactRenderer3D } from '../../render3d/ShieldImpactRenderer3D';
import type { WaterSplash3D } from '../../render3d/WaterSplash3D';
import type { Debris3D } from '../../render3d/Debris3D';
import type { BurnMark3D } from '../../render3d/BurnMark3D';
import {
  GroundPrintRenderPacket3D,
  type GroundPrint3D,
} from '../../render3d/GroundPrint3D';
import {
  BuildingRenderPacket3D,
  UnitRenderPacket3D,
} from '../../render3d/EntityRenderPackets3D';
import type { AreaDrag3D } from '../../render3d/AreaDrag3D';
import type { AirLiftProbeOverlay3D } from '../../render3d/AirLiftProbeOverlay3D';
import type { LineDrag3D } from '../../render3d/LineDrag3D';
import type { SprayRenderer3D } from '../../render3d/SprayRenderer3D';
import type { PylonTubeFlowRenderer } from '../../render3d/PylonTubeFlowRenderer';
import type { SmokeTrail3D } from '../../render3d/SmokeTrail3D';
import type { FogOfWarFog3D } from '../../render3d/FogOfWarFog3D';
import type { SightBoundaryRenderer3D } from '../../render3d/SightBoundaryRenderer3D';
import type { OverlayLineSystem } from '../../render3d/OverlayLineSystem';
import {
  ContactShadowRenderPacket3D,
  type ContactShadowRenderer3D,
} from '../../render3d/ContactShadowRenderer3D';
import {
  BodyHudRenderPacket3D,
  type HealthBar3D,
} from '../../render3d/HealthBar3D';
import {
  PieceNameRenderPacket3D,
  type NameLabel3D,
} from '../../render3d/NameLabel3D';
import { HudFade } from '../../render3d/HudFade';
import type { Waypoint3D } from '../../render3d/Waypoint3D';
import {
  resolveTurretName,
  resolveShotName,
} from '../../render3d/EntityName';
import {
  PIECE_TAG_BODY,
  turretPieceTag,
} from '../../render3d/HealthBar3D';
import {
  getTurretHudNameY,
  getShotHudNameY,
} from '../../render3d/HudAnchor';
import {
  ENTITY_HUD_FADE_START_DISTANCE_FRAC,
  ENTITY_HUD_FADE_END_DISTANCE_FRAC,
} from '@/config';
import type {
  RenderFrameState3D,
  RenderViewState3D,
} from '../../render3d/RenderFrameState3D';
import type { FootprintBounds, FootprintQuad, ViewportFootprint } from '../../ViewportFootprint';
import type { RtsScene3DCameraFootprintSystem } from './RtsScene3DCameraFootprintSystem';
import type { RtsScene3DSelectionSystem } from './RtsScene3DSelectionSystem';
import { EntityLodState3D } from '../../render3d/EntityLod3D';

type RtsScene3DRenderPhaseResources = {
  entityRenderer: Render3DEntities;
  beamRenderer: BeamRenderer3D;
  shieldRenderer: ShieldRenderer3D;
  terrainTileRenderer: TerrainTileRenderer3D;
  buildGhostRenderer: BuildGhost3D;
  metalDepositRenderer: MetalDepositRenderer3D | null;
  environmentPropRenderer: EnvironmentPropRenderer3D | null;
  contactShadowRenderer: ContactShadowRenderer3D | null;
  waterRenderer: WaterRenderer3D;
  explosionRenderer: Explosion3D;
  shieldImpactRenderer: ShieldImpactRenderer3D;
  waterSplashRenderer: WaterSplash3D;
  debrisRenderer: Debris3D;
  burnMarkRenderer: BurnMark3D;
  groundPrintRenderer: GroundPrint3D;
  areaDragRenderer: AreaDrag3D;
  airLiftProbeOverlay: AirLiftProbeOverlay3D;
  lineDragRenderer: LineDrag3D;
  sprayRenderer: SprayRenderer3D;
  pylonTubeFlowRenderer: PylonTubeFlowRenderer;
  smokeTrailRenderer: SmokeTrail3D;
  fogOfWarFogRenderer: FogOfWarFog3D;
  overlayLineSystem: OverlayLineSystem;
  sightBoundaryRenderer: SightBoundaryRenderer3D;
  radarBoundaryRenderer: SightBoundaryRenderer3D;
  healthBar3D: HealthBar3D | null;
  nameLabel3D: NameLabel3D | null;
  waypoint3D: Waypoint3D | null;
};

type RtsScene3DRenderPhaseResult = {
  cameraQuad: FootprintQuad;
  cameraView: CameraViewBasis;
  renderMs: number;
};

export type RtsScene3DRenderPhaseTimings = {
  scopeMs: number;
  projectileQueryMs: number;
  entityPacketMs: number;
  entityRendererMs: number;
  terrainMs: number;
  beamMs: number;
  effectsMs: number;
  hudMs: number;
  totalMs: number;
  unitRows: number;
  buildingRows: number;
  unitLodProxyRows: number;
  buildingLodProxyRows: number;
  projectileRows: number;
  lineProjectileRows: number;
};

type RenderPhaseEntityLists = {
  unitRows: UnitRenderPacket3D;
  buildingRows: BuildingRenderPacket3D;
  bodyHud: BodyHudRenderPacket3D;
  shields: ShieldRenderPacket3D;
  pieceNames: PieceNameRenderPacket3D;
  contactShadows: ContactShadowRenderPacket3D;
  groundPrints: GroundPrintRenderPacket3D;
};

type RenderPhaseEntityListOptions = {
  includeBodyHud: boolean;
  includeBodyNames: boolean;
  includeShields: boolean;
  includeContactShadows: boolean;
  includeGroundPrints: boolean;
  hoveredEntity: Entity | null;
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
  private readonly projectileRenderLists: ClientProjectileRenderLists = {
    traveling: [],
    smokeTrail: [],
    line: [],
    burnMark: [],
  };
  private readonly nearLineProjectiles: Entity[] = [];
  private readonly nearBurnMarkProjectiles: Entity[] = [];
  private readonly nearSmokeTrailProjectiles: Entity[] = [];
  private readonly nearCommanderSprays: SprayTarget[] = [];
  private readonly nearResourcePylonSprays: SprayTarget[] = [];
  private readonly nearPylonFreeLegSprays: SprayTarget[] = [];
  private readonly scopedUnitsScratch: Entity[] = [];
  private readonly scopedBuildingsScratch: Entity[] = [];
  private readonly bodyHudPacket = new BodyHudRenderPacket3D();
  private readonly shieldPacket = new ShieldRenderPacket3D();
  private readonly pieceNamePacket = new PieceNameRenderPacket3D();
  private readonly contactShadowPacket = new ContactShadowRenderPacket3D();
  private readonly groundPrintPacket = new GroundPrintRenderPacket3D();
  private readonly unitRenderPacket = new UnitRenderPacket3D();
  private readonly buildingRenderPacket = new BuildingRenderPacket3D();
  private readonly entityLod = new EntityLodState3D();
  private readonly renderEntityLists: RenderPhaseEntityLists = {
    unitRows: this.unitRenderPacket,
    buildingRows: this.buildingRenderPacket,
    bodyHud: this.bodyHudPacket,
    shields: this.shieldPacket,
    pieceNames: this.pieceNamePacket,
    contactShadows: this.contactShadowPacket,
    groundPrints: this.groundPrintPacket,
  };
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private readonly enqueuePylonTubeHandoff = (flowKey: string, intensity: number): void => {
    this.resources.pylonTubeFlowRenderer.enqueueTipHandoff(flowKey, intensity);
  };
  private readonly getGroundPrintLocomotionMesh = (entityId: EntityId) =>
    this.resources.entityRenderer.getLocomotionMesh(entityId);
  /** Camera-distance fade shared by HP/build bars + name labels so
   *  both fade + cull together as the camera zooms out (BAR style). */
  private readonly hudFade = new HudFade();
  /** Scratch for reading the canvas size into the overlay-line material. */
  private readonly _overlayResolution = new THREE.Vector2();
  private readonly cameraViewBasis: CameraViewBasis = {
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 },
    towardCamera: { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 },
  };
  private readonly lastPhaseTimings: RtsScene3DRenderPhaseTimings = {
    scopeMs: 0,
    projectileQueryMs: 0,
    entityPacketMs: 0,
    entityRendererMs: 0,
    terrainMs: 0,
    beamMs: 0,
    effectsMs: 0,
    hudMs: 0,
    totalMs: 0,
    unitRows: 0,
    buildingRows: 0,
    unitLodProxyRows: 0,
    buildingLodProxyRows: 0,
    projectileRows: 0,
    lineProjectileRows: 0,
  };

  constructor(
    private readonly threeApp: ThreeApp,
    private readonly clientViewState: ClientViewState,
    private readonly renderScope: ViewportFootprint,
    private readonly cameraFootprintSystem: RtsScene3DCameraFootprintSystem,
    private readonly selectionSystem: RtsScene3DSelectionSystem,
    private readonly resources: RtsScene3DRenderPhaseResources,
    private readonly getLocalPlayerId: () => PlayerId,
    private readonly getInputManager: () => Input3DManager | null,
    private readonly lookupPlayerName: (id: PlayerId) => string | null,
    private readonly getCameraQuadUpdate: () => ((
      quad: FootprintQuad,
      cameraYaw: number,
      cameraPitch: number,
      cameraView: CameraViewBasis,
    ) => void) | undefined,
  ) {}

  getCameraViewBasis(): CameraViewBasis {
    return this.cameraViewBasis;
  }

  getLastPhaseTimings(): RtsScene3DRenderPhaseTimings {
    return this.lastPhaseTimings;
  }

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

  isStartupReady(): boolean {
    return (
      this.resources.terrainTileRenderer.isReady() &&
      (this.resources.environmentPropRenderer?.isReady() ?? true)
    );
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
    effectDtMs: number;
    graphicsConfig: GraphicsConfig;
    renderFrameState: RenderFrameState3D;
  }): RtsScene3DRenderPhaseResult {
    const { effectDtMs, graphicsConfig, renderFrameState } = options;
    const renderStart = performance.now();
    const {
      entityRenderer,
      beamRenderer,
      shieldRenderer,
      terrainTileRenderer,
      metalDepositRenderer,
      environmentPropRenderer,
      contactShadowRenderer,
      waterRenderer,
      explosionRenderer,
      shieldImpactRenderer,
      waterSplashRenderer,
      debrisRenderer,
      burnMarkRenderer,
      groundPrintRenderer,
      areaDragRenderer,
      airLiftProbeOverlay,
      lineDragRenderer,
      sprayRenderer,
      pylonTubeFlowRenderer,
      smokeTrailRenderer,
      fogOfWarFogRenderer,
      overlayLineSystem,
      sightBoundaryRenderer,
      radarBoundaryRenderer,
      healthBar3D,
      nameLabel3D,
      waypoint3D,
    } = this.resources;
    const timings = this.lastPhaseTimings;
    let phaseMark = renderStart;

    metalDepositRenderer?.update(graphicsConfig);
    const hudFrameStride = Math.max(1, graphicsConfig.hudFrameStride | 0);
    const effectFrameStride = Math.max(1, graphicsConfig.effectFrameStride | 0);
    const updateHudThisFrame = hudFrameStride <= 1 || this.renderFrameIndex % hudFrameStride === 0;
    const updateEffectsThisFrame = effectFrameStride <= 1 || this.renderFrameIndex % effectFrameStride === 0;
    // Body bars are motion anchors, not just HUD content. They must follow
    // fast units every render frame even when the budget throttles heavier HUD
    // work with hudFrameStride; otherwise flyers visibly jump between stale and
    // current bar positions.
    const updateNameHudThisFrame = updateHudThisFrame && nameLabel3D !== null;
    const updateBodyHudThisFrame = healthBar3D !== null;
    const unitNameHudEnabled = updateNameHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('unit', 'name');
    const towerNameHudEnabled = updateNameHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('tower', 'name');
    const buildingNameHudEnabled = updateNameHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('building', 'name');
    const bodyNamesEnabled = unitNameHudEnabled || towerNameHudEnabled || buildingNameHudEnabled;
    const turretNamesEnabled = updateNameHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('turret', 'name');
    const shotNamesEnabled = updateNameHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('shot', 'name');
    const selectionHudMode = getSelectionHudMode();

    const cameraFootprint = this.cameraFootprintSystem.update(this.threeApp.camera);
    const cameraQuad = cameraFootprint.quad;
    const cameraView = this.updateCameraViewBasis(this.threeApp.camera);
    this.entityLod.beginFrame();
    this.renderScope.setQuad(
      cameraQuad,
      cameraFootprint.bounds,
    );
    const projectileQueryBounds = this.getProjectileQueryBounds();
    let phaseNow = performance.now();
    timings.scopeMs = phaseNow - phaseMark;
    phaseMark = phaseNow;
    const projectileLists = this.collectRenderProjectiles(projectileQueryBounds);
    phaseNow = performance.now();
    timings.projectileQueryMs = phaseNow - phaseMark;
    phaseMark = phaseNow;
    environmentPropRenderer?.update();
    this.getCameraQuadUpdate()?.(
      cameraQuad,
      this.threeApp.orbit.yaw,
      this.threeApp.orbit.pitch,
      cameraView,
    );

    const serverMeta = this.clientViewState.getServerMeta();
    const fogOfWarEnabled = serverMeta?.fogOfWarEnabled === true;
    const turretShieldSpheresEnabled = serverMeta?.turretShieldSpheresEnabled ?? true;
    const forceFieldsVisible = serverMeta?.forceFieldsVisible ?? true;
    // Keep every overlay line's screen-pixel width correct for the current
    // canvas size (one shared material drives all of them).
    const overlaySize = this.threeApp.renderer.getSize(this._overlayResolution);
    overlayLineSystem.setResolution(overlaySize.x, overlaySize.y);
    sightBoundaryRenderer.update(
      this.clientViewState,
      this.getLocalPlayerId(),
      getSightBoundary(),
      this.renderScope,
    );
    radarBoundaryRenderer.update(
      this.clientViewState,
      this.getLocalPlayerId(),
      getRadarBoundary(),
      this.renderScope,
    );
    const inputManager = this.getInputManager();
    const hoveredEntity = inputManager?.getHoveredEntity() ?? null;
    const bodyHudEnabled = updateBodyHudThisFrame &&
      (
        hoveredEntity !== null ||
        getEntityHudToggle('unit', 'healthBar') ||
        getEntityHudToggle('unit', 'buildBars') ||
        getEntityHudToggle('tower', 'healthBar') ||
        getEntityHudToggle('tower', 'buildBars') ||
        getEntityHudToggle('building', 'healthBar') ||
        getEntityHudToggle('building', 'buildBars')
      );
    const updateContactShadowsThisFrame =
      contactShadowRenderer?.shouldUpdate(this.renderFrameIndex) ?? false;
    const entityLists = this.prepareEntityLists({
      includeBodyHud: bodyHudEnabled,
      includeBodyNames: bodyNamesEnabled,
      includeShields: turretShieldSpheresEnabled && forceFieldsVisible,
      includeContactShadows:
        contactShadowRenderer?.shouldBuildPacket(this.renderFrameIndex) ?? false,
      includeGroundPrints: updateEffectsThisFrame,
      hoveredEntity,
    }, selectionHudMode, renderFrameState.view);
    phaseNow = performance.now();
    timings.entityPacketMs = phaseNow - phaseMark;
    phaseMark = phaseNow;
    const lineProjectiles = this.filterNearLodProjectiles(
      projectileLists.line,
      this.nearLineProjectiles,
    );
    entityRenderer.update(
      renderFrameState,
      (serverMeta?.turretShieldPanelsEnabled ?? true) && forceFieldsVisible,
      {
        unitRows: entityLists.unitRows,
        buildingRows: entityLists.buildingRows,
        beamAimProjectiles: lineProjectiles,
        projectileRenderProjectiles: projectileLists.traveling,
        isEntityEmissionFarLod: (entity) => this.entityEmissionUsesFarLod(entity),
        entityDetailRung: (entity) =>
          this.entityLod.entityDetailRungForView(renderFrameState.view, entity),
        scoped: this.renderScope.getMode() !== 'all',
      },
      {
        reclaimTargets:
          (inputManager?.isInReclaimMode() ?? false) ||
          (inputManager?.isInCaptureMode() ?? false) ||
          (inputManager?.isInResurrectMode() ?? false) ||
          (inputManager?.isInResurrectAreaMode() ?? false),
      },
    );
    airLiftProbeOverlay.update(this.selectionSystem.getSelectedUnits());
    phaseNow = performance.now();
    timings.entityRendererMs = phaseNow - phaseMark;
    phaseMark = phaseNow;
    this.clientViewState.consumeRenderDirties();
    if (shotNamesEnabled) {
      this.populateShotNamePacket(
        projectileLists.traveling,
        selectionHudMode,
      );
    }
    if (turretNamesEnabled) {
      this.populateRenderListTurretNamePacket(entityLists, selectionHudMode);
    }
    if (contactShadowRenderer && updateContactShadowsThisFrame) {
      contactShadowRenderer.update(entityLists.contactShadows, this.renderFrameIndex);
    }
    // Whole-map cell overlays (DEBUG: BUILD / METAL / WATER and CLIENT PATH)
    // are baked directly onto the terrain AND metal-deposit coin surfaces by
    // the shared BuildGridOverlayShader inside terrainTileRenderer.update().
    // The build-mode hover footprint is a separate, localized signal owned by
    // BuildGhost3D's setTarget path.
    terrainTileRenderer.update(
      graphicsConfig,
      renderFrameState,
      {
        localPlayerId: this.getLocalPlayerId(),
        fogShadeEnabled: fogOfWarEnabled && getFogShade(),
      },
    );
    phaseNow = performance.now();
    timings.terrainMs = phaseNow - phaseMark;
    phaseMark = phaseNow;

    beamRenderer.update(
      lineProjectiles,
      graphicsConfig,
      this.clientViewState.getLineProjectileRenderVersion(),
      entityRenderer,
      (entity) => this.entityEmissionUsesFarLod(entity),
      renderFrameState.view,
    );
    phaseNow = performance.now();
    timings.beamMs = phaseNow - phaseMark;
    phaseMark = phaseNow;

    waterRenderer.update(
      effectDtMs / 1000,
      graphicsConfig,
      renderFrameState,
    );
    this.fireExplosionAccumMs += effectDtMs;
    this.debrisAccumMs += effectDtMs;
    const materialExplosionsEnabled = getMaterialExplosions();
    if (!materialExplosionsEnabled) {
      debrisRenderer.clear();
      this.debrisAccumMs = 0;
    }
    if (updateEffectsThisFrame) {
      explosionRenderer.update(this.fireExplosionAccumMs);
      if (materialExplosionsEnabled) {
        debrisRenderer.update(this.debrisAccumMs);
      }
      this.fireExplosionAccumMs = 0;
      this.debrisAccumMs = 0;
    }
    shieldImpactRenderer.setVisible(forceFieldsVisible);
    if (forceFieldsVisible) {
      shieldImpactRenderer.update(effectDtMs, lineProjectiles);
    }
    waterSplashRenderer.update(effectDtMs);
    this.burnMarkAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      burnMarkRenderer.update(
        this.filterNearLodProjectiles(
          projectileLists.burnMark,
          this.nearBurnMarkProjectiles,
        ),
        this.burnMarkAccumMs,
      );
      this.burnMarkAccumMs = 0;
    }

    this.groundPrintAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      groundPrintRenderer.update(
        entityLists.groundPrints,
        this.getGroundPrintLocomotionMesh,
        this.groundPrintAccumMs,
      );
      this.groundPrintAccumMs = 0;
    }

    this.sprayAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      const pylonFreeLegSprays = this.filterNearLodSprays(
        pylonTubeFlowRenderer.update(
          entityRenderer.getPylonTubeFlows(),
          this.sprayAccumMs,
        ),
        this.nearPylonFreeLegSprays,
      );
      const commanderSprays = this.filterNearLodSprays(
        this.clientViewState.getSprayTargets(),
        this.nearCommanderSprays,
      );
      const resourcePylonSprays = this.filterNearLodSprays(
        entityRenderer.getResourcePylonSprayTargets(),
        this.nearResourcePylonSprays,
      );
      if (resourcePylonSprays.length > 0) {
        const commanderSprayCount = commanderSprays.length;
        const resourcePylonSprayCount = resourcePylonSprays.length;
        this.combinedSprayTargets.length = commanderSprayCount + resourcePylonSprayCount;
        for (let i = 0; i < commanderSprayCount; i++) {
          this.combinedSprayTargets[i] = commanderSprays[i];
        }
        for (let i = 0; i < resourcePylonSprayCount; i++) {
          this.combinedSprayTargets[commanderSprayCount + i] = resourcePylonSprays[i];
        }
        sprayRenderer.update(
          this.combinedSprayTargets,
          this.sprayAccumMs,
          pylonFreeLegSprays,
          this.enqueuePylonTubeHandoff,
        );
      } else {
        sprayRenderer.update(
          commanderSprays,
          this.sprayAccumMs,
          pylonFreeLegSprays,
          this.enqueuePylonTubeHandoff,
        );
      }
      this.sprayAccumMs = 0;
    }

    this.smokeTrailAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      smokeTrailRenderer.update(
        this.filterNearLodProjectiles(
          projectileLists.smokeTrail,
          this.nearSmokeTrailProjectiles,
        ),
        this.smokeTrailAccumMs,
        this.renderFrameIndex,
        this.renderScope,
        entityRenderer.getHoverSmokeEmitters(),
        renderFrameState.view,
      );
      fogOfWarFogRenderer.update(
        this.clientViewState,
        this.getLocalPlayerId(),
        fogOfWarEnabled && getFogClouds(),
        this.smokeTrailAccumMs,
      );
      this.smokeTrailAccumMs = 0;
    }
    phaseNow = performance.now();
    timings.effectsMs = phaseNow - phaseMark;
    phaseMark = phaseNow;

    if (inputManager) {
      areaDragRenderer.update(inputManager.getAreaDragState());
      lineDragRenderer.update(inputManager.getLineDragState());
    }

    let hudFrustum: THREE.Frustum | undefined;
    if (bodyHudEnabled || bodyNamesEnabled || turretNamesEnabled || shotNamesEnabled) {
      const cam = this.threeApp.camera;
      if (this.renderScope.getMode() !== 'all') {
        this.frustumMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.frustumMatrix);
        hudFrustum = this.frustum;
      }
      const farRefDistance = this.threeApp.orbit.getFarReferenceDistance();
      // Refresh the HUD fade from the live camera; the fade window scales
      // with the orbit's map-scaled far reference distance so it tracks map
      // size. (Zoom-out is unbounded; HUD elements are simply fully faded by
      // the time the camera reaches the far reference.)
      this.hudFade.update(
        cam,
        farRefDistance * ENTITY_HUD_FADE_START_DISTANCE_FRAC,
        farRefDistance * ENTITY_HUD_FADE_END_DISTANCE_FRAC,
      );
    }

    if (turretShieldSpheresEnabled && forceFieldsVisible) {
      shieldRenderer.beginFrame(graphicsConfig);
      shieldRenderer.processPacket(entityLists.shields);
      shieldRenderer.endFrame();
    } else {
      shieldRenderer.clear();
    }

    if (bodyHudEnabled || bodyNamesEnabled || turretNamesEnabled || shotNamesEnabled) {
      this.drawEntityHud(
        bodyHudEnabled ? healthBar3D : null,
        bodyNamesEnabled || turretNamesEnabled || shotNamesEnabled ? nameLabel3D : null,
        hudFrustum,
        entityLists,
      );
    }

    if (updateHudThisFrame) {
      waypoint3D?.update(
        this.selectionSystem.getSelectedUnits(),
        this.selectionSystem.getSelectedBuildings(),
      );
    }

    this.entityLod.endFrame();
    const renderEnd = performance.now();
    timings.hudMs = renderEnd - phaseMark;
    timings.totalMs = renderEnd - renderStart;
    timings.unitRows = entityLists.unitRows.count;
    timings.buildingRows = entityLists.buildingRows.count;
    timings.unitLodProxyRows = this.countUnitLodProxyRows(entityLists.unitRows);
    timings.buildingLodProxyRows = this.countBuildingLodProxyRows(entityLists.buildingRows);
    timings.projectileRows = projectileLists.traveling.length;
    timings.lineProjectileRows = lineProjectiles.length;
    return {
      cameraQuad,
      cameraView,
      renderMs: timings.totalMs,
    };
  }

  private updateCameraViewBasis(camera: THREE.Camera): CameraViewBasis {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const basis = this.cameraViewBasis;
    basis.right.x = e[0];
    basis.right.y = e[2];
    basis.right.z = e[1];
    basis.up.x = e[4];
    basis.up.y = e[6];
    basis.up.z = e[5];
    basis.towardCamera.x = e[8];
    basis.towardCamera.y = e[10];
    basis.towardCamera.z = e[9];
    return basis;
  }

  private countUnitLodProxyRows(rows: UnitRenderPacket3D): number {
    let count = 0;
    for (let row = 0; row < rows.count; row++) {
      if (rows.lodProxyAt(row)) count++;
    }
    return count;
  }

  private countBuildingLodProxyRows(rows: BuildingRenderPacket3D): number {
    let count = 0;
    for (let row = 0; row < rows.count; row++) {
      if (rows.lodProxyAt(row)) count++;
    }
    return count;
  }

  private prepareEntityLists(
    options: RenderPhaseEntityListOptions,
    mode: SelectionHudMode,
    renderView: RenderViewState3D,
  ): RenderPhaseEntityLists {
    return this.clientViewState.prepareRenderEntityPackets3D(
      this.renderEntityLists,
      {
        renderScope: this.renderScope,
        includeBodyHud: options.includeBodyHud,
        includeBodyNames: options.includeBodyNames,
        includeShields: options.includeShields,
        includeContactShadows: options.includeContactShadows,
        includeGroundPrints: options.includeGroundPrints,
        hoveredEntity: options.hoveredEntity,
        scopedUnitsOut: this.scopedUnitsScratch,
        scopedBuildingsOut: this.scopedBuildingsScratch,
        selectionHudMode: mode,
        getEntityHudToggle,
        lookupPlayerName: this.lookupPlayerName,
        getGroundPrintLocomotionMesh: this.getGroundPrintLocomotionMesh,
        isEntityFarLod: (entity) => this.entityUsesFarLod(entity, renderView),
        isEntityEmissionFarLod: (entity) => this.entityEmissionUsesFarLod(entity),
      },
    );
  }

  private getProjectileQueryBounds(): FootprintBounds | null {
    if (this.renderScope.getMode() === 'all') return null;
    return this.renderScope.getCullingBounds(
      this.clientViewState.getProjectileRenderScopePadding(),
    );
  }

  private collectRenderProjectiles(bounds: FootprintBounds | null): ClientProjectileRenderLists {
    return this.clientViewState.collectProjectileRenderLists(bounds, this.projectileRenderLists);
  }

  private entityUsesFarLod(entity: Entity, renderView: RenderViewState3D): boolean {
    return this.entityLod.entityUsesLodProxyForView(renderView, entity);
  }

  private entityEmissionUsesFarLod(entity: Entity): boolean {
    return this.entityLod.entityUsesLowLodDistance(this.threeApp.camera, entity);
  }

  private filterNearLodProjectiles(
    projectiles: readonly Entity[],
    out: Entity[],
  ): readonly Entity[] {
    out.length = 0;
    for (let i = 0; i < projectiles.length; i++) {
      const projectile = projectiles[i];
      if (!this.entityEmissionUsesFarLod(projectile)) out.push(projectile);
    }
    return out;
  }

  private filterNearLodSprays(
    sprays: readonly SprayTarget[],
    out: SprayTarget[],
  ): readonly SprayTarget[] {
    out.length = 0;
    for (let i = 0; i < sprays.length; i++) {
      const spray = sprays[i];
      const source = this.clientViewState.getEntity(spray.source.id);
      if (source !== undefined && this.entityEmissionUsesFarLod(source)) continue;
      const target = this.clientViewState.getEntity(spray.target.id);
      if (target !== undefined && this.entityEmissionUsesFarLod(target)) continue;
      out.push(spray);
    }
    return out;
  }

  private populateTurretNamePacket(hosts: readonly Entity[], mode: SelectionHudMode): void {
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i];
      if (!this.entityEmissionUsesFarLod(host)) {
        this.pushTurretNamesForEntity(host, mode);
      }
    }
  }

  private populateRenderListTurretNamePacket(
    lists: RenderPhaseEntityLists,
    mode: SelectionHudMode,
  ): void {
    if (this.renderScope.getMode() === 'all') {
      this.populateTurretNamePacket(this.clientViewState.getArmedEntities(), mode);
      return;
    }
    for (let row = 0; row < lists.unitRows.count; row++) {
      this.pushTurretNamesForEntityId(lists.unitRows.entityIdAt(row), mode);
    }
    for (let row = 0; row < lists.buildingRows.count; row++) {
      this.pushTurretNamesForEntityId(lists.buildingRows.entityIdAt(row), mode);
    }
  }

  private pushTurretNamesForEntityId(entityId: EntityId, mode: SelectionHudMode): void {
    const entity = this.clientViewState.getEntity(entityId);
    if (
      entity !== undefined &&
      !this.entityEmissionUsesFarLod(entity)
    ) {
      this.pushTurretNamesForEntity(entity, mode);
    }
  }

  private pushTurretNamesForEntity(host: Entity, mode: SelectionHudMode): void {
    if (this.entityEmissionUsesFarLod(host)) return;
    const turrets = host.combat?.turrets;
    if (!turrets) return;
    const entityRenderer = this.resources.entityRenderer;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (turret.config.visualOnly) continue;
      if (turret.config.shot === null) continue;
      if (turret.config.shot.type === 'shield') continue;
      const mount = entityRenderer.getTurretMountWorldState(host.id, i);
      if (mount === null) continue;
      const name = resolveTurretName(host, turret, true, mode);
      if (name === null) continue;
      this.pieceNamePacket.push(
        host.id,
        turretPieceTag(i),
        mount.x,
        getTurretHudNameY(mount.z, turret.config),
        mount.y,
        name,
      );
    }
  }

  private populateShotNamePacket(projectiles: readonly Entity[], mode: SelectionHudMode): void {
    const packet = this.pieceNamePacket;
    const scope = this.renderScope;
    for (let i = 0; i < projectiles.length; i++) {
      const shot = projectiles[i];
      if (this.entityEmissionUsesFarLod(shot)) continue;
      if (!scope.inScope(shot.transform.x, shot.transform.y, 100)) continue;
      const proj = shot.projectile;
      if (!proj || proj.projectileType !== 'projectile' || proj.maxHp <= 0) continue;
      const name = resolveShotName(shot, true, mode);
      if (name === null) continue;
      packet.push(
        shot.id,
        PIECE_TAG_BODY,
        shot.transform.x,
        getShotHudNameY(shot),
        shot.transform.y,
        name,
      );
    }
  }

  /** Drive HUD sprites from prebuilt render packets so the draw step
   *  only consumes compact rows. */
  private drawEntityHud(
    healthBar3D: HealthBar3D | null,
    nameLabel3D: NameLabel3D | null,
    hudFrustum: THREE.Frustum | undefined,
    entityLists: RenderPhaseEntityLists,
  ): void {
    if (!healthBar3D && !nameLabel3D) return;

    if (healthBar3D) healthBar3D.beginFrame(this.hudFade, hudFrustum);
    if (nameLabel3D) nameLabel3D.beginFrame(this.hudFade, hudFrustum);

    healthBar3D?.processBodyHudPacket(entityLists.bodyHud);
    nameLabel3D?.processPieceNamePacket(entityLists.pieceNames);

    if (healthBar3D) healthBar3D.endFrame();
    if (nameLabel3D) nameLabel3D.endFrame();
  }
}
