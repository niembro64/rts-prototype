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
import type { ShieldRenderer3D } from '../../render3d/ShieldRenderer3D';
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
import type { HealthBar3D } from '../../render3d/HealthBar3D';
import type { NameLabel3D } from '../../render3d/NameLabel3D';
import { PIECE_TAG_COMMANDER_OWNER_NAME } from '../../render3d/NameLabel3D';
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
  unitsAndBuildings: readonly Entity[];
  hudEntities: readonly Entity[];
  armedEntities: readonly Entity[];
  shieldUnits: readonly Entity[];
  projectiles: readonly Entity[];
  contactShadows: ContactShadowRenderPacket3D;
  groundPrints: GroundPrintRenderPacket3D;
};

type RenderPhaseEntityListOptions = {
  includeUnitsAndBuildings: boolean;
  includeHudEntities: boolean;
  includeArmedEntities: boolean;
  includeShieldUnits: boolean;
  includeProjectiles: boolean;
  includeContactShadows: boolean;
  includeGroundPrints: boolean;
};

const EMPTY_ENTITY_LIST: readonly Entity[] = [];

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
  private readonly scopedUnitsAndBuildingsScratch: Entity[] = [];
  private readonly scopedHudEntitiesScratch: Entity[] = [];
  private readonly scopedArmedEntitiesScratch: Entity[] = [];
  private readonly scopedShieldUnitsScratch: Entity[] = [];
  private readonly scopedProjectilesScratch: Entity[] = [];
  private readonly contactShadowPacket = new ContactShadowRenderPacket3D();
  private readonly groundPrintPacket = new GroundPrintRenderPacket3D();
  private readonly renderEntityLists: RenderPhaseEntityLists = {
    units: [],
    buildings: [],
    unitsAndBuildings: [],
    hudEntities: [],
    armedEntities: [],
    shieldUnits: [],
    projectiles: [],
    contactShadows: this.contactShadowPacket,
    groundPrints: this.groundPrintPacket,
  };
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private readonly nameLabelAnchorScratch = { x: 0, y: 0, z: 0 };
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
    return this.resources.environmentPropRenderer?.isReady() ?? true;
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
    const updateContactShadowsThisFrame =
      contactShadowRenderer?.shouldUpdate(this.renderFrameIndex) ?? false;
    const entityLists = this.prepareEntityLists({
      includeUnitsAndBuildings: bodyNamesEnabled,
      includeHudEntities: updateEntityHudThisFrame && healthBar3D !== null,
      includeArmedEntities: turretNamesEnabled,
      includeShieldUnits: turretShieldSpheresEnabled,
      includeProjectiles: shotNamesEnabled,
      includeContactShadows:
        contactShadowRenderer?.shouldBuildPacket(this.renderFrameIndex) ?? false,
      includeGroundPrints: updateEffectsThisFrame,
    });
    if (contactShadowRenderer && updateContactShadowsThisFrame) {
      contactShadowRenderer.update(entityLists.contactShadows, this.renderFrameIndex);
    }
    // The whole-map build-grid visualization (terrain-shader red/green/blue
    // overlay + matching blue squares above each deposit coin) is gated
    // solely to the DEBUG: BUILD toggle. The build-mode hover footprint is
    // a separate, localized signal owned by BuildGhost3D's setTarget path.
    const inputManager = this.getInputManager();
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
      for (const u of entityLists.shieldUnits) {
        shieldRenderer.perUnit(u);
      }
    }
    shieldRenderer.endFrame();

    const hoveredEntity = inputManager?.getHoveredEntity() ?? null;
    if (updateEntityHudThisFrame) {
      this.drawEntityHud(healthBar3D, nameLabel3D, hudFrustum, hoveredEntity, entityLists);
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
    const contactShadows = this.contactShadowPacket;
    const groundPrints = this.groundPrintPacket;
    contactShadows.reset();
    groundPrints.reset();
    if (this.renderScope.getMode() === 'all') {
      lists.units = this.clientViewState.getUnits();
      lists.buildings = this.clientViewState.getBuildings();
      lists.unitsAndBuildings = options.includeUnitsAndBuildings
        ? this.clientViewState.getUnitsAndBuildings()
        : EMPTY_ENTITY_LIST;
      lists.hudEntities = options.includeHudEntities
        ? this.clientViewState.getHudEntities()
        : EMPTY_ENTITY_LIST;
      lists.armedEntities = options.includeArmedEntities
        ? this.clientViewState.getArmedEntities()
        : EMPTY_ENTITY_LIST;
      lists.shieldUnits = options.includeShieldUnits
        ? this.clientViewState.getShieldUnits()
        : EMPTY_ENTITY_LIST;
      lists.projectiles = options.includeProjectiles
        ? this.clientViewState.getProjectiles()
        : EMPTY_ENTITY_LIST;
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
    const unitsAndBuildings = this.scopedUnitsAndBuildingsScratch;
    const hudEntities = this.scopedHudEntitiesScratch;
    const armedEntities = this.scopedArmedEntitiesScratch;
    const shieldUnits = this.scopedShieldUnitsScratch;
    const projectiles = this.scopedProjectilesScratch;
    units.length = 0;
    buildings.length = 0;
    unitsAndBuildings.length = 0;
    hudEntities.length = 0;
    armedEntities.length = 0;
    shieldUnits.length = 0;
    projectiles.length = 0;

    const scope = this.renderScope;
    for (const entity of this.clientViewState.getUnitsAndBuildings()) {
      if (!this.entityInRenderScope(entity)) continue;
      if (options.includeUnitsAndBuildings) unitsAndBuildings.push(entity);
      if (entity.unit) units.push(entity);
      else if (entity.building) buildings.push(entity);
      if (options.includeHudEntities && this.entityNeedsBodyHud(entity)) {
        hudEntities.push(entity);
      }
      if ((options.includeArmedEntities || options.includeShieldUnits) && entity.combat) {
        let hasCombatTurret = false;
        let hasShield = false;
        const turrets = entity.combat.turrets;
        for (let i = 0; i < turrets.length; i++) {
          const turret = turrets[i];
          if (turret.config.visualOnly) continue;
          hasCombatTurret = true;
          const shot = turret.config.shot;
          if (shot !== undefined && shot.type === 'shield' && shot.barrier !== undefined) {
            hasShield = true;
          }
          if (hasCombatTurret && hasShield) break;
        }
        if (options.includeArmedEntities && hasCombatTurret) armedEntities.push(entity);
        if (options.includeShieldUnits && hasShield && entity.unit) shieldUnits.push(entity);
      }
    }

    if (options.includeProjectiles) {
      for (const projectile of this.clientViewState.getProjectiles()) {
        if (scope.inScope(projectile.transform.x, projectile.transform.y, 100)) {
          projectiles.push(projectile);
        }
      }
    }

    lists.units = units;
    lists.buildings = buildings;
    lists.unitsAndBuildings = unitsAndBuildings;
    lists.hudEntities = hudEntities;
    lists.armedEntities = armedEntities;
    lists.shieldUnits = shieldUnits;
    lists.projectiles = projectiles;
    if (options.includeContactShadows) {
      this.populateContactShadowPacket(units, buildings);
    }
    if (options.includeGroundPrints) {
      this.populateGroundPrintPacket(units);
    }
    return lists;
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

  /** Drive every HUD bar + name pass for the frame from the live HUD
   *  config: body bars (unit/tower/building) from getHudEntities(),
   *  turret bars/names from getArmedEntities(), locomotion bars
   *  from getHudEntities() units, and (only if any shot toggle is on)
   *  shot bars/names from the projectile list. Selection is read from
   *  the live entity ref here, never from a cached filter. */
  private drawEntityHud(
    healthBar3D: HealthBar3D | null,
    nameLabel3D: NameLabel3D | null,
    hudFrustum: THREE.Frustum | undefined,
    hoveredEntity: Entity | null,
    entityLists: RenderPhaseEntityLists,
  ): void {
    if (!healthBar3D && !nameLabel3D) return;
    const mode = getSelectionHudMode();
    const lookup = this.lookupPlayerDisplayName;

    const shotNameToggle = getEntityHudToggle('shot', 'name');
    const unitNameToggle = getEntityHudToggle('unit', 'name');
    const towerNameToggle = getEntityHudToggle('tower', 'name');
    const buildingNameToggle = getEntityHudToggle('building', 'name');
    const bodyNamesEnabled = unitNameToggle || towerNameToggle || buildingNameToggle;

    if (healthBar3D) healthBar3D.beginFrame(this.hudFade, hudFrustum);
    if (nameLabel3D) nameLabel3D.beginFrame(this.hudFade, hudFrustum);

    // ── Body bars + names (unit / tower / building) ──
    for (const e of entityLists.hudEntities) {
      const type = this.hudTypeOf(e);
      const selected = e.selectable?.selected === true;
      const forceVisible = e === hoveredEntity;
      const buildInProgress = isBuildInProgress(e.buildable);
      const hp = e.unit ? e.unit.hp : e.building ? e.building.hp : 0;
      const maxHp = e.unit ? e.unit.maxHp : e.building ? e.building.maxHp : 0;
      const healthNotFull = maxHp > 0 && hp < maxHp;
      const showHealth = this.barVisible(
        getEntityHudToggle(type, 'healthBar'), selected, mode, healthNotFull,
      );
      // Build bars are construction paid/required progress only; once
      // complete the buildable is gone and the bars are hidden.
      const showBuild = this.barVisible(
        getEntityHudToggle(type, 'buildBars'), selected, mode, buildInProgress,
      );
      if (healthBar3D && (showHealth || showBuild || forceVisible)) {
        if (e.unit) healthBar3D.perUnit(e, forceVisible, showHealth, showBuild);
        else if (e.building) healthBar3D.perBuilding(e, forceVisible, showHealth, showBuild);
      }
    }

    // Hovered entity forces its body HEALTH bar on even when full-HP /
    // toggle-off, matching the legacy hover behavior. It may not be in
    // getHudEntities() (full HP, not building); the renderer's packed
    // dedup key makes a second call a no-op if it already drew above.
    if (healthBar3D && hoveredEntity) {
      if (hoveredEntity.unit) healthBar3D.perUnit(hoveredEntity, true);
      else if (hoveredEntity.building) healthBar3D.perBuilding(hoveredEntity, true);
    }

    // Body NAMES iterate every unit/building (names show even at full
    // HP). Commander owners get a separate styled label so the body
    // label stays a blueprint name.
    if (nameLabel3D && bodyNamesEnabled) {
      for (const e of entityLists.unitsAndBuildings) {
        const type = this.hudTypeOf(e);
        const nameToggle = type === 'unit'
          ? unitNameToggle
          : type === 'tower'
            ? towerNameToggle
            : buildingNameToggle;
        const name = resolveEntityDisplayName(e, nameToggle, mode);
        if (name !== null) nameLabel3D.perEntity(e, name);
        const ownerName = resolveCommanderOwnerName(e, lookup, nameToggle, mode);
        if (ownerName !== null) {
          nameLabel3D.perPieceName(
            e,
            PIECE_TAG_COMMANDER_OWNER_NAME,
            this.setNameLabelAnchor(
              e.transform.x,
              getUnitHudNameY(e) + NAME_LABEL_OWNER_Y_OFFSET,
              e.transform.y,
            ),
            ownerName,
            'owner',
          );
        }
      }
    }

    // ── Turret names ──
    const turretNameToggle = getEntityHudToggle('turret', 'name');
    if (turretNameToggle) {
      const entityRenderer = this.resources.entityRenderer;
      for (const host of entityLists.armedEntities) {
        const turrets = host.combat?.turrets;
        if (!turrets) continue;
        for (let i = 0; i < turrets.length; i++) {
          const turret = turrets[i];
          // Skip visual-only / construction-emitter (shot === undefined)
          // and shield-emitter turrets.
          if (turret.config.visualOnly) continue;
          if (turret.config.shot === undefined) continue;
          if (turret.config.shot.type === 'shield') continue;
          const mount = entityRenderer.getTurretMountWorldState(host.id, i);
          if (mount === null) continue;
          if (nameLabel3D && turretNameToggle) {
            const name = resolveTurretName(host, turret, turretNameToggle, mode);
            if (name !== null) {
              nameLabel3D.perPieceName(
                host,
                turretPieceTag(i),
                this.setNameLabelAnchor(
                  mount.x,
                  getTurretHudNameY(mount.z, turret.config),
                  mount.y,
                ),
                name,
              );
            }
          }
        }
      }
    }

    // ── Shot names. Shot HP bars stay disabled until projectile HP
    // rides a rolling authoritative snapshot instead of spawn state.
    if (nameLabel3D && shotNameToggle) {
      for (const shot of entityLists.projectiles) {
        const proj = shot.projectile;
        if (!proj || proj.projectileType !== 'projectile' || proj.maxHp <= 0) continue;
        const name = resolveShotName(shot, shotNameToggle, mode);
        if (name !== null) {
          nameLabel3D.perPieceName(
            shot,
            PIECE_TAG_BODY,
            this.setNameLabelAnchor(
              shot.transform.x,
              getShotHudNameY(shot),
              shot.transform.y,
            ),
            name,
          );
        }
      }
    }

    if (healthBar3D) healthBar3D.endFrame();
    if (nameLabel3D) nameLabel3D.endFrame();
  }

  private setNameLabelAnchor(x: number, y: number, z: number): { x: number; y: number; z: number } {
    const anchor = this.nameLabelAnchorScratch;
    anchor.x = x;
    anchor.y = y;
    anchor.z = z;
    return anchor;
  }
}
