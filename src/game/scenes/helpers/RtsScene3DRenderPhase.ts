import * as THREE from 'three';
import {
  getFogShade,
  getEntityShadows,
  getForceFieldsVisible,
  getRadarBoundary,
  getSightBoundary,
  getEntityHudToggle,
  getSelectionHudMode,
  getWindParticles,
  writeFogShadePresentationSettings,
} from '@/clientBarConfig';
import type { SelectionHudMode } from '@/clientBarConfig';
import { areCaptureInstrumentsHidden } from '@/game/capture/captureInstrumentGate';
import { isAttackEmitter } from '@/game/sim/emitterKinds';
import { isClientTransportUnit } from '@/game/sim/transports';
import type { GraphicsConfig } from '@/types/graphics';
import type { CameraViewBasis, SprayTarget } from '@/types/ui';
import type { ClientViewState } from '../../network/ClientViewState';
import type { ClientProjectileRenderLists } from '../../network/ClientProjectileStore';
import type { ContactBlipRenderer3D } from '../../render3d/ContactBlipRenderer3D';
import { featureVisibleAtRung } from '../../render3d/EntityDetailLevel3D';
import type { Entity, EntityId, PlayerId } from '../../sim/types';
import type { ThreeApp } from '../../render3d/ThreeApp';
import { isPresentationAnimationPaused } from '../../render3d/presentationClock';
import type { Render3DEntities } from '../../render3d/Render3DEntities';
import type { Input3DManager } from '../../render3d/Input3DManager';
import type { BeamRenderer3D } from '../../render3d/BeamRenderer3D';
import {
  ShieldRenderPacket3D,
  type ShieldRenderer3D,
} from '../../render3d/ShieldRenderer3D';
import type { TerrainTileRenderer3D } from '../../render3d/TerrainTileRenderer3D';
import type { BuildGhost3D } from '../../render3d/BuildGhost3D';
import type { EnvironmentPropRenderer3D } from '../../render3d/EnvironmentPropRenderer3D';
import type { WaterRenderer3D } from '../../render3d/WaterRenderer3D';
import type { ShieldImpactRenderer3D } from '../../render3d/ShieldImpactRenderer3D';
import type { WaterSplash3D } from '../../render3d/WaterSplash3D';
import type { WindParticleField3D } from '../../render3d/WindParticleField3D';
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
import type { SurfaceLiftProbeOverlay3D } from '../../render3d/SurfaceLiftProbeOverlay3D';
import type { LineDrag3D } from '../../render3d/LineDrag3D';
import type { SprayRenderer3D } from '../../render3d/SprayRenderer3D';
import type { PylonTubeFlowRenderer } from '../../render3d/PylonTubeFlowRenderer';
import type { SmokeTrail3D } from '../../render3d/SmokeTrail3D';
import type { SightBoundaryRenderer3D } from '../../render3d/SightBoundaryRenderer3D';
import type { OverlayLineSystem } from '../../render3d/OverlayLineSystem';
import {
  EntityShadowRenderPacket3D,
} from '../../render3d/EntityShadowRenderPacket3D';
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
  getShotHudBarsY,
} from '../../render3d/HudAnchor';
import {
  ENTITY_HUD_FADE_START_DISTANCE_FRAC,
  ENTITY_HUD_FADE_END_DISTANCE_FRAC,
  ENTITY_SHADOW_RENDER_CONFIG,
} from '@/config';
import type {
  RenderFrameState3D,
  RenderViewState3D,
} from '../../render3d/RenderFrameState3D';
import type { FootprintBounds, FootprintQuad, ViewportFootprint } from '../../ViewportFootprint';
import type { RtsScene3DCameraFootprintSystem } from './RtsScene3DCameraFootprintSystem';
import type { RtsScene3DSelectionSystem } from './RtsScene3DSelectionSystem';
import { EntityLodState3D } from '../../render3d/EntityLod3D';

/** LOD proxy-row counts are telemetry only the performance harness reads —
 *  two full row walks per frame otherwise consumed by nobody. The harness
 *  flips this on for the duration of a capture. */
export const RENDER_PHASE_PROXY_ROW_TELEMETRY = { enabled: false };

