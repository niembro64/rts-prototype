import type Phaser from '../PhaserCompat';
import type { CommandQueue, MoveCommand, RepairCommand, AttackCommand, SetFactoryWaypointsCommand, WaypointTarget } from '../sim/commands';
import type { Entity, EntityId } from '../sim/types';
import {
  getPathLength,
  assignUnitsToTargets,
  WAYPOINT_COLORS,
  findRepairTargetAt,
  findAttackTargetAt,
  LinePathAccumulator,
} from './helpers';
import type { InputEntitySource, InputContext } from './inputBindings';
import type { InputState } from './InputState';
import type { SelectionController } from './SelectionController';
import type { BuildingPlacementController } from './BuildingPlacementController';

/**
 * CommandController - Handles right-click commands (move, attack, patrol, fight),
 * shift-queue, line path drawing, repair commands, and factory waypoints.
 */
export class CommandController {
  private scene: Phaser.Scene;
  private context: InputContext;
  private entitySource: InputEntitySource;
  private commandQueue: CommandQueue;
  private state: InputState;
  private linePathGraphics: Phaser.GameObjects.Graphics;
  private selectionController: SelectionController;
  private buildingController: BuildingPlacementController;
  private shiftKey: Phaser.Input.Keyboard.Key;
  private linePath = new LinePathAccumulator();

  constructor(
    scene: Phaser.Scene,
    context: InputContext,
    entitySource: InputEntitySource,
    commandQueue: CommandQueue,
    state: InputState,
    linePathGraphics: Phaser.GameObjects.Graphics,
    selectionController: SelectionController,
    buildingController: BuildingPlacementController,
    shiftKey: Phaser.Input.Keyboard.Key,
  ) {
    this.scene = scene;
    this.context = context;
    this.entitySource = entitySource;
    this.commandQueue = commandQueue;
    this.state = state;
    this.linePathGraphics = linePathGraphics;
    this.selectionController = selectionController;
    this.buildingController = buildingController;
    this.shiftKey = shiftKey;
  }

  setEntitySource(source: InputEntitySource): void {
    this.entitySource = source;
  }

  /** Handle right-click down - start line path or factory waypoint */
  handleRightClickDown(worldX: number, worldY: number): void {
    // Cancel build/D-gun mode on right click
    if (this.state.isBuildMode) {
      this.buildingController.exitBuildMode();
      return;
    }
    if (this.state.isDGunMode) {
      this.buildingController.exitDGunMode();
      return;
    }

    // Check if commander is selected and right-clicking on a repair target
    const commander = this.buildingController.getSelectedCommander();
    if (commander?.ownership) {
      const repairTarget = this.findRepairTarget(worldX, worldY, commander.ownership.playerId);
      if (repairTarget) {
        // Issue repair command
        const command: RepairCommand = {
          type: 'repair',
          tick: this.context.getTick(),
          commanderId: commander.id,
          targetId: repairTarget.id,
          queue: this.shiftKey.isDown,
        };
        this.commandQueue.enqueue(command);
        return;
      }
    }

    // Check if right-clicking on an enemy target (attack command)
    const selectedUnits = this.selectionController.getSelectedUnits();
    if (selectedUnits.length > 0) {
      const attackTarget = this.findAttackTarget(worldX, worldY, this.context.activePlayerId);
      if (attackTarget) {
        const command: AttackCommand = {
          type: 'attack',
          tick: this.context.getTick(),
          entityIds: selectedUnits.map((e) => e.id),
          targetId: attackTarget.id,
          queue: this.shiftKey.isDown,
        };
        this.commandQueue.enqueue(command);
        return;
      }
    }

    // Start line path drawing if units are selected
    if (selectedUnits.length > 0) {
      this.state.isDrawingLinePath = true;
      this.linePath.start(worldX, worldY, selectedUnits.length);
    } else {
      // Check if factories are selected - start factory waypoint mode.
      // Factory waypoints treat the single placed point *as* the
      // target (no spreading), so we seed the accumulator with a
      // fixed target instead of distributing unitCount along a path.
      const selectedFactories = this.selectionController.getSelectedFactories();
      if (selectedFactories.length > 0) {
        this.state.isDrawingLinePath = true;
        this.linePath.startWithFixedTarget(worldX, worldY);
      }
    }
  }

  /** Handle pointer move while drawing line path */
  handleLinePathMove(worldX: number, worldY: number): void {
    if (!this.state.isDrawingLinePath) return;
    const unitCount = this.selectionController.getSelectedUnits().length;
    this.linePath.append(worldX, worldY, unitCount);
  }

  /** End line path and issue commands */
  endLinePath(shiftHeld: boolean): void {
    this.finishLinePath(shiftHeld);
    this.state.isDrawingLinePath = false;
    this.linePath.reset();
    this.linePathGraphics.clear();
  }

  /** Find a repairable target at a world position (incomplete building or damaged friendly unit) */
  private findRepairTarget(worldX: number, worldY: number, playerId: number): Entity | null {
    return findRepairTargetAt(this.entitySource, worldX, worldY, playerId);
  }

  /** Find an enemy target at a world position (enemy unit or building) */
  private findAttackTarget(worldX: number, worldY: number, playerId: number): Entity | null {
    return findAttackTargetAt(this.entitySource, worldX, worldY, playerId);
  }

