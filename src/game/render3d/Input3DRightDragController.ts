import type { MoveCommand } from '../sim/commands';
import type { ClientCommandSink } from '../input/ClientCommandSink';
import type { Entity, EntityId, PlayerId, WaypointType } from '../sim/types';
import { LAND_CELL_SIZE } from '../../config';
import {
  buildAttackCommandAt,
  buildAttackCommandForTarget,
  buildFormationPreservingMoveTargets,
  buildFactoryGuardCommands,
  buildFactoryRallyCommands,
  buildGuardCommandForTarget,
  buildLinePathMoveCommand,
  buildReclaimCommandForTarget,
  buildRepairOrGuardCommandAt,
  LinePathAccumulator,
  shouldCollapseLinePathToSingleMove,
} from '../input/helpers';
import {
  queueModeForDragRelease,
  queueModeFromEvent,
  type QueueCommandMode,
} from '../input/queueModifiers';
import { isAttackableEnemyTarget } from '../input/helpers/AttackTargetHelper';
import { isReclaimableTarget } from '../sim/reclaim';
import { getBuilderConstructionRate } from '../sim/builderBuildRoster';
import type { CommandCursorKind } from '../input/CommandCursors';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';

/** A unit can attack iff it mounts a real weapon turret (a pure
 *  construction emitter does not count) — used to pick attack vs reclaim on
 *  an enemy, BAR's leader rule. */
function unitCanAttack(unit: Entity): boolean {
  const turrets = unit.combat?.turrets;
  if (turrets === undefined) return false;
  for (let i = 0; i < turrets.length; i++) {
    if (turrets[i].config.constructionEmitter === null) return true;
  }
  return false;
}
import { getTerrainBedHeight, isWaterAt } from '../sim/Terrain';
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
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean;
};