type RtsScene3DRenderPhaseResources = {
  entityRenderer: Render3DEntities;
  beamRenderer: BeamRenderer3D;
  shieldRenderer: ShieldRenderer3D;
  terrainTileRenderer: TerrainTileRenderer3D;
  buildGhostRenderer: BuildGhost3D;
  environmentPropRenderer: EnvironmentPropRenderer3D | null;
  waterRenderer: WaterRenderer3D;
  shieldImpactRenderer: ShieldImpactRenderer3D;
  waterSplashRenderer: WaterSplash3D;
  burnMarkRenderer: BurnMark3D;
  groundPrintRenderer: GroundPrint3D;
  areaDragRenderer: AreaDrag3D;
  airLiftProbeOverlay: SurfaceLiftProbeOverlay3D;
  lineDragRenderer: LineDrag3D;
  sprayRenderer: SprayRenderer3D;
  pylonTubeFlowRenderer: PylonTubeFlowRenderer;
  smokeTrailRenderer: SmokeTrail3D;
  windParticleFieldRenderer: WindParticleField3D;
  overlayLineSystem: OverlayLineSystem;
  sightBoundaryRenderer: SightBoundaryRenderer3D;
  radarBoundaryRenderer: SightBoundaryRenderer3D;
  contactBlipRenderer: ContactBlipRenderer3D;
  healthBar3D: HealthBar3D | null;
  nameLabel3D: NameLabel3D | null;
  waypoint3D: Waypoint3D | null;
};

type RtsScene3DRenderPhaseResult = {
  cameraQuad: FootprintQuad;
  cameraView: CameraViewBasis;
  renderMs: number;
};

type RtsScene3DRenderPhaseTimings = {
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
  entityShadows: EntityShadowRenderPacket3D;
  groundPrints: GroundPrintRenderPacket3D;
};

type RenderPhaseEntityListOptions = {
  includeBodyHud: boolean;
  includeBodyNames: boolean;
  includeShields: boolean;
  shieldVisibilityTeamMask: number;
  includeEntityShadows: boolean;
  includeGroundPrints: boolean;
  hoveredEntity: Entity | null;
};

/** Shared empty selection used while a clean capture suppresses the
 *  selection-driven instruments (waypoints, lift probes). */
const EMPTY_CAPTURE_SELECTION: readonly Entity[] = [];

