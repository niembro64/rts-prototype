import * as THREE from 'three';
import {
  getBuildGridDebug,
  getRadarBoundary,
  getSightBoundary,
  getEntityHudToggle,
  getSelectionHudMode,
} from '@/clientBarConfig';
import type { EntityHudType, SelectionHudMode } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { SprayTarget } from '@/types/ui';
import type { ClientViewState } from '../../network/ClientViewState';
import type { Entity, EntityId, PlayerId } from '../../sim/types';
import { getDefaultPlayerName } from '@/playerNamesConfig';
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
  PIECE_TAG_COMMANDER_OWNER_NAME,
  PieceNameRenderPacket3D,
  type NameLabel3D,
} from '../../render3d/NameLabel3D';
import { HudFade } from '../../render3d/HudFade';
import type { Waypoint3D } from '../../render3d/Waypoint3D';
import {
  resolveCommanderOwnerName,
  resolveEntityDisplayName,
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
  getUnitHudNameY,
  getBuildingHudNameY,
} from '../../render3d/HudAnchor';
import { isBuildInProgress } from '../../sim/buildableHelpers';
import {
  ENTITY_HUD_FADE_START_DISTANCE_FRAC,
  ENTITY_HUD_FADE_END_DISTANCE_FRAC,
} from '@/config';
import { NAME_LABEL_OWNER_Y_OFFSET } from '@/nameLabelConfig';
import type { RenderFrameState3D } from '../../render3d/RenderFrameState3D';
import type { FootprintQuad } from '../../ViewportFootprint';
import type { ViewportFootprint } from '../../ViewportFootprint';
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
  units: readonly Entity[];
  buildings: readonly Entity[];
  bodyHud: BodyHudRenderPacket3D;
  shields: ShieldRenderPacket3D;
  pieceNames: PieceNameRenderPacket3D;
  contactShadows: ContactShadowRenderPacket3D;
  groundPrints: GroundPrintRenderPacket3D;
};

