import type { CommandQueue, MoveCommand } from '../sim/commands';
import type { Entity, EntityId, PlayerId, WaypointType } from '../sim/types';
import { LAND_CELL_SIZE } from '../../config';
import {
  buildAttackCommandAt,
  buildAttackCommandForTarget,
  buildFormationPreservingMoveTargets,
  buildFactoryGuardCommands,
  buildFactoryRallyCommands,
  buildLinePathMoveCommand,
  buildRepairCommandAt,
  LinePathAccumulator,
  shouldCollapseLinePathToSingleMove,
} from '../input/helpers';
import type { CommandCursorKind } from '../input/CommandCursors';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import { getSurfaceHeight, isWaterAt } from '../sim/Terrain';
import type { Input3DPicker } from './Input3DPicker';
import {
  resolveProjectileSelectionGroundReach,
  type ProjectileGroundReach,
} from './ProjectileBallisticPreview';

type RightDragEntitySource = {
  getUnits: () => Entity[];
  getBuildings: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
};

type Input3DRightDragControllerConfig = {
  getEntitySource: () => RightDragEntitySource;
  commandQueue: CommandQueue;
  picker: Input3DPicker;
  getTick: () => number;
  getActivePlayerId: () => PlayerId;
  getWaypointMode: () => WaypointType;
  isFormationAssumeMode: () => boolean;
  isFormationMoveMode: () => boolean;
  exitFormationModes: () => void;
  getSelectedCommander: () => Entity | null;
  getMapSampleBounds: () => { width: number; height: number };
  applyCursor: (kind: CommandCursorKind) => void;
  refreshCursor: () => void;
};

export type Input3DLineDragState = {
  active: boolean;
  points: ReadonlyArray<{ x: number; y: number; z?: number }>;
  targets: ReadonlyArray<{ x: number; y: number; z?: number }>;
  targetBallisticReach: ReadonlyArray<ProjectileGroundReach>;
  mode: WaypointType;
};

export class Input3DRightDragController {
  private rightDown = false;
  private readonly linePath = new LinePathAccumulator();
  private readonly selectedFactoriesScratch: Entity[] = [];
  private preserveFormationDrag = false;
  private readonly formationPreviewTargets: { x: number; y: number; z?: number }[] = [];
  private readonly targetBallisticReach: ProjectileGroundReach[] = [];

  constructor(private readonly config: Input3DRightDragControllerConfig) {}

  get active(): boolean {
    return this.rightDown;
  }

  hasSelectedFactories(): boolean {
    return this.getSelectedFactories().length > 0;
  }

  handleMouseMove(e: MouseEvent): void {
    this.config.applyCursor(this.waypointCursorKind());
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const selectedUnits = this.source().getSelectedUnits();
    this.linePath.append(world.x, world.y, selectedUnits.length, world.z);
    this.linePath.recomputeTargets(selectedUnits.length);
    this.updateFormationPreviewTargets(selectedUnits);
  }

