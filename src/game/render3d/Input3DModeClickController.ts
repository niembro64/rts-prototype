import type { ClientCommandSink } from '../input/ClientCommandSink';
import type { Entity, EntityId, PlayerId, BuildingBlueprintId } from '../sim/types';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import {
  buildAttackCommandAt,
  buildAttackCommandForTarget,
  buildAttackAreaCommand,
  buildAttackGroundCommand,
  buildCaptureCommandForTarget,
  buildGuardCommandAt,
  buildGuardCommandForTarget,
  buildLoadTransportCommandForTarget,
  buildReclaimAreaCommand,
  buildReclaimCommandForTarget,
  buildRepairAreaCommand,
  buildResurrectAreaCommand,
  buildResurrectCommandForTarget,
  buildUnloadTransportCommand,
  getSelectedClientTransports,
  type CommanderModeController,
  type InputSelectedCommands,
} from '../input/helpers';
import type { CommandCursorKind } from '../input/CommandCursors';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import type { BuildGhost3D } from './BuildGhost3D';
import {
  Input3DBuildPlacementState,
  type BuildFacingInfo,
  type BuildLineSpacingInfo,
} from './Input3DBuildPlacementState';
import type { Input3DPicker } from './Input3DPicker';
import { entityCanBuild } from '../sim/builderBuildRoster';
import { CLICK_DRAG_THRESHOLD_PX } from '../input/constants';
import { METAL_EXTRACTOR_UPGRADE_AREA_MAX_RADIUS } from '../sim/commandLimits';
import {
  canBuilderUpgradeMetalExtractor,
  isUpgradeableMetalExtractorTarget,
} from '../sim/metalExtractorUpgrade';
import {
  EMPTY_AREA_DRAG_STATE,
  type Input3DAreaDragKind,
  type Input3DAreaDragState,
} from './Input3DAreaDragState';
import { resolveProjectileSelectionGroundReach } from './ProjectileBallisticPreview';
import { queueModeFromEvent, type QueueCommandMode } from '../input/queueModifiers';

const REPAIR_AREA_RADIUS = 220;
const RECLAIM_AREA_RADIUS = 220;
const RESURRECT_AREA_RADIUS = 220;
const ATTACK_AREA_RADIUS = 300;
const MEX_UPGRADE_AREA_RADIUS = 220;
const AREA_MEX_BLUEPRINT_ID: BuildingBlueprintId = 'buildingExtractor';

type AreaDrag = {
  kind: Input3DAreaDragKind;
  button: 0 | 2;
  start: { x: number; y: number; z?: number };
  current: { x: number; y: number; z?: number };
  startClientX: number;
  startClientY: number;
  queue: boolean;
  queueFront: boolean;
  queueInsertIndex?: number;
};

type BuildPreviewTarget = {
  buildingBlueprintId: BuildingBlueprintId;
  worldX: number;
  worldY: number;
};

type BuildShapePlacementPlanner = (
  buildingBlueprintId: BuildingBlueprintId,
  entitySource: ModeClickEntitySource,
) => ReadonlyArray<{ gridX: number; gridY: number }>;

type ModeClickEntitySource = {
  getUnits: () => Entity[];
  getBuildings: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
  getSelectedUnits: () => Entity[];
  getEntitySetVersion?: () => number;
  getTerrainBuildabilityGrid?: () => TerrainBuildabilityGrid | null;
};

type Input3DModeClickControllerConfig = {
  getEntitySource: () => ModeClickEntitySource;
  commandQueue: ClientCommandSink;
  picker: Input3DPicker;
  mode: CommanderModeController;
  selectedCommands: InputSelectedCommands;
  getTick: () => number;
  getActivePlayerId: () => PlayerId;
  getQueueInsertIndex: () => number | null;
  getSelectedCommander: () => Entity | null;
  getSelectedBuilder: () => Entity | null;
  applyCursor: (kind: CommandCursorKind) => void;
  isRepairAreaMode: () => boolean;
  isAttackMode: () => boolean;
  isAttackAreaMode: () => boolean;
  isAttackGroundMode: () => boolean;
  isManualLaunchMode: () => boolean;
  isGuardMode: () => boolean;
  isReclaimMode: () => boolean;
  isCaptureMode: () => boolean;
  isResurrectMode: () => boolean;
  isResurrectAreaMode: () => boolean;
  isLoadTransportMode: () => boolean;
  isUnloadTransportMode: () => boolean;
  isMexUpgradeMode: () => boolean;
  isPingMode: () => boolean;
  isTowerTargetMode: () => boolean;
  exitRepairAreaMode: () => void;
  exitAttackMode: () => void;
  exitAttackAreaMode: () => void;
  exitAttackGroundMode: () => void;
  exitManualLaunchMode: () => void;
  exitGuardMode: () => void;
  exitReclaimMode: () => void;
  exitCaptureMode: () => void;
  exitResurrectMode: () => void;
  exitResurrectAreaMode: () => void;
  exitLoadTransportMode: () => void;
  exitUnloadTransportMode: () => void;
  exitMexUpgradeMode: () => void;
  exitPingMode: () => void;
  exitTowerTargetMode: () => void;
};