type RenderPhaseEntityListOptions = {
  includeBodyHud: boolean;
  includeBodyNames: boolean;
  includeTurretNames: boolean;
  includeShields: boolean;
  includeShotNames: boolean;
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
  private readonly scopedUnitsScratch: Entity[] = [];
  private readonly scopedBuildingsScratch: Entity[] = [];
  private readonly bodyHudPacket = new BodyHudRenderPacket3D();
  private readonly shieldPacket = new ShieldRenderPacket3D();
  private readonly pieceNamePacket = new PieceNameRenderPacket3D();
  private readonly contactShadowPacket = new ContactShadowRenderPacket3D();
  private readonly groundPrintPacket = new GroundPrintRenderPacket3D();
  private readonly renderEntityLists: RenderPhaseEntityLists = {
    units: [],
    buildings: [],
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
  private readonly lookupPlayerDisplayName = (playerId: PlayerId): string | null =>
    this.lookupPlayerName(playerId) ?? getDefaultPlayerName(playerId);
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

    const cameraFootprint = this.cameraFootprintSystem.update(this.threeApp.camera);
    const cameraQuad = cameraFootprint.quad;
    this.renderScope.setQuad(
      cameraQuad,
      cameraFootprint.bounds,
    );
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
    entityRenderer.update(
      renderFrameState,
      serverMeta?.turretShieldPanelsEnabled ?? true,
    );
    const inputManager = this.getInputManager();
    const hoveredEntity = inputManager?.getHoveredEntity() ?? null;
    const updateContactShadowsThisFrame =
      contactShadowRenderer?.shouldUpdate(this.renderFrameIndex) ?? false;
    const entityLists = this.prepareEntityLists({
      includeBodyHud: updateEntityHudThisFrame && healthBar3D !== null,
      includeBodyNames: bodyNamesEnabled,
      includeTurretNames: turretNamesEnabled,
      includeShields: turretShieldSpheresEnabled,
      includeShotNames: shotNamesEnabled,
      includeContactShadows:
        contactShadowRenderer?.shouldBuildPacket(this.renderFrameIndex) ?? false,
      includeGroundPrints: updateEffectsThisFrame,
      hoveredEntity,
    });
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

    const lineProjectiles = this.clientViewState.collectLineProjectiles(this.lineProjectilesScratch);
    const smokeTrailProjectiles = updateEffectsThisFrame
      ? this.clientViewState.collectSmokeTrailProjectiles(this.smokeTrailProjectilesScratch)
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
      const burnMarkProjectiles = this.clientViewState.collectBurnMarkProjectiles(this.burnMarkProjectilesScratch);
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

  /** Per-element BAR visibility decision (health / buildBars).
   *  Names use {@link nameVisible} instead (no fullness). `notFull` is
   *  the piece's `current < max` test for this element. */
  private barVisible(
    perType: boolean,
    selected: boolean,
    mode: SelectionHudMode,
    notFull: boolean,
  ): boolean {
    if (!perType) return false;
    if (selected) {
      if (mode === 'always') return true;
      if (mode === 'never') return false;
      return notFull; // whenNotFull
    }
    return notFull;
  }

  /** Map an entity's discriminator to its HUD config type. Towers carry
   *  a `building` component but report type 'tower' so they get their
   *  own toggle row. */
  private hudTypeOf(entity: Entity): EntityHudType {
    if (entity.type === 'unit') return 'unit';
    if (entity.type === 'tower') return 'tower';
    return 'building';
  }

  private prepareEntityLists(options: RenderPhaseEntityListOptions): RenderPhaseEntityLists {
    const lists = this.renderEntityLists;
    const bodyHud = this.bodyHudPacket;
    const shields = this.shieldPacket;
    const pieceNames = this.pieceNamePacket;
    const contactShadows = this.contactShadowPacket;
    const groundPrints = this.groundPrintPacket;
    const mode = getSelectionHudMode();
    bodyHud.reset();
    shields.reset();
    pieceNames.reset();
    contactShadows.reset();
    groundPrints.reset();
    if (this.renderScope.getMode() === 'all') {
      lists.units = this.clientViewState.getUnits();
      lists.buildings = this.clientViewState.getBuildings();
      if (options.includeBodyHud) {
        this.populateBodyHudPacket(this.clientViewState.getHudEntities(), options.hoveredEntity, mode);
      }
      if (options.includeBodyNames) {
        this.populateBodyNamePacket(this.clientViewState.getUnitsAndBuildings(), mode);
      }
      if (options.includeTurretNames) {
        this.populateTurretNamePacket(this.clientViewState.getArmedEntities(), mode);
      }
      if (options.includeShields) {
        this.populateShieldPacket(this.clientViewState.getShieldUnits());
      }
      if (options.includeShotNames) {
        this.populateShotNamePacket(this.clientViewState.getProjectiles(), mode);
      }
      if (options.includeContactShadows) {
        this.populateContactShadowPacket(lists.units, lists.buildings);
      }
      if (options.includeGroundPrints) {
        this.populateGroundPrintPacket(lists.units);
      }
      return lists;
    }

    const units = this.scopedUnitsScratch;
    const buildings = this.scopedBuildingsScratch;
    units.length = 0;
    buildings.length = 0;

    const scope = this.renderScope;
    let hoveredBodyHudPushed = false;
    for (const entity of this.clientViewState.getUnitsAndBuildings()) {
      if (!this.entityInRenderScope(entity)) continue;
      if (entity.unit) units.push(entity);
      else if (entity.building) buildings.push(entity);
      if (options.includeBodyHud && this.entityNeedsBodyHud(entity)) {
        const forceVisible = entity === options.hoveredEntity;
        if (forceVisible) hoveredBodyHudPushed = true;
        this.pushBodyHudEntity(entity, forceVisible, mode);
      }
      if (options.includeBodyNames) {
        this.pushBodyNamesForEntity(entity, mode);
      }
      if (options.includeTurretNames) {
        this.pushTurretNamesForEntity(entity, mode);
      }
      if (options.includeShields && entity.unit && entity.combat) {
        shields.pushUnit(entity, scope);
      }
    }

    if (options.includeBodyHud && options.hoveredEntity !== null && !hoveredBodyHudPushed) {
      this.pushBodyHudEntity(options.hoveredEntity, true, mode);
    }
    if (options.includeShotNames) {
      this.populateShotNamePacket(this.clientViewState.getProjectiles(), mode);
    }

    lists.units = units;
    lists.buildings = buildings;
    if (options.includeContactShadows) {
      this.populateContactShadowPacket(units, buildings);
    }
    if (options.includeGroundPrints) {
      this.populateGroundPrintPacket(units);
    }
    return lists;
  }

  private populateShieldPacket(units: readonly Entity[]): void {
    const packet = this.shieldPacket;
    for (const unit of units) {
      packet.pushUnit(unit, this.renderScope);
    }
  }

  private populateBodyHudPacket(
    entities: readonly Entity[],
    hoveredEntity: Entity | null,
    mode: SelectionHudMode,
  ): void {
    let hoveredBodyHudPushed = false;
    for (const entity of entities) {
      const forceVisible = entity === hoveredEntity;
      if (forceVisible) hoveredBodyHudPushed = true;
      this.pushBodyHudEntity(entity, forceVisible, mode);
    }
    if (hoveredEntity !== null && !hoveredBodyHudPushed) {
      this.pushBodyHudEntity(hoveredEntity, true, mode);
    }
  }

  private pushBodyHudEntity(entity: Entity, forceVisible: boolean, mode: SelectionHudMode): void {
    const type = this.hudTypeOf(entity);
    const selected = entity.selectable?.selected === true;
    const buildInProgress = isBuildInProgress(entity.buildable);
    const hp = entity.unit ? entity.unit.hp : entity.building ? entity.building.hp : 0;
    const maxHp = entity.unit ? entity.unit.maxHp : entity.building ? entity.building.maxHp : 0;
    const healthNotFull = maxHp > 0 && hp < maxHp;
    const showHealth = this.barVisible(
      getEntityHudToggle(type, 'healthBar'), selected, mode, healthNotFull,
    );
    const showBuild = this.barVisible(
      getEntityHudToggle(type, 'buildBars'), selected, mode, buildInProgress,
    );
    this.bodyHudPacket.pushEntity(entity, forceVisible, showHealth, showBuild);
  }

  private populateBodyNamePacket(entities: readonly Entity[], mode: SelectionHudMode): void {
    for (const entity of entities) {
      this.pushBodyNamesForEntity(entity, mode);
    }
  }

  private pushBodyNamesForEntity(entity: Entity, mode: SelectionHudMode): void {
    const type = this.hudTypeOf(entity);
    const nameToggle = type === 'unit'
      ? getEntityHudToggle('unit', 'name')
      : type === 'tower'
        ? getEntityHudToggle('tower', 'name')
        : getEntityHudToggle('building', 'name');
    const bodyName = resolveEntityDisplayName(entity, nameToggle, mode);
    if (bodyName !== null) {
      this.pieceNamePacket.push(
        entity.id,
        PIECE_TAG_BODY,
        entity.transform.x,
        entity.unit ? getUnitHudNameY(entity) : getBuildingHudNameY(entity),
        entity.transform.y,
        bodyName,
      );
    }
    const ownerName = resolveCommanderOwnerName(entity, this.lookupPlayerDisplayName, nameToggle, mode);
    if (ownerName !== null) {
      this.pieceNamePacket.push(
        entity.id,
        PIECE_TAG_COMMANDER_OWNER_NAME,
        entity.transform.x,
        getUnitHudNameY(entity) + NAME_LABEL_OWNER_Y_OFFSET,
        entity.transform.y,
        ownerName,
        'owner',
      );
    }
  }

  private populateTurretNamePacket(hosts: readonly Entity[], mode: SelectionHudMode): void {
    for (const host of hosts) {
      this.pushTurretNamesForEntity(host, mode);
    }
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

  private populateContactShadowPacket(
    units: readonly Entity[],
    buildings: readonly Entity[],
  ): void {
    const packet = this.contactShadowPacket;
    const mapWidth = this.clientViewState.getMapWidth();
    const mapHeight = this.clientViewState.getMapHeight();
    for (const unit of units) {
      packet.pushUnit(unit, mapWidth, mapHeight, this.renderScope);
    }
    for (const building of buildings) {
      packet.pushBuilding(building, this.renderScope);
    }
  }

  private populateGroundPrintPacket(units: readonly Entity[]): void {
    const packet = this.groundPrintPacket;
    const mapWidth = this.clientViewState.getMapWidth();
    const mapHeight = this.clientViewState.getMapHeight();
    for (const unit of units) {
      packet.pushUnit(unit, this.getGroundPrintLocomotionMesh, mapWidth, mapHeight);
    }
  }

  private entityInRenderScope(entity: Entity): boolean {
    const unit = entity.unit;
    if (unit) {
      const radius = unit.radius.visual ?? unit.radius.hitbox ?? 100;
      return this.renderScope.inScope(entity.transform.x, entity.transform.y, Math.max(350, radius));
    }
    const building = entity.building;
    if (building) {
      const radius = Math.max(building.width, building.height) * 0.75;
      return this.renderScope.inScope(entity.transform.x, entity.transform.y, Math.max(200, radius));
    }
    return this.renderScope.inScope(entity.transform.x, entity.transform.y, 100);
  }

  private entityNeedsBodyHud(entity: Entity): boolean {
    const buildInProgress = isBuildInProgress(entity.buildable);
    if (buildInProgress) return true;
    const unit = entity.unit;
    if (unit) return unit.hp > 0 && unit.hp < unit.maxHp;
    const building = entity.building;
    return building !== null && building.hp > 0 && building.hp < building.maxHp;
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