  handleMouseDown(e: MouseEvent): void {
    const source = this.source();
    const selectedUnits = source.getSelectedUnits();
    const tick = this.config.getTick();
    const activePlayerId = this.config.getActivePlayerId();
    const queueFront = isQueueFrontModifier(e);
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? source.getEntity(entityHitId)
      : null;
    const preserveFormationMove = selectedUnits.length > 0 && this.shouldUseFormationOffsets(e);

    if (!preserveFormationMove) {
      const meshAttackCmd = buildAttackCommandForTarget(
        entityHit,
        selectedUnits,
        activePlayerId,
        tick,
        e.shiftKey,
        queueFront,
      );
      if (meshAttackCmd) {
        debugLog(
          GAME_DIAGNOSTICS.commandPlans,
          '[click] attack-mesh: hit target #%d, %d unit(s)',
          meshAttackCmd.targetId, selectedUnits.length,
        );
        this.config.applyCursor('attack');
        this.config.commandQueue.enqueue(meshAttackCmd);
        return;
      }
    }

    if (selectedUnits.length === 0) {
      const factoryGuardCmds = buildFactoryGuardCommands(
        this.getSelectedFactories(),
        entityHit,
        activePlayerId,
        tick,
      );
      if (factoryGuardCmds.length > 0) {
        debugLog(
          GAME_DIAGNOSTICS.commandPlans,
          '[click] factory-guard: hit target #%d, %d factory(s)',
          factoryGuardCmds[0].targetId, factoryGuardCmds.length,
        );
        this.config.applyCursor('guard');
        for (const cmd of factoryGuardCmds) this.config.commandQueue.enqueue(cmd);
        return;
      }
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;

    if (!preserveFormationMove) {
      const repairCmd = buildRepairCommandAt(
        source,
        world.x, world.y,
        this.config.getSelectedCommander(),
        tick,
        e.shiftKey,
        queueFront,
      );
      if (repairCmd) {
        debugLog(
          GAME_DIAGNOSTICS.commandPlans,
          '[click] repair: clicked at (%d, %d, %d) -> target #%d',
          Math.round(world.x), Math.round(world.y), Math.round(world.z),
          repairCmd.targetId,
        );
        this.config.applyCursor('repair');
        this.config.commandQueue.enqueue(repairCmd);
        return;
      }
    }

    if (selectedUnits.length > 0) {
      if (!preserveFormationMove) {
        const attackCmd = buildAttackCommandAt(
          source,
          world.x, world.y,
          selectedUnits,
          activePlayerId,
          tick,
          e.shiftKey,
          queueFront,
        );
        if (attackCmd) {
          debugLog(
            GAME_DIAGNOSTICS.commandPlans,
            '[click] attack: clicked at (%d, %d, %d) -> target #%d, %d unit(s)',
            Math.round(world.x), Math.round(world.y), Math.round(world.z),
            attackCmd.targetId, selectedUnits.length,
          );
          this.config.applyCursor('attack');
          this.config.commandQueue.enqueue(attackCmd);
          return;
        }
      }
      debugLog(
        GAME_DIAGNOSTICS.commandPlans,
        '[click] move-start: clicked at (%d, %d, %d), %d unit(s) selected',
        Math.round(world.x), Math.round(world.y), Math.round(world.z),
        selectedUnits.length,
      );
      this.rightDown = true;
      this.preserveFormationDrag = preserveFormationMove;
      this.config.applyCursor(this.waypointCursorKind());
      this.linePath.start(world.x, world.y, selectedUnits.length, world.z);
      this.updateFormationPreviewTargets(selectedUnits);
      return;
    }

    const factories = this.getSelectedFactories();
    if (factories.length > 0) {
      debugLog(
        GAME_DIAGNOSTICS.commandPlans,
        '[click] factory-waypoint-start: clicked at (%d, %d, %d), %d factory(s) selected',
        Math.round(world.x), Math.round(world.y), Math.round(world.z),
        factories.length,
      );
      this.rightDown = true;
      this.preserveFormationDrag = false;
      this.config.applyCursor('factoryWaypoint');
      this.linePath.startWithFixedTarget(world.x, world.y, world.z);
    }
  }

  handleMouseUp(e: MouseEvent): void {
    this.rightDown = false;
    const source = this.source();
    const selectedUnits = source.getSelectedUnits();
    const points = this.linePath.points;
    const shiftHeld = e.shiftKey;
    const queueFront = isQueueFrontModifier(e);
    const tick = this.config.getTick();

    if (selectedUnits.length > 0 && points.length > 0) {
      const finalPoint = points[points.length - 1];
      const preserveFormation = this.shouldUseFormationOffsets(e);
      if (!preserveFormation) {
        const repairCmd = buildRepairCommandAt(
          source,
          finalPoint.x, finalPoint.y,
          this.config.getSelectedCommander(),
          tick, shiftHeld, queueFront,
        );
        if (repairCmd) {
          debugLog(
            GAME_DIAGNOSTICS.commandPlans,
            '[click] repair-on-release: released at (%d, %d, %d) -> target #%d',
            Math.round(finalPoint.x), Math.round(finalPoint.y),
            finalPoint.z !== undefined ? Math.round(finalPoint.z) : -1,
            repairCmd.targetId,
          );
          this.config.commandQueue.enqueue(repairCmd);
          this.resetLineDrag();
          this.config.refreshCursor();
          return;
        }
      }
      const moveCmd = buildLinePathMoveCommand(
        this.linePath,
        selectedUnits,
        this.config.getWaypointMode(),
        tick,
        shiftHeld,
        queueFront,
        preserveFormation,
        this.resolveFormationSpeed(e),
      );
      if (moveCmd) {
        this.logMoveCommand(selectedUnits, points.length, finalPoint, moveCmd, preserveFormation);
        this.config.commandQueue.enqueue(moveCmd);
        if (this.isFormationModeActive() && !shiftHeld) this.config.exitFormationModes();
      }
      this.resetLineDrag();
      this.config.refreshCursor();
      return;
    }

    const factories = this.getSelectedFactories();
    if (factories.length > 0 && points.length > 0) {
      const finalPoint = points[points.length - 1];
      debugLog(
        GAME_DIAGNOSTICS.commandPlans,
        '[click] factory-waypoint: released at (%d, %d, %d), %d factory(s)',
        Math.round(finalPoint.x), Math.round(finalPoint.y),
        finalPoint.z !== undefined ? Math.round(finalPoint.z) : -1,
        factories.length,
      );
      const cmds = buildFactoryRallyCommands(
        factories, finalPoint.x, finalPoint.y,
        this.config.getWaypointMode(), tick, finalPoint.z,
      );
      for (const cmd of cmds) this.config.commandQueue.enqueue(cmd);
    }
    this.resetLineDrag();
    this.config.refreshCursor();
  }

  getLineDragState(): Input3DLineDragState {
    const useFormationTargets = this.shouldUseFormationPreviewTargets();
    const targets = useFormationTargets ? this.formationPreviewTargets : this.linePath.targets;
    this.updateTargetBallisticReach(targets);
    return {
      active: this.rightDown,
      points: this.linePath.points,
      targets,
      targetBallisticReach: this.targetBallisticReach,
      mode: this.config.getWaypointMode(),
    };
  }

  private source(): RightDragEntitySource {
    return this.config.getEntitySource();
  }

  private waypointCursorKind(): CommandCursorKind {
    switch (this.config.getWaypointMode()) {
      case 'fight': return 'fight';
      case 'patrol': return 'patrol';
      case 'move':
      default: return 'move';
    }
  }

  private shouldUseFormationOffsets(e: MouseEvent): boolean {
    return e.altKey || e.ctrlKey || e.metaKey || this.isFormationModeActive();
  }

  private resolveFormationSpeed(e: MouseEvent): MoveCommand['formationSpeed'] | undefined {
    if (this.config.isFormationMoveMode()) return 'slowest';
    if (this.config.isFormationAssumeMode()) return undefined;
    return (e.ctrlKey || e.metaKey) ? 'slowest' : undefined;
  }

  private isFormationModeActive(): boolean {
    return this.config.isFormationAssumeMode() || this.config.isFormationMoveMode();
  }

  private updateFormationPreviewTargets(selectedUnits: readonly Entity[]): void {
    const out = this.formationPreviewTargets;
    out.length = 0;
    if (!this.preserveFormationDrag || !this.shouldUseFormationPreviewTargets()) return;
    const points = this.linePath.points;
    const finalPoint = points[points.length - 1];
    if (finalPoint === undefined) return;
    const targets = buildFormationPreservingMoveTargets(
      selectedUnits,
      finalPoint.x,
      finalPoint.y,
      finalPoint.z,
      (x, y) => this.resolveFormationPreviewTargetZ(x, y),
    );
    for (let i = 0; i < targets.individualTargets.length; i++) {
      out.push(targets.individualTargets[i]);
    }
  }

  private updateTargetBallisticReach(
    targets: ReadonlyArray<{ x: number; y: number; z?: number }>,
  ): void {
    const out = this.targetBallisticReach;
    out.length = 0;
    if (!this.rightDown || this.config.getWaypointMode() !== 'fight' || targets.length === 0) {
      return;
    }
    const selectedUnits = this.source().getSelectedUnits();
    if (selectedUnits.length === 0) return;
    const { width, height } = this.config.getMapSampleBounds();
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      out.push(resolveProjectileSelectionGroundReach(
        selectedUnits,
        target.x,
        target.y,
        target.z ?? 0,
        width,
        height,
      ));
    }
  }