export class Input3DModeClickController {
  private readonly buildPlacement = new Input3DBuildPlacementState();
  private buildGhost: BuildGhost3D | null = null;
  private areaDrag: AreaDrag | null = null;
  private clickQueueModeOverride: QueueCommandMode | null = null;
  private areaHoverPreview: Input3DAreaDragState = EMPTY_AREA_DRAG_STATE;
  private lastBuildPreviewTarget: BuildPreviewTarget | null = null;

  constructor(private readonly config: Input3DModeClickControllerConfig) {}

  get active(): boolean {
    return this.areaDrag !== null ||
      this.config.mode.isInBuildMode ||
      this.config.mode.isInDGunMode ||
      this.config.isRepairAreaMode() ||
      this.config.isAttackMode() ||
      this.config.isAttackAreaMode() ||
      this.config.isAttackGroundMode() ||
      this.config.isManualLaunchMode() ||
      this.config.isGuardMode() ||
      this.config.isReclaimMode() ||
      this.config.isCaptureMode() ||
      this.config.isResurrectMode() ||
      this.config.isResurrectAreaMode() ||
      this.config.isLoadTransportMode() ||
      this.config.isUnloadTransportMode() ||
      this.config.isMexUpgradeMode() ||
      this.config.isPingMode() ||
      this.config.isTowerTargetMode();
  }

  get buildDiagnostics() {
    return this.buildPlacement.diagnostics;
  }

  setBuildGhost(ghost: BuildGhost3D | null): void {
    this.buildGhost = ghost;
  }

  setMapBounds(width: number, height: number, playerCount: number): void {
    this.buildPlacement.setMapBounds(width, height, playerCount);
  }

  getMapSampleBounds(): { width: number; height: number } {
    return {
      width: this.buildPlacement.width,
      height: this.buildPlacement.height,
    };
  }

  getBuildLineSpacingInfo(): BuildLineSpacingInfo {
    return this.buildPlacement.spacingInfo;
  }

  increaseBuildLineSpacing(): BuildLineSpacingInfo {
    return this.buildPlacement.increaseBuildLineSpacing();
  }

  decreaseBuildLineSpacing(): BuildLineSpacingInfo {
    return this.buildPlacement.decreaseBuildLineSpacing();
  }

  getBuildFacingInfo(): BuildFacingInfo {
    return this.buildPlacement.facingInfo;
  }

  rotateBuildFacingClockwise(): BuildFacingInfo {
    const next = this.buildPlacement.rotateBuildFacingClockwise();
    this.refreshBuildPreviewFacing();
    return next;
  }

  rotateBuildFacingCounterClockwise(): BuildFacingInfo {
    const next = this.buildPlacement.rotateBuildFacingCounterClockwise();
    this.refreshBuildPreviewFacing();
    return next;
  }

  handleBuildModeChange(buildingBlueprintId: BuildingBlueprintId | null): void {
    this.buildPlacement.reset();
    this.lastBuildPreviewTarget = null;
    if (buildingBlueprintId === null) {
      this.buildGhost?.hide();
    }
  }

  cursorKindForActiveMode(): CommandCursorKind | null {
    if (this.config.mode.isInBuildMode) {
      return this.buildPlacement.diagnostics
        ? (this.buildPlacement.diagnostics.canPlace ? 'build' : 'blocked')
        : 'build';
    }
    if (this.config.mode.isInDGunMode) return 'dgun';
    if (this.config.isRepairAreaMode()) return 'repair';
    if (this.config.isAttackMode()) return 'attack';
    if (this.config.isAttackAreaMode()) return 'attack';
    if (this.config.isAttackGroundMode()) return 'attack';
    if (this.config.isManualLaunchMode()) return 'attack';
    if (this.config.isGuardMode()) return 'guard';
    if (this.config.isReclaimMode()) return 'reclaim';
    if (this.config.isCaptureMode()) return 'reclaim';
    if (this.config.isResurrectMode()) return 'repair';
    if (this.config.isResurrectAreaMode()) return 'repair';
    if (this.config.isLoadTransportMode()) return 'guard';
    if (this.config.isUnloadTransportMode()) return 'move';
    if (this.config.isMexUpgradeMode()) return 'build';
    if (this.config.isPingMode()) return 'ping';
    if (this.config.isTowerTargetMode()) return 'attack';
    return null;
  }

  handleMouseDown(e: MouseEvent): boolean {
    if (!this.active) return false;
    e.preventDefault();
    if (e.button === 0) {
      if (this.beginAreaDrag(e)) return true;
      this.handleLeftClick(e);
    } else if (e.button === 2) {
      if (this.beginRightButtonAreaDrag(e)) return true;
      this.areaDrag = null;
      this.handleRightCancel();
    }
    return true;
  }

