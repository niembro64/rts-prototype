import type Phaser from 'phaser';
import type { CommandQueue, MoveCommand, RepairCommand, SetFactoryWaypointsCommand, WaypointTarget } from '../sim/commands';
import type { Entity, EntityId } from '../sim/types';
import {

  getPathLength,
  calculateLinePathTargets,
  assignUnitsToTargets,
  WAYPOINT_COLORS,
  findRepairTargetAt,
} from './helpers';
import { magnitude } from '../math';
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
      console.log('[Input] Repair target check:', {
        hasCommander: !!commander,
        playerId: commander.ownership.playerId,
        clickPos: { x: worldX, y: worldY },
        repairTargetFound: !!repairTarget,
        repairTargetId: repairTarget?.id,
      });
      if (repairTarget) {
        // Issue repair command
        const command: RepairCommand = {
          type: 'repair',
          tick: this.context.getTick(),
          commanderId: commander.id,
          targetId: repairTarget.id,
          queue: this.shiftKey.isDown,
        };
        console.log('[Input] Creating RepairCommand:', command);
        this.commandQueue.enqueue(command);
        return;
      }
    }

    // Start line path drawing if units are selected
    const selectedUnits = this.selectionController.getSelectedUnits();
    if (selectedUnits.length > 0) {
      this.state.isDrawingLinePath = true;
      this.state.linePathPoints = [{ x: worldX, y: worldY }];
      this.state.linePathTargets = [];
      this.updateLinePathTargets(selectedUnits.length);
    } else {
      // Check if factories are selected - start factory waypoint mode
      const selectedFactories = this.selectionController.getSelectedFactories();
      if (selectedFactories.length > 0) {
        this.state.isDrawingLinePath = true;
        this.state.linePathPoints = [{ x: worldX, y: worldY }];
        this.state.linePathTargets = [{ x: worldX, y: worldY }];
      }
    }
  }

  /** Handle pointer move while drawing line path */
  handleLinePathMove(worldX: number, worldY: number): void {
    if (!this.state.isDrawingLinePath) return;

    // Add point if it's far enough from the last point (to avoid too many points)
    const lastPoint = this.state.linePathPoints[this.state.linePathPoints.length - 1];
    const dx = worldX - lastPoint.x;
    const dy = worldY - lastPoint.y;
    const dist = magnitude(dx, dy);
    if (dist > 10) {
      this.state.linePathPoints.push({ x: worldX, y: worldY });
      const selectedUnits = this.selectionController.getSelectedUnits();
      this.updateLinePathTargets(selectedUnits.length);
    }
  }

  /** End line path and issue commands */
  endLinePath(shiftHeld: boolean): void {
    this.finishLinePath(shiftHeld);
    this.state.isDrawingLinePath = false;
    this.state.linePathPoints = [];
    this.state.linePathTargets = [];
    this.linePathGraphics.clear();
  }

  /** Update the calculated target positions along the path */
  private updateLinePathTargets(unitCount: number): void {
    this.state.linePathTargets = calculateLinePathTargets(this.state.linePathPoints, unitCount);
  }

  /** Find a repairable target at a world position (incomplete building or damaged friendly unit) */
  private findRepairTarget(worldX: number, worldY: number, playerId: number): Entity | null {
    return findRepairTargetAt(this.entitySource, worldX, worldY, playerId);
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

    // Check if commander is ending waypoint on a repair target (incomplete building)
    const commander = this.buildingController.getSelectedCommander();
    if (commander?.ownership) {
      const finalPoint = this.state.linePathPoints[this.state.linePathPoints.length - 1];
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

    const pathLength = getPathLength(this.state.linePathPoints);

    // If path is very short (just a click), do a regular group move
    if (pathLength < 20) {
      const target = this.state.linePathPoints[this.state.linePathPoints.length - 1];
      const command: MoveCommand = {
        type: 'move',
        tick: this.context.getTick(),
        entityIds: selectedUnits.map((e) => e.id),
        targetX: target.x,
        targetY: target.y,
        waypointType: this.state.waypointMode,
        queue: shiftHeld,
      };
      this.commandQueue.enqueue(command);
      return;
    }

    // Assign units to positions using closest distance
    const assignments = assignUnitsToTargets(selectedUnits, this.state.linePathTargets);

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
    const target = this.state.linePathPoints[this.state.linePathPoints.length - 1];

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

    if (!this.state.isDrawingLinePath || this.state.linePathPoints.length === 0) return;

    const camera = this.scene.cameras.main;
    const lineWidth = 2 / camera.zoom;
    const dotRadius = 8 / camera.zoom;
    const pathColor = WAYPOINT_COLORS[this.state.waypointMode];

    // Draw the path line
    this.linePathGraphics.lineStyle(lineWidth, pathColor, 0.6);
    this.linePathGraphics.beginPath();
    this.linePathGraphics.moveTo(this.state.linePathPoints[0].x, this.state.linePathPoints[0].y);
    for (let i = 1; i < this.state.linePathPoints.length; i++) {
      this.linePathGraphics.lineTo(this.state.linePathPoints[i].x, this.state.linePathPoints[i].y);
    }
    this.linePathGraphics.strokePath();

    // Draw dots at target positions
    this.linePathGraphics.fillStyle(pathColor, 0.9);
    for (const target of this.state.linePathTargets) {
      this.linePathGraphics.fillCircle(target.x, target.y, dotRadius);
    }

    // Draw outline around dots
    this.linePathGraphics.lineStyle(lineWidth, 0xffffff, 0.8);
    for (const target of this.state.linePathTargets) {
      this.linePathGraphics.strokeCircle(target.x, target.y, dotRadius);
    }
  }

  /** Public method to queue unit at factory from UI */
  queueUnitAtFactory(factoryId: number, weaponId: string): void {
    const factory = this.entitySource.getEntity(factoryId);
    if (!factory?.factory) return;

    const command = {
      type: 'queueUnit' as const,
      tick: this.context.getTick(),
      factoryId: factoryId,
      weaponId: weaponId,
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