type Input3DRightDragControllerConfig = {
  getEntitySource: () => RightDragEntitySource;
  commandQueue: ClientCommandSink;
  picker: Input3DPicker;
  getTick: () => number;
  getActivePlayerId: () => PlayerId;
  getWaypointMode: () => WaypointType;
  getQueueInsertIndex: () => number | null;
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
  /** Dedicated single-point path for issueWorldPointCommand so a
   *  minimap command can never clobber a live viewport right-drag. */
  private readonly worldPointPath = new LinePathAccumulator();
  private readonly selectedFactoriesScratch: Entity[] = [];
  private preserveFormationDrag = false;
  private dragStartQueueMode: QueueCommandMode | null = null;
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
    const world = this.config.picker.raycastTerrainBed(e.clientX, e.clientY);
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
    const queueMode = queueModeFromEvent(e, this.config.getQueueInsertIndex());
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? source.getEntity(entityHitId)
      : null;
    const preserveFormationMove = selectedUnits.length > 0 && this.shouldUseFormationOffsets(e);
    const selectionHasAttacker = selectedUnits.some(unitCanAttack);

    // Enemy under the cursor: an attack-capable selection attacks it; a pure
    // builder selection reclaims it instead (BAR default-command leader rule).
    if (!preserveFormationMove && selectionHasAttacker) {
      const meshAttackCmd = buildAttackCommandForTarget(
        entityHit,
        selectedUnits,
        activePlayerId,
        tick,
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
        source.arePlayersAllied,
      );
      if (meshAttackCmd) {
        if (meshAttackCmd.type === 'attack') {
          debugLog(
            GAME_DIAGNOSTICS.commandPlans,
            '[click] attack-mesh: hit target #%d, %d unit(s)',
            meshAttackCmd.targetId, selectedUnits.length,
          );
        } else {
          debugLog(
            GAME_DIAGNOSTICS.commandPlans,
            '[click] attack-ground-mesh: (%d, %d, %d), %d unit(s)',
            Math.round(meshAttackCmd.targetX),
            Math.round(meshAttackCmd.targetY),
            Math.round(meshAttackCmd.targetZ ?? 0),
            selectedUnits.length,
          );
        }
        this.config.applyCursor('attack');
        this.config.commandQueue.enqueue(meshAttackCmd);
        return;
      }
    }

    if (
      !preserveFormationMove &&
      isAttackableEnemyTarget(entityHit, activePlayerId, source.arePlayersAllied) &&
      isReclaimableTarget(entityHit)
    ) {
      let issued = false;
      for (let i = 0; i < selectedUnits.length; i++) {
        const reclaimer = selectedUnits[i];
        if (reclaimer.builder === null || getBuilderConstructionRate(reclaimer) <= 0) continue;
        const reclaimCmd = buildReclaimCommandForTarget(
          entityHit,
          reclaimer,
          tick,
          queueMode.queue,
          queueMode.queueFront,
          queueMode.queueInsertIndex,
        );
        if (reclaimCmd !== null) {
          this.config.commandQueue.enqueue(reclaimCmd);
          issued = true;
        }
      }
      if (issued) {
        debugLog(
          GAME_DIAGNOSTICS.commandPlans,
          '[click] reclaim-mesh: enemy #%d, builder(s) reclaiming',
          entityHitId ?? -1,
        );
        this.config.applyCursor('reclaim');
        return;
      }
    }

    if (selectedUnits.length === 0) {
      const factoryGuardCmds = buildFactoryGuardCommands(
        this.getSelectedFactories(),
        entityHit,
        activePlayerId,
        tick,
        source.arePlayersAllied,
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

    // Right-click on a friendly body in 3D issues GUARD — BAR's smart
    // default command over an ally. What the guard then does (defend the
    // target, repair/heal it, or assist what it is building) is resolved
    // per the guarder's own capabilities in the guard behavior. Self-guard
    // is excluded by buildGuardCommandForTarget (drops the target itself).
    if (!preserveFormationMove && selectedUnits.length > 0) {
      const guardCmd = buildGuardCommandForTarget(
        entityHit,
        selectedUnits,
        activePlayerId,
        tick,
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
        source.arePlayersAllied,
      );
      if (guardCmd) {
        debugLog(
          GAME_DIAGNOSTICS.commandPlans,
          '[click] guard-mesh: hit target #%d, %d unit(s)',
          guardCmd.targetId, selectedUnits.length,
        );
        this.config.applyCursor('guard');
        this.config.commandQueue.enqueue(guardCmd);
        return;
      }
    }

    const world = this.config.picker.raycastTerrainBed(e.clientX, e.clientY);
    if (!world) return;

    if (!preserveFormationMove) {
      const repairCmd = buildRepairOrGuardCommandAt(
        source,
        world.x, world.y,
        this.config.getSelectedCommander(),
        selectedUnits,
        tick,
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
      );
      if (repairCmd) {
        debugLog(
          GAME_DIAGNOSTICS.commandPlans,
          '[click] %s: clicked at (%d, %d, %d) -> target #%d',
          repairCmd.type,
          Math.round(world.x), Math.round(world.y), Math.round(world.z),
          repairCmd.targetId,
        );
        this.config.applyCursor(repairCmd.type === 'guard' ? 'guard' : 'repair');
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
          queueMode.queue,
          queueMode.queueFront,
          queueMode.queueInsertIndex,
        );
        if (attackCmd) {
          if (attackCmd.type === 'attack') {
            debugLog(
              GAME_DIAGNOSTICS.commandPlans,
              '[click] attack: clicked at (%d, %d, %d) -> target #%d, %d unit(s)',
              Math.round(world.x), Math.round(world.y), Math.round(world.z),
              attackCmd.targetId, selectedUnits.length,
            );
          } else {
            debugLog(
              GAME_DIAGNOSTICS.commandPlans,
              '[click] attack-ground: clicked at (%d, %d, %d) -> ground (%d, %d, %d), %d unit(s)',
              Math.round(world.x), Math.round(world.y), Math.round(world.z),
              Math.round(attackCmd.targetX),
              Math.round(attackCmd.targetY),
              Math.round(attackCmd.targetZ ?? 0),
              selectedUnits.length,
            );
          }
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
      this.beginLineDrag(queueMode);
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
      this.beginLineDrag(queueMode);
      this.preserveFormationDrag = false;
      // Factory rally points use the same command cursor (move/fight/patrol) as
      // units, matching BAR: the cursor reflects the command, not the target.
      this.config.applyCursor(this.waypointCursorKind());
      this.linePath.startWithFixedTarget(world.x, world.y, world.z);
    }
  }

  handleMouseUp(e: MouseEvent): void {
    this.rightDown = false;
    const source = this.source();
    const selectedUnits = source.getSelectedUnits();
    const points = this.linePath.points;
    const queueMode = this.resolveReleaseQueueMode(e);
    const tick = this.config.getTick();

    if (selectedUnits.length > 0 && points.length > 0) {
      const finalPoint = points[points.length - 1];
      const preserveFormation = this.shouldUseFormationOffsets(e);
      if (!preserveFormation) {
        const repairCmd = buildRepairOrGuardCommandAt(
          source,
          finalPoint.x, finalPoint.y,
          this.config.getSelectedCommander(),
          selectedUnits,
          tick, queueMode.queue, queueMode.queueFront, queueMode.queueInsertIndex,
        );
        if (repairCmd) {
          debugLog(
            GAME_DIAGNOSTICS.commandPlans,
            '[click] %s-on-release: released at (%d, %d, %d) -> target #%d',
            repairCmd.type,
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
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
        preserveFormation,
        this.resolveFormationSpeed(e),
      );
      if (moveCmd) {
        this.logMoveCommand(selectedUnits, points.length, finalPoint, moveCmd, preserveFormation);
        this.config.commandQueue.enqueue(moveCmd);
        if (this.isFormationModeActive() && !queueMode.queue) this.config.exitFormationModes();
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

  /** Issue the standard right-click command for a world point that did
   *  not come from a viewport ray — the minimap right-click path. Runs
   *  the same dispatch order as a viewport right-click (commander
   *  repair → attack-if-enemy-at-point → group move for units; rally
   *  for selected factories) through the shared builders, so minimap
   *  and viewport commands cannot drift. */
  issueWorldPointCommand(x: number, y: number, queueMode: QueueCommandMode): void {
    const source = this.source();
    const selectedUnits = source.getSelectedUnits();
    const tick = this.config.getTick();
    const bounds = this.config.getMapSampleBounds();
    const z = getTerrainBedHeight(x, y, bounds.width, bounds.height, LAND_CELL_SIZE);

    if (selectedUnits.length > 0) {
      const repairCmd = buildRepairOrGuardCommandAt(
        source,
        x, y,
        this.config.getSelectedCommander(),
        selectedUnits,
        tick,
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
      );
      if (repairCmd) {
        this.config.commandQueue.enqueue(repairCmd);
        return;
      }
      const attackCmd = buildAttackCommandAt(
        source,
        x, y,
        selectedUnits,
        this.config.getActivePlayerId(),
        tick,
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
      );
      if (attackCmd) {
        this.config.commandQueue.enqueue(attackCmd);
        return;
      }
      this.worldPointPath.start(x, y, selectedUnits.length, z);
      const moveCmd = buildLinePathMoveCommand(
        this.worldPointPath,
        selectedUnits,
        this.config.getWaypointMode(),
        tick,
        queueMode.queue,
        queueMode.queueFront,
        queueMode.queueInsertIndex,
      );
      if (moveCmd) this.config.commandQueue.enqueue(moveCmd);
      return;
    }

    const factories = this.getSelectedFactories();
    if (factories.length > 0) {
      const cmds = buildFactoryRallyCommands(
        factories, x, y,
        this.config.getWaypointMode(), tick, z,
      );
      for (const cmd of cmds) this.config.commandQueue.enqueue(cmd);
    }
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

  private beginLineDrag(queueMode: QueueCommandMode): void {
    this.rightDown = true;
    this.dragStartQueueMode = queueMode;
  }

  private resolveReleaseQueueMode(e: MouseEvent): QueueCommandMode {
    const releaseQueueMode = queueModeFromEvent(e, this.config.getQueueInsertIndex());
    return queueModeForDragRelease(this.dragStartQueueMode, releaseQueueMode);
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
    return getTerrainBedHeight(x, y, width, height, LAND_CELL_SIZE);
  }

  private resetLineDrag(): void {
    this.linePath.reset();
    this.preserveFormationDrag = false;
    this.dragStartQueueMode = null;
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