  handleMouseMove(e: MouseEvent): boolean {
    if (this.areaDrag !== null) {
      this.updateAreaDrag(e);
      this.config.applyCursor(this.cursorKindForActiveMode() ?? 'game');
      return true;
    }
    const buildingBlueprintId = this.config.mode.buildingBlueprintId;
    if (buildingBlueprintId !== null) {
      this.updateBuildPreview(e, buildingBlueprintId);
      return true;
    }
    if (this.updateAreaHoverPreview(e)) {
      this.config.applyCursor(this.cursorKindForActiveMode() ?? 'game');
      return true;
    }
    this.areaHoverPreview = EMPTY_AREA_DRAG_STATE;
    const cursor = this.cursorKindForActiveMode();
    if (cursor !== null) {
      this.config.applyCursor(cursor);
      return true;
    }
    return false;
  }

  handleMouseUp(e: MouseEvent): boolean {
    if (this.areaDrag === null || e.button !== this.areaDrag.button) return false;
    e.preventDefault();
    this.updateAreaDrag(e);
    const drag = this.areaDrag;
    this.areaDrag = null;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (Math.sqrt(dx * dx + dy * dy) < CLICK_DRAG_THRESHOLD_PX) {
      if (drag.button === 0) {
        this.withClickQueueMode(drag, () => this.handleLeftClick(e));
      }
      else this.handleRightCancel();
      return true;
    }
    this.commitAreaDrag(drag);
    return true;
  }

  getAreaDragState(): Input3DAreaDragState {
    const drag = this.areaDrag;
    if (drag === null) {
      const previewKind = this.config.isAttackGroundMode() ? 'attackGround' : this.activeAreaDragKind();
      return previewKind !== null && previewKind === this.areaHoverPreview.kind
        ? this.areaHoverPreview
        : EMPTY_AREA_DRAG_STATE;
    }
    return {
      active: true,
      kind: drag.kind,
      x: drag.start.x,
      y: drag.start.y,
      z: drag.start.z,
      endX: drag.current.x,
      endY: drag.current.y,
      endZ: drag.current.z,
      radius: Math.max(1, areaDragRadius(drag)),
      ballisticReach: this.resolveAttackBallisticReach(drag.kind, drag.start),
    };
  }

  private beginAreaDrag(e: MouseEvent): boolean {
    const kind = this.activeAreaDragKind();
    if (kind === null) return false;
    return this.beginAreaDragWithKind(e, kind, 0);
  }

  private beginRightButtonAreaDrag(e: MouseEvent): boolean {
    if (!this.config.isReclaimMode()) return false;
    return this.beginAreaDragWithKind(e, 'reclaimArea', 2);
  }

  private beginAreaDragWithKind(
    e: MouseEvent,
    kind: Input3DAreaDragKind,
    button: 0 | 2,
  ): boolean {
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return false;
    const resolvedKind = kind === 'buildLine'
      ? resolveBuildDragKind(e)
      : kind;
    const queueMode = queueModeFromEvent(e, this.config.getQueueInsertIndex());
    this.areaDrag = {
      kind: resolvedKind,
      button,
      start: { x: world.x, y: world.y, z: world.z },
      current: { x: world.x, y: world.y, z: world.z },
      startClientX: e.clientX,
      startClientY: e.clientY,
      queue: queueMode.queue,
      queueFront: queueMode.queueFront,
      queueInsertIndex: queueMode.queueInsertIndex,
    };
    return true;
  }

  private updateAreaDrag(e: MouseEvent): void {
    const drag = this.areaDrag;
    if (drag === null) return;
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    drag.current = { x: world.x, y: world.y, z: world.z };
  }

  private updateAreaHoverPreview(e: MouseEvent): boolean {
    const kind = this.config.isAttackGroundMode() ? 'attackGround' : this.activeAreaDragKind();
    if (kind === null || kind === 'buildMexArea' || kind === 'buildLine') return false;
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return false;
    this.areaHoverPreview = {
      active: true,
      kind,
      x: world.x,
      y: world.y,
      z: world.z,
      radius: defaultAreaRadius(kind),
      ballisticReach: this.resolveAttackBallisticReach(kind, world),
    };
    return true;
  }

  private activeAreaDragKind(): Input3DAreaDragKind | null {
    const buildingBlueprintId = this.config.mode.buildingBlueprintId;
    if (buildingBlueprintId === AREA_MEX_BLUEPRINT_ID) return 'buildMexArea';
    if (buildingBlueprintId !== null) return 'buildLine';
    if (this.config.isRepairAreaMode()) return 'repairArea';
    if (this.config.isAttackAreaMode()) return 'attackArea';
    if (this.config.isReclaimMode()) return 'reclaimArea';
    if (this.config.isResurrectAreaMode()) return 'resurrectArea';
    if (this.config.isMexUpgradeMode()) return 'upgradeMexArea';
    return null;
  }

