import * as THREE from 'three';
import type { Entity, EntityId, PlayerId, Turret } from '../sim/types';
import type { MetalDeposit } from '../../metalDepositConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getGraphicsConfig, getTeamTrim } from '@/clientBarConfig';
import type { ClientViewState } from '../network/ClientViewState';
import { IndexedEntityIdMap } from '../network/IndexedEntityIdCollections';
import { getTurretHeadRadius } from '../math';
import {
  applyEntityGroupFade,
  disposeEntityGroupFade,
  DyingMeshFade,
  ENTITY_DEATH_FADE_MS,
  updateEntityBuildVisual,
} from './EntityFade3D';
import { entityBodyColorHexForPlayer } from './EntityInstanceColor3D';
import { VISION_FADE_IN_MS, VISION_FADE_OUT_MS } from '@/visionConfig';
import {
  EntityDeathDisassembly3D,
  type EntityDeathBlast3D,
  type EntityDeathRenderablePart3D,
} from './EntityDeathDisassembly3D';
import {
  buildBuildingShape,
  type BuildingDetailMesh,
  type BuildingShapeType,
} from './BuildingShape3D';
import type { EntityMesh } from './EntityMesh3D';
import { applyChartToMesh, patchSurfaceChartTree } from './SurfaceChartMaterial3D';
import type { TeamTrimRenderer3D } from './TeamTrimRenderer3D';
import * as THREE_TRIM from 'three';
import { entityTeamColorHexForPlayer } from './EntityInstanceColor3D';
import { collectBuildingTeamOrnaments } from './BuildingTeamOrnament3D';
import type { RenderFrameState3D } from './RenderFrameState3D';
import { BuildingAnimationController3D } from './BuildingAnimationController3D';
import { applySolarCollectorPetalPose } from './SolarCollectorMesh3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import type { ResourcePylonFlowController3D } from './ResourcePylonFlowController3D';
import type { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import {
  buildTurretMesh3D,
  type TurretMesh,
} from './TurretMesh3D';
import { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import { BuildingRenderPacket3D } from './EntityRenderPackets3D';
import {
  TURRET_AIM_INPUT_STRIDE,
  UnitTurretAimBatch3D,
} from './UnitTurretAimBatch3D';
import {
  BUILDING_POSE_INPUT_STRIDE,
  BuildingPoseBatch3D,
} from './BuildingPoseBatch3D';
import type { ScopedRenderMeshRetention3D } from './ScopedRenderMeshRetention3D';
import {
  setEulerYIfChanged,
  setEulerZIfChanged,
  setObjectVisibleIfChanged,
  setVector3IfChanged,
} from './threeTransformWriteUtils';
import { growFloat32Array } from './typedArrayRenderUtils';
import type { EntityLodProxyRenderer3D } from './EntityLodProxyRenderer3D';
import { entityDetailLevelForView } from './EntityLod3D';
import {
  BUILDING_ANIMATION_MIN_RUNG,
  DETAIL_REBUILD_BUDGET_BUILDINGS,
  DETAIL_RUNG_GLYPH,
  type DetailRung,
  detailLevelForRung,
  detailRungForLevel,
  detailRungIndex,
  featureVisibleAtDetail,
  geometryTierForDetail,
  turretStyleForDetail,
  visualFeatureVisibleAtDetail,
} from './EntityDetailLevel3D';
import {
  CLIENT_RENDER_TURRET_FLAG_CONSTRUCTION_EMITTER,
  CLIENT_RENDER_TURRET_FLAG_HEAD_ONLY,
  type ClientRenderTurretHostRows,
} from './ClientRenderTurretStateSlab';
import {
  applyEntityLodVisualState3D,
  captureEntityLodVisualState3D,
  type EntityLodVisualState3D,
} from './EntityLodVisualState3D';

const BUILDING_HEIGHT = 120;

function isTowerShapeType(shapeType: BuildingShapeType): boolean {
  return shapeType.startsWith('tower');
}

function buildingDetailBandForLevel(level: number, shapeType: BuildingShapeType): number {
  const tower = isTowerShapeType(shapeType);
  const category = tower ? 'tower' : 'building';
  return (
    detailRungIndex(level) * 64 +
    (featureVisibleAtDetail('turretHead', level) ? 32 : 0) +
    (featureVisibleAtDetail('barrelSecondary', level) ? 16 : 0) +
    (featureVisibleAtDetail('muzzleDetail', level) ? 8 : 0) +
    (visualFeatureVisibleAtDetail(category, tower ? 'launcherDetails' : 'typeDetails', level, tower ? 0.52 : 0.38) ? 4 : 0) +
    (visualFeatureVisibleAtDetail(category, tower ? 'animationAndGlow' : 'largeAnimation', level, tower ? 0.68 : 0.54) ? 2 : 0) +
    (visualFeatureVisibleAtDetail(category, tower ? 'smallTrim' : 'tinyTrim', level, tower ? 0.82 : 0.72) ? 1 : 0)
  );
}

function buildingDetailVisibleAtLevel(
  detailMesh: BuildingDetailMesh,
  shapeType: BuildingShapeType,
  level: number,
): boolean {
  if (
    detailMesh.role === 'constructionHostBody' ||
    detailMesh.role === 'constructionMarking'
  ) {
    return true;
  }
  const tower = isTowerShapeType(shapeType);
  if (detailMesh.role === 'teamOrnament') return true;
  if (detailMesh.role === 'tinyTrim') {
    return visualFeatureVisibleAtDetail(
      tower ? 'tower' : 'building',
      tower ? 'smallTrim' : 'tinyTrim',
      level,
      tower ? 0.82 : 0.72,
    );
  }
  if (detailMesh.role === 'windRig' || detailMesh.role === 'extractorRotor' || detailMesh.role === 'radarRig') {
    return visualFeatureVisibleAtDetail(
      tower ? 'tower' : 'building',
      tower ? 'animationAndGlow' : 'largeAnimation',
      level,
      tower ? 0.68 : 0.54,
    );
  }
  if (detailMesh.role === 'solarLeaf' || detailMesh.role === 'solarPanel') {
    return visualFeatureVisibleAtDetail('building', 'typeDetails', level, 0.38);
  }
  return visualFeatureVisibleAtDetail(
    tower ? 'tower' : 'building',
    tower ? 'launcherDetails' : 'typeDetails',
    level,
    tower ? 0.52 : 0.38,
  );
}

function entityHasPerFrameBuildingTurretWork(entity: Entity): boolean {
  const turrets = entity.combat?.turrets;
  if (!turrets || turrets.length === 0) return false;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const barrel = turret.presentation.barrel;
    if (
      barrel !== null &&
      (barrel.type === 'simpleMultiBarrel' || barrel.type === 'coneMultiBarrel')
    ) {
      return true;
    }
  }
  return false;
}

function positionBuildingTurretRoot(turretMesh: TurretMesh, turret: Turret): void {
  const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.presentation);
  setVector3IfChanged(
    turretMesh.root.position,
    turret.mount.x,
    turret.mount.z - headRadius,
    turret.mount.y,
  );
  setObjectVisibleIfChanged(turretMesh.root, false);
  turretMesh.cachedRootVisible = false;
}

type BuildingTurretSpinEntry = {
  turretIndex: number;
  turretMesh: TurretMesh;
  active: boolean;
};

type BuildingTurretStateFields = {
  rotation: number;
  pitch: number;
  headOnly: boolean;
  constructionEmitter: boolean;
};

function turretStateFields(
  rows: ClientRenderTurretHostRows | undefined,
  turretIndex: number,
): BuildingTurretStateFields | null {
  if (rows === undefined || turretIndex < 0 || turretIndex >= rows.count) return null;
  const row = rows.start + turretIndex;
  const flags = rows.views.flags[row];
  return {
    rotation: rows.views.rotation[row],
    pitch: rows.views.pitch[row],
    headOnly: (flags & CLIENT_RENDER_TURRET_FLAG_HEAD_ONLY) !== 0,
    constructionEmitter: (flags & CLIENT_RENDER_TURRET_FLAG_CONSTRUCTION_EMITTER) !== 0,
  };
}

