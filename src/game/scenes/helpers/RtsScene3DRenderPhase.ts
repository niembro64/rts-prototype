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
import type { Entity, PlayerId } from '../../sim/types';
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
import type { GroundPrint3D } from '../../render3d/GroundPrint3D';
import type { LineDrag3D } from '../../render3d/LineDrag3D';
import type { SprayRenderer3D } from '../../render3d/SprayRenderer3D';
import type { PylonTubeFlowRenderer } from '../../render3d/PylonTubeFlowRenderer';
import type { SmokeTrail3D } from '../../render3d/SmokeTrail3D';
import type { FogOfWarFog3D } from '../../render3d/FogOfWarFog3D';
import type { SightBoundaryRenderer3D } from '../../render3d/SightBoundaryRenderer3D';
import type { ContactShadowRenderer3D } from '../../render3d/ContactShadowRenderer3D';
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
      { turretShieldPanelsEnabled: serverMeta?.turretShieldPanelsEnabled ?? true },
    );
    contactShadowRenderer?.update(
      this.clientViewState.getUnits(),
      this.clientViewState.getBuildings(),
      graphicsConfig,
      this.renderFrameIndex,
      this.renderScope,
    );
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
        this.clientViewState.getUnits(),
        (e) => entityRenderer.getLocomotionMesh(e.id),
        this.groundPrintAccumMs,
        this.clientViewState.getMapWidth(),
        this.clientViewState.getMapHeight(),
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
          (flowKey, intensity) => pylonTubeFlowRenderer.enqueueTipHandoff(flowKey, intensity),
        );
      } else {
        sprayRenderer.update(
          commanderSprays,
          this.sprayAccumMs,
          pylonFreeLegSprays,
          (flowKey, intensity) => pylonTubeFlowRenderer.enqueueTipHandoff(flowKey, intensity),
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
    if (this.clientViewState.getServerMeta()?.turretShieldSpheresEnabled ?? true) {
      for (const u of this.clientViewState.getShieldUnits()) {
        shieldRenderer.perUnit(u);
      }
    }
    shieldRenderer.endFrame();

    const hoveredEntity = inputManager?.getHoveredEntity() ?? null;
    this.drawEntityHud(healthBar3D, nameLabel3D, hudFrustum, hoveredEntity);

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
  ): void {
    if (!healthBar3D && !nameLabel3D) return;
    const mode = getSelectionHudMode();
    const lookup = (pid: PlayerId): string | null =>
      this.lookupPlayerName(pid) ?? getDefaultPlayerName(pid);

    const shotNameToggle = getEntityHudToggle('shot', 'name');

    if (healthBar3D) healthBar3D.beginFrame(this.hudFade, hudFrustum);
    if (nameLabel3D) nameLabel3D.beginFrame(this.hudFade, hudFrustum);

    // ── Body bars + names (unit / tower / building) ──
    for (const e of this.clientViewState.getHudEntities()) {
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
    if (nameLabel3D) {
      for (const e of this.clientViewState.getUnitsAndBuildings()) {
        const type = this.hudTypeOf(e);
        const nameToggle = getEntityHudToggle(type, 'name');
        const name = resolveEntityDisplayName(e, nameToggle, mode);
        if (name !== null) nameLabel3D.perEntity(e, name);
        const ownerName = resolveCommanderOwnerName(e, lookup, nameToggle, mode);
        if (ownerName !== null) {
          nameLabel3D.perPieceName(
            e,
            PIECE_TAG_COMMANDER_OWNER_NAME,
            {
              x: e.transform.x,
              y: getUnitHudNameY(e) + NAME_LABEL_OWNER_Y_OFFSET,
              z: e.transform.y,
            },
            ownerName,
            'owner',
          );
        }
      }
    }

    // ── Turret bars + names ──
    const turretHealthToggle = getEntityHudToggle('turret', 'healthBar');
    const turretBuildToggle = getEntityHudToggle('turret', 'buildBars');
    const turretNameToggle = getEntityHudToggle('turret', 'name');
    if (turretHealthToggle || turretBuildToggle || turretNameToggle) {
      const entityRenderer = this.resources.entityRenderer;
      for (const host of this.clientViewState.getArmedEntities()) {
        const turrets = host.combat?.turrets;
        if (!turrets) continue;
        const selected = host.selectable?.selected === true;
        for (let i = 0; i < turrets.length; i++) {
          const turret = turrets[i];
          // Skip visual-only / construction-emitter (shot === undefined)
          // and shield-emitter turrets — they're not damageable weapon
          // bodies.
          if (turret.config.visualOnly) continue;
          if (turret.config.shot === undefined) continue;
          if (turret.config.shot.type === 'shield') continue;
          const mount = entityRenderer.getTurretMountWorldState(host.id, i);
          if (mount === null) continue;
          if (healthBar3D && (turretHealthToggle || turretBuildToggle)) {
            const healthNotFull = turret.maxHp > 0 && turret.hp < turret.maxHp;
            const buildInProgress = isBuildInProgress(host.buildable);
            const showHealth = this.barVisible(turretHealthToggle, selected, mode, healthNotFull);
            const showBuild = this.barVisible(turretBuildToggle, selected, mode, buildInProgress);
            if (showHealth || showBuild) {
              healthBar3D.perTurret(host, i, mount, false, showHealth, showBuild);
            }
          }
          if (nameLabel3D && turretNameToggle) {
            const name = resolveTurretName(host, turret, turretNameToggle, mode);
            if (name !== null) {
              nameLabel3D.perPieceName(
                host,
                turretPieceTag(i),
                { x: mount.x, y: getTurretHudNameY(mount.z, turret.config), z: mount.y },
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
      for (const shot of this.clientViewState.getProjectiles()) {
        const proj = shot.projectile;
        if (!proj || proj.projectileType !== 'projectile' || proj.maxHp <= 0) continue;
        const name = resolveShotName(shot, shotNameToggle, mode);
        if (name !== null) {
          nameLabel3D.perPieceName(
            shot,
            PIECE_TAG_BODY,
            { x: shot.transform.x, y: getShotHudNameY(shot), z: shot.transform.y },
            name,
          );
        }
      }
    }

    if (healthBar3D) healthBar3D.endFrame();
    if (nameLabel3D) nameLabel3D.endFrame();
  }
}