  private commitAreaDrag(drag: AreaDrag): void {
    const radius = Math.max(1, areaDragRadius(drag));
    if (drag.kind === 'buildMexArea') {
      this.commitBuildMexAreaDrag(drag, radius);
      return;
    }
    if (drag.kind === 'buildLine') {
      this.commitBuildLineDrag(drag);
      return;
    }
    if (drag.kind === 'buildBorder') {
      this.commitBuildBorderDrag(drag);
      return;
    }
    if (drag.kind === 'buildGrid') {
      this.commitBuildGridDrag(drag);
      return;
    }
    if (drag.kind === 'repairArea') {
      const cmd = buildRepairAreaCommand(
        this.config.getSelectedCommander(),
        drag.start.x,
        drag.start.y,
        radius,
        this.config.getTick(),
        drag.queue,
        drag.start.z,
        drag.queueFront,
        drag.queueInsertIndex,
      );
      if (cmd) this.config.commandQueue.enqueue(cmd);
      this.config.applyCursor('repair');
      if (!drag.queue) this.config.exitRepairAreaMode();
      return;
    }
    if (drag.kind === 'attackArea') {
      const cmd = buildAttackAreaCommand(
        this.config.getEntitySource().getSelectedUnits(),
        drag.start.x,
        drag.start.y,
        radius,
        this.config.getTick(),
        drag.queue,
        drag.start.z,
        drag.queueFront,
        drag.queueInsertIndex,
      );
      if (cmd) this.config.commandQueue.enqueue(cmd);
      this.config.applyCursor('attack');
      if (!drag.queue) this.config.exitAttackAreaMode();
      return;
    }
    if (drag.kind === 'resurrectArea') {
      const cmd = buildResurrectAreaCommand(
        this.config.getSelectedCommander(),
        drag.start.x,
        drag.start.y,
        radius,
        this.config.getTick(),
        drag.queue,
        drag.start.z,
        drag.queueFront,
        drag.queueInsertIndex,
      );
      if (cmd) this.config.commandQueue.enqueue(cmd);
      this.config.applyCursor('repair');
      if (!drag.queue) this.config.exitResurrectAreaMode();
      return;
    }
    if (drag.kind === 'upgradeMexArea') {
      const builderIds = this.getSelectedMetalExtractorUpgradeBuilderIds();
      if (builderIds.length === 0) {
        this.config.applyCursor('blocked');
        return;
      }
      this.config.commandQueue.enqueue({
        type: 'upgradeMetalExtractorArea',
        tick: this.config.getTick(),
        builderIds,
        targetX: drag.start.x,
        targetY: drag.start.y,
        targetZ: drag.start.z,
        radius: Math.min(radius, METAL_EXTRACTOR_UPGRADE_AREA_MAX_RADIUS),
        queue: drag.queue,
        queueFront: drag.queueFront,
        queueInsertIndex: drag.queueInsertIndex,
      });
      this.config.applyCursor('build');
      if (!drag.queue) this.config.exitMexUpgradeMode();
      return;
    }
    const cmd = buildReclaimAreaCommand(
      this.config.getSelectedCommander(),
      drag.start.x,
      drag.start.y,
      radius,
      this.config.getTick(),
      drag.queue,
      drag.start.z,
      drag.queueFront,
      drag.queueInsertIndex,
    );
    if (cmd) this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('reclaim');
    if (!drag.queue) this.config.exitReclaimMode();
  }

  private commitBuildMexAreaDrag(drag: AreaDrag, radius: number): void {
    this.commitBuildShapePlacements(
      drag,
      AREA_MEX_BLUEPRINT_ID,
      (_buildingBlueprintId, entitySource) => this.buildPlacement.planMetalExtractorPlacementsInArea(
        drag.start.x,
        drag.start.y,
        radius,
        entitySource,
      ),
    );
  }

  private commitBuildLineDrag(drag: AreaDrag): void {
    const buildingBlueprintId = this.config.mode.buildingBlueprintId;
    if (buildingBlueprintId === null) return;
    this.commitBuildShapePlacements(
      drag,
      buildingBlueprintId,
      (blueprintId, entitySource) => this.buildPlacement.planBuildLinePlacements(
        blueprintId,
        drag.start.x,
        drag.start.y,
        drag.current.x,
        drag.current.y,
        entitySource,
      ),
    );
  }

  private commitBuildBorderDrag(drag: AreaDrag): void {
    const buildingBlueprintId = this.config.mode.buildingBlueprintId;
    if (buildingBlueprintId === null) return;
    this.commitBuildShapePlacements(
      drag,
      buildingBlueprintId,
      (blueprintId, entitySource) => this.buildPlacement.planBuildBorderPlacements(
        blueprintId,
        drag.start.x,
        drag.start.y,
        drag.current.x,
        drag.current.y,
        entitySource,
      ),
    );
  }