  /** Finish line path and issue move commands (for units or factory waypoints) */
  private finishLinePath(shiftHeld: boolean): void {
    const selectedUnits = this.selectionController.getSelectedUnits();

    // Handle factory waypoints if no units selected
    if (selectedUnits.length === 0) {
      const selectedFactories = this.selectionController.getSelectedFactories();
      if (selectedFactories.length > 0) {
        this.finishFactoryWaypoints(shiftHeld);
      }
      return;
    }

    const points = this.linePath.points;
    const finalPoint = points[points.length - 1];

    // Check if commander is ending waypoint on a repair target (incomplete building)
    const commander = this.buildingController.getSelectedCommander();
    if (commander?.ownership) {
      const repairTarget = this.findRepairTarget(finalPoint.x, finalPoint.y, commander.ownership.playerId);
      if (repairTarget) {
        // Issue repair command instead of move command
        const command: RepairCommand = {
          type: 'repair',
          tick: this.context.getTick(),
          commanderId: commander.id,
          targetId: repairTarget.id,
          queue: shiftHeld,
        };
        this.commandQueue.enqueue(command);
        return;
      }
    }

    const pathLength = getPathLength(points);

    // If path is very short (just a click), do a regular group move
    if (pathLength < 20) {
      const command: MoveCommand = {
        type: 'move',
        tick: this.context.getTick(),
        entityIds: selectedUnits.map((e) => e.id),
        targetX: finalPoint.x,
        targetY: finalPoint.y,
        waypointType: this.state.waypointMode,
        queue: shiftHeld,
      };
      this.commandQueue.enqueue(command);
      return;
    }

    // Assign units to positions using closest distance
    const assignments = assignUnitsToTargets(selectedUnits, this.linePath.targets);

    // Build individual targets array in entity order
    const entityIds: EntityId[] = [];
    const individualTargets: WaypointTarget[] = [];
    for (const unit of selectedUnits) {
      const target = assignments.get(unit.id);
      if (target) {
        entityIds.push(unit.id);
        individualTargets.push({ x: target.x, y: target.y });
      }
    }

    // Issue single move command with individual targets
    const command: MoveCommand = {
      type: 'move',
      tick: this.context.getTick(),
      entityIds,
      individualTargets,
      waypointType: this.state.waypointMode,
      queue: shiftHeld,
    };
    this.commandQueue.enqueue(command);
  }

  /** Finish setting factory waypoints */
  private finishFactoryWaypoints(shiftHeld: boolean): void {
    const selectedFactories = this.selectionController.getSelectedFactories();
    if (selectedFactories.length === 0) return;

    // Get the target point(s) from the line path
    const points = this.linePath.points;
    const target = points[points.length - 1];

    // Create the new waypoint
    const newWaypoint = {
      x: target.x,
      y: target.y,
      type: this.state.waypointMode,
    };

    // Issue command for each selected factory
    for (const factory of selectedFactories) {
      if (!factory.factory) continue;

      const command: SetFactoryWaypointsCommand = {
        type: 'setFactoryWaypoints',
        tick: this.context.getTick(),
        factoryId: factory.id,
        waypoints: [newWaypoint],
        queue: shiftHeld,
      };
      this.commandQueue.enqueue(command);
    }
  }

  /** Draw line path preview */
  drawLinePath(): void {
    this.linePathGraphics.clear();

    const points = this.linePath.points;
    if (!this.state.isDrawingLinePath || points.length === 0) return;

    const camera = this.scene.cameras.main;
    const lineWidth = 2 / camera.zoom;
    const dotRadius = 8 / camera.zoom;
    const pathColor = WAYPOINT_COLORS[this.state.waypointMode];

    // Draw the path line
    this.linePathGraphics.lineStyle(lineWidth, pathColor, 0.6);
    this.linePathGraphics.beginPath();
    this.linePathGraphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this.linePathGraphics.lineTo(points[i].x, points[i].y);
    }
    this.linePathGraphics.strokePath();

    // Draw dots at target positions
    const targets = this.linePath.targets;
    this.linePathGraphics.fillStyle(pathColor, 0.9);
    for (const target of targets) {
      this.linePathGraphics.fillCircle(target.x, target.y, dotRadius);
    }

    // Draw outline around dots
    this.linePathGraphics.lineStyle(lineWidth, 0xffffff, 0.8);
    for (const target of targets) {
      this.linePathGraphics.strokeCircle(target.x, target.y, dotRadius);
    }
  }

  /** Public method to queue unit at factory from UI */
  queueUnitAtFactory(factoryId: number, unitId: string): void {
    const factory = this.entitySource.getEntity(factoryId);
    if (!factory?.factory) return;

    const command = {
      type: 'queueUnit' as const,
      tick: this.context.getTick(),
      factoryId: factoryId,
      unitId: unitId,
    };
    this.commandQueue.enqueue(command);
  }

  /** Public method to cancel queue item at factory from UI */
  cancelQueueItemAtFactory(factoryId: number, index: number): void {
    const factory = this.entitySource.getEntity(factoryId);
    if (!factory?.factory) return;

    const command = {
      type: 'cancelQueueItem' as const,
      tick: this.context.getTick(),
      factoryId: factoryId,
      index: index,
    };
    this.commandQueue.enqueue(command);
  }

  destroy(): void {
    this.linePathGraphics.destroy();
  }
}