type BuildingEntityMeshFactoryOptions = {
  entity: Entity;
  width: number;
  depth: number;
  ownerId: PlayerId | undefined;
  geometryKey: string;
  world: THREE.Group;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  coneBarrelGeom: THREE.CylinderGeometry;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  getTeamOrnamentMat: (playerId: PlayerId | undefined) => THREE.Material;
  barrelMat: THREE.Material;
  detailLevel: number;
};

function createBuildingEntityMesh3D(options: BuildingEntityMeshFactoryOptions): EntityMesh {
  const {
    entity,
    width,
    depth,
    ownerId,
    geometryKey,
    world,
    turretHeadGeom,
    barrelGeom,
    coneBarrelGeom,
    getPrimaryMat,
    getTeamOrnamentMat,
    barrelMat,
    detailLevel,
  } = options;
  const shapeType: BuildingShapeType = entity.buildingBlueprintId
    ? getBuildingConfig(entity.buildingBlueprintId).renderProfile
    : 'unknown';
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.userData.entityId = entity.id;

  const shape = buildBuildingShape(
    shapeType,
    width,
    depth,
    getPrimaryMat(ownerId),
    entity.buildingBlueprintId,
    geometryTierForDetail(detailLevel),
  );
  shape.primary.matrixAutoUpdate = false;
  shape.primary.userData.entityId = entity.id;

  const chassis = new THREE.Group();
  chassis.userData.entityId = entity.id;
  chassis.add(shape.primary);
  group.add(chassis);

  const visibleDetails = shape.details.filter((detailMesh) =>
    buildingDetailVisibleAtLevel(detailMesh, shapeType, detailLevel));
  for (const detail of visibleDetails) {
    detail.mesh.userData.entityId = entity.id;
    group.add(detail.mesh);
  }
  const solarOpenAmount = entity.building?.activeState?.open === false ? 0 : 1;
  const solarPetalPoseApplied = shapeType === 'buildingSolar' &&
    applySolarCollectorPetalPose(visibleDetails, solarOpenAmount);

  const buildingTurretMeshes: TurretMesh[] = [];
  const buildingTurrets = entity.combat?.turrets;
  if (buildingTurrets) {
    const baseBuildingGfx = getGraphicsConfig();
    const buildingGfx = {
      ...baseBuildingGfx,
      turretStyle: turretStyleForDetail(detailLevel, baseBuildingGfx.turretStyle),
      barrelSpin:
        baseBuildingGfx.barrelSpin &&
        featureVisibleAtDetail('muzzleDetail', detailLevel),
    };
    for (let ti = 0; ti < buildingTurrets.length; ti++) {
      const turret = buildingTurrets[ti];
      const turretMesh = buildTurretMesh3D(group, turret, buildingGfx, {
        headGeom: turretHeadGeom,
        barrelGeom,
        coneBarrelGeom,
        primaryMat: getPrimaryMat(ownerId),
        barrelMat,
        detailLevel,
      });
      positionBuildingTurretRoot(turretMesh, turret);
      if (turretMesh.head) turretMesh.head.userData.entityId = entity.id;
      for (const barrel of turretMesh.barrels) barrel.userData.entityId = entity.id;
      // Same role table as a unit's turrets: a head is a sensor dome and a
      // barrel is a barrel shaft whether a walker or a tower carries it.
      if (turretMesh.head !== undefined && turretMesh.shieldEmitterCore !== true) {
        applyChartToMesh(
          turretMesh.head,
          'sensorDome',
          `turretHead:${geometryTierForDetail(detailLevel)}`,
        );
      }
      buildingTurretMeshes.push(turretMesh);
    }
  }

  // Coverage backstop — see the matching call in UnitMeshBuilder3D. A
  // building's art is spread across a dozen mesh modules (solar, wind,
  // extractor, radar, converter, factory, tower) each holding its own
  // structure materials; walking the finished assembly is what keeps every
  // wall, strut, vane and platform made of the same metal as the units
  // parked beside it.
  patchSurfaceChartTree(group);

  const buildingTeamOrnaments = collectBuildingTeamOrnaments(group);
  const teamOrnamentMat = getTeamOrnamentMat(ownerId);
  for (const ornament of buildingTeamOrnaments) ornament.material = teamOrnamentMat;

  world.add(group);

  return {
    group,
    chassis,
    chassisMeshes: [shape.primary],
    // Buildings don't use unit body-shape pools (they have their own
    // BuildingShape3D path), so the field is unused here.
    bodyShapeKey: '',
    turrets: buildingTurretMeshes,
    geometryKey,
    buildingDetails: visibleDetails,
    buildingTeamOrnaments,
    isFactoryConstructionHost: shape.isFactoryConstructionHost,
    windRig: visualFeatureVisibleAtDetail('building', 'largeAnimation', detailLevel, 0.54)
      ? shape.windRig
      : undefined,
    extractorRig: visualFeatureVisibleAtDetail('building', 'largeAnimation', detailLevel, 0.54)
      ? shape.extractorRig
      : undefined,
    solarRig: visualFeatureVisibleAtDetail('building', 'typeDetails', detailLevel, 0.38)
      ? shape.solarRig
      : undefined,
    radarRig: visualFeatureVisibleAtDetail('building', 'largeAnimation', detailLevel, 0.54)
      ? shape.radarRig
      : undefined,
    converterRig: visualFeatureVisibleAtDetail('building', 'typeDetails', detailLevel, 0.38)
      ? shape.converterRig
      : undefined,
    buildingRenderFrameKey: geometryKey,
    buildingRenderBlueprintId: entity.buildingBlueprintId,
    buildingRenderTurretCount: buildingTurrets?.length ?? 0,
    buildingHasPerFrameTurretWork:
      entityHasPerFrameBuildingTurretWork(entity) &&
      featureVisibleAtDetail('barrelSecondary', detailLevel),
    buildingHeight: shape.height,
    buildingPrimaryMaterialLocked: shape.primaryMaterialLocked === true,
    buildingBodyless: shape.bodyless === true,
    solarOpenAmount,
    solarPetalPoseAmount: solarPetalPoseApplied ? solarOpenAmount : undefined,
  };
}

type BuildingEntityRenderer3DOptions = {
  world: THREE.Group;
  clientViewState: ClientViewState;
  selectionOverlays: SelectionOverlayRenderer3D;
  constructionVisuals: ConstructionVisualController3D;
  resourcePylonFlows: ResourcePylonFlowController3D;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  coneBarrelGeom: THREE.CylinderGeometry;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  getTeamOrnamentMat: (playerId: PlayerId | undefined) => THREE.Material;
  barrelMat: THREE.Material;
  /** Shared team-trim pool. Optional so harnesses can omit it. */
  teamTrim?: TeamTrimRenderer3D | null;
  disposeWorldParentedOverlays: (mesh: EntityMesh, releaseTeamTrim?: boolean) => void;
  metalDeposits: readonly MetalDeposit[];
  scopedMeshRetention: ScopedRenderMeshRetention3D;
  lodProxyRenderer: EntityLodProxyRenderer3D;
};

