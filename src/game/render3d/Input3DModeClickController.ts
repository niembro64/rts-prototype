import type { CommandQueue } from '../sim/commands';
import type { Entity, EntityId, PlayerId, BuildingBlueprintId } from '../sim/types';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import {
  buildAttackCommandAt,
  buildAttackCommandForTarget,
  buildAttackAreaCommand,
  buildAttackGroundCommand,
  buildGuardCommandAt,
  buildGuardCommandForTarget,
  buildReclaimAreaCommand,
  buildReclaimCommandForTarget,
  buildRepairAreaCommand,
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
import {
  EMPTY_AREA_DRAG_STATE,
  type Input3DAreaDragKind,
  type Input3DAreaDragState,
} from './Input3DAreaDragState';
import { resolveProjectileSelectionGroundReach } from './ProjectileBallisticPreview';

const REPAIR_AREA_RADIUS = 220;
const RECLAIM_AREA_RADIUS = 220;
const ATTACK_AREA_RADIUS = 300;
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
  commandQueue: CommandQueue;
  picker: Input3DPicker;
  mode: CommanderModeController;
  selectedCommands: InputSelectedCommands;
  getTick: () => number;
  getActivePlayerId: () => PlayerId;
  getSelectedCommander: () => Entity | null;
  getSelectedBuilder: () => Entity | null;
  applyCursor: (kind: CommandCursorKind) => void;
  isRepairAreaMode: () => boolean;
  isAttackMode: () => boolean;
  isAttackAreaMode: () => boolean;
  isAttackGroundMode: () => boolean;
  isGuardMode: () => boolean;
  isReclaimMode: () => boolean;
  isPingMode: () => boolean;
  isTowerTargetMode: () => boolean;
  exitRepairAreaMode: () => void;
  exitAttackMode: () => void;
  exitAttackAreaMode: () => void;
  exitAttackGroundMode: () => void;
  exitGuardMode: () => void;
  exitReclaimMode: () => void;
  exitPingMode: () => void;
  exitTowerTargetMode: () => void;
};

export class Input3DModeClickController {
  private readonly buildPlacement = new Input3DBuildPlacementState();
  private buildGhost: BuildGhost3D | null = null;
  private areaDrag: AreaDrag | null = null;
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
      this.config.isGuardMode() ||
      this.config.isReclaimMode() ||
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
    if (this.config.isGuardMode()) return 'guard';
    if (this.config.isReclaimMode()) return 'reclaim';
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
      if (drag.button === 0) this.handleLeftClick(e);
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
    this.areaDrag = {
      kind: resolvedKind,
      button,
      start: { x: world.x, y: world.y, z: world.z },
      current: { x: world.x, y: world.y, z: world.z },
      startClientX: e.clientX,
      startClientY: e.clientY,
      queue: e.shiftKey,
      queueFront: isQueueFrontModifier(e),
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
      );
      if (cmd) this.config.commandQueue.enqueue(cmd);
      this.config.applyCursor('attack');
      if (!drag.queue) this.config.exitAttackAreaMode();
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

