import * as THREE from 'three';
import {
  getBuildGridDebug,
  getRadarBoundary,
  getSightBoundary,
  getEntityHudToggle,
  getSelectionHudMode,
} from '@/clientBarConfig';
import type { SelectionHudMode } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { SprayTarget } from '@/types/ui';
import type { ClientViewState } from '../../network/ClientViewState';
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
import type { LineDrag3D } from '../../render3d/LineDrag3D';
import type { SprayRenderer3D } from '../../render3d/SprayRenderer3D';
import type { PylonTubeFlowRenderer } from '../../render3d/PylonTubeFlowRenderer';
import type { SmokeTrail3D } from '../../render3d/SmokeTrail3D';
import type { FogOfWarFog3D } from '../../render3d/FogOfWarFog3D';
import type { SightBoundaryRenderer3D } from '../../render3d/SightBoundaryRenderer3D';
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
import type { RenderFrameState3D } from '../../render3d/RenderFrameState3D';
import type { FootprintBounds, FootprintQuad, ViewportFootprint } from '../../ViewportFootprint';
import type { RtsScene3DCameraFootprintSystem } from './RtsScene3DCameraFootprintSystem';
import type { RtsScene3DSelectionSystem } from './RtsScene3DSelectionSystem';

export type RtsScene3DRenderPhaseResources = {
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
  lineDragRenderer: LineDrag3D;
  sprayRenderer: SprayRenderer3D;
  pylonTubeFlowRenderer: PylonTubeFlowRenderer;
  smokeTrailRenderer: SmokeTrail3D;
  fogOfWarFogRenderer: FogOfWarFog3D;
  sightBoundaryRenderer: SightBoundaryRenderer3D;
  radarBoundaryRenderer: SightBoundaryRenderer3D;
  healthBar3D: HealthBar3D | null;
  nameLabel3D: NameLabel3D | null;
  waypoint3D: Waypoint3D | null;
};