export class BuildingEntityRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly selectionOverlays: SelectionOverlayRenderer3D;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly resourcePylonFlows: ResourcePylonFlowController3D;
  private readonly turretHeadGeom: THREE.SphereGeometry;
  private readonly barrelGeom: THREE.CylinderGeometry;
  private readonly coneBarrelGeom: THREE.CylinderGeometry;
  private readonly getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly getTeamOrnamentMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly barrelMat: THREE.Material;
  /** Shared team-trim pool, owned by Render3DEntities. Null in harnesses
   *  that construct this renderer without one. */
  private teamTrim: TeamTrimRenderer3D | null = null;
  private readonly disposeWorldParentedOverlays: (
    mesh: EntityMesh,
    releaseTeamTrim?: boolean,
  ) => void;
  private readonly scopedMeshRetention: ScopedRenderMeshRetention3D;
  private readonly lodProxyRenderer: EntityLodProxyRenderer3D;
  private readonly animations: BuildingAnimationController3D;
  private readonly meshes = new IndexedEntityIdMap<EntityMesh>();
  private renderScopeToken = 0;
  private lastEntitySetVersion = -1;
  /** Per-frame cap on detail-band mesh rebuilds — camera sweeps spread
   *  their rebuilds over frames; over-budget buildings keep the previous
   *  rung until a later frame. */
  private buildingRebuildBudgetLeft = 0;
  // Shared death-out flow (same controller units use, see EntityFade3D): a
  // dead building/tower is kept and its whole group dissolved 1 → 0 before
  // teardown while its actual textured parts break apart. Assigned here
  // because the callbacks close over this renderer.
  private readonly dyingBuildings: DyingMeshFade<EntityMesh>;
  // Buildings/towers that left the local player's vision. Same as unit
  // vision fade-out: quiet alpha dissolve in place, distinct from death.
  private readonly vanishingBuildings: DyingMeshFade<EntityMesh>;
  private readonly deathDisassembly = new EntityDeathDisassembly3D();
  /** Per-entity vision fade-IN clock. Kept outside row updates because
   *  buildings are usually submitted only when dirty, unlike units. */
  private readonly spawnFadeElapsed = new IndexedEntityIdMap<number>();
  /** Gatling spin for tower-mounted multi-barrel turrets (e.g. the
   *  Anti-Air rocket gatling). Towers render per-Mesh, so they keep
   *  their own spin state separate from the unit renderer's. */
  private readonly barrelSpin = new UnitBarrelSpinState3D();
  private barrelSpinEnabled = false;
  private readonly fallbackBuildingRenderRows = new BuildingRenderPacket3D();
  private readonly turretAimBatch = new UnitTurretAimBatch3D();
  private turretAimInput = new Float32Array(TURRET_AIM_INPUT_STRIDE * 256);
  private turretAimCount = 0;
  private readonly turretAimMeshes: TurretMesh[] = [];
  /** The host and colour each queued turret belongs to, so the team collar
   *  can be composed from the building's freshly written pose in the same
   *  pass that writes the turret's own aim. */
  private readonly turretAimHosts: EntityMesh[] = [];
  private readonly turretAimTeamColors: number[] = [];
  private readonly collarPosition = new THREE_TRIM.Vector3();
  private readonly collarQuaternion = new THREE_TRIM.Quaternion();
  private readonly collarIdentity = new THREE_TRIM.Quaternion();
  private readonly collarZero = new THREE_TRIM.Vector3();
  private readonly buildingPoseBatch = new BuildingPoseBatch3D();
  private buildingPoseInput = new Float32Array(BUILDING_POSE_INPUT_STRIDE * 256);
  private buildingPoseCount = 0;
  private readonly buildingPoseMeshes: EntityMesh[] = [];
  private readonly buildingPoseRotations: number[] = [];
  private readonly buildingSpinEntries: BuildingTurretSpinEntry[] = [];
  private readonly buildingSpinEntriesByEntity = new IndexedEntityIdMap<BuildingTurretSpinEntry[]>();
  private buildingSpinDeadEntries = 0;
  private buildingSpinResetPending = false;
  private lastFrameStateKey: string | null = null;
  private lastRangeOverlayStateVersion = -1;
  private lastUnitOverlayStateVersion = -1;
  private buildingTeamTrimEnabled: boolean | null = null;

  constructor(options: BuildingEntityRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.selectionOverlays = options.selectionOverlays;
    this.constructionVisuals = options.constructionVisuals;
    this.resourcePylonFlows = options.resourcePylonFlows;
    this.turretHeadGeom = options.turretHeadGeom;
    this.barrelGeom = options.barrelGeom;
    this.coneBarrelGeom = options.coneBarrelGeom;
    this.getPrimaryMat = options.getPrimaryMat;
    this.getTeamOrnamentMat = options.getTeamOrnamentMat;
    this.barrelMat = options.barrelMat;
    this.teamTrim = options.teamTrim ?? null;
    this.disposeWorldParentedOverlays = options.disposeWorldParentedOverlays;
    this.scopedMeshRetention = options.scopedMeshRetention;
    this.lodProxyRenderer = options.lodProxyRenderer;
    this.animations = new BuildingAnimationController3D(
      this.clientViewState,
      this.constructionVisuals,
      this.resourcePylonFlows,
      options.metalDeposits,
    );
    this.dyingBuildings = new DyingMeshFade<EntityMesh>(
      ENTITY_DEATH_FADE_MS,
      (mesh, fade, dtMs) => {
        this.deathDisassembly.advance(mesh, dtMs);
        applyEntityGroupFade(mesh.group, fade);
        this.fadeBuildingTurretCollars(mesh, fade);
      },
      (_id, mesh) => this.disposeBuildingMesh(mesh),
    );
    this.vanishingBuildings = new DyingMeshFade<EntityMesh>(
      VISION_FADE_OUT_MS,
      (mesh, fade) => this.applyBuildingEntityFade(mesh, fade),
      (_id, mesh) => this.disposeBuildingMesh(mesh),
    );
  }

  markEntityKilled(id: EntityId, blast?: EntityDeathBlast3D): void {
    const mesh = this.meshes.get(id);
    if (mesh) {
      mesh.killed = true;
      mesh.deathBlast = blast;
    }
  }

  update(
    buildingRows: BuildingRenderPacket3D | undefined,
    frameState: RenderFrameState3D,
    spinDt: number,
    currentDtMs: number,
    timeMs: number,
    scopedRender: boolean = false,
    entityDetailRung?: (entity: Entity) => DetailRung,
    entityLodProxyFadeAlpha?: (entity: Entity) => number,
  ): void {
    this.buildingRebuildBudgetLeft = DETAIL_REBUILD_BUDGET_BUILDINGS;
    this.syncBuildingTeamOrnamentState();
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const packetProvided = buildingRows !== undefined;
    const fallbackFullPrune = !packetProvided && entitySetVersion !== this.lastEntitySetVersion;
    const rangeOverlayStateVersion = this.selectionOverlays.getRangeStateVersion();
    const unitOverlayStateVersion = this.selectionOverlays.getUnitOverlayStateVersion();
    const forceFullRows =
      !scopedRender &&
      (
        !packetProvided ||
        this.lastFrameStateKey !== frameState.key ||
        this.lastRangeOverlayStateVersion !== rangeOverlayStateVersion ||
        this.lastUnitOverlayStateVersion !== unitOverlayStateVersion ||
        (this.meshes.size === 0 && this.clientViewState.getBuildings().length > 0)
      );
    const pruneBuildings = scopedRender || fallbackFullPrune || forceFullRows;
    const pruneToken = pruneBuildings
      ? ++this.renderScopeToken
      : 0;
    const nextBarrelSpinEnabled = getGraphicsConfig().barrelSpin;
    if (nextBarrelSpinEnabled !== this.barrelSpinEnabled) {
      this.buildingSpinResetPending = !nextBarrelSpinEnabled;
      this.barrelSpinEnabled = nextBarrelSpinEnabled;
    }
    this.beginTurretAimFrame();
    this.beginBuildingPoseFrame();
    if (buildingRows !== undefined) {
      this.removeBuildingMeshesFromPacket(buildingRows);
    }
    const rows = forceFullRows
      ? this.populateFallbackBuildingRenderRows(entityDetailRung)
      : buildingRows ?? this.populateFallbackBuildingRenderRows(entityDetailRung);
    if (buildingRows === undefined) this.removeBuildingMeshesFromPacket(rows);

    for (let row = 0; row < rows.count; row++) {
      const entityId = rows.entityIdAt(row);

      const mesh = this.meshes.get(entityId);
      if (rows.lodProxyAt(row)) {
        this.lodProxyRenderer.pushBuildingProxy(
          rows.x[row],
          rows.y[row],
          rows.z[row],
          rows.lodProxyRadius[row],
          rows.lodProxyGlyph[row],
          rows.ownerIdAt(row),
        );
        if (mesh !== undefined) {
          if (pruneBuildings) mesh.renderSeenToken = pruneToken;
          this.deactivateBuildingMeshForLod(entityId, mesh);
        }
        continue;
      }
      const entity = rows.entityAt(row);
      if (entity === undefined || entity.building === null) continue;
      const shapeType: BuildingShapeType = entity.buildingBlueprintId
        ? getBuildingConfig(entity.buildingBlueprintId).renderProfile
        : 'unknown';
      // Latched detail rung (screen-coverage LOD with hysteresis) from the
      // scene's shared EntityLodState3D — the same state that stamped this
      // packet's proxy flag. Its representative level drives the rebuild
      // band and every feature/tier decision at build time.
      const detailRung = entityDetailRung !== undefined
        ? entityDetailRung(entity)
        : detailRungForLevel(entityDetailLevelForView(frameState.view, entity));
      // BAR-style cross-fade: the icon fades in ON TOP of the still-fully-
      // opaque building before the (hysteresis-latched) glyph flip above
      // stops drawing the model entirely.
      const proxyFadeAlpha = entityLodProxyFadeAlpha?.(entity) ?? 0;
      if (proxyFadeAlpha > 0) {
        this.lodProxyRenderer.pushBuildingProxy(
          rows.x[row],
          rows.y[row],
          rows.z[row],
          rows.lodProxyRadius[row],
          rows.lodProxyGlyph[row],
          rows.ownerIdAt(row),
          proxyFadeAlpha,
        );
      }
      const detailLevel = detailLevelForRung(detailRung);
      const detailBand = buildingDetailBandForLevel(detailLevel, shapeType);
      const detailBandChanged =
        mesh !== undefined &&
        mesh.buildingRenderDetailBand !== detailBand;
      const wasLodProxyActive = mesh?.renderLodProxyActive === true;
      if (mesh !== undefined) {
        this.reactivateBuildingMeshForScope(entity, mesh);
        this.reactivateBuildingMeshForLod(entity, mesh);
        // Below the animation rung the building's animators (wind blades,
        // extractor rotor, radar sweep, solar petals) and gatling spin
        // freeze in place — a live gate, not a rebuild.
        this.applyBuildingAnimationGate(
          entity,
          mesh,
          detailRung >= BUILDING_ANIMATION_MIN_RUNG,
        );
      }
      const rowDirty = rows.renderDirtyAt(row) || rows.lifecycleDirtyAt(row);
      const activePrediction = rows.activePredictionAt(row);
      const needsTurretPoseFrame = rows.turretCount[row] > 0;
      const bodyFadeActive =
        rows.bodyOpacity[row] < 1 || mesh?.buildingGroupFadeActive === true;
      const rangeOverlayVersionDirty =
        mesh !== undefined && mesh.buildingRangeOverlayVersion !== rangeOverlayStateVersion;
      const unitOverlayVersionDirty =
        mesh !== undefined && mesh.buildingUnitOverlayVersion !== unitOverlayStateVersion;
      const overlayDirty =
        mesh !== undefined &&
        (rowDirty || rangeOverlayVersionDirty || unitOverlayVersionDirty) &&
        this.staticBuildingOverlaysNeedUpdate(mesh, entity, rows, row);
      if (mesh !== undefined && rangeOverlayVersionDirty && !overlayDirty) {
        mesh.buildingRangeOverlayVersion = rangeOverlayStateVersion;
      }
      if (mesh !== undefined && unitOverlayVersionDirty && !overlayDirty) {
        mesh.buildingUnitOverlayVersion = unitOverlayStateVersion;
      }
      if (
        mesh !== undefined &&
        !rowDirty &&
        !activePrediction &&
        !bodyFadeActive &&
        !overlayDirty &&
        !wasLodProxyActive &&
        !detailBandChanged
      ) {
        // Static building bodies can stay cached, but their mounted turrets
        // consume adjacent-tick presentation poses on every display frame.
        // Updating only this lightweight batched pose path keeps turret motion
        // independent of the much lower presentation-snapshot dirty cadence.
        if (needsTurretPoseFrame) {
          this.updateTurretPoses(entity, mesh, rows, row);
        }
        setObjectVisibleIfChanged(mesh.group, true);
        if (pruneBuildings) mesh.renderSeenToken = pruneToken;
        continue;
      }

      this.updateBuilding(
        entity,
        rows,
        row,
        frameState,
        rangeOverlayStateVersion,
        unitOverlayStateVersion,
        mesh === undefined || overlayDirty,
        detailLevel,
        detailBand,
      );
      if (pruneBuildings) {
        const updatedMesh = this.meshes.get(entityId);
        if (updatedMesh !== undefined) updatedMesh.renderSeenToken = pruneToken;
      }
    }

    this.flushBuildingPoseRecords();
    this.flushTurretAimRecords();
    if (pruneBuildings) this.pruneUnseenBuildingMeshes(pruneToken, scopedRender);
    this.updateBuildingTurretSpinQueue(spinDt);
    this.animations.update(spinDt, currentDtMs, timeMs);
    this.updateBuildingSpawnFades(currentDtMs);
    // Advance any in-progress death-out fades every frame (independent of
    // the entity-set prune cadence below).
    this.dyingBuildings.update(currentDtMs);
    this.vanishingBuildings.update(currentDtMs);

    this.lastEntitySetVersion = entitySetVersion;
    this.lastFrameStateKey = frameState.key;
    this.lastRangeOverlayStateVersion = rangeOverlayStateVersion;
    this.lastUnitOverlayStateVersion = unitOverlayStateVersion;
  }

  private populateFallbackBuildingRenderRows(
    entityDetailRung?: (entity: Entity) => DetailRung,
  ): BuildingRenderPacket3D {
    const rows = this.fallbackBuildingRenderRows;
    rows.reset();
    const buildings = this.clientViewState.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      // Stamp the proxy flag from the same latched rung the real packet
      // carries — a hardcoded false here would flash glyph-state
      // buildings back to full meshes for one forced frame.
      const lodProxy = entityDetailRung !== undefined &&
        entityDetailRung(buildings[i]) === DETAIL_RUNG_GLYPH;
      rows.pushEntity(buildings[i], false, true, true, lodProxy);
    }
    return rows;
  }

  private staticBuildingOverlaysNeedUpdate(
    mesh: EntityMesh,
    entity: Entity,
    rows: BuildingRenderPacket3D,
    row: number,
  ): boolean {
    return this.selectionOverlays.buildingRangeOverlaysNeedUpdate(
      mesh,
      entity,
      rows.selectedAt(row),
    ) || this.selectionOverlays.unitStaticOverlaysNeedUpdate(mesh, rows.selectedAt(row));
  }

  private disposeBuildingMesh(mesh: EntityMesh): void {
    this.deathDisassembly.forget(mesh);
    this.world.remove(mesh.group);
    disposeEntityGroupFade(mesh.group);
    this.disposeWorldParentedOverlays(mesh);
  }

  private detachBuildingMeshGroup(mesh: EntityMesh): void {
    if (mesh.group.parent === this.world) this.world.remove(mesh.group);
    // Building-specific ornamentation is group-parented and leaves with the
    // building. Only turret collars remain world-parented in the shared trim
    // pool, so park those slots while this building is out of scope.
    if (mesh.teamTrimSlot !== undefined) this.teamTrim?.hide(mesh.teamTrimSlot);
    for (const turret of mesh.turrets) {
      const slot = turret.teamCollar?.slot;
      if (slot !== undefined) this.teamTrim?.hide(slot);
    }
  }

  private attachBuildingMeshGroup(mesh: EntityMesh): void {
    if (mesh.group.parent !== this.world) this.world.add(mesh.group);
  }

  private currentSpawnFadeIn(id: EntityId): number {
    if (VISION_FADE_IN_MS <= 0) return 1;
    const elapsed = this.spawnFadeElapsed.get(id);
    if (elapsed === undefined) return 1;
    return Math.min(elapsed, VISION_FADE_IN_MS) / VISION_FADE_IN_MS;
  }

  private applyBuildingEntityFade(mesh: EntityMesh, fade: number): void {
    mesh.entityLifecycleFade = fade;
    const build = mesh.entityBuildVisual !== undefined
      && mesh.entityBuildVisual.progress < 1
      ? mesh.entityBuildVisual
      : null;
    const fadeActive = fade < 1 || build !== null;
    if (fadeActive || mesh.buildingGroupFadeActive === true) {
      applyEntityGroupFade(mesh.group, fade, build);
      mesh.buildingGroupFadeActive = fadeActive;
    }
    this.fadeBuildingTurretCollars(mesh, fade);
  }

  private fadeBuildingTurretCollars(mesh: EntityMesh, fade: number): void {
    for (const turret of mesh.turrets) {
      const slot = turret.teamCollar?.slot;
      if (slot !== undefined) this.teamTrim?.fade(slot, fade);
    }
  }

  private captureBuildingRendererDeathParts(
    mesh: EntityMesh,
  ): EntityDeathRenderablePart3D[] {
    const parts: EntityDeathRenderablePart3D[] = [];
    for (const turret of mesh.turrets) {
      const slot = turret.teamCollar?.slot;
      if (slot === undefined) continue;
      const part = this.teamTrim?.captureDeathPart(slot);
      if (part !== undefined && part !== null) parts.push(part);
    }
    return parts;
  }

  private updateBuildingSpawnFades(dtMs: number): void {
    if (this.spawnFadeElapsed.size === 0) return;
    if (VISION_FADE_IN_MS <= 0) {
      for (const id of this.spawnFadeElapsed.keys()) {
        const mesh = this.meshes.get(id);
        if (mesh === undefined) continue;
        this.spawnFadeElapsed.set(id, VISION_FADE_IN_MS);
        this.applyBuildingEntityFade(mesh, mesh.buildingMaterializationOpacity ?? 1);
      }
      return;
    }

    for (const [id, prev] of this.spawnFadeElapsed) {
      if (prev === VISION_FADE_IN_MS) continue;
      const mesh = this.meshes.get(id);
      if (mesh === undefined) continue;
      const elapsed = Math.min(prev + dtMs, VISION_FADE_IN_MS);
      this.spawnFadeElapsed.set(id, elapsed);
      const fadeIn = elapsed / VISION_FADE_IN_MS;
      this.applyBuildingEntityFade(mesh, (mesh.buildingMaterializationOpacity ?? 1) * fadeIn);
    }
  }

  private removeBuildingMeshesFromPacket(
    rows: BuildingRenderPacket3D,
  ): void {
    for (let i = 0; i < rows.removedCount; i++) {
      this.removeBuildingMeshForViewRemoval(rows.removedEntityIdAt(i));
    }
  }

  private removeBuildingMeshForViewRemoval(
    id: EntityId,
  ): void {
    const wasScopedHidden = this.scopedMeshRetention.forgetBuilding(id);
    this.unregisterBuildingSpinTurrets(id);
    this.spawnFadeElapsed.delete(id);

    const mesh = this.meshes.get(id);
    if (!mesh) return;

    this.disposeWorldParentedOverlays(mesh, false);
    this.animations.unregister(id);
    this.meshes.delete(id);
    if (wasScopedHidden) {
      this.disposeBuildingMesh(mesh);
      return;
    }
    if (mesh.killed) {
      if (mesh.deathBlast !== undefined) {
        this.deathDisassembly.prepare(
          mesh,
          mesh.deathBlast,
          this.captureBuildingRendererDeathParts(mesh),
        );
      }
      this.dyingBuildings.markDying(id, mesh, mesh.entityLifecycleFade);
    } else {
      this.vanishingBuildings.markDying(id, mesh, mesh.entityLifecycleFade);
    }
  }

  private pruneUnseenBuildingMeshes(
    pruneToken: number,
    scopedRender: boolean,
  ): void {
    for (const [id, mesh] of this.meshes) {
      if (mesh.renderSeenToken === pruneToken) continue;
      if (scopedRender) {
        this.deactivateBuildingMeshForScope(id, mesh);
      } else {
        this.removeBuildingMeshForViewRemoval(id);
      }
    }
  }

  private deactivateBuildingMeshForScope(
    id: EntityId,
    mesh: EntityMesh,
  ): void {
    if (!this.scopedMeshRetention.markBuildingHidden(id)) return;
    this.animations.detach(id);
    this.deactivateBuildingSpinEntries(id);
    this.disposeWorldParentedOverlays(mesh);
    this.applyBuildingEntityFade(mesh, 0);
    setObjectVisibleIfChanged(mesh.group, false);
    this.detachBuildingMeshGroup(mesh);
  }

  private deactivateBuildingMeshForLod(
    id: EntityId,
    mesh: EntityMesh,
  ): void {
    if (mesh.renderLodProxyActive === true) return;
    mesh.renderLodProxyActive = true;
    this.animations.detach(id);
    this.deactivateBuildingSpinEntries(id);
    this.disposeWorldParentedOverlays(mesh);
    this.applyBuildingEntityFade(mesh, 0);
    setObjectVisibleIfChanged(mesh.group, false);
    this.detachBuildingMeshGroup(mesh);
  }

  private reactivateBuildingMeshForScope(entity: Entity, mesh: EntityMesh): void {
    if (!this.scopedMeshRetention.markBuildingActive(entity.id)) return;
    this.attachBuildingMeshGroup(mesh);
    setObjectVisibleIfChanged(mesh.group, true);
    this.animations.register(entity, mesh);
    this.registerBuildingSpinTurrets(entity, mesh);
    mesh.buildingAnimationsGated = false;
    this.applyBuildingEntityFade(
      mesh,
      (mesh.buildingMaterializationOpacity ?? 1) * this.currentSpawnFadeIn(entity.id),
    );
  }

  private reactivateBuildingMeshForLod(entity: Entity, mesh: EntityMesh): void {
    if (mesh.renderLodProxyActive !== true) return;
    mesh.renderLodProxyActive = false;
    this.attachBuildingMeshGroup(mesh);
    setObjectVisibleIfChanged(mesh.group, true);
    this.animations.register(entity, mesh);
    this.registerBuildingSpinTurrets(entity, mesh);
    mesh.buildingAnimationsGated = false;
    this.applyBuildingEntityFade(
      mesh,
      (mesh.buildingMaterializationOpacity ?? 1) * this.currentSpawnFadeIn(entity.id),
    );
  }

  /** Live animation gate for the detail rung: freezes/resumes this
   *  building's animators + gatling spin without touching the mesh.
   *  The freeze side is LEVEL-triggered (re-asserted every visible
   *  frame, cheap no-ops once removed) because updateBuilding's
   *  animations.sync and the reactivation paths re-register animators;
   *  an edge-triggered gate would be silently defeated by them. Spin
   *  state is retained so barrels freeze in place and resume from the
   *  frozen angle. */
  private applyBuildingAnimationGate(
    entity: Entity,
    mesh: EntityMesh,
    animate: boolean,
  ): void {
    const gated = mesh.buildingAnimationsGated === true;
    if (!animate) {
      mesh.buildingAnimationsGated = true;
      this.animations.detach(entity.id);
      this.deactivateBuildingSpinEntries(entity.id);
    } else if (gated) {
      mesh.buildingAnimationsGated = false;
      this.animations.register(entity, mesh);
      this.registerBuildingSpinTurrets(entity, mesh);
    }
  }

  destroy(): void {
    for (const mesh of this.meshes.values()) {
      this.disposeBuildingMesh(mesh);
    }
    this.meshes.clear();
    this.dyingBuildings.destroyAll();
    this.vanishingBuildings.destroyAll();
    this.spawnFadeElapsed.clear();
    this.renderScopeToken = 0;
    this.lastEntitySetVersion = -1;
    this.animations.destroy();
    this.barrelSpin.clear();
    this.buildingSpinEntries.length = 0;
    this.buildingSpinEntriesByEntity.clear();
    this.buildingSpinDeadEntries = 0;
    this.buildingSpinResetPending = false;
  }

  private updateBuilding(
    entity: Entity,
    rows: BuildingRenderPacket3D,
    row: number,
    frameState: RenderFrameState3D,
    rangeOverlayStateVersion: number,
    unitOverlayStateVersion: number,
    updateStaticOverlays: boolean,
    detailLevel: number,
    detailBand: number,
  ): void {
    // If this id is mid death-fade and reappeared (id reuse / re-add),
    // finalize the dying mesh so we don't draw it under the rebuilt one.
    if (this.dyingBuildings.size > 0 && this.dyingBuildings.has(entity.id)) {
      this.dyingBuildings.finalize(entity.id);
    }
    if (this.vanishingBuildings.size > 0 && this.vanishingBuildings.has(entity.id)) {
      this.vanishingBuildings.finalize(entity.id);
    }
    const ownerId = rows.ownerIdAt(row);
    const width = rows.width[row];
    const depth = rows.footprintDepth[row];
    const blueprintId = rows.buildingBlueprintIds[row] ?? null;
    const turretCount = rows.turretCount[row];

    let mesh = this.meshes.get(entity.id);
    let retainedLodVisualState: EntityLodVisualState3D | undefined;
    const coreKeyChanged =
      mesh !== undefined &&
      (
        mesh.buildingRenderFrameKey !== frameState.key ||
        mesh.buildingRenderBlueprintId !== blueprintId ||
        mesh.buildingRenderTurretCount !== turretCount
      );
    const bandOnlyChanged =
      mesh !== undefined &&
      !coreKeyChanged &&
      mesh.buildingRenderDetailBand !== detailBand;
    // Band-only changes are cosmetics and defer under the per-frame
    // rebuild budget; core key changes (graphics/blueprint) are
    // correctness and always rebuild.
    if (
      mesh &&
      (coreKeyChanged || (bandOnlyChanged && this.buildingRebuildBudgetLeft > 0))
    ) {
      if (!coreKeyChanged) this.buildingRebuildBudgetLeft--;
      if (bandOnlyChanged) {
        retainedLodVisualState = captureEntityLodVisualState3D(mesh);
        this.animations.detach(entity.id);
      } else {
        this.animations.unregister(entity.id);
      }
      this.meshes.delete(entity.id);
      if (bandOnlyChanged) this.deactivateBuildingSpinEntries(entity.id);
      else this.unregisterBuildingSpinTurrets(entity.id);
      this.scopedMeshRetention.forgetBuilding(entity.id);
      this.disposeBuildingMesh(mesh);
      mesh = undefined;
    }
    if (!mesh) {
      mesh = createBuildingEntityMesh3D({
        entity,
        width,
        depth,
        ownerId,
        geometryKey: frameState.key,
        world: this.world,
        turretHeadGeom: this.turretHeadGeom,
        barrelGeom: this.barrelGeom,
        coneBarrelGeom: this.coneBarrelGeom,
        getPrimaryMat: this.getPrimaryMat,
        getTeamOrnamentMat: this.getTeamOrnamentMat,
        barrelMat: this.barrelMat,
        detailLevel,
      });
      applyEntityLodVisualState3D(mesh, retainedLodVisualState);
      mesh.buildingRenderDetailBand = detailBand;
      this.meshes.set(entity.id, mesh);
      this.setBuildingTeamOrnamentsVisible(
        mesh,
        this.buildingTeamTrimEnabled ?? getTeamTrim(),
      );
      this.animations.register(entity, mesh);
      this.registerBuildingSpinTurrets(entity, mesh);
      if (!this.spawnFadeElapsed.has(entity.id)) {
        this.spawnFadeElapsed.set(entity.id, 0);
      }
    }

    const progress = rows.progress[row];
    const selected = rows.selectedAt(row);
    const x = rows.x[row];
    const y = rows.y[row];
    const z = rows.z[row];
    const rotation = rows.rotation[row];
    const buildingBaseY = rows.baseY[row];
    const detailsReady = progress >= 1;
    const renderDirty =
      mesh.buildingCachedOwnerId !== ownerId ||
      mesh.buildingCachedProgress !== progress ||
      mesh.buildingCachedSelected !== selected ||
      mesh.buildingCachedWidth !== width ||
      mesh.buildingCachedDepth !== depth ||
      mesh.buildingCachedX !== x ||
      mesh.buildingCachedY !== y ||
      mesh.buildingCachedZ !== z ||
      mesh.buildingCachedRotation !== rotation;

    if (renderDirty) {
      this.updateBuildingMesh(
        mesh,
        ownerId,
        width,
        depth,
        progress,
        selected,
        x,
        y,
        z,
        rotation,
        buildingBaseY,
        detailsReady,
      );
    } else {
      setObjectVisibleIfChanged(mesh.group, true);
    }

    this.updateTurretPoses(entity, mesh, rows, row);
    if (updateStaticOverlays) {
      this.selectionOverlays.updateRangeRings(mesh, entity);
      this.selectionOverlays.updateHostVolumes(mesh, entity);
      mesh.buildingRangeOverlayVersion = rangeOverlayStateVersion;
      mesh.buildingUnitOverlayVersion = unitOverlayStateVersion;
    }

    // Materialization — mounted turrets share the host body's build
    // fraction because they are not separate construction pieces.
    // Finished buildings sit at opacity 1, where applyEntityGroupFade
    // restores the real materials and costs nothing. While under
    // construction the per-Mesh assembly runs the BAR nanoframe bands
    // (queued ghost at fraction 0, bottom-to-top materialization after),
    // so the group fade carries only the vision fade-in — the bands own
    // the build translucency.
    const bodyOpacity = rows.bodyOpacity[row];
    mesh.buildingMaterializationOpacity = bodyOpacity;
    if (progress < 1) {
      updateEntityBuildVisual(
        mesh,
        progress,
        entityBodyColorHexForPlayer(ownerId),
      );
    } else {
      mesh.entityBuildVisual = undefined;
    }
    this.applyBuildingEntityFade(
      mesh,
      (progress < 1 ? 1 : bodyOpacity) * this.currentSpawnFadeIn(entity.id),
    );
    // While the detail-rung gate holds this building's animators frozen,
    // sync would re-register them right before this frame's animation
    // tick — the gate owns registration until the rung climbs back.
    if (mesh.buildingAnimationsGated !== true) this.animations.sync(entity, mesh);
  }

  private updateBuildingMesh(
    mesh: EntityMesh,
    ownerId: PlayerId | undefined,
    width: number,
    depth: number,
    progress: number,
    selected: boolean,
    x: number,
    y: number,
    z: number,
    rotation: number,
    buildingBaseY: number,
    detailsReady: boolean,
  ): void {
    setObjectVisibleIfChanged(mesh.group, true);
    if (!mesh.buildingPrimaryMaterialLocked) {
      const primaryMat = this.getPrimaryMat(ownerId);
      for (const chassisMesh of mesh.chassisMeshes) chassisMesh.material = primaryMat;
    }
    if (mesh.buildingTeamOrnaments && mesh.buildingTeamOrnaments.length > 0) {
      const teamMat = this.getTeamOrnamentMat(ownerId);
      for (const ornament of mesh.buildingTeamOrnaments) ornament.material = teamMat;
      mesh.buildingTeamOrnamentColorHex = entityTeamColorHexForPlayer(ownerId);
    }

    // Transform.z is the building's vertical center in sim space.
    // Render from the footprint base so buildings sit on the same
    // terrain height the server used when creating their collider.
    const height = mesh.buildingHeight ?? BUILDING_HEIGHT;
    this.enqueueBuildingPose(
      mesh,
      x,
      y,
      buildingBaseY,
      rotation,
      width,
      height,
      depth,
      mesh.buildingBodyless === true,
    );
    // Construction appearance is now the shared materialization fade
    // (applied per frame in updateBuilding), not a pale shell-material
    // swap — buildings alpha-fade in the same way as units.

    // Full size from frame one — construction is revealed by the shared
    // opacity fade (same as units), never by rising out of the ground.
    const primary = mesh.chassisMeshes[0];
    if (mesh.buildingBodyless) {
      // Bodyless render profiles have no chassis to show. Keep the
      // primary hidden and unscaled.
      setObjectVisibleIfChanged(primary, false);
    } else {
      setObjectVisibleIfChanged(primary, true);
    }

    if (mesh.buildingDetails) {
      // Details fade in with the body via applyEntityGroupFade — build-in
      // is opacity only, so every part materializes together at constant
      // size instead of popping in at completion. detailsReady still gates
      // their animation (see BuildingAnimationController3D), not existence.
      for (const detail of mesh.buildingDetails) {
        setObjectVisibleIfChanged(detail.mesh, true);
      }
    }

    this.setBuildingTeamOrnamentsVisible(
      mesh,
      this.buildingTeamTrimEnabled ?? getTeamTrim(),
    );

    this.selectionOverlays.updateSelectionRing(mesh, selected, Math.hypot(width, depth) * 0.55);

    mesh.buildingCachedOwnerId = ownerId;
    mesh.buildingCachedProgress = progress;
    mesh.buildingCachedSelected = selected;
    mesh.buildingCachedWidth = width;
    mesh.buildingCachedDepth = depth;
    mesh.buildingCachedX = x;
    mesh.buildingCachedY = y;
    mesh.buildingCachedZ = z;
    mesh.buildingCachedRotation = rotation;
    mesh.buildingCachedDetailsReady = detailsReady;
  }

  private syncBuildingTeamOrnamentState(): void {
    const enabled = this.teamTrim?.isEnabled() ?? getTeamTrim();
    const visibilityChanged = enabled !== this.buildingTeamTrimEnabled;
    if (visibilityChanged) this.buildingTeamTrimEnabled = enabled;
    for (const mesh of this.meshes.values()) {
      if (visibilityChanged) this.setBuildingTeamOrnamentsVisible(mesh, enabled);
      const ownerId = mesh.buildingCachedOwnerId;
      const teamColorHex = entityTeamColorHexForPlayer(ownerId);
      if (mesh.buildingTeamOrnamentColorHex === teamColorHex) continue;
      const teamMat = this.getTeamOrnamentMat(ownerId);
      for (const ornament of mesh.buildingTeamOrnaments ?? []) {
        ornament.material = teamMat;
      }
      mesh.buildingTeamOrnamentColorHex = teamColorHex;
    }
  }

  private setBuildingTeamOrnamentsVisible(mesh: EntityMesh, visible: boolean): void {
    const ornaments = mesh.buildingTeamOrnaments;
    if (ornaments === undefined) return;
    for (const ornament of ornaments) {
      setObjectVisibleIfChanged(ornament, visible);
    }
  }

  private updateTurretPoses(
    entity: Entity,
    mesh: EntityMesh,
    rows: BuildingRenderPacket3D,
    row: number,
  ): void {
    const turretRows = rows.turretStateAt(row);
    const combatTurrets = rows.turretsAt(row);
    const turretCount = turretRows !== undefined ? turretRows.count : combatTurrets.length;
    if (mesh.turrets.length !== turretCount) return;
    const underConstruction = rows.shellAt(row);
    const bodyVisible = rows.bodyOpacity[row] > 0;
    const ownerId = rows.ownerIdAt(row);
    const teamColorHex = entityTeamColorHexForPlayer(ownerId);
    for (let turretIndex = 0; turretIndex < turretCount; turretIndex++) {
      const turret = combatTurrets[turretIndex];
      const turretState = turretStateFields(turretRows, turretIndex);
      if (turretState === null && turret === undefined) continue;
      const turretMesh = mesh.turrets[turretIndex];
      const visible = bodyVisible;
      this.setTurretRootVisible(turretMesh, visible);
      if (!visible) continue;
      // Legacy construction-emitter geometry has no head sphere or barrels.
      // No live builder/factory mounts it; this branch only preserves stable
      // rendering for old captured fixtures.
      if (turretState?.constructionEmitter === true || turret?.presentation.constructionEmitter) {
        // Building construction pylons (the fabricator's) stand fused to
        // the TOP of the torus ring, pointing straight up — the rig stays
        // upright (no construction-drone flip).
        if (turretMesh.constructionEmitter) {
          setEulerZIfChanged(turretMesh.constructionEmitter.group.rotation, 0);
        }
        this.enqueueTurretAim(
          turretMesh,
          rows.rotation[row],
          turretState?.rotation ?? turret.rotation,
          0,
          mesh,
          teamColorHex,
        );
        continue;
      }
      // Head-only utility turrets draw a bare body and skip barrel posing,
      // but their body still consumes the logical turret yaw. Treat that
      // head as body geometry: keep it on
      // player primary so state/LOD changes do not shift the body tone.
      // While the shell override owns the head material during
      // construction, leave it alone.
      const headOnly = turretState?.headOnly ?? turret.presentation.headOnly;
      if (headOnly) {
        if (turretMesh.head && !underConstruction) {
          this.setTurretHeadMaterial(turretMesh, this.getPrimaryMat(ownerId));
        }
      } else if (!underConstruction) {
        this.setTurretBarrelMaterial(turretMesh, this.barrelMat);
      }
      this.enqueueTurretAim(
        turretMesh,
        rows.rotation[row],
        turretState?.rotation ?? turret.rotation,
        headOnly ? 0 : (turretState?.pitch ?? turret.pitch),
        mesh,
        teamColorHex,
      );
      // Gatling spin for multi-barrel tower turrets (e.g. the Anti-Air
      // rocket cluster). Single-barrel turrets have no spin state, so
      // angleFor returns undefined and the cluster stays still.
      if (!headOnly && turretMesh.spinGroup) {
        this.setTurretSpinRotation(
          turretMesh,
          this.barrelSpinEnabled
            ? this.barrelSpin.angleFor(entity.id, turretIndex) ?? 0
            : 0,
        );
      }
    }
  }

  private registerBuildingSpinTurrets(entity: Entity, mesh: EntityMesh): void {
    // Entry refresh only — retained spin angles survive so a gate resume
    // continues from the frozen angle instead of restarting at zero.
    this.deactivateBuildingSpinEntries(entity.id);
    const turrets = entity.combat?.turrets;
    if (!turrets || turrets.length === 0) return;
    const entries: BuildingTurretSpinEntry[] = [];
    for (
      let turretIndex = 0;
      turretIndex < turrets.length && turretIndex < mesh.turrets.length;
      turretIndex++
    ) {
      const turretMesh = mesh.turrets[turretIndex];
      if (!turretMesh.spinGroup) continue;
      const barrel = turrets[turretIndex].presentation.barrel;
      if (
        barrel === null ||
        (barrel.type !== 'simpleMultiBarrel' && barrel.type !== 'coneMultiBarrel')
      ) {
        continue;
      }
      const entry: BuildingTurretSpinEntry = {
        turretIndex,
        turretMesh,
        active: true,
      };
      entries.push(entry);
      this.buildingSpinEntries.push(entry);
    }
    if (entries.length > 0) this.buildingSpinEntriesByEntity.set(entity.id, entries);
  }

  private unregisterBuildingSpinTurrets(entityId: EntityId): void {
    this.deactivateBuildingSpinEntries(entityId);
    this.barrelSpin.delete(entityId);
  }

  /** Stop advancing this building's gatling spin WITHOUT wiping the
   *  stored spin angle — the detail-rung animation gate freezes barrels
   *  in place (updateTurretPoses keeps writing the retained angle) and
   *  resumes from it, unlike real teardown which forgets the state. */
  private deactivateBuildingSpinEntries(entityId: EntityId): void {
    const entries = this.buildingSpinEntriesByEntity.get(entityId);
    if (entries === undefined) return;
    for (const entry of entries) {
      if (!entry.active) continue;
      entry.active = false;
      this.buildingSpinDeadEntries++;
    }
    this.buildingSpinEntriesByEntity.delete(entityId);
  }

  private updateBuildingTurretSpinQueue(spinDt: number): void {
    if (this.buildingSpinEntries.length === 0) return;

    if (!this.barrelSpinEnabled) {
      if (!this.buildingSpinResetPending) {
        this.compactBuildingSpinEntriesIfNeeded();
        return;
      }
      for (const entry of this.buildingSpinEntries) {
        if (entry.active) this.setTurretSpinRotation(entry.turretMesh, 0);
      }
      this.buildingSpinResetPending = false;
      this.compactBuildingSpinEntriesIfNeeded();
      return;
    }

    for (const [entityId, entries] of this.buildingSpinEntriesByEntity) {
      const entity = this.clientViewState.getEntity(entityId);
      if (entity === undefined || entity.combat === null) {
        this.unregisterBuildingSpinTurrets(entityId);
        continue;
      }
      if (!this.barrelSpin.advanceRows(
        entityId,
        this.clientViewState.getRenderTurretStateRows(entityId),
        spinDt,
      )) {
        this.barrelSpin.advance(entity, spinDt);
      }
      for (const entry of entries) {
        if (!entry.active) continue;
        this.setTurretSpinRotation(
          entry.turretMesh,
          this.barrelSpin.angleFor(entityId, entry.turretIndex) ?? 0,
        );
      }
    }
    this.compactBuildingSpinEntriesIfNeeded();
  }

  private compactBuildingSpinEntriesIfNeeded(): void {
    if (
      this.buildingSpinDeadEntries <= 0 ||
      this.buildingSpinDeadEntries * 2 < this.buildingSpinEntries.length
    ) {
      return;
    }
    let write = 0;
    for (let read = 0; read < this.buildingSpinEntries.length; read++) {
      const entry = this.buildingSpinEntries[read];
      if (!entry.active) continue;
      this.buildingSpinEntries[write] = entry;
      write++;
    }
    this.buildingSpinEntries.length = write;
    this.buildingSpinDeadEntries = 0;
  }

  private setTurretRootVisible(turretMesh: TurretMesh, visible: boolean): void {
    if (turretMesh.cachedRootVisible === visible) return;
    setObjectVisibleIfChanged(turretMesh.root, visible);
    turretMesh.cachedRootVisible = visible;
  }

  private setTurretHeadMaterial(turretMesh: TurretMesh, material: THREE.Material): void {
    if (!turretMesh.head || turretMesh.cachedHeadMaterial === material) return;
    turretMesh.head.material = material;
    turretMesh.cachedHeadMaterial = material;
  }

  private setTurretBarrelMaterial(turretMesh: TurretMesh, material: THREE.Material): void {
    if (turretMesh.cachedBarrelMaterial === material) return;
    for (const barrel of turretMesh.barrels) barrel.material = material;
    turretMesh.cachedBarrelMaterial = material;
  }

  private setTurretSpinRotation(turretMesh: TurretMesh, rotationX: number): void {
    if (!turretMesh.spinGroup || turretMesh.cachedSpinRotationX === rotationX) return;
    turretMesh.spinGroup.rotation.x = rotationX;
    turretMesh.cachedSpinRotationX = rotationX;
  }

  private beginTurretAimFrame(): void {
    this.turretAimCount = 0;
    this.turretAimMeshes.length = 0;
    this.turretAimHosts.length = 0;
    this.turretAimTeamColors.length = 0;
  }

  private beginBuildingPoseFrame(): void {
    this.buildingPoseCount = 0;
    this.buildingPoseMeshes.length = 0;
    this.buildingPoseRotations.length = 0;
  }

  private flushBuildingPoseRecords(): void {
    const count = this.buildingPoseCount;
    if (count <= 0) return;

    const input = this.buildingPoseBatch.begin(count);
    input.set(this.buildingPoseInput.subarray(0, count * BUILDING_POSE_INPUT_STRIDE));
    const output = this.buildingPoseBatch.compute(count);
    const outputStride = this.buildingPoseBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const mesh = this.buildingPoseMeshes[i];
      const outputBase = i * outputStride;
      mesh.group.matrix.fromArray(output, outputBase);
      mesh.group.position.set(
        output[outputBase + 12],
        output[outputBase + 13],
        output[outputBase + 14],
      );
      mesh.group.rotation.y = this.buildingPoseRotations[i];
      mesh.group.matrixWorldNeedsUpdate = true;

      const primary = mesh.chassisMeshes[0];
      primary.matrix.fromArray(output, outputBase + 16);
      primary.matrixWorldNeedsUpdate = true;
    }
  }

  private flushTurretAimRecords(): void {
    const count = this.turretAimCount;
    if (count <= 0) return;

    const input = this.turretAimBatch.begin(count);
    input.set(this.turretAimInput.subarray(0, count * TURRET_AIM_INPUT_STRIDE));
    const output = this.turretAimBatch.compute(count);
    const outputStride = this.turretAimBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const turretMesh = this.turretAimMeshes[i];
      const outputBase = i * outputStride;
      setEulerYIfChanged(turretMesh.yawGroup.rotation, output[outputBase]);
      if (turretMesh.pitchGroup) {
        setEulerZIfChanged(turretMesh.pitchGroup.rotation, output[outputBase + 1]);
      }
      this.writeTurretTeamCollar(
        turretMesh,
        this.turretAimHosts[i],
        this.turretAimTeamColors[i],
      );
    }
  }

  /**
   * A tower turret's team collar, in the ornament pool's world space.
   *
   * Composed from the host's own pose rather than read off `matrixWorld`:
   * the building pose was written moments ago in this same frame and three
   * has not walked the graph yet, so a world matrix here would be one frame
   * stale — which on a rotating turret reads as the collar lagging behind
   * its own barrels.
   */
  private writeTurretTeamCollar(
    turretMesh: TurretMesh,
    host: EntityMesh | undefined,
    teamColorHex: number,
  ): void {
    const collar = turretMesh.teamCollar;
    const trim = this.teamTrim;
    if (collar === undefined || trim === null || host === undefined) return;
    if (collar.slot === undefined) {
      const slot = trim.allocTurretCollar(collar.radius, collar.tier);
      if (slot < 0) return;
      collar.slot = slot;
    }
    const pitchPosition = turretMesh.pitchGroup?.position;
    const pitchQuaternion = turretMesh.pitchGroup?.quaternion;
    this.collarPosition
      .set(collar.centerX, 0, 0)
      .applyQuaternion(pitchQuaternion ?? this.collarIdentity)
      .add(pitchPosition ?? this.collarZero)
      .applyQuaternion(turretMesh.yawGroup.quaternion)
      .add(turretMesh.yawGroup.position)
      .applyQuaternion(turretMesh.root.quaternion)
      .add(turretMesh.root.position)
      .applyQuaternion(host.group.quaternion)
      .add(host.group.position);
    this.collarQuaternion
      .copy(host.group.quaternion)
      .multiply(turretMesh.root.quaternion)
      .multiply(turretMesh.yawGroup.quaternion)
      .multiply(pitchQuaternion ?? this.collarIdentity);
    trim.setTurretCollar(
      collar.slot,
      this.collarPosition.x,
      this.collarPosition.y,
      this.collarPosition.z,
      this.collarQuaternion,
      collar.length,
      collar.radius,
      teamColorHex,
    );
  }

  private enqueueTurretAim(
    turretMesh: TurretMesh,
    hostRotation: number,
    aimRotation: number,
    aimPitch: number,
    host: EntityMesh,
    teamColorHex: number,
  ): void {
    const index = this.turretAimCount;
    this.turretAimCount++;
    this.ensureTurretAimInputCapacity(this.turretAimCount);

    const base = index * TURRET_AIM_INPUT_STRIDE;
    const input = this.turretAimInput;
    input[base] = hostRotation;
    input[base + 1] = aimRotation;
    input[base + 2] = aimPitch;
    input[base + 3] = 0;
    input[base + 4] = 0;
    input[base + 5] = 0;
    input[base + 6] = 1;
    input[base + 7] = 0;
    this.turretAimMeshes[index] = turretMesh;
    this.turretAimHosts[index] = host;
    this.turretAimTeamColors[index] = teamColorHex;
  }

  private enqueueBuildingPose(
    mesh: EntityMesh,
    x: number,
    y: number,
    baseY: number,
    rotation: number,
    width: number,
    height: number,
    depth: number,
    bodyless: boolean,
  ): void {
    const index = this.buildingPoseCount;
    this.buildingPoseCount++;
    this.ensureBuildingPoseInputCapacity(this.buildingPoseCount);

    const base = index * BUILDING_POSE_INPUT_STRIDE;
    const input = this.buildingPoseInput;
    input[base] = x;
    input[base + 1] = y;
    input[base + 2] = baseY;
    input[base + 3] = rotation;
    input[base + 4] = width;
    input[base + 5] = height;
    input[base + 6] = depth;
    input[base + 7] = bodyless ? 1 : 0;
    this.buildingPoseMeshes[index] = mesh;
    this.buildingPoseRotations[index] = -rotation;
  }

  private ensureTurretAimInputCapacity(count: number): void {
    const needed = count * TURRET_AIM_INPUT_STRIDE;
    if (this.turretAimInput.length >= needed) return;
    this.turretAimInput = growFloat32Array(this.turretAimInput, needed);
  }

  private ensureBuildingPoseInputCapacity(count: number): void {
    const needed = count * BUILDING_POSE_INPUT_STRIDE;
    if (this.buildingPoseInput.length >= needed) return;
    this.buildingPoseInput = growFloat32Array(this.buildingPoseInput, needed);
  }
}