  private handleLeftClick(e: MouseEvent): void {
    if (this.config.mode.isInBuildMode) this.handleBuildClick(e);
    else if (this.config.mode.isInDGunMode) this.handleDGunClick(e);
    else if (this.config.isRepairAreaMode()) this.handleRepairAreaClick(e);
    else if (this.config.isAttackMode()) this.handleAttackClick(e);
    else if (this.config.isAttackAreaMode()) this.handleAttackAreaClick(e);
    else if (this.config.isAttackGroundMode()) this.handleAttackGroundClick(e);
    else if (this.config.isGuardMode()) this.handleGuardClick(e);
    else if (this.config.isReclaimMode()) this.handleReclaimClick(e);
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
    else if (this.config.isGuardMode()) this.config.exitGuardMode();
    else if (this.config.isReclaimMode()) this.config.exitReclaimMode();
    else if (this.config.isTowerTargetMode()) this.config.exitTowerTargetMode();
    else this.config.exitPingMode();
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
    const cmd = this.config.mode.buildStartBuildCommand(
      builder, world.x, world.y,
      this.config.getTick(), e.shiftKey, isQueueFrontModifier(e),
      this.buildPlacement.facingInfo.rotation,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    if (!e.shiftKey) this.config.mode.exitBuildMode();
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
    const cmd = buildRepairAreaCommand(
      commander,
      world.x,
      world.y,
      REPAIR_AREA_RADIUS,
      this.config.getTick(),
      e.shiftKey,
      world.z,
      isQueueFrontModifier(e),
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('repair');
    if (!e.shiftKey) this.config.exitRepairAreaMode();
  }

  private handleAttackAreaClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitAttackAreaMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = buildAttackAreaCommand(
      selectedUnits,
      world.x,
      world.y,
      ATTACK_AREA_RADIUS,
      this.config.getTick(),
      e.shiftKey,
      world.z,
      isQueueFrontModifier(e),
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('attack');
    if (!e.shiftKey) this.config.exitAttackAreaMode();
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
    const meshAttackCmd = buildAttackCommandForTarget(
      entityHit,
      selectedUnits,
      this.config.getActivePlayerId(),
      tick,
      e.shiftKey,
      isQueueFrontModifier(e),
    );
    if (meshAttackCmd) {
      this.config.commandQueue.enqueue(meshAttackCmd);
      this.config.applyCursor('attack');
      if (!e.shiftKey) this.config.exitAttackMode();
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
      e.shiftKey,
      isQueueFrontModifier(e),
    );
    if (!attackCmd) return;
    this.config.commandQueue.enqueue(attackCmd);
    this.config.applyCursor('attack');
    if (!e.shiftKey) this.config.exitAttackMode();
  }

  private handleAttackGroundClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitAttackGroundMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = buildAttackGroundCommand(
      selectedUnits,
      world.x,
      world.y,
      this.config.getTick(),
      e.shiftKey,
      world.z,
      isQueueFrontModifier(e),
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('attack');
    if (!e.shiftKey) this.config.exitAttackGroundMode();
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
    if (!e.shiftKey) this.config.exitPingMode();
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

    const meshGuardCmd = buildGuardCommandForTarget(
      entityHit,
      selectedUnits,
      this.config.getActivePlayerId(),
      tick,
      e.shiftKey,
      isQueueFrontModifier(e),
    );
    if (meshGuardCmd) {
      this.config.commandQueue.enqueue(meshGuardCmd);
      this.config.applyCursor('guard');
      if (!e.shiftKey) this.config.exitGuardMode();
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
      e.shiftKey,
      isQueueFrontModifier(e),
    );
    if (!guardCmd) return;
    this.config.commandQueue.enqueue(guardCmd);
    this.config.applyCursor('guard');
    if (!e.shiftKey) this.config.exitGuardMode();
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

    const meshReclaimCmd = buildReclaimCommandForTarget(
      entityHit,
      commander,
      tick,
      e.shiftKey,
      isQueueFrontModifier(e),
    );
    if (meshReclaimCmd) {
      this.config.commandQueue.enqueue(meshReclaimCmd);
      this.config.applyCursor('reclaim');
      if (!e.shiftKey) this.config.exitReclaimMode();
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
      e.shiftKey,
      world.z,
      isQueueFrontModifier(e),
    );
    if (!reclaimCmd) return;
    this.config.commandQueue.enqueue(reclaimCmd);
    this.config.applyCursor('reclaim');
    if (!e.shiftKey) this.config.exitReclaimMode();
  }

  private handleTowerTargetClick(e: MouseEvent): void {
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    if (entityHitId === null) return;
    this.config.selectedCommands.setTowerTarget(entityHitId);
    if (!e.shiftKey) this.config.exitTowerTargetMode();
  }
}

function isQueueFrontModifier(e: MouseEvent): boolean {
  return e.shiftKey && (e.ctrlKey || e.metaKey);
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
    case 'attackArea': return ATTACK_AREA_RADIUS;
    case 'attackGround': return 48;
    case 'buildMexArea': return 1;
    default: return 1;
  }
}