export type RtsScene3DRenderPhaseResult = {
  cameraQuad: FootprintQuad;
  renderMs: number;
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
  private readonly lineProjectilesScratch: Entity[] = [];
  private readonly burnMarkProjectilesScratch: Entity[] = [];
  private readonly smokeTrailProjectilesScratch: Entity[] = [];
  private readonly shotNameProjectilesScratch: Entity[] = [];
  private readonly scopedUnitsScratch: Entity[] = [];
  private readonly scopedBuildingsScratch: Entity[] = [];
  private readonly bodyHudPacket = new BodyHudRenderPacket3D();
  private readonly shieldPacket = new ShieldRenderPacket3D();
  private readonly pieceNamePacket = new PieceNameRenderPacket3D();
  private readonly contactShadowPacket = new ContactShadowRenderPacket3D();
  private readonly groundPrintPacket = new GroundPrintRenderPacket3D();
  private readonly unitRenderPacket = new UnitRenderPacket3D();
  private readonly buildingRenderPacket = new BuildingRenderPacket3D();
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
      buildGhostRenderer,
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
      lineDragRenderer,
      sprayRenderer,
      pylonTubeFlowRenderer,
      smokeTrailRenderer,
      fogOfWarFogRenderer,
      sightBoundaryRenderer,
      radarBoundaryRenderer,
      healthBar3D,
      nameLabel3D,
      waypoint3D,
    } = this.resources;

    metalDepositRenderer?.update(graphicsConfig);
    const hudFrameStride = Math.max(1, graphicsConfig.hudFrameStride | 0);
    const effectFrameStride = Math.max(1, graphicsConfig.effectFrameStride | 0);
    const updateHudThisFrame = hudFrameStride <= 1 || this.renderFrameIndex % hudFrameStride === 0;
    const updateEffectsThisFrame = effectFrameStride <= 1 || this.renderFrameIndex % effectFrameStride === 0;
    const updateEntityHudThisFrame = updateHudThisFrame && (healthBar3D !== null || nameLabel3D !== null);
    const unitNameHudEnabled = updateEntityHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('unit', 'name');
    const towerNameHudEnabled = updateEntityHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('tower', 'name');
    const buildingNameHudEnabled = updateEntityHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('building', 'name');
    const bodyNamesEnabled = unitNameHudEnabled || towerNameHudEnabled || buildingNameHudEnabled;
    const turretNamesEnabled = updateEntityHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('turret', 'name');
    const shotNamesEnabled = updateEntityHudThisFrame &&
      nameLabel3D !== null &&
      getEntityHudToggle('shot', 'name');
    const selectionHudMode = getSelectionHudMode();

    const cameraFootprint = this.cameraFootprintSystem.update(this.threeApp.camera);
    const cameraQuad = cameraFootprint.quad;
    this.renderScope.setQuad(
      cameraQuad,
      cameraFootprint.bounds,
    );
    const projectileQueryBounds = this.getProjectileQueryBounds();
    environmentPropRenderer?.update();
    this.getCameraQuadUpdate()?.(cameraQuad, this.threeApp.orbit.yaw);

    const serverMeta = this.clientViewState.getServerMeta();
    const fogOfWarEnabled = serverMeta?.fogOfWarEnabled === true;
    const turretShieldSpheresEnabled = serverMeta?.turretShieldSpheresEnabled ?? true;
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
    const updateContactShadowsThisFrame =
      contactShadowRenderer?.shouldUpdate(this.renderFrameIndex) ?? false;
    const entityLists = this.prepareEntityLists({
      includeBodyHud: updateEntityHudThisFrame && healthBar3D !== null,
      includeBodyNames: bodyNamesEnabled,
      includeShields: turretShieldSpheresEnabled,
      includeContactShadows:
        contactShadowRenderer?.shouldBuildPacket(this.renderFrameIndex) ?? false,
      includeGroundPrints: updateEffectsThisFrame,
      hoveredEntity,
    }, selectionHudMode);
    const lineProjectiles = this.collectRenderLineProjectiles(projectileQueryBounds);
    entityRenderer.update(
      renderFrameState,
      serverMeta?.turretShieldPanelsEnabled ?? true,
      {
        unitRows: entityLists.unitRows,
        buildingRows: entityLists.buildingRows,
        beamAimProjectiles: lineProjectiles,
        scoped: this.renderScope.getMode() !== 'all',
      },
    );
    this.clientViewState.consumeUnitRenderDirties();
    if (shotNamesEnabled) {
      this.populateShotNamePacket(
        this.collectRenderShotNameProjectiles(projectileQueryBounds),
        selectionHudMode,
      );
    }
    if (turretNamesEnabled) {
      this.populateRenderListTurretNamePacket(entityLists, selectionHudMode);
    }
    if (contactShadowRenderer && updateContactShadowsThisFrame) {
      contactShadowRenderer.update(entityLists.contactShadows, this.renderFrameIndex);
    }
    // The whole-map build-grid visualization (terrain-shader red/green/blue
    // overlay + matching blue squares above each deposit coin) is gated
    // solely to the DEBUG: BUILD toggle. The build-mode hover footprint is
    // a separate, localized signal owned by BuildGhost3D's setTarget path.
    buildGhostRenderer.setBuildGridOverlayVisible(getBuildGridDebug());
    terrainTileRenderer.update(
      graphicsConfig,
      renderFrameState,
    );

    const smokeTrailProjectiles = updateEffectsThisFrame
      ? this.collectRenderSmokeTrailProjectiles(projectileQueryBounds)
      : this.smokeTrailProjectilesScratch;
    beamRenderer.update(
      lineProjectiles,
      graphicsConfig,
      this.clientViewState.getLineProjectileRenderVersion(),
      entityRenderer,
    );

    waterRenderer.update(
      effectDtMs / 1000,
      graphicsConfig,
      renderFrameState,
    );
    this.fireExplosionAccumMs += effectDtMs;
    this.debrisAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      explosionRenderer.update(this.fireExplosionAccumMs);
      debrisRenderer.update(this.debrisAccumMs);
      this.fireExplosionAccumMs = 0;
      this.debrisAccumMs = 0;
    }
    shieldImpactRenderer.update(effectDtMs, lineProjectiles);
    waterSplashRenderer.update(effectDtMs);
    this.burnMarkAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      const burnMarkProjectiles = this.collectRenderBurnMarkProjectiles(projectileQueryBounds);
      burnMarkRenderer.update(burnMarkProjectiles, this.burnMarkAccumMs);
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

    const cam = this.threeApp.camera;
    this.frustumMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    const farRefDistance = this.threeApp.orbit.getFarReferenceDistance();
    this.sprayAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      const pylonFreeLegSprays = pylonTubeFlowRenderer.update(
        entityRenderer.getPylonTubeFlows(),
        this.sprayAccumMs,
      );
      const commanderSprays = this.clientViewState.getSprayTargets();
      const factorySprays = entityRenderer.getFactorySprayTargets();
      if (factorySprays.length > 0) {
        this.combinedSprayTargets.length = 0;
        for (const spray of commanderSprays) this.combinedSprayTargets.push(spray);
        for (const spray of factorySprays) this.combinedSprayTargets.push(spray);
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
        smokeTrailProjectiles,
        this.smokeTrailAccumMs,
        this.renderFrameIndex,
        this.renderScope,
        entityRenderer.getHoverSmokeEmitters(),
      );
      fogOfWarFogRenderer.update(
        this.clientViewState,
        this.getLocalPlayerId(),
        fogOfWarEnabled,
        this.smokeTrailAccumMs,
      );
      this.smokeTrailAccumMs = 0;
    }

    if (inputManager) {
      lineDragRenderer.update(inputManager.getLineDragState());
    }

    const hudFrustum = this.renderScope.getMode() === 'all' ? undefined : this.frustum;
    // Refresh the HUD fade from the live camera; the fade window scales
    // with the orbit's map-scaled far reference distance so it tracks map
    // size. (Zoom-out is unbounded; HUD elements are simply fully faded by
    // the time the camera reaches the far reference.)
    this.hudFade.update(
      cam,
      farRefDistance * ENTITY_HUD_FADE_START_DISTANCE_FRAC,
      farRefDistance * ENTITY_HUD_FADE_END_DISTANCE_FRAC,
    );

    shieldRenderer.beginFrame(graphicsConfig);
    if (turretShieldSpheresEnabled) {
      shieldRenderer.processPacket(entityLists.shields);
    }
    shieldRenderer.endFrame();

    if (updateEntityHudThisFrame) {
      this.drawEntityHud(healthBar3D, nameLabel3D, hudFrustum, entityLists);
    }

    if (updateHudThisFrame) {
      waypoint3D?.update(
        this.selectionSystem.getSelectedUnits(),
        this.selectionSystem.getSelectedBuildings(),
      );
    }

    return {
      cameraQuad,
      renderMs: performance.now() - renderStart,
    };
  }

  private prepareEntityLists(
    options: RenderPhaseEntityListOptions,
    mode: SelectionHudMode,
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
      },
    );
  }

  private getProjectileQueryBounds(): FootprintBounds | null {
    if (this.renderScope.getMode() === 'all') return null;
    return this.renderScope.getCullingBounds(
      this.clientViewState.getProjectileRenderScopePadding(),
    );
  }

  private collectRenderLineProjectiles(bounds: FootprintBounds | null): Entity[] {
    return bounds === null
      ? this.clientViewState.collectLineProjectiles(this.lineProjectilesScratch)
      : this.clientViewState.collectScopedLineProjectiles(bounds, this.lineProjectilesScratch);
  }

  private collectRenderSmokeTrailProjectiles(bounds: FootprintBounds | null): Entity[] {
    return bounds === null
      ? this.clientViewState.collectSmokeTrailProjectiles(this.smokeTrailProjectilesScratch)
      : this.clientViewState.collectScopedSmokeTrailProjectiles(bounds, this.smokeTrailProjectilesScratch);
  }

  private collectRenderBurnMarkProjectiles(bounds: FootprintBounds | null): Entity[] {
    return bounds === null
      ? this.clientViewState.collectBurnMarkProjectiles(this.burnMarkProjectilesScratch)
      : this.clientViewState.collectScopedBurnMarkProjectiles(bounds, this.burnMarkProjectilesScratch);
  }

  private collectRenderShotNameProjectiles(bounds: FootprintBounds | null): Entity[] {
    return bounds === null
      ? this.clientViewState.collectTravelingProjectiles(this.shotNameProjectilesScratch)
      : this.clientViewState.collectScopedTravelingProjectiles(bounds, this.shotNameProjectilesScratch);
  }

  private populateTurretNamePacket(hosts: readonly Entity[], mode: SelectionHudMode): void {
    for (const host of hosts) {
      this.pushTurretNamesForEntity(host, mode);
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
    if (entity !== undefined) this.pushTurretNamesForEntity(entity, mode);
  }

  private pushTurretNamesForEntity(host: Entity, mode: SelectionHudMode): void {
    const turrets = host.combat?.turrets;
    if (!turrets) return;
    const entityRenderer = this.resources.entityRenderer;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (turret.config.visualOnly) continue;
      if (turret.config.shot === undefined) continue;
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
    for (const shot of projectiles) {
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