  private shouldUseFormationPreviewTargets(): boolean {
    return this.preserveFormationDrag && shouldCollapseLinePathToSingleMove(this.linePath.points);
  }

  private resolveFormationPreviewTargetZ(x: number, y: number): number | undefined {
    const { width, height } = this.config.getMapSampleBounds();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return undefined;
    }
    return getSurfaceHeight(x, y, width, height, LAND_CELL_SIZE);
  }

  private resetLineDrag(): void {
    this.linePath.reset();
    this.preserveFormationDrag = false;
    this.formationPreviewTargets.length = 0;
    this.targetBallisticReach.length = 0;
  }

  private getSelectedFactories(): Entity[] {
    const out = this.selectedFactoriesScratch;
    out.length = 0;
    const selectedBuildings = this.source().getSelectedBuildings();
    const activePlayerId = this.config.getActivePlayerId();
    for (let i = 0; i < selectedBuildings.length; i++) {
      const building = selectedBuildings[i];
      if (
        building.factory !== null &&
        building.ownership?.playerId === activePlayerId
      ) {
        out.push(building);
      }
    }
    return out;
  }

  private logMoveCommand(
    selectedUnits: readonly Entity[],
    pointCount: number,
    finalPoint: { x: number; y: number; z?: number },
    moveCmd: NonNullable<ReturnType<typeof buildLinePathMoveCommand>>,
    preserveFormation: boolean,
  ): void {
    if (!GAME_DIAGNOSTICS.commandPlans) return;
    const { width, height } = this.config.getMapSampleBounds();
    const canSampleWet = Number.isFinite(width) && Number.isFinite(height);
    const finalWet = canSampleWet
      ? isWaterAt(finalPoint.x, finalPoint.y, width, height)
      : null;
    debugLog(
      true,
      '[click] move: released at (%d, %d, %d) wet=%s, %d unit(s), %d drag sample(s), waypointType=%s, preserveFormation=%s',
      Math.round(finalPoint.x), Math.round(finalPoint.y),
      finalPoint.z !== undefined ? Math.round(finalPoint.z) : -1,
      finalWet,
      selectedUnits.length, pointCount, moveCmd.waypointType, preserveFormation,
    );
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      const ux = unit.transform.x;
      const uy = unit.transform.y;
      const uz = unit.transform.z;
      const unitWet = canSampleWet ? isWaterAt(ux, uy, width, height) : null;
      const target = moveCmd.individualTargets?.[i];
      debugLog(
        true,
        '  [click]   unit #%d at (%d, %d, %d) wet=%s%s',
        unit.id,
        Math.round(ux), Math.round(uy), Math.round(uz),
        unitWet,
        target
          ? ` -> (${Math.round(target.x)}, ${Math.round(target.y)}, ${target.z !== undefined ? Math.round(target.z) : -1})`
          : ` -> (${Math.round(finalPoint.x)}, ${Math.round(finalPoint.y)}, ${finalPoint.z !== undefined ? Math.round(finalPoint.z) : -1})`,
      );
    }
  }
}

function isQueueFrontModifier(e: MouseEvent): boolean {
  return e.shiftKey && (e.ctrlKey || e.metaKey);
}
