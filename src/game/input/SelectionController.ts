import type Phaser from 'phaser';
import type { CommandQueue, SelectCommand } from '../sim/commands';
import type { Entity, WaypointType } from '../sim/types';
import { performSelection } from './helpers';
import type { InputEntitySource, InputContext } from './inputBindings';
import type { InputState } from './InputState';

/**
 * SelectionController - Handles box selection, click selection, and double-click selection.
 * Also tracks selection changes to reset waypoint mode.
 */
export class SelectionController {
  private scene: Phaser.Scene;
  private context: InputContext;
  private entitySource: InputEntitySource;
  private commandQueue: CommandQueue;
  private state: InputState;
  private selectionGraphics: Phaser.GameObjects.Graphics;

  // Callback for UI to show waypoint mode changes
  public onWaypointModeChange?: (mode: WaypointType) => void;

  constructor(
    scene: Phaser.Scene,
    context: InputContext,
    entitySource: InputEntitySource,
    commandQueue: CommandQueue,
    state: InputState,
    selectionGraphics: Phaser.GameObjects.Graphics,
  ) {
    this.scene = scene;
    this.context = context;
    this.entitySource = entitySource;
    this.commandQueue = commandQueue;
    this.state = state;
    this.selectionGraphics = selectionGraphics;
  }

  setEntitySource(source: InputEntitySource): void {
    this.entitySource = source;
  }

  /** Get selected units from current entity source */
  getSelectedUnits(): Entity[] {
    return this.entitySource.getUnits().filter(
      (e) => e.selectable?.selected && e.ownership?.playerId === this.context.activePlayerId
    );
  }

  /** Get selected factories from current entity source */
  getSelectedFactories(): Entity[] {
    return this.entitySource.getBuildings().filter(
      (e) => e.selectable?.selected && e.factory !== undefined && e.ownership?.playerId === this.context.activePlayerId
    );
  }

  /** Start selection drag from a world-space point */
  startDrag(worldX: number, worldY: number): void {
    this.state.isDraggingSelection = true;
    this.state.selectionStartWorldX = worldX;
    this.state.selectionStartWorldY = worldY;
    this.state.selectionEndWorldX = worldX;
    this.state.selectionEndWorldY = worldY;
  }

  /** Update selection drag end point */
  updateDrag(worldX: number, worldY: number): void {
    this.state.selectionEndWorldX = worldX;
    this.state.selectionEndWorldY = worldY;
  }

  /** Finish selection and issue select command */
  finishSelection(additive: boolean): void {
    const result = performSelection(
      this.entitySource,
      this.state.selectionStartWorldX,
      this.state.selectionStartWorldY,
      this.state.selectionEndWorldX,
      this.state.selectionEndWorldY,
      this.context.activePlayerId
    );

    // Issue select command
    const command: SelectCommand = {
      type: 'select',
      tick: this.context.getTick(),
      entityIds: result.entityIds,
      additive,
    };

    this.commandQueue.enqueue(command);
  }

  /** End the drag state and clear graphics */
  endDrag(shiftKey: boolean): void {
    this.finishSelection(shiftKey);
    this.state.isDraggingSelection = false;
    this.selectionGraphics.clear();
  }

  // Set waypoint mode and notify UI
  setWaypointMode(mode: WaypointType): void {
    if (this.state.waypointMode !== mode) {
      this.state.waypointMode = mode;
      this.onWaypointModeChange?.(mode);
    }
  }

  // Get current waypoint mode
  getWaypointMode(): WaypointType {
    return this.state.waypointMode;
  }

  /**
   * Check if selection changed and reset waypoint mode to 'move'.
   * Zero-allocation: iterates cached units array directly instead of .filter() + .map() + new Set().
   */
  checkSelectionChange(): void {
    const units = this.entitySource.getUnits();
    const playerId = this.context.activePlayerId;
    const prev = this.state.previousSelectedIds;

    // Count currently selected units and check if any are new
    let currentCount = 0;
    let changed = false;
    for (const u of units) {
      if (u.selectable?.selected && u.ownership?.playerId === playerId) {
        currentCount++;
        if (!prev.has(u.id)) changed = true;
      }
    }

    // Size mismatch means something was deselected
    if (!changed && currentCount !== prev.size) changed = true;

    if (changed) {
      this.setWaypointMode('move');
      // Rebuild previousSelectedIds in place (reuse Set, avoid new allocation)
      prev.clear();
      for (const u of units) {
        if (u.selectable?.selected && u.ownership?.playerId === playerId) {
          prev.add(u.id);
        }
      }
    }
  }

  /** Draw selection rectangle (world space) */
  drawSelectionRect(): void {
    this.selectionGraphics.clear();

    if (!this.state.isDraggingSelection) return;

    const camera = this.scene.cameras.main;

    // Already in world coordinates - use directly
    const x = Math.min(this.state.selectionStartWorldX, this.state.selectionEndWorldX);
    const y = Math.min(this.state.selectionStartWorldY, this.state.selectionEndWorldY);
    const w = Math.abs(this.state.selectionEndWorldX - this.state.selectionStartWorldX);
    const h = Math.abs(this.state.selectionEndWorldY - this.state.selectionStartWorldY);

    // Fill
    this.selectionGraphics.fillStyle(0x00ff88, 0.15);
    this.selectionGraphics.fillRect(x, y, w, h);

    // Border (scale line width inversely with zoom so it looks consistent)
    const lineWidth = 2 / camera.zoom;
    this.selectionGraphics.lineStyle(lineWidth, 0x00ff88, 0.8);
    this.selectionGraphics.strokeRect(x, y, w, h);
  }

  destroy(): void {
    this.selectionGraphics.destroy();
  }
}