export class RtsScene3DRenderPhase {
  private renderFrameIndex = 0;
  private lastEffectsTickMs = 0;
  private burnMarkAccumMs = 0;
  private shieldImpactAccumMs = 0;
  private waterSplashAccumMs = 0;
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
  private readonly entityShadowPacket = new EntityShadowRenderPacket3D();
  private readonly groundPrintPacket = new GroundPrintRenderPacket3D();
  private readonly unitRenderPacket = new UnitRenderPacket3D();
  private readonly buildingRenderPacket = new BuildingRenderPacket3D();
  private readonly entityLod = new EntityLodState3D();
  /** The active frame's shared LOD view. Every visual channel consults this
   * rather than a second distance-only emission cutoff. */
  private currentLodView: RenderViewState3D | null = null;
  private readonly renderEntityLists: RenderPhaseEntityLists = {
    unitRows: this.unitRenderPacket,
    buildingRows: this.buildingRenderPacket,
    bodyHud: this.bodyHudPacket,
    shields: this.shieldPacket,
    pieceNames: this.pieceNamePacket,
    entityShadows: this.entityShadowPacket,
    groundPrints: this.groundPrintPacket,
  };
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private readonly enqueuePylonTubeHandoff = (flowKey: string, intensity: number): void => {
    this.resources.pylonTubeFlowRenderer.enqueueTipHandoff(flowKey, intensity);
  };
  private readonly getGroundPrintLocomotionMesh = (entityId: EntityId) =>
    this.resources.entityRenderer.getLocomotionMesh(entityId);
  // Per-frame LOD callbacks hoisted to stable instance closures so the
  // render phase does not allocate them (and the callees can stay
  // monomorphic). They read `currentLodView`, which run() assigns from
  // the frame state before any of them can fire.
  private readonly isEntityEmissionFarLodRef = (entity: Entity): boolean =>
    this.entityEmissionUsesFarLod(entity);
  private readonly isEntityFarLodRef = (entity: Entity): boolean =>
    this.currentLodView !== null && this.entityUsesFarLod(entity, this.currentLodView);
  private readonly entityDetailRungRef = (entity: Entity) =>
    this.entityLod.entityDetailRungForView(this.currentLodView!, entity);
  private readonly isEntityHudRungVisibleRef = (entity: Entity): boolean => {
    const view = this.currentLodView;
    if (view === null) return true;
    return featureVisibleAtRung(
      'healthBar',
      this.entityLod.entityDetailRungForView(view, entity),
    );
  };
  private readonly isEntityNameRungVisibleRef = (entity: Entity): boolean => {
    const view = this.currentLodView;
    if (view === null) return true;
    return featureVisibleAtRung(
      'nameLabel',
      this.entityLod.entityDetailRungForView(view, entity),
    );
  };
  private readonly entityLodProxyFadeAlphaRef = (entity: Entity) =>
    this.entityLod.entityLodProxyFadeAlphaForView(this.currentLodView!, entity);
  /** Reused argument packet for entityRenderer.update; consumed
   *  synchronously by the callee every frame. */
  private readonly entityRendererPacket = {
    unitRows: this.unitRenderPacket,
    buildingRows: this.buildingRenderPacket,
    projectileRenderProjectiles: [] as readonly Entity[],
    lineProjectiles: [] as readonly Entity[],
    isEntityEmissionFarLod: this.isEntityEmissionFarLodRef,
    entityDetailRung: this.entityDetailRungRef,
    entityLodProxyFadeAlpha: this.entityLodProxyFadeAlphaRef,
    shieldVisibilityTeamMask: 0,
    scoped: false,
  };
  private readonly entityRendererOverlayModes = {
    reclaimTargets: false,
    hoveredEntityId: null as EntityId | null,
    /** transport id -> carried unit's volume radius, from the live beam
     *  sprays; drives the ring's presentation-only carry expansion. */
    carryExpansionBySourceId: null as ReadonlyMap<EntityId, number> | null,
    /** Passenger ids held in a tractor beam — locomotion rigs must hang,
     *  not walk, while the carrier drags them. */
    beamCarriedEntityIds: null as ReadonlySet<EntityId> | null,
    /** transport id -> passenger id, for the gravity-beam blob volume. */
    beamPairsByTransportId: null as ReadonlyMap<EntityId, EntityId> | null,
  };
  private _sprayRelationTick = -1;
  private _sprayRelationSetVersion = -1;
  private readonly _carryExpansionScratch = new Map<EntityId, number>();
  private readonly _beamCarriedScratch = new Set<EntityId>();
  private readonly _beamPairsScratch = new Map<EntityId, EntityId>();
  private readonly _spraysSansBeams: SprayTarget[] = [];
  private readonly terrainFogShadeScratch = {
    unseenDarkness: 0,
    radarDarkness: 0,
    unseenDesaturation: 0,
    radarDesaturation: 0,
    enabled: false,
  };
  private readonly terrainUpdateOptions = {
    localPlayerId: 0 as PlayerId,
    fogShade: this.terrainFogShadeScratch,
    entityShadows: this.entityShadowPacket,
    visibleBounds: null as unknown as FootprintBounds,
    updateWorldShadeCoverage: true,
  };
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

  /** Wall-clock value held for the shield lattice during a pause. */
  private pausedShieldTimeMs: number | null = null;

