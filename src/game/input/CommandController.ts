import type Phaser from '../PhaserCompat';
import type { CommandQueue } from '../sim/commands';
import {
  WAYPOINT_COLORS,
  LinePathAccumulator,
  buildAttackCommandAt,
  buildLinePathMoveCommand,
  buildRepairCommandAt,
  buildFactoryWaypointCommands,
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
    const repairCmd = buildRepairCommandAt(
      this.entitySource,
      worldX, worldY,
      this.buildingController.getSelectedCommander(),
      this.context.getTick(),
      this.shiftKey.isDown,
    );
    if (repairCmd) {
      this.commandQueue.enqueue(repairCmd);
      return;
    }

    // Check if right-clicking on an enemy target (attack command)
    const selectedUnits = this.selectionController.getSelectedUnits();
    const attackCmd = buildAttackCommandAt(
      this.entitySource,
      worldX, worldY,
      selectedUnits,
      this.context.activePlayerId,
      this.context.getTick(),
      this.shiftKey.isDown,
    );
    if (attackCmd) {
      this.commandQueue.enqueue(attackCmd);
      return;
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
    if (points.length === 0) return;
    const finalPoint = points[points.length - 1];

    // Commander-specific: if the path ends on a repair target
    // (incomplete building or damaged friendly), issue repair
    // instead of move. Shared with the 3D path via buildRepairCommandAt.
    const repairCmd = buildRepairCommandAt(
      this.entitySource,
      finalPoint.x, finalPoint.y,
      this.buildingController.getSelectedCommander(),
      this.context.getTick(),
      shiftHeld,
    );
    if (repairCmd) {
      this.commandQueue.enqueue(repairCmd);
      return;
    }

    const moveCmd = buildLinePathMoveCommand(
      this.linePath,
      selectedUnits,
      this.state.waypointMode,
      this.context.getTick(),
      shiftHeld,
    );
    if (moveCmd) this.commandQueue.enqueue(moveCmd);
  }

  /** Finish setting factory waypoints */
  private finishFactoryWaypoints(shiftHeld: boolean): void {
    const selectedFactories = this.selectionController.getSelectedFactories();
    if (selectedFactories.length === 0) return;
    const points = this.linePath.points;
    if (points.length === 0) return;
    const target = points[points.length - 1];
    const cmds = buildFactoryWaypointCommands(
      selectedFactories, target.x, target.y,
      this.state.waypointMode,
      this.context.getTick(), shiftHeld,
    );
    for (const cmd of cmds) this.commandQueue.enqueue(cmd);
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