  private commitBuildGridDrag(drag: AreaDrag): void {
    const buildingBlueprintId = this.config.mode.buildingBlueprintId;
    if (buildingBlueprintId === null) return;
    this.commitBuildShapePlacements(
      drag,
      buildingBlueprintId,
      (blueprintId, entitySource) => this.buildPlacement.planBuildGridPlacements(
        blueprintId,
        drag.start.x,
        drag.start.y,
        drag.current.x,
        drag.current.y,
        entitySource,
      ),
    );
  }

  private commitBuildShapePlacements(
    drag: AreaDrag,
    buildingBlueprintId: BuildingBlueprintId,
    planner: BuildShapePlacementPlanner,
  ): void {
    const builders = this.getSelectedBuildersForBlueprint(buildingBlueprintId);
    if (builders.length === 0) {
      this.config.applyCursor('blocked');
      return;
    }

    const entitySource = this.config.getEntitySource();
    const placements = planner(buildingBlueprintId, entitySource);
    if (placements.length === 0) {
      this.config.applyCursor('blocked');
      return;
    }

    const tick = this.config.getTick();
    const perBuilderCounts = new Map<number, number>();
    for (let i = 0; i < placements.length; i++) {
      const placement = placements[i];
      const builder = builders[i % builders.length];
      const assignedCount = perBuilderCounts.get(builder.id) ?? 0;
      perBuilderCounts.set(builder.id, assignedCount + 1);
      this.config.commandQueue.enqueue({
        type: 'startBuild',
        tick,
        builderId: builder.id,
        buildingBlueprintId,
        gridX: placement.gridX,
        gridY: placement.gridY,
        rotation: this.buildPlacement.facingInfo.rotation,
        queue: assignedCount === 0 ? drag.queue : true,
        queueFront: assignedCount === 0 ? drag.queueFront : false,
        queueInsertIndex: assignedCount === 0 ? drag.queueInsertIndex : undefined,
      });
    }
    this.config.applyCursor('build');
    if (!drag.queue) this.config.mode.exitBuildMode();
  }

