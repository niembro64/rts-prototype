import type Phaser from '../PhaserCompat';
import type { CommandQueue, SelectCommand } from '../sim/commands';
import type { Entity, EntityId, PlayerId, WaypointType } from '../sim/types';
import {
  findClosestUnitToPoint,
  findClosestBuildingToPoint,
} from './helpers';
import type { InputEntitySource, InputContext } from './inputBindings';
import type { InputState } from './InputState';

/** Drag less than this many screen pixels counts as a click rather
 *  than a box-select. Matches the old world-space threshold at
 *  zoom=1 and is camera-invariant now that drag is tracked in pixels. */
const CLICK_DRAG_THRESHOLD_PX = 10;

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
    // Draw the selection rect in screen space. With camera rotation
    // the rect must stay axis-aligned on-screen (the user is dragging
    // pixels, not world units), so we parent the graphics to the HUD
    // layer and use screen-space coords everywhere.
    this.selectionGraphics.setScrollFactor(0);
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

  /** Start selection drag from a screen-space point */
  startDrag(screenX: number, screenY: number): void {
    this.state.isDraggingSelection = true;
    this.state.selectionStartScreenX = screenX;
    this.state.selectionStartScreenY = screenY;
    this.state.selectionEndScreenX = screenX;
    this.state.selectionEndScreenY = screenY;
  }

  /** Update selection drag end point (screen coords) */
  updateDrag(screenX: number, screenY: number): void {
    this.state.selectionEndScreenX = screenX;
    this.state.selectionEndScreenY = screenY;
  }

  /** Finish selection and issue select command. Drag is in screen
   *  space; we project each owned unit's world position to screen
   *  and test containment there — this matches Input3DManager's
   *  approach and works with camera rotation + zoom. */
  finishSelection(additive: boolean): void {
    const camera = this.scene.cameras.main;
    const sx1 = this.state.selectionStartScreenX;
    const sy1 = this.state.selectionStartScreenY;
    const sx2 = this.state.selectionEndScreenX;
    const sy2 = this.state.selectionEndScreenY;

    const dx = sx2 - sx1;
    const dy = sy2 - sy1;
    const wasClick = Math.hypot(dx, dy) < CLICK_DRAG_THRESHOLD_PX;

    const pid = this.context.activePlayerId;
    let entityIds: EntityId[];

    if (wasClick) {
      // Convert the click point to world coords and reuse the
      // existing collider-based closest-unit / closest-building
      // lookups. (These still live in world space because the
      // collider radii are in world units.)
      const world = camera.getWorldPoint(sx1, sy1);
      entityIds = this.pickSingleEntityAt(world.x, world.y, pid);
    } else {
      entityIds = this.pickEntitiesInScreenRect(
        Math.min(sx1, sx2), Math.min(sy1, sy2),
        Math.max(sx1, sx2), Math.max(sy1, sy2),
        pid,
      );
    }

    const command: SelectCommand = {
      type: 'select',
      tick: this.context.getTick(),
      entityIds,
      additive,
    };

    this.commandQueue.enqueue(command);
  }

  /** Screen-rect hit test. Units take precedence over buildings —
   *  only if no units are hit do we fall through to buildings. */
  private pickEntitiesInScreenRect(
    minX: number, minY: number,
    maxX: number, maxY: number,
    pid: PlayerId,
  ): EntityId[] {
    const camera = this.scene.cameras.main;
    const ids: EntityId[] = [];

    for (const u of this.entitySource.getUnits()) {
      if (u.ownership?.playerId !== pid) continue;
      const s = camera.getScreenPoint(u.transform.x, u.transform.y);
      if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) {
        ids.push(u.id);
      }
    }
    if (ids.length > 0) return ids;

    for (const b of this.entitySource.getBuildings()) {
      if (b.ownership?.playerId !== pid) continue;
      const s = camera.getScreenPoint(b.transform.x, b.transform.y);
      if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) {
        ids.push(b.id);
      }
    }
    return ids;
  }

  private pickSingleEntityAt(
    worldX: number, worldY: number, pid: PlayerId,
  ): EntityId[] {
    const unit = findClosestUnitToPoint(this.entitySource, worldX, worldY, pid);
    if (unit) return [unit.id];
    const building = findClosestBuildingToPoint(
      this.entitySource, worldX, worldY, pid,
    );
    if (building) return [building.id];
    return [];
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

  /** Draw the selection rectangle in screen space (the graphics layer
   *  was reparented to the HUD in the constructor, so x/y/w/h are
   *  pixel coords, not world). The rect stays axis-aligned on screen
   *  regardless of camera rotation or zoom, which is what the user
   *  expects when dragging a box. */
  drawSelectionRect(): void {
    this.selectionGraphics.clear();

    if (!this.state.isDraggingSelection) return;

    const x = Math.min(this.state.selectionStartScreenX, this.state.selectionEndScreenX);
    const y = Math.min(this.state.selectionStartScreenY, this.state.selectionEndScreenY);
    const w = Math.abs(this.state.selectionEndScreenX - this.state.selectionStartScreenX);
    const h = Math.abs(this.state.selectionEndScreenY - this.state.selectionStartScreenY);

    this.selectionGraphics.fillStyle(0x00ff88, 0.15);
    this.selectionGraphics.fillRect(x, y, w, h);
    this.selectionGraphics.lineStyle(2, 0x00ff88, 0.8);
    this.selectionGraphics.strokeRect(x, y, w, h);
  }

  destroy(): void {
    this.selectionGraphics.destroy();
  }
}
