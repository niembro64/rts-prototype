import type { ClientCommandSink } from '../input/ClientCommandSink';
import type { Entity, EntityId, PlayerId, BuildingBlueprintId } from '../sim/types';
import { isAttackEmitter } from '../sim/emitterKinds';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import {
  buildAttackCommandAt,
  buildAttackCommandForTarget,
  buildAttackAreaCommand,
  buildAttackGroundCommand,
  buildCaptureCommandForTarget,
  buildGuardCommandAt,
  buildGuardCommandForTarget,
  buildLoadTransportAreaCommand,
  buildLoadTransportCommandForTarget,
  buildReclaimAreaCommand,
  buildReclaimCommandForTarget,
  buildRepairAreaCommand,
  buildRepairCommandForTarget,
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
import type { MetalDeposit } from '../../metalDepositConfig';
import {
  Input3DBuildPlacementState,
  type BuildFacingInfo,
  type BuildLineSpacingInfo,
} from './Input3DBuildPlacementState';
import type { Input3DPicker } from './Input3DPicker';
import {
  entityCanBuild,
  getBuilderConstructionRate,
} from '../sim/hostCapabilities';
import { getBuildingConfig } from '../sim/buildConfigs';
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
import {
  effectiveQueueModifierEvent,
  queueModeFromEvent,
  type QueueCommandMode,
} from '../input/queueModifiers';
import {
  resolveAreaCommandTargetFilter,
  type AreaCommandTargetFilter,
} from '../sim/areaCommandFilters';
import { entityHasBarAttackCommand } from '../sim/unitCommandCapabilities';

const REPAIR_AREA_RADIUS = 220;
const RECLAIM_AREA_RADIUS = 220;
const RESURRECT_AREA_RADIUS = 220;
const LOAD_TRANSPORT_AREA_RADIUS = 220;
const UNLOAD_TRANSPORT_AREA_MIN_RADIUS = 64;
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
  /** Entity under the cursor at the drag anchor (the area center) for
   *  the filterable area commands. BAR's cmd_area_commands_filter picks
   *  its Ctrl/Alt filter reference from the unit/feature at the command
   *  position, which is where our drag starts. Null = open ground. */
  anchorEntityId: EntityId | null;
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

type BuildQueuePlacement = {
  gridX: number;
  gridY: number;
};

type SelectedBuildRoster = {
  activeBuilder: Entity;
  capableBuilders: Entity[];
  ineligibleBuilders: Entity[];
};

type BuildOrderGroup = {
  leader: Entity;
  builders: Entity[];
  power: number;
  placements: BuildQueuePlacement[];
};

type ModeClickEntitySource = {
  getUnits: () => Entity[];
  getBuildings: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
  getSelectedUnits: () => Entity[];
  getSelectedBuildings?: () => Entity[];
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean;
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
  getSelectedResurrectSource: () => Entity | null;
  onBuildCommandIssued: (queued: boolean) => void;
  applyCursor: (kind: CommandCursorKind) => void;
  isRepairAreaMode: () => boolean;
  isRestoreAreaMode: () => boolean;
  isAttackMode: () => boolean;
  isAttackAreaMode: () => boolean;
  isAttackGroundMode: () => boolean;
  isManualLaunchMode: () => boolean;
  isGuardMode: () => boolean;
  isReclaimMode: () => boolean;
  isCaptureMode: () => boolean;
  isResurrectMode: () => boolean;
  isResurrectAreaMode: () => boolean;
  isResurrectModeAreaCapable: () => boolean;
  isLoadTransportMode: () => boolean;
  isUnloadTransportMode: () => boolean;
  isMexUpgradeMode: () => boolean;
  isPingMode: () => boolean;
  isTowerTargetMode: () => boolean;
  isTowerTargetNoGroundMode: () => boolean;
  /** BAR cmd_buildsplit parity: true while the build-split modifier
   *  (held Space, BAR's `bind Any+space buildsplit`) is active. */
  isBuildSplitModifierHeld: () => boolean;
  exitRepairAreaMode: () => void;
  exitRestoreAreaMode: () => void;
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
  exitTowerTargetNoGroundMode: () => void;
  registerBarTargetTypeTracking?: (targetId: EntityId) => boolean;
  registerNearestBarTargetTypeTracking?: (point: { x: number; y: number; z?: number }) => EntityId | null;
  clearBarTargetTypeTrackingForSelected?: () => void;
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
      this.config.isRestoreAreaMode() ||
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
      this.config.isTowerTargetMode() ||
      this.config.isTowerTargetNoGroundMode();
  }

  get buildDiagnostics() {
    return this.buildPlacement.diagnostics;
  }

  setBuildGhost(ghost: BuildGhost3D | null): void {
    this.buildGhost = ghost;
  }

  setMapBounds(
    width: number,
    height: number,
    playerCount: number,
    metalDeposits: ReadonlyArray<MetalDeposit> | null = null,
  ): void {
    this.buildPlacement.setMapBounds(width, height, playerCount, metalDeposits);
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
    if (this.config.isRestoreAreaMode()) return 'repair';
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
    if (this.config.isTowerTargetNoGroundMode()) return 'attack';
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
    this.commitAreaDrag(drag, e);
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
    // BAR only enters multi-placement drag grammar while Shift is held.
    // Without Shift, the ordinary build click places exactly one structure
    // even if the pointer happens to move before release.
    if (
      kind === 'buildLine' &&
      !effectiveQueueModifierEvent(e).shiftKey
    ) return false;
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
      anchorEntityId: isFilterableAreaDragKind(resolvedKind)
        ? this.config.picker.raycastEntity(e.clientX, e.clientY)
        : null,
    };
    return true;
  }

  private updateAreaDrag(e: MouseEvent): void {
    const drag = this.areaDrag;
    if (drag === null) return;
    // BAR's engine re-reads Alt/Ctrl while a placement drag is live, so
    // pressing Alt mid-drag flips line -> grid fill (and Alt+Ctrl -> the
    // hollow box) with immediate preview feedback.
    if (isBuildShapeDragKind(drag.kind)) drag.kind = resolveBuildDragKind(e);
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
    if (this.config.isRestoreAreaMode()) return null;
    if (this.config.isAttackAreaMode()) return 'attackArea';
    if (this.config.isReclaimMode()) return 'reclaimArea';
    if (this.config.isResurrectMode() && this.config.isResurrectModeAreaCapable()) return 'resurrectArea';
    if (this.config.isResurrectAreaMode()) return 'resurrectArea';
    if (this.config.isLoadTransportMode()) return 'loadTransportArea';
    if (this.config.isUnloadTransportMode()) return 'unloadTransportArea';
    if (this.config.isMexUpgradeMode()) return 'upgradeMexArea';
    return null;
  }

  private commitAreaDrag(drag: AreaDrag, releaseEvent: MouseEvent): void {
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
    // BAR cmd_area_commands_filter: Ctrl/Alt held when the area command
    // is issued (drag release) filter its targets by the entity at the
    // area center. Modifier state is read at release; the reference
    // entity was captured at the drag anchor.
    const targetFilter = this.resolveAreaDragTargetFilter(drag, releaseEvent);
    if (drag.kind === 'repairArea') {
      const builders = this.getSelectedBuilders();
      for (let i = 0; i < builders.length; i++) {
        const cmd = buildRepairAreaCommand(
          builders[i],
          drag.start.x,
          drag.start.y,
          radius,
          this.config.getTick(),
          drag.queue,
          drag.start.z,
          drag.queueFront,
          drag.queueInsertIndex,
          targetFilter,
        );
        if (cmd) this.config.commandQueue.enqueue(cmd);
      }
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
        this.config.getSelectedResurrectSource(),
        drag.start.x,
        drag.start.y,
        radius,
        this.config.getTick(),
        drag.queue,
        drag.start.z,
        drag.queueFront,
        drag.queueInsertIndex,
        targetFilter,
      );
      if (cmd) this.config.commandQueue.enqueue(cmd);
      this.config.applyCursor('repair');
      if (!drag.queue) this.exitActiveResurrectMode();
      return;
    }
    if (drag.kind === 'loadTransportArea') {
      const transports = getSelectedClientTransports(this.config.getEntitySource().getSelectedUnits());
      const cmd = buildLoadTransportAreaCommand(
        transports,
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
      this.config.applyCursor(cmd ? 'guard' : 'blocked');
      if (!drag.queue) this.config.exitLoadTransportMode();
      return;
    }
    if (drag.kind === 'unloadTransportArea') {
      const transports = getSelectedClientTransports(this.config.getEntitySource().getSelectedUnits());
      const cmd = buildUnloadTransportCommand(
        transports,
        drag.start.x,
        drag.start.y,
        this.config.getTick(),
        drag.queue,
        drag.start.z,
        drag.queueFront,
        drag.queueInsertIndex,
        radius >= UNLOAD_TRANSPORT_AREA_MIN_RADIUS ? radius : undefined,
      );
      if (cmd) this.config.commandQueue.enqueue(cmd);
      this.config.applyCursor(cmd ? 'move' : 'blocked');
      if (!drag.queue) this.config.exitUnloadTransportMode();
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
    const builders = this.getSelectedBuilders();
    for (let i = 0; i < builders.length; i++) {
      const cmd = buildReclaimAreaCommand(
        builders[i],
        drag.start.x,
        drag.start.y,
        radius,
        this.config.getTick(),
        drag.queue,
        drag.start.z,
        drag.queueFront,
        drag.queueInsertIndex,
        targetFilter,
      );
      if (cmd) this.config.commandQueue.enqueue(cmd);
    }
    this.config.applyCursor('reclaim');
    if (!drag.queue) this.config.exitReclaimMode();
  }

  /** BAR cmd_area_commands_filter parity. Ctrl at release keeps only
   *  targets in the anchor entity's broad category (BAR: "all units in
   *  the area" / same-tech wrecks — our blueprints have no tech levels,
   *  so all wrecks); Alt keeps only targets with its exact blueprint
   *  (BAR: same unitDefId / featureDefId). No anchor entity or no
   *  modifier = unfiltered. Note: when the drag also queues (Shift held
   *  at press), Ctrl doubles as the queue-front modifier — both
   *  meanings apply, mirroring how BAR stacks its area filters on top
   *  of whatever queue options the command carries. */
  private resolveAreaDragTargetFilter(
    drag: AreaDrag,
    releaseEvent: MouseEvent,
  ): AreaCommandTargetFilter | undefined {
    if (drag.anchorEntityId === null) return undefined;
    const hovered = this.config.getEntitySource().getEntity(drag.anchorEntityId);
    if (hovered === undefined) return undefined;
    const modifiers = effectiveQueueModifierEvent(releaseEvent);
    const filter = resolveAreaCommandTargetFilter(
      hovered,
      modifiers.ctrlKey || modifiers.metaKey,
      modifiers.altKey,
    );
    return filter.filterCategory !== undefined || filter.filterBlueprintId !== undefined
      ? filter
      : undefined;
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

  /** BAR-style multi-builder build order batching:
   *  - Default: group capable builders by unit type, sort groups by
   *    total build power, and give each group one contiguous cost-based
   *    slice of the ordered placements.
   *  - Split modifier held: fork into one group per builder, then use
   *    the same build-power partitioning. BAR appends peer follow-up
   *    build commands; because our startBuild creates the frame
   *    immediately, queued guard is the local equivalent assist order. */
  private commitBuildShapePlacements(
    drag: AreaDrag,
    buildingBlueprintId: BuildingBlueprintId,
    planner: BuildShapePlacementPlanner,
  ): void {
    const roster = this.getSelectedBuildRoster(buildingBlueprintId);
    if (roster === null) {
      this.config.applyCursor('blocked');
      return;
    }

    const entitySource = this.config.getEntitySource();
    const placements = planner(buildingBlueprintId, entitySource);
    if (placements.length === 0) {
      this.config.applyCursor('blocked');
      return;
    }

    const split = this.config.isBuildSplitModifierHeld() && roster.capableBuilders.length > 1;
    const groups = split
      ? this.createSplitBuildOrderGroups(roster.capableBuilders)
      : this.createDefaultBuildOrderGroups(roster);
    this.distributeBuildPlacements(groups, placements, buildingBlueprintId);

    const tick = this.config.getTick();
    for (let i = 0; i < groups.length; i++) {
      this.enqueueBuildGroupPlacements(groups[i], drag, buildingBlueprintId, tick);
    }

    const workingGroups = groups.filter((group) => group.placements.length > 0);
    if (split) {
      this.enqueueSplitBuildAssists(
        groups,
        workingGroups,
        roster.ineligibleBuilders,
        drag,
        tick,
      );
    } else {
      this.enqueueDefaultBuildAssists(
        groups,
        workingGroups,
        roster.ineligibleBuilders,
        drag,
        tick,
      );
    }

    this.config.applyCursor('build');
    this.config.onBuildCommandIssued(drag.queue);
    if (!drag.queue) this.config.mode.exitBuildMode();
  }

  /** Active builder plus selected construction units. The active
   *  builder still gates the local build-mode command surface; selected
   *  builders that cannot build this structure are retained so they can
   *  assist a working group instead of silently doing nothing. */
  private getSelectedBuildRoster(
    buildingBlueprintId: BuildingBlueprintId,
  ): SelectedBuildRoster | null {
    const activeBuilder = this.config.getSelectedBuilder();
    if (activeBuilder === null) return null;
    if (!entityCanBuild(activeBuilder, buildingBlueprintId)) return null;

    const selectedBuilders: Entity[] = [];
    const seen = new Set<EntityId>();
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (unit.builder === null || unit.unit === null) continue;
      selectedBuilders.push(unit);
      seen.add(unit.id);
    }
    if (!seen.has(activeBuilder.id)) selectedBuilders.unshift(activeBuilder);

    const capableBuilders: Entity[] = [];
    const ineligibleBuilders: Entity[] = [];
    for (let i = 0; i < selectedBuilders.length; i++) {
      const builder = selectedBuilders[i];
      if (entityCanBuild(builder, buildingBlueprintId)) capableBuilders.push(builder);
      else ineligibleBuilders.push(builder);
    }
    return {
      activeBuilder,
      capableBuilders,
      ineligibleBuilders,
    };
  }

  private createDefaultBuildOrderGroups(roster: SelectedBuildRoster): BuildOrderGroup[] {
    const byType = new Map<string, BuildOrderGroup>();
    for (let i = 0; i < roster.capableBuilders.length; i++) {
      const builder = roster.capableBuilders[i];
      const unitBlueprintId = builder.unit?.unitBlueprintId ?? `entity:${builder.id}`;
      let group = byType.get(unitBlueprintId);
      if (group === undefined) {
        group = {
          leader: builder,
          builders: [],
          power: 0,
          placements: [],
        };
        byType.set(unitBlueprintId, group);
      }
      group.builders.push(builder);
      group.power += this.builderBuildPower(builder);
      if (builder.id === roster.activeBuilder.id) group.leader = builder;
    }
    return this.sortBuildOrderGroups(Array.from(byType.values()));
  }

  private createSplitBuildOrderGroups(builders: readonly Entity[]): BuildOrderGroup[] {
    const groups: BuildOrderGroup[] = [];
    for (let i = 0; i < builders.length; i++) {
      const builder = builders[i];
      groups.push({
        leader: builder,
        builders: [builder],
        power: this.builderBuildPower(builder),
        placements: [],
      });
    }
    return this.sortBuildOrderGroups(groups);
  }

  private sortBuildOrderGroups(groups: BuildOrderGroup[]): BuildOrderGroup[] {
    return groups.sort((a, b) => {
      if (b.power !== a.power) return b.power - a.power;
      return a.leader.id - b.leader.id;
    });
  }

  private distributeBuildPlacements(
    groups: BuildOrderGroup[],
    placements: ReadonlyArray<BuildQueuePlacement>,
    buildingBlueprintId: BuildingBlueprintId,
  ): void {
    if (groups.length === 0 || placements.length === 0) return;

    const placementCost = this.buildPlacementCost(buildingBlueprintId);
    let nextPlacementIndex = 0;
    let remainingPower = 0;
    for (let i = 0; i < groups.length; i++) remainingPower += groups[i].power;
    let remainingCost = placements.length * placementCost;

    for (
      let groupIndex = 0;
      groupIndex < groups.length && nextPlacementIndex < placements.length;
      groupIndex++
    ) {
      const group = groups[groupIndex];
      if (groupIndex === groups.length - 1 || remainingPower <= 0) {
        while (nextPlacementIndex < placements.length) {
          group.placements.push(placements[nextPlacementIndex++]);
        }
        break;
      }

      const targetCost = remainingCost * (group.power / remainingPower);
      let groupCost = 0;
      while (nextPlacementIndex < placements.length) {
        const nextCost = groupCost + placementCost;
        if (
          group.placements.length > 0 &&
          Math.abs(nextCost - targetCost) > Math.abs(groupCost - targetCost)
        ) {
          break;
        }
        group.placements.push(placements[nextPlacementIndex++]);
        groupCost = nextCost;
      }

      remainingPower -= group.power;
      remainingCost -= groupCost;
    }
  }

  private enqueueBuildGroupPlacements(
    group: BuildOrderGroup,
    drag: AreaDrag,
    buildingBlueprintId: BuildingBlueprintId,
    tick: number,
  ): void {
    for (let i = 0; i < group.placements.length; i++) {
      const placement = group.placements[i];
      this.config.commandQueue.enqueue({
        type: 'startBuild',
        tick,
        builderId: group.leader.id,
        buildingBlueprintId,
        gridX: placement.gridX,
        gridY: placement.gridY,
        rotation: this.buildPlacement.facingInfo.rotation,
        queue: i === 0 ? drag.queue : true,
        queueFront: i === 0 ? drag.queueFront : false,
        queueInsertIndex: i === 0 ? drag.queueInsertIndex : undefined,
      });
    }
  }

  private enqueueDefaultBuildAssists(
    groups: readonly BuildOrderGroup[],
    workingGroups: readonly BuildOrderGroup[],
    ineligibleBuilders: readonly Entity[],
    drag: AreaDrag,
    tick: number,
  ): void {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.placements.length > 0) {
        this.enqueueGuardForBuilders(
          group.builders.filter((builder) => builder.id !== group.leader.id),
          group.leader,
          tick,
          drag.queue,
          drag.queueFront,
          drag.queueInsertIndex,
        );
      } else {
        const target = this.assistTargetForIndex(workingGroups, i);
        if (target !== null) {
          this.enqueueGuardForBuilders(
            group.builders,
            target.leader,
            tick,
            drag.queue,
            drag.queueFront,
            drag.queueInsertIndex,
          );
        }
      }
    }
    this.enqueueIneligibleBuildAssists(ineligibleBuilders, workingGroups, drag, tick);
  }

  private enqueueSplitBuildAssists(
    groups: readonly BuildOrderGroup[],
    workingGroups: readonly BuildOrderGroup[],
    ineligibleBuilders: readonly Entity[],
    drag: AreaDrag,
    tick: number,
  ): void {
    if (workingGroups.length > 1) {
      for (let i = 0; i < workingGroups.length; i++) {
        const group = workingGroups[i];
        const target = workingGroups[(i + 1) % workingGroups.length];
        this.enqueueGuardForBuilders(
          [group.leader],
          target.leader,
          tick,
          true,
          false,
          undefined,
        );
      }
    }

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.placements.length > 0) continue;
      const target = this.assistTargetForIndex(workingGroups, i);
      if (target !== null) {
        this.enqueueGuardForBuilders(
          group.builders,
          target.leader,
          tick,
          drag.queue,
          drag.queueFront,
          drag.queueInsertIndex,
        );
      }
    }
    this.enqueueIneligibleBuildAssists(ineligibleBuilders, workingGroups, drag, tick);
  }

  private enqueueIneligibleBuildAssists(
    builders: readonly Entity[],
    workingGroups: readonly BuildOrderGroup[],
    drag: AreaDrag,
    tick: number,
  ): void {
    for (let i = 0; i < builders.length; i++) {
      const target = this.assistTargetForIndex(workingGroups, i);
      if (target === null) continue;
      this.enqueueGuardForBuilders(
        [builders[i]],
        target.leader,
        tick,
        drag.queue,
        drag.queueFront,
        drag.queueInsertIndex,
      );
    }
  }

  private enqueueGuardForBuilders(
    builders: readonly Entity[],
    target: Entity,
    tick: number,
    queue: boolean,
    queueFront: boolean,
    queueInsertIndex: number | undefined,
  ): void {
    if (builders.length === 0) return;
    const guardCmd = buildGuardCommandForTarget(
      target,
      builders,
      this.config.getActivePlayerId(),
      tick,
      queue,
      queueFront,
      queueInsertIndex,
      this.config.getEntitySource().arePlayersAllied,
    );
    if (guardCmd) this.config.commandQueue.enqueue(guardCmd);
  }

  private assistTargetForIndex(
    workingGroups: readonly BuildOrderGroup[],
    index: number,
  ): BuildOrderGroup | null {
    if (workingGroups.length === 0) return null;
    return workingGroups[index % workingGroups.length];
  }

  private builderBuildPower(builder: Entity): number {
    return Math.max(1, getBuilderConstructionRate(builder));
  }

  private buildPlacementCost(buildingBlueprintId: BuildingBlueprintId): number {
    const config = getBuildingConfig(buildingBlueprintId);
    return Math.max(1, config.cost.energy + config.cost.metal);
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
    else if (this.config.isRestoreAreaMode()) this.handleRestoreAreaClick(e);
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
    else if (this.config.isTowerTargetMode()) this.handleTowerTargetClick(e, true);
    else if (this.config.isTowerTargetNoGroundMode()) this.handleTowerTargetClick(e, false);
    else this.handlePingClick(e);
  }

  private handleRightCancel(): void {
    if (this.config.mode.isInBuildMode) this.config.mode.exitBuildMode();
    else if (this.config.mode.isInDGunMode) this.config.mode.exitDGunMode();
    else if (this.config.isRepairAreaMode()) this.config.exitRepairAreaMode();
    else if (this.config.isRestoreAreaMode()) this.config.exitRestoreAreaMode();
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
    else if (this.config.isTowerTargetNoGroundMode()) this.config.exitTowerTargetNoGroundMode();
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
    this.commitBuildShapePlacements(
      {
        kind: 'buildLine',
        button: 0,
        start: { x: world.x, y: world.y, z: world.z },
        current: { x: world.x, y: world.y, z: world.z },
        startClientX: e.clientX,
        startClientY: e.clientY,
        queue: queueMode.queue,
        queueFront: queueMode.queueFront,
        queueInsertIndex: queueMode.queueInsertIndex,
        anchorEntityId: null,
      },
      buildingBlueprintId,
      () => [{ gridX: diagnostics.gridX, gridY: diagnostics.gridY }],
    );
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
    const activePlayerId = this.config.getActivePlayerId();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : undefined;
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const targetId = entityHit !== undefined && !isAlliedTargetForPlayer(
      entityHit,
      activePlayerId,
      this.config.getEntitySource().arePlayersAllied,
    )
      ? entityHit.id
      : undefined;
    const cmd = this.config.mode.buildFireDGunCommand(
      commander,
      world.x,
      world.y,
      this.config.getTick(),
      world.z,
      targetId,
    );
    this.config.commandQueue.enqueue(cmd);
  }

  private handleRepairAreaClick(e: MouseEvent): void {
    const exitMode = () => this.config.exitRepairAreaMode();
    const builders = this.getSelectedBuilders();
    if (builders.length === 0) {
      exitMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);

    let issuedTargetRepair = false;
    for (let i = 0; i < builders.length; i++) {
      const targetRepairCmd = buildRepairCommandForTarget(
        entityHit,
        builders[i],
        tick,
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
        this.config.getEntitySource().arePlayersAllied,
      );
      if (targetRepairCmd) {
        this.config.commandQueue.enqueue(targetRepairCmd);
        issuedTargetRepair = true;
      }
    }
    if (issuedTargetRepair) {
      this.config.applyCursor('repair');
      if (!queueMode.queue) exitMode();
      return;
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    for (let i = 0; i < builders.length; i++) {
      const cmd = buildRepairAreaCommand(
        builders[i],
        world.x,
        world.y,
        REPAIR_AREA_RADIUS,
        tick,
        queueMode.queue,
        world.z,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
      );
      if (cmd) this.config.commandQueue.enqueue(cmd);
    }
    this.config.applyCursor('repair');
    if (!queueMode.queue) exitMode();
  }

  private handleRestoreAreaClick(e: MouseEvent): void {
    const builder = this.config.getSelectedBuilder();
    if (!builder) {
      this.config.exitRestoreAreaMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    this.config.applyCursor('repair');
    if (!this.resolveClickQueueMode(e).queue) this.config.exitRestoreAreaMode();
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
    const source = this.config.getEntitySource();
    const selectedAttackHosts = source.getSelectedUnits().concat(source.getSelectedBuildings?.() ?? []);
    if (!selectedAttackHosts.some(entityHasBarAttackCommand)) {
      this.config.exitAttackMode();
      return;
    }
    const tick = this.config.getTick();
    const activePlayerId = this.config.getActivePlayerId();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);
    const meshAttackCmd = buildAttackCommandForTarget(
      entityHit,
      selectedAttackHosts,
      activePlayerId,
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
      source.arePlayersAllied,
    );
    if (meshAttackCmd) {
      this.config.commandQueue.enqueue(meshAttackCmd);
      this.config.applyCursor('attack');
      if (!queueMode.queue) this.config.exitAttackMode();
      return;
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    if (isAlliedTargetForPlayer(
      entityHit,
      activePlayerId,
      this.config.getEntitySource().arePlayersAllied,
    )) {
      const allyGroundAttackCmd = buildAttackGroundCommand(
        selectedAttackHosts,
        world.x,
        world.y,
        tick,
        queueMode.queue,
        world.z,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
      );
      if (!allyGroundAttackCmd) return;
      this.config.commandQueue.enqueue(allyGroundAttackCmd);
      this.config.applyCursor('attack');
      if (!queueMode.queue) this.config.exitAttackMode();
      return;
    }
    const attackCmd = buildAttackCommandAt(
      source,
      world.x,
      world.y,
      selectedAttackHosts,
      activePlayerId,
      tick,
      queueMode.queue,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    // Recoil CMD_ATTACK is ICON_UNIT_OR_MAP: an empty-ground click is an
    // Attack Point order, not Fight. buildAttackGroundCommand capability-
    // filters unarmed scouts and air-only fighters from mixed selections.
    const cmd = attackCmd ?? buildAttackGroundCommand(
      selectedAttackHosts,
      world.x,
      world.y,
      tick,
      queueMode.queue,
      world.z,
      queueMode.queueFront,
      queueMode.queueInsertIndex,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
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
      let hasManualLaunchTurret = false;
      for (let j = 0; j < combat.turrets.length; j++) {
        const turret = combat.turrets[j];
        if (!isAttackEmitter(turret) || turret.config.passive || turret.config.shot === null) continue;
        hasManualLaunchTurret = true;
        break;
      }
      if (hasManualLaunchTurret) {
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
      this.config.getEntitySource().arePlayersAllied,
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
    const builders = this.getSelectedBuilders();
    if (builders.length === 0) {
      this.config.exitReclaimMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;
    const queueMode = this.resolveClickQueueMode(e);

    let issuedTargetReclaim = false;
    for (let i = 0; i < builders.length; i++) {
      const meshReclaimCmd = buildReclaimCommandForTarget(
        entityHit,
        builders[i],
        tick,
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
      );
      if (meshReclaimCmd) {
        this.config.commandQueue.enqueue(meshReclaimCmd);
        issuedTargetReclaim = true;
      }
    }
    if (issuedTargetReclaim) {
      this.config.applyCursor('reclaim');
      if (!queueMode.queue) this.config.exitReclaimMode();
      return;
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    for (let i = 0; i < builders.length; i++) {
      const reclaimCmd = buildReclaimAreaCommand(
        builders[i],
        world.x,
        world.y,
        RECLAIM_AREA_RADIUS,
        tick,
        queueMode.queue,
        world.z,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
      );
      if (reclaimCmd) this.config.commandQueue.enqueue(reclaimCmd);
    }
    this.config.applyCursor('reclaim');
    if (!queueMode.queue) this.config.exitReclaimMode();
  }

  /**
   * BAR applies builder orders to every selected constructor that owns the
   * capability. Keep the active builder first for stable UI intent, then the
   * remaining selected builders in selection order.
   */
  private getSelectedBuilders(): Entity[] {
    const activeBuilder = this.config.getSelectedBuilder();
    const builders: Entity[] = [];
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (
        unit.unit === null ||
        unit.builder === null ||
        getBuilderConstructionRate(unit) <= 0 ||
        unit.id === activeBuilder?.id
      ) continue;
      builders.push(unit);
    }
    if (
      activeBuilder !== null &&
      activeBuilder.unit !== null &&
      activeBuilder.builder !== null &&
      getBuilderConstructionRate(activeBuilder) > 0
    ) {
      builders.unshift(activeBuilder);
    }
    return builders;
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
      this.config.getEntitySource().arePlayersAllied,
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
    const resurrectSource = this.config.getSelectedResurrectSource();
    if (!resurrectSource) {
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
      resurrectSource,
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
    const resurrectSource = this.config.getSelectedResurrectSource();
    if (!resurrectSource) {
      this.config.exitResurrectAreaMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const queueMode = this.resolveClickQueueMode(e);
    const cmd = buildResurrectAreaCommand(
      resurrectSource,
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

  private exitActiveResurrectMode(): void {
    if (this.config.isResurrectMode()) {
      this.config.exitResurrectMode();
      return;
    }
    this.config.exitResurrectAreaMode();
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
      transports,
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

  private handleTowerTargetClick(e: MouseEvent, allowGround: boolean): void {
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    if (entityHitId !== null) {
      if (!allowGround || e.altKey) {
        this.config.registerBarTargetTypeTracking?.(entityHitId);
      } else {
        this.config.clearBarTargetTypeTrackingForSelected?.();
      }
      this.config.selectedCommands.setTowerTarget(entityHitId);
    } else if (allowGround) {
      const world = this.config.picker.raycastGround(e.clientX, e.clientY);
      if (!world) return;
      if (e.altKey) {
        const snappedTargetId = this.config.registerNearestBarTargetTypeTracking?.(world) ?? null;
        if (snappedTargetId !== null) {
          this.config.selectedCommands.setTowerTarget(snappedTargetId);
        } else {
          this.config.clearBarTargetTypeTrackingForSelected?.();
          this.config.selectedCommands.setTowerTarget(null, world);
        }
      } else {
        this.config.clearBarTargetTypeTrackingForSelected?.();
        this.config.selectedCommands.setTowerTarget(null, world);
      }
    } else {
      const world = this.config.picker.raycastGround(e.clientX, e.clientY);
      if (!world) return;
      const snappedTargetId = this.config.registerNearestBarTargetTypeTracking?.(world) ?? null;
      if (snappedTargetId === null) {
        this.config.clearBarTargetTypeTrackingForSelected?.();
        return;
      }
      this.config.selectedCommands.setTowerTarget(snappedTargetId);
    }
    if (!this.resolveClickQueueMode(e).queue) {
      if (allowGround) this.config.exitTowerTargetMode();
      else this.config.exitTowerTargetNoGroundMode();
    }
  }
}

function isAlliedTargetForPlayer(
  target: Entity | null | undefined,
  playerId: PlayerId,
  arePlayersAllied: ((a: PlayerId, b: PlayerId) => boolean) | undefined = undefined,
): boolean {
  const targetPlayerId = target?.ownership?.playerId;
  if (targetPlayerId === undefined) return false;
  return arePlayersAllied !== undefined
    ? arePlayersAllied(playerId, targetPlayerId)
    : targetPlayerId === playerId;
}


/** BAR placement-drag modes (engine GuiHandler, mirrored by
 *  gui_pregame_build.lua determineBuildMode): Shift+drag = LINE,
 *  Shift+Alt+drag = GRID (filled rectangle), and Shift+Alt+Ctrl+drag =
 *  BOX (hollow frame). beginAreaDrag owns the required Shift gate; this
 *  resolver re-reads Alt/Ctrl during a live drag for immediate previews. */
function resolveBuildDragKind(e: MouseEvent): Input3DAreaDragKind {
  const modifiers = effectiveQueueModifierEvent(e);
  if (modifiers.altKey && (modifiers.ctrlKey || modifiers.metaKey)) return 'buildBorder';
  if (modifiers.altKey) return 'buildGrid';
  return 'buildLine';
}

function isBuildShapeDragKind(kind: Input3DAreaDragKind): boolean {
  return kind === 'buildLine' || kind === 'buildBorder' || kind === 'buildGrid';
}

function isFilterableAreaDragKind(kind: Input3DAreaDragKind): boolean {
  return kind === 'repairArea' || kind === 'reclaimArea' || kind === 'resurrectArea';
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
    case 'loadTransportArea': return LOAD_TRANSPORT_AREA_RADIUS;
    case 'unloadTransportArea': return UNLOAD_TRANSPORT_AREA_MIN_RADIUS;
    case 'attackArea': return ATTACK_AREA_RADIUS;
    case 'attackGround': return 48;
    case 'buildMexArea': return 1;
    case 'upgradeMexArea': return MEX_UPGRADE_AREA_RADIUS;
    default: return 1;
  }
}