  private getSelectedBuildersForBlueprint(buildingBlueprintId: BuildingBlueprintId): Entity[] {
    const builders: Entity[] = [];
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (entityCanBuild(unit, buildingBlueprintId)) builders.push(unit);
    }
    if (builders.length > 0) return builders;
    const builder = this.config.getSelectedBuilder();
    return entityCanBuild(builder, buildingBlueprintId) && builder !== null ? [builder] : [];
  }

  private getSelectedMetalExtractorUpgradeBuilderIds(): EntityId[] {
    const builderIds: EntityId[] = [];
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (canBuilderUpgradeMetalExtractor(unit)) builderIds.push(unit.id);
    }
    return builderIds;
  }

  private handleLeftClick(e: MouseEvent): void {
    if (this.config.mode.isInBuildMode) this.handleBuildClick(e);
    else if (this.config.mode.isInDGunMode) this.handleDGunClick(e);
    else if (this.config.isRepairAreaMode()) this.handleRepairAreaClick(e);
    else if (this.config.isAttackMode()) this.handleAttackClick(e);
    else if (this.config.isAttackAreaMode()) this.handleAttackAreaClick(e);
    else if (this.config.isAttackGroundMode()) this.handleAttackGroundClick(e);
    else if (this.config.isManualLaunchMode()) this.handleManualLaunchClick(e);
    else if (this.config.isGuardMode()) this.handleGuardClick(e);
    else if (this.config.isReclaimMode()) this.handleReclaimClick(e);
    else if (this.config.isCaptureMode()) this.handleCaptureClick(e);
    else if (this.config.isResurrectMode()) this.handleResurrectClick(e);
    else if (this.config.isResurrectAreaMode()) this.handleResurrectAreaClick(e);
    else if (this.config.isLoadTransportMode()) this.handleLoadTransportClick(e);
    else if (this.config.isUnloadTransportMode()) this.handleUnloadTransportClick(e);
    else if (this.config.isMexUpgradeMode()) this.handleMexUpgradeClick(e);
    else if (this.config.isTowerTargetMode()) this.handleTowerTargetClick(e);
    else this.handlePingClick(e);
  }

  private handleRightCancel(): void {
    if (this.config.mode.isInBuildMode) this.config.mode.exitBuildMode();
    else if (this.config.mode.isInDGunMode) this.config.mode.exitDGunMode();
    else if (this.config.isRepairAreaMode()) this.config.exitRepairAreaMode();
    else if (this.config.isAttackMode()) this.config.exitAttackMode();
    else if (this.config.isAttackAreaMode()) this.config.exitAttackAreaMode();
    else if (this.config.isAttackGroundMode()) this.config.exitAttackGroundMode();
    else if (this.config.isManualLaunchMode()) this.config.exitManualLaunchMode();
    else if (this.config.isGuardMode()) this.config.exitGuardMode();
    else if (this.config.isReclaimMode()) this.config.exitReclaimMode();
    else if (this.config.isCaptureMode()) this.config.exitCaptureMode();
    else if (this.config.isResurrectMode()) this.config.exitResurrectMode();
    else if (this.config.isResurrectAreaMode()) this.config.exitResurrectAreaMode();
    else if (this.config.isLoadTransportMode()) this.config.exitLoadTransportMode();
    else if (this.config.isUnloadTransportMode()) this.config.exitUnloadTransportMode();
    else if (this.config.isMexUpgradeMode()) this.config.exitMexUpgradeMode();
    else if (this.config.isTowerTargetMode()) this.config.exitTowerTargetMode();
    else this.config.exitPingMode();
  }

  private resolveClickQueueMode(e: MouseEvent): QueueCommandMode {
    return this.clickQueueModeOverride ?? queueModeFromEvent(e, this.config.getQueueInsertIndex());
  }

  private withClickQueueMode(drag: AreaDrag, run: () => void): void {
    const previous = this.clickQueueModeOverride;
    this.clickQueueModeOverride = {
      queue: drag.queue,
      queueFront: drag.queueFront,
      queueInsertIndex: drag.queueInsertIndex,
    };
    try {
      run();
    } finally {
      this.clickQueueModeOverride = previous;
    }
  }

  private updateBuildPreview(e: MouseEvent, buildingBlueprintId: BuildingBlueprintId): void {
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (world) {
      const builder = this.config.getSelectedBuilder();
      if (!entityCanBuild(builder, buildingBlueprintId)) {
        this.config.applyCursor('blocked');
        this.lastBuildPreviewTarget = null;
        this.buildGhost?.hide();
        return;
      }
      const diagnostics = this.validateBuildPlacement(buildingBlueprintId, world.x, world.y);
      this.config.applyCursor(diagnostics.canPlace ? 'build' : 'blocked');
      this.lastBuildPreviewTarget = { buildingBlueprintId, worldX: world.x, worldY: world.y };
      this.buildGhost?.setTarget(
        buildingBlueprintId,
        world.x,
        world.y,
        builder,
        this.buildPlacement.canPlace,
        diagnostics,
        this.buildPlacement.facingInfo.rotation,
      );
    } else {
      this.buildPlacement.clearDiagnostics();
      this.lastBuildPreviewTarget = null;
      this.config.applyCursor('blocked');
    }
  }

  private refreshBuildPreviewFacing(): void {
    const target = this.lastBuildPreviewTarget;
    if (target === null || !this.config.mode.isInBuildMode) return;
    if (this.config.mode.buildingBlueprintId !== target.buildingBlueprintId) return;
    const builder = this.config.getSelectedBuilder();
    if (!entityCanBuild(builder, target.buildingBlueprintId)) {
      this.buildGhost?.hide();
      this.lastBuildPreviewTarget = null;
      return;
    }
    const diagnostics = this.validateBuildPlacement(
      target.buildingBlueprintId,
      target.worldX,
      target.worldY,
    );
    this.buildGhost?.setTarget(
      target.buildingBlueprintId,
      target.worldX,
      target.worldY,
      builder,
      diagnostics.canPlace,
      diagnostics,
      this.buildPlacement.facingInfo.rotation,
    );
  }

  private handleBuildClick(e: MouseEvent): void {
    const builder = this.config.getSelectedBuilder();
    if (!builder) {
      this.config.mode.exitBuildMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const buildingBlueprintId = this.config.mode.buildingBlueprintId;
    if (buildingBlueprintId === null) return;
    if (!entityCanBuild(builder, buildingBlueprintId)) {
      this.config.applyCursor('blocked');
      return;
    }
    const diagnostics = this.validateBuildPlacement(buildingBlueprintId, world.x, world.y);
    this.config.applyCursor(diagnostics.canPlace ? 'build' : 'blocked');
    this.lastBuildPreviewTarget = { buildingBlueprintId, worldX: world.x, worldY: world.y };
    this.buildGhost?.setTarget(
      buildingBlueprintId, world.x, world.y,
      builder,
      diagnostics.canPlace,
      diagnostics,
      this.buildPlacement.facingInfo.rotation,
    );
    if (!diagnostics.canPlace) {
      debugLog(GAME_DIAGNOSTICS.commandPlans, 'Blocked invalid build placement', {
        buildingBlueprintId,
        reason: diagnostics.failureReason,
        metalFraction: diagnostics.metalFraction,
      });
      return;
    }
    const queueMode = this.resolveClickQueueMode(e);
    const cmd = this.config.mode.buildStartBuildCommand(
      builder, world.x, world.y,
      this.config.getTick(), queueMode.queue, queueMode.queueFront,
      queueMode.queueInsertIndex,
      this.buildPlacement.facingInfo.rotation,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    if (!queueMode.queue) this.config.mode.exitBuildMode();
  }

  private validateBuildPlacement(
    buildingBlueprintId: BuildingBlueprintId,
    worldX: number,
    worldY: number,
  ) {
    return this.buildPlacement.validate(
      buildingBlueprintId,
      worldX,
      worldY,
      this.config.getEntitySource(),
    );
  }

  private handleDGunClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.mode.exitDGunMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = this.config.mode.buildFireDGunCommand(
      commander, world.x, world.y, this.config.getTick(), world.z,
    );
    this.config.commandQueue.enqueue(cmd);
  }

  private handleRepairAreaClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.exitRepairAreaMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const queueMode = this.resolveClickQueueMode(e);
    const cmd = buildRepairAreaCommand(
      commander,
      world.x,
      world.y,
      REPAIR_AREA_RADIUS,
      this.config.getTick(),
      queueMode.queue,
      world.z,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('repair');
    if (!queueMode.queue) this.config.exitRepairAreaMode();
  }

  private handleAttackAreaClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitAttackAreaMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const queueMode = this.resolveClickQueueMode(e);
    const cmd = buildAttackAreaCommand(
      selectedUnits,
      world.x,
      world.y,
      ATTACK_AREA_RADIUS,
      this.config.getTick(),
      queueMode.queue,
      world.z,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('attack');
    if (!queueMode.queue) this.config.exitAttackAreaMode();
  }

  private handleAttackClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitAttackMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);
    const meshAttackCmd = buildAttackCommandForTarget(
      entityHit,
      selectedUnits,
      this.config.getActivePlayerId(),
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (meshAttackCmd) {
      this.config.commandQueue.enqueue(meshAttackCmd);
      this.config.applyCursor('attack');
      if (!queueMode.queue) this.config.exitAttackMode();
      return;
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const attackCmd = buildAttackCommandAt(
      this.config.getEntitySource(),
      world.x,
      world.y,
      selectedUnits,
      this.config.getActivePlayerId(),
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!attackCmd) return;
    this.config.commandQueue.enqueue(attackCmd);
    this.config.applyCursor('attack');
    if (!queueMode.queue) this.config.exitAttackMode();
  }

  private handleAttackGroundClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitAttackGroundMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const queueMode = this.resolveClickQueueMode(e);
    const cmd = buildAttackGroundCommand(
      selectedUnits,
      world.x,
      world.y,
      this.config.getTick(),
      queueMode.queue,
      world.z,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('attack');
    if (!queueMode.queue) this.config.exitAttackGroundMode();
  }

  private handleManualLaunchClick(e: MouseEvent): void {
    const targets = this.config.selectedCommands.selectedTargetableCombatEntities();
    const entityIds: EntityId[] = [];
    for (let i = 0; i < targets.length; i++) {
      const combat = targets[i].combat;
      if (combat === null) continue;
      if (combat.turrets.some((turret) =>
        !turret.config.visualOnly && !turret.config.passive && turret.config.shot !== null
      )) {
        entityIds.push(targets[i].id);
      }
    }
    if (entityIds.length === 0) {
      this.config.exitManualLaunchMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    this.config.commandQueue.enqueue({
      type: 'manualLaunch',
      tick: this.config.getTick(),
      entityIds,
      targetX: world.x,
      targetY: world.y,
      targetZ: world.z,
    });
    this.config.applyCursor('attack');
    if (!this.resolveClickQueueMode(e).queue) this.config.exitManualLaunchMode();
  }

  private resolveAttackBallisticReach(
    kind: Input3DAreaDragKind,
    target: { x: number; y: number; z?: number },
  ): Input3DAreaDragState['ballisticReach'] {
    if (kind !== 'attackArea' && kind !== 'attackGround') return null;
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    const { width, height } = this.getMapSampleBounds();
    return resolveProjectileSelectionGroundReach(
      selectedUnits,
      target.x,
      target.y,
      target.z ?? 0,
      width,
      height,
    );
  }

  private handlePingClick(e: MouseEvent): void {
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    this.config.commandQueue.enqueue({
      type: 'ping',
      tick: this.config.getTick(),
      targetX: world.x,
      targetY: world.y,
      targetZ: world.z,
    });
    this.config.applyCursor('ping');
    if (!this.resolveClickQueueMode(e).queue) this.config.exitPingMode();
  }

  private handleGuardClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitGuardMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);

    const meshGuardCmd = buildGuardCommandForTarget(
      entityHit,
      selectedUnits,
      this.config.getActivePlayerId(),
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (meshGuardCmd) {
      this.config.commandQueue.enqueue(meshGuardCmd);
      this.config.applyCursor('guard');
      if (!queueMode.queue) this.config.exitGuardMode();
      return;
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const guardCmd = buildGuardCommandAt(
      this.config.getEntitySource(),
      world.x,
      world.y,
      selectedUnits,
      this.config.getActivePlayerId(),
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!guardCmd) return;
    this.config.commandQueue.enqueue(guardCmd);
    this.config.applyCursor('guard');
    if (!queueMode.queue) this.config.exitGuardMode();
  }

  private handleReclaimClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.exitReclaimMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);

    const meshReclaimCmd = buildReclaimCommandForTarget(
      entityHit,
      commander,
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (meshReclaimCmd) {
      this.config.commandQueue.enqueue(meshReclaimCmd);
      this.config.applyCursor('reclaim');
      if (!queueMode.queue) this.config.exitReclaimMode();
      return;
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const reclaimCmd = buildReclaimAreaCommand(
      commander,
      world.x,
      world.y,
      RECLAIM_AREA_RADIUS,
      tick,
      queueMode.queue,
      world.z,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!reclaimCmd) return;
    this.config.commandQueue.enqueue(reclaimCmd);
    this.config.applyCursor('reclaim');
    if (!queueMode.queue) this.config.exitReclaimMode();
  }

  private handleCaptureClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.exitCaptureMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);

    const captureCmd = buildCaptureCommandForTarget(
      entityHit,
      commander,
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!captureCmd) {
      this.config.applyCursor('blocked');
      return;
    }
    this.config.commandQueue.enqueue(captureCmd);
    this.config.applyCursor('reclaim');
    if (!queueMode.queue) this.config.exitCaptureMode();
  }

  private handleResurrectClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.exitResurrectMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);

    const resurrectCmd = buildResurrectCommandForTarget(
      entityHit,
      commander,
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!resurrectCmd) {
      this.config.applyCursor('blocked');
      return;
    }
    this.config.commandQueue.enqueue(resurrectCmd);
    this.config.applyCursor('repair');
    if (!queueMode.queue) this.config.exitResurrectMode();
  }

  private handleResurrectAreaClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.exitResurrectAreaMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const queueMode = this.resolveClickQueueMode(e);
    const cmd = buildResurrectAreaCommand(
      commander,
      world.x,
      world.y,
      RESURRECT_AREA_RADIUS,
      this.config.getTick(),
      queueMode.queue,
      world.z,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('repair');
    if (!queueMode.queue) this.config.exitResurrectAreaMode();
  }

  private handleLoadTransportClick(e: MouseEvent): void {
    const transports = getSelectedClientTransports(this.config.getEntitySource().getSelectedUnits());
    if (transports.length === 0) {
      this.config.exitLoadTransportMode();
      return;
    }
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);
    const cmd = buildLoadTransportCommandForTarget(
      entityHit,
      transports[0],
      this.config.getTick(),
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!cmd) {
      this.config.applyCursor('blocked');
      return;
    }
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('guard');
    if (!queueMode.queue) this.config.exitLoadTransportMode();
  }

  private handleUnloadTransportClick(e: MouseEvent): void {
    const transports = getSelectedClientTransports(this.config.getEntitySource().getSelectedUnits());
    if (transports.length === 0) {
      this.config.exitUnloadTransportMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const queueMode = this.resolveClickQueueMode(e);
    const cmd = buildUnloadTransportCommand(
      transports,
      world.x,
      world.y,
      this.config.getTick(),
      queueMode.queue,
      world.z,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('move');
    if (!queueMode.queue) this.config.exitUnloadTransportMode();
  }

  private handleMexUpgradeClick(e: MouseEvent): void {
    const builderIds = this.getSelectedMetalExtractorUpgradeBuilderIds();
    if (builderIds.length === 0) {
      this.config.exitMexUpgradeMode();
      return;
    }
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const target = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    if (!isUpgradeableMetalExtractorTarget(target, this.config.getActivePlayerId())) {
      this.config.applyCursor('blocked');
      return;
    }
    const queueMode = this.resolveClickQueueMode(e);
    this.config.commandQueue.enqueue({
      type: 'upgradeMetalExtractor',
      tick: this.config.getTick(),
      builderId: builderIds[0],
      targetId: target.id,
      queue: queueMode.queue,
      queueFront: queueMode.queueFront,
      queueInsertIndex: queueMode.queueInsertIndex,
    });
    this.config.applyCursor('build');
    if (!queueMode.queue) this.config.exitMexUpgradeMode();
  }

  private handleTowerTargetClick(e: MouseEvent): void {
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    if (entityHitId === null) return;
    this.config.selectedCommands.setTowerTarget(entityHitId);
    if (!this.resolveClickQueueMode(e).queue) this.config.exitTowerTargetMode();
  }
}

function resolveBuildDragKind(e: MouseEvent): Input3DAreaDragKind {
  if (e.ctrlKey || e.metaKey) return 'buildGrid';
  if (e.altKey) return 'buildBorder';
  return 'buildLine';
}

function areaDragRadius(drag: AreaDrag): number {
  const dx = drag.current.x - drag.start.x;
  const dy = drag.current.y - drag.start.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function defaultAreaRadius(kind: Input3DAreaDragKind): number {
  switch (kind) {
    case 'repairArea': return REPAIR_AREA_RADIUS;
    case 'reclaimArea': return RECLAIM_AREA_RADIUS;
    case 'resurrectArea': return RESURRECT_AREA_RADIUS;
    case 'attackArea': return ATTACK_AREA_RADIUS;
    case 'attackGround': return 48;
    case 'buildMexArea': return 1;
    case 'upgradeMexArea': return MEX_UPGRADE_AREA_RADIUS;
    default: return 1;
  }
}