  constructor(
    private readonly threeApp: ThreeApp,
    private readonly clientViewState: ClientViewState,
    private readonly renderScope: ViewportFootprint,
    private readonly cameraFootprintSystem: RtsScene3DCameraFootprintSystem,
    private readonly selectionSystem: RtsScene3DSelectionSystem,
    private readonly resources: RtsScene3DRenderPhaseResources,
    private readonly getLocalPlayerId: () => PlayerId,
    /** True while a spectator views the whole battle. Everything
     *  perspective-shaped in this phase — fog shade, sight/radar rings,
     *  shield visibility — must go wide open rather than borrowing the
     *  view seat's perspective. */
    private readonly getWatchingAll: () => boolean,
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

  resetEffectAccumulators(): void {
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
      environmentPropRenderer,
      waterRenderer,
      shieldImpactRenderer,
      waterSplashRenderer,
      burnMarkRenderer,
      groundPrintRenderer,
      areaDragRenderer,
      airLiftProbeOverlay,
      lineDragRenderer,
      sprayRenderer,
      pylonTubeFlowRenderer,
      smokeTrailRenderer,
      windParticleFieldRenderer,
      overlayLineSystem,
      sightBoundaryRenderer,
      radarBoundaryRenderer,
      contactBlipRenderer,
      healthBar3D,
      nameLabel3D,
      waypoint3D,
    } = this.resources;
    const timings = this.lastPhaseTimings;
    let phaseMark = renderStart;

    const hudFrameStride = Math.max(1, graphicsConfig.hudFrameStride | 0);
    const effectFrameStride = Math.max(1, graphicsConfig.effectFrameStride | 0);
    const updateHudThisFrame = hudFrameStride <= 1 || this.renderFrameIndex % hudFrameStride === 0;
    const updateEffectsThisFrame = effectFrameStride <= 1 || this.renderFrameIndex % effectFrameStride === 0;
    // Clean-capture gate: while a no-HUD screenshot/recording is live, every
    // in-canvas instrument (bars, labels, overlay lines, waypoints, probes)
    // is suppressed. Level-triggered — read fresh each frame, so the gate
    // dropping restores everything on the very next frame. Contact blips and
    // the fog shade stay: sensor truth is world, not instrumentation.
    const captureClean = areCaptureInstrumentsHidden();
    // Body bars are motion anchors, not just HUD content. They must follow
    // fast units every render frame even when the budget throttles heavier HUD
    // work with hudFrameStride; otherwise flyers visibly jump between stale and
    // current bar positions.
    const updateNameHudThisFrame = !captureClean && updateHudThisFrame && nameLabel3D !== null;
    const updateBodyHudThisFrame = !captureClean && healthBar3D !== null;
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
    this.currentLodView = renderFrameState.view;
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
    environmentPropRenderer?.update(renderFrameState.view);
    this.getCameraQuadUpdate()?.(
      cameraQuad,
      this.threeApp.orbit.yaw,
      this.threeApp.orbit.pitch,
      cameraView,
    );

    const serverMeta = this.clientViewState.getServerMeta();
    // A watcher on ALL sees the whole map: the sim's fog stays authoritative
    // and hashed (lockstep never turns it off), but this client renders no
    // shade over it. Following one seat restores that seat's exact view.
    const watchingAll = this.getWatchingAll();
    const fogOfWarEnabled = serverMeta?.fogOfWarEnabled === true && !watchingAll;
    const turretShieldSpheresEnabled = serverMeta?.turretShieldSpheresEnabled ?? true;
    const forceFieldsVisible = getForceFieldsVisible();
    windParticleFieldRenderer.update(
      getWindParticles() ? serverMeta?.wind : undefined,
      effectDtMs,
      renderFrameState.view,
    );
    // Keep every overlay line's screen-pixel width correct for the current
    // canvas size (one shared material drives all of them).
    const overlaySize = this.threeApp.renderer.getSize(this._overlayResolution);
    overlayLineSystem.setResolution(overlaySize.x, overlaySize.y);
    overlayLineSystem.setSuppressed(captureClean);
    // Sight/radar rings trace ONE seat's sensor perspective; on ALL there is
    // no such seat, so they draw nothing rather than the view seat's rings.
    sightBoundaryRenderer.update(
      this.clientViewState,
      this.getLocalPlayerId(),
      getSightBoundary() && !watchingAll,
      this.renderScope,
    );
    radarBoundaryRenderer.update(
      this.clientViewState,
      this.getLocalPlayerId(),
      getRadarBoundary() && !watchingAll,
      this.renderScope,
    );
    // Contact-only enemies are drawn as generic blips here, from the same
    // contact rows the minimap uses. They are deliberately NOT part of the
    // entity render path: a contact has no blueprint to draw.
    contactBlipRenderer.update(
      this.clientViewState.getMinimapEntitiesOverride(),
      this.clientViewState.getMinimapContactSampling(performance.now()),
      this.renderScope,
      effectDtMs,
    );
    const inputManager = this.getInputManager();
    // Resolved once per frame and handed to BOTH force-material renderers.
    const shieldVisibilityTeamMask = this.resolveShieldVisibilityTeamMask();
    const hoveredEntity = captureClean ? null : (inputManager?.getHoveredEntity() ?? null);
    const bodyHudEnabled = updateBodyHudThisFrame &&
      (
        hoveredEntity !== null ||
        getEntityHudToggle('unit', 'healthBar') ||
        getEntityHudToggle('tower', 'healthBar') ||
        getEntityHudToggle('building', 'healthBar')
      );
    // Rocket-class travelling shots carry real HP (they can be shot down),
    // so they get body health bars too. Their rows are appended by this
    // phase directly — shots never enter the entity render-state slabs.
    const shotBarsEnabled = updateBodyHudThisFrame &&
      getEntityHudToggle('shot', 'healthBar');
    const entityLists = this.prepareEntityLists({
      includeBodyHud: bodyHudEnabled || shotBarsEnabled,
      includeBodyNames: bodyNamesEnabled,
      includeShields: turretShieldSpheresEnabled && forceFieldsVisible,
      shieldVisibilityTeamMask,
      includeEntityShadows:
        ENTITY_SHADOW_RENDER_CONFIG.enabled && getEntityShadows(),
      includeGroundPrints: updateEffectsThisFrame,
      hoveredEntity,
    }, selectionHudMode, renderFrameState.view);
    phaseNow = performance.now();
    timings.entityPacketMs = phaseNow - phaseMark;
    phaseMark = phaseNow;
    // Beams own a real Low imposter segment, so they must reach the beam
    // renderer at every distance. Its LOD resolver selects fidelity there.
    const lineProjectiles = projectileLists.line;
    const rendererPacket = this.entityRendererPacket;
    rendererPacket.unitRows = entityLists.unitRows;
    rendererPacket.buildingRows = entityLists.buildingRows;
    rendererPacket.projectileRenderProjectiles = projectileLists.traveling;
    rendererPacket.lineProjectiles = lineProjectiles;
    rendererPacket.scoped = this.renderScope.getMode() !== 'all';
    // Mirror panels are drawn by the unit renderer rather than the shield
    // renderer (they are unit-scale mounted hardware, not world-scale field
    // geometry), so the same visibility answer has to reach both.
    rendererPacket.shieldVisibilityTeamMask = shieldVisibilityTeamMask;
    this.entityRendererOverlayModes.reclaimTargets =
      (inputManager?.isInReclaimMode() ?? false) ||
      (inputManager?.isInCaptureMode() ?? false);
    this.entityRendererOverlayModes.hoveredEntityId = hoveredEntity?.id ?? null;
    // A spray SOURCED from a transport is always its attraction beam
    // (transports own no build power), so the beam list doubles as the
    // carry-expansion channel with no extra wire state.
    // P1-28: spray topology only changes when authoritative state lands
    // (snapshot/tick) or entities come and go — rebuild the relation maps
    // on those signals rather than every display frame.
    const sprayRelationTick = this.clientViewState.getTick();
    const sprayRelationSetVersion = this.clientViewState.getEntitySetVersion();
    if (
      sprayRelationTick !== this._sprayRelationTick ||
      sprayRelationSetVersion !== this._sprayRelationSetVersion
    ) {
      this._sprayRelationTick = sprayRelationTick;
      this._sprayRelationSetVersion = sprayRelationSetVersion;
      this._carryExpansionScratch.clear();
      this._beamCarriedScratch.clear();
      this._beamPairsScratch.clear();
      const beamSprays = this.clientViewState.getSprayTargets();
      for (let i = 0; i < beamSprays.length; i++) {
        const spray = beamSprays[i];
        const source = this.clientViewState.getEntity(spray.source.id);
        if (!isClientTransportUnit(source)) continue;
        this._carryExpansionScratch.set(spray.source.id, spray.target.radius ?? 0);
        this._beamCarriedScratch.add(spray.target.id);
        this._beamPairsScratch.set(spray.source.id, spray.target.id);
      }
    }
    this.entityRendererOverlayModes.carryExpansionBySourceId =
      this._carryExpansionScratch.size > 0 ? this._carryExpansionScratch : null;
    this.entityRendererOverlayModes.beamCarriedEntityIds =
      this._beamCarriedScratch.size > 0 ? this._beamCarriedScratch : null;
    this.entityRendererOverlayModes.beamPairsByTransportId =
      this._beamPairsScratch.size > 0 ? this._beamPairsScratch : null;
    entityRenderer.update(
      renderFrameState,
      (serverMeta?.turretShieldPanelsEnabled ?? true) && forceFieldsVisible,
      rendererPacket,
      this.entityRendererOverlayModes,
    );
    airLiftProbeOverlay.update(
      captureClean ? EMPTY_CAPTURE_SELECTION : this.selectionSystem.getSelectedUnits(),
    );
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
    if (shotBarsEnabled) {
      this.populateShotHealthBarPacket(projectileLists.traveling, entityLists.bodyHud);
    }
    if (turretNamesEnabled) {
      this.populateRenderListTurretNamePacket(entityLists, selectionHudMode);
    }
    // Whole-map cell overlays (DEBUG: BUILD / METAL / WATER and CLIENT PATH)
    // are baked directly onto the terrain AND metal-deposit coin surfaces by
    // the shared BuildGridOverlayShader inside terrainTileRenderer.update().
    // The build-mode hover footprint is a separate, localized signal owned by
    // BuildGhost3D's setTarget path.
    writeFogShadePresentationSettings(this.terrainFogShadeScratch);
    this.terrainFogShadeScratch.enabled = fogOfWarEnabled && getFogShade();
    this.terrainUpdateOptions.localPlayerId = this.getLocalPlayerId();
    this.terrainUpdateOptions.entityShadows = entityLists.entityShadows;
    this.terrainUpdateOptions.visibleBounds = this.renderScope.getBounds();
    this.terrainUpdateOptions.updateWorldShadeCoverage = updateEffectsThisFrame;
    terrainTileRenderer.update(
      graphicsConfig,
      renderFrameState,
      this.terrainUpdateOptions,
    );
    phaseNow = performance.now();
    timings.terrainMs = phaseNow - phaseMark;
    phaseMark = phaseNow;

    beamRenderer.update(
      lineProjectiles,
      graphicsConfig,
      this.clientViewState.getLineProjectileRenderVersion(),
      entityRenderer,
      this.isEntityEmissionFarLodRef,
      renderFrameState.view,
      this.entityDetailRungRef,
      effectDtMs,
    );
    phaseNow = performance.now();
    timings.beamMs = phaseNow - phaseMark;
    phaseMark = phaseNow;

    waterRenderer.update(
      effectDtMs / 1000,
      graphicsConfig,
      renderFrameState,
    );
    // P1-30: both CPU particle pools honor the effect-frame stride like the
    // neighboring burn/print/spray/smoke effects — they accumulate dt on
    // skipped frames and integrate once on effect frames.
    shieldImpactRenderer.setVisible(forceFieldsVisible);
    this.shieldImpactAccumMs += effectDtMs;
    this.waterSplashAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      if (forceFieldsVisible) {
        shieldImpactRenderer.update(
          this.shieldImpactAccumMs,
          lineProjectiles,
          renderFrameState.view,
        );
      }
      this.shieldImpactAccumMs = 0;
      waterSplashRenderer.update(this.waterSplashAccumMs, renderFrameState.view);
      this.waterSplashAccumMs = 0;
    }
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
          renderFrameState.view,
        ),
        this.nearPylonFreeLegSprays,
      );
      this._spraysSansBeams.length = 0;
      const allSprays = this.clientViewState.getSprayTargets();
      for (let i = 0; i < allSprays.length; i++) {
        if (this._beamPairsScratch.has(allSprays[i].source.id)) continue;
        this._spraysSansBeams.push(allSprays[i]);
      }
      const commanderSprays = this.filterNearLodSprays(
        this._spraysSansBeams,
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
          renderFrameState.view,
        );
      } else {
        sprayRenderer.update(
          commanderSprays,
          this.sprayAccumMs,
          pylonFreeLegSprays,
          this.enqueuePylonTubeHandoff,
          renderFrameState.view,
        );
      }
      this.sprayAccumMs = 0;
    }

    this.smokeTrailAccumMs += effectDtMs;
    if (updateEffectsThisFrame) {
      const locomotionSmokeEmitters = entityRenderer.getLocomotionSmokeEmitters();
      smokeTrailRenderer.update(
        this.filterNearLodProjectiles(
          projectileLists.smokeTrail,
          this.nearSmokeTrailProjectiles,
        ),
        this.smokeTrailAccumMs,
        this.renderFrameIndex,
        this.renderScope,
        locomotionSmokeEmitters,
        renderFrameState.view,
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
    if (bodyHudEnabled || shotBarsEnabled || bodyNamesEnabled || turretNamesEnabled || shotNamesEnabled) {
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
      // The lattice spin runs on a wall timestamp; hold it while the
      // presentation is paused so shields freeze with everything else.
      const shieldTimeMs = isPresentationAnimationPaused()
        ? (this.pausedShieldTimeMs ??= renderStart)
        : (this.pausedShieldTimeMs = null, renderStart);
      shieldRenderer.beginFrame(graphicsConfig, renderFrameState.view, shieldTimeMs);
      shieldRenderer.processPacket(entityLists.shields);
      shieldRenderer.endFrame();
    } else {
      shieldRenderer.clear();
    }

    if (bodyHudEnabled || shotBarsEnabled || bodyNamesEnabled || turretNamesEnabled || shotNamesEnabled) {
      this.drawEntityHud(
        bodyHudEnabled || shotBarsEnabled ? healthBar3D : null,
        bodyNamesEnabled || turretNamesEnabled || shotNamesEnabled ? nameLabel3D : null,
        hudFrustum,
        entityLists,
      );
    } else if (captureClean) {
      // Force an empty begin/end pass so the sprite pools hide whatever the
      // last instrumented frame left visible — the clean frame must not
      // inherit stale bars or labels.
      this.drawEntityHud(healthBar3D, nameLabel3D, hudFrustum, entityLists);
    }

    if (captureClean) {
      waypoint3D?.update(EMPTY_CAPTURE_SELECTION, EMPTY_CAPTURE_SELECTION);
    } else if (updateHudThisFrame) {
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
    if (RENDER_PHASE_PROXY_ROW_TELEMETRY.enabled) {
      timings.unitLodProxyRows = this.countLodProxyRows(entityLists.unitRows);
      timings.buildingLodProxyRows = this.countLodProxyRows(entityLists.buildingRows);
    } else {
      timings.unitLodProxyRows = 0;
      timings.buildingLodProxyRows = 0;
    }
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

  private countLodProxyRows(rows: UnitRenderPacket3D | BuildingRenderPacket3D): number {
    let count = 0;
    for (let row = 0; row < rows.count; row++) {
      if (rows.lodProxyAt(row)) count++;
    }
    return count;
  }

  /** Reused options for prepareRenderEntityPackets3D; consumed
   *  synchronously by ClientViewState. The LOD callbacks read
   *  `currentLodView`, which run() sets to the same view previously
   *  captured here per call. */
  private readonly prepareEntityListOptions = {
    renderScope: null as unknown as ViewportFootprint,
    renderView: null as RenderViewState3D | null,
    includeBodyHud: false,
    includeBodyNames: false,
    includeShields: false,
    shieldVisibilityTeamMask: 0,
    includeEntityShadows: false,
    includeGroundPrints: false,
    hoveredEntity: null as Entity | null,
    scopedUnitsOut: this.scopedUnitsScratch,
    scopedBuildingsOut: this.scopedBuildingsScratch,
    selectionHudMode: 'auto' as SelectionHudMode,
    getEntityHudToggle,
    lookupPlayerName: null as unknown as (id: PlayerId) => string | null,
    getGroundPrintLocomotionMesh: this.getGroundPrintLocomotionMesh,
    isEntityFarLod: this.isEntityFarLodRef,
    isEntityEmissionFarLod: this.isEntityEmissionFarLodRef,
    isEntityHudRungVisible: this.isEntityHudRungVisibleRef,
    isEntityNameRungVisible: this.isEntityNameRungVisibleRef,
  };

  /** Zero unless this client's side has NO switched-ON Shield Detection Lab,
   *  in which case only its own team's shields may be drawn.
   *
   *  The host already publishes which seats hold the detection channel, and
   *  the vision mask already names this client's side, so the rule is a bit
   *  test rather than a second notion of alliance on the client. A snapshot
   *  from a host that predates the field leaves the mask undefined, and that
   *  falls back to showing everything rather than blinding the player. */
  /** Whose shield surfaces this client draws, as an owner-player bitmask
   *  (0 = every owner, no restriction).
   *
   *  A side always reads its own equipment: every field this player or an
   *  ally is running is drawn unconditionally, because an unpowered shield
   *  is meant to be "a visible, reversible battlefield state that the player
   *  can read off their own army" (budget_design_philosophy.html, "Shields
   *  are powered equipment"). Reading an ENEMY's fields is what the Shield
   *  Detection Lab buys — the same per-player upgrade that switches the
   *  targeting gate on — so without it the mask narrows to this side. The
   *  local bit is OR'd in last so no vision-mask edge case can ever hide
   *  this client's own shields from it. */
  private resolveShieldVisibilityTeamMask(): number {
    const detectionMask = this.clientViewState.getServerMeta()?.shieldAwareTargetingPlayerMask;
    if (detectionMask === undefined) return 0;
    // A watcher on ALL sees every shield; a seat-scoped mask would borrow
    // the view seat's detection upgrades.
    if (this.getWatchingAll()) return 0;
    const localPlayerId = this.getLocalPlayerId();
    const localBit = localPlayerId >= 1 && localPlayerId <= 31
      ? 1 << (localPlayerId - 1)
      : 0;
    if ((detectionMask & localBit) !== 0) return 0;
    let teamMask = localBit;
    for (const playerId of this.clientViewState.getVisionPlayerIds(localPlayerId)) {
      if (playerId >= 1 && playerId <= 31) teamMask |= 1 << (playerId - 1);
    }
    // A team mask that resolved to nothing (no seated local player, e.g. a
    // spectator) would hide every shield in the match; treat that as "no
    // restriction" instead.
    return teamMask === 0 ? 0 : teamMask;
  }

  private prepareEntityLists(
    options: RenderPhaseEntityListOptions,
    mode: SelectionHudMode,
    renderView: RenderViewState3D,
  ): RenderPhaseEntityLists {
    const packetOptions = this.prepareEntityListOptions;
    packetOptions.renderScope = this.renderScope;
    packetOptions.renderView = renderView;
    packetOptions.includeBodyHud = options.includeBodyHud;
    packetOptions.includeBodyNames = options.includeBodyNames;
    packetOptions.includeShields = options.includeShields;
    packetOptions.shieldVisibilityTeamMask = options.shieldVisibilityTeamMask;
    packetOptions.includeEntityShadows = options.includeEntityShadows;
    packetOptions.includeGroundPrints = options.includeGroundPrints;
    packetOptions.hoveredEntity = options.hoveredEntity;
    packetOptions.selectionHudMode = mode;
    packetOptions.lookupPlayerName = this.lookupPlayerName;
    packetOptions.getGroundPrintLocomotionMesh = this.getGroundPrintLocomotionMesh;
    packetOptions.isEntityFarLod = this.isEntityFarLodRef;
    packetOptions.isEntityEmissionFarLod = this.isEntityEmissionFarLodRef;
    return this.clientViewState.prepareRenderEntityPackets3D(
      this.renderEntityLists,
      packetOptions,
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
    return this.currentLodView !== null &&
      this.entityUsesFarLod(entity, this.currentLodView);
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
      if (!isAttackEmitter(turret)) continue;
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
        getTurretHudNameY(mount.z, turret.presentation),
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

  /** Rocket-class shots get the same body health bar every damaged entity
   *  gets: hidden at full health, drawn while hp is down. Missiles and
   *  plasma stay bare — their hp is a collision detail, not a story the
   *  player follows across the sky. */
  private populateShotHealthBarPacket(
    projectiles: readonly Entity[],
    packet: BodyHudRenderPacket3D,
  ): void {
    const scope = this.renderScope;
    for (let i = 0; i < projectiles.length; i++) {
      const shot = projectiles[i];
      if (this.entityEmissionUsesFarLod(shot)) continue;
      if (!scope.inScope(shot.transform.x, shot.transform.y, 100)) continue;
      const proj = shot.projectile;
      if (!proj || proj.projectileType !== 'projectile' || proj.maxHp <= 0) continue;
      if (proj.config.shotProfile.runtime.type !== 'rocket') continue;
      if (proj.hp >= proj.maxHp || proj.hp <= 0) continue;
      packet.pushRow(
        shot.id,
        shot.transform.x,
        getShotHudBarsY(shot),
        shot.transform.y,
        proj.config.shotProfile.runtime.radius.other * 2,
        proj.hp / proj.maxHp,
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
