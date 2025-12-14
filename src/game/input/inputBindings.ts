import Phaser from 'phaser';
import type { WorldState } from '../sim/WorldState';
import { CommandQueue, type SelectCommand, type MoveCommand, type WaypointTarget } from '../sim/commands';
import type { Entity, EntityId, WaypointType } from '../sim/types';

// Point in world space
interface WorldPoint {
  x: number;
  y: number;
}

// Input state
interface InputState {
  isDraggingSelection: boolean;
  // Selection stored in WORLD coordinates (not screen)
  selectionStartWorldX: number;
  selectionStartWorldY: number;
  selectionEndWorldX: number;
  selectionEndWorldY: number;
  isPanningCamera: boolean;
  panStartX: number;
  panStartY: number;
  cameraStartX: number;
  cameraStartY: number;
  // Line move state
  isDrawingLinePath: boolean;
  linePathPoints: WorldPoint[];
  linePathTargets: WorldPoint[]; // Calculated positions for each unit
  // Waypoint mode
  waypointMode: WaypointType;
  // Track previous selection to detect changes
  previousSelectedIds: Set<EntityId>;
}

// Waypoint mode colors
const WAYPOINT_COLORS: Record<WaypointType, number> = {
  move: 0x00ff00,   // Green
  patrol: 0x0088ff, // Blue
  fight: 0xff4444,  // Red
};

// Camera constraints
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;
const PAN_SPEED = 500;

export class InputManager {
  private scene: Phaser.Scene;
  private world: WorldState;
  private commandQueue: CommandQueue;
  private state: InputState;
  private selectionGraphics: Phaser.GameObjects.Graphics;
  private linePathGraphics: Phaser.GameObjects.Graphics;
  private keys: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
    M: Phaser.Input.Keyboard.Key;
    F: Phaser.Input.Keyboard.Key;
    H: Phaser.Input.Keyboard.Key;
  };

  // Callback for UI to show waypoint mode changes
  public onWaypointModeChange?: (mode: WaypointType) => void;

  constructor(scene: Phaser.Scene, world: WorldState, commandQueue: CommandQueue) {
    this.scene = scene;
    this.world = world;
    this.commandQueue = commandQueue;

    this.state = {
      isDraggingSelection: false,
      selectionStartWorldX: 0,
      selectionStartWorldY: 0,
      selectionEndWorldX: 0,
      selectionEndWorldY: 0,
      isPanningCamera: false,
      panStartX: 0,
      panStartY: 0,
      cameraStartX: 0,
      cameraStartY: 0,
      isDrawingLinePath: false,
      linePathPoints: [],
      linePathTargets: [],
      waypointMode: 'move',
      previousSelectedIds: new Set(),
    };

    // Selection rectangle graphics (world-space, drawn over entities)
    this.selectionGraphics = scene.add.graphics();
    this.selectionGraphics.setDepth(1000);

    // Line path graphics for line move command
    this.linePathGraphics = scene.add.graphics();
    this.linePathGraphics.setDepth(1000);

    // Setup keyboard
    const keyboard = scene.input.keyboard;
    if (!keyboard) {
      throw new Error('Keyboard input not available');
    }

    this.keys = {
      W: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      M: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M),
      F: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F),
      H: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.H),
    };

    this.setupPointerEvents();
    this.setupWheelEvent();
    this.setupModeHotkeys();
  }

  // Setup waypoint mode hotkeys
  private setupModeHotkeys(): void {
    this.keys.M.on('down', () => {
      this.setWaypointMode('move');
    });
    this.keys.F.on('down', () => {
      this.setWaypointMode('fight');
    });
    this.keys.H.on('down', () => {
      this.setWaypointMode('patrol');
    });
  }

  // Set waypoint mode and notify UI
  private setWaypointMode(mode: WaypointType): void {
    if (this.state.waypointMode !== mode) {
      this.state.waypointMode = mode;
      this.onWaypointModeChange?.(mode);
    }
  }

  // Get current waypoint mode
  public getWaypointMode(): WaypointType {
    return this.state.waypointMode;
  }

  private setupPointerEvents(): void {
    const pointer = this.scene.input;

    // Pointer down
    pointer.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.leftButtonDown()) {
        // Start selection drag - convert to world coords immediately
        const camera = this.scene.cameras.main;
        const worldPoint = camera.getWorldPoint(p.x, p.y);
        this.state.isDraggingSelection = true;
        this.state.selectionStartWorldX = worldPoint.x;
        this.state.selectionStartWorldY = worldPoint.y;
        this.state.selectionEndWorldX = worldPoint.x;
        this.state.selectionEndWorldY = worldPoint.y;
      } else if (p.middleButtonDown()) {
        // Start camera pan
        this.state.isPanningCamera = true;
        this.state.panStartX = p.x;
        this.state.panStartY = p.y;
        this.state.cameraStartX = this.scene.cameras.main.scrollX;
        this.state.cameraStartY = this.scene.cameras.main.scrollY;
      } else if (p.rightButtonDown()) {
        // Start line path drawing if units are selected
        const selectedUnits = this.world.getSelectedUnits();
        if (selectedUnits.length > 0) {
          const camera = this.scene.cameras.main;
          const worldPoint = camera.getWorldPoint(p.x, p.y);
          this.state.isDrawingLinePath = true;
          this.state.linePathPoints = [{ x: worldPoint.x, y: worldPoint.y }];
          this.state.linePathTargets = [];
          this.updateLinePathTargets(selectedUnits.length);
        }
      }
    });

    // Pointer move
    pointer.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.state.isDraggingSelection) {
        // Convert to world coords immediately
        const camera = this.scene.cameras.main;
        const worldPoint = camera.getWorldPoint(p.x, p.y);
        this.state.selectionEndWorldX = worldPoint.x;
        this.state.selectionEndWorldY = worldPoint.y;
      }

      if (this.state.isPanningCamera) {
        const dx = this.state.panStartX - p.x;
        const dy = this.state.panStartY - p.y;
        const camera = this.scene.cameras.main;
        camera.scrollX = this.state.cameraStartX + dx / camera.zoom;
        camera.scrollY = this.state.cameraStartY + dy / camera.zoom;
      }

      if (this.state.isDrawingLinePath) {
        const camera = this.scene.cameras.main;
        const worldPoint = camera.getWorldPoint(p.x, p.y);
        // Add point if it's far enough from the last point (to avoid too many points)
        const lastPoint = this.state.linePathPoints[this.state.linePathPoints.length - 1];
        const dx = worldPoint.x - lastPoint.x;
        const dy = worldPoint.y - lastPoint.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 10) {
          this.state.linePathPoints.push({ x: worldPoint.x, y: worldPoint.y });
          const selectedUnits = this.world.getSelectedUnits();
          this.updateLinePathTargets(selectedUnits.length);
        }
      }
    });

    // Pointer up
    pointer.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (this.state.isDraggingSelection && !p.leftButtonDown()) {
        this.finishSelection(p.event.shiftKey);
        this.state.isDraggingSelection = false;
        this.selectionGraphics.clear();
      }

      if (this.state.isPanningCamera && !p.middleButtonDown()) {
        this.state.isPanningCamera = false;
      }

      if (this.state.isDrawingLinePath && !p.rightButtonDown()) {
        this.finishLinePath(p.event.shiftKey);
        this.state.isDrawingLinePath = false;
        this.state.linePathPoints = [];
        this.state.linePathTargets = [];
        this.linePathGraphics.clear();
      }
    });

    // Disable context menu
    this.scene.game.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  private setupWheelEvent(): void {
    this.scene.input.on('wheel', (_p: Phaser.Input.Pointer, _gos: unknown, _dx: number, dy: number) => {
      const camera = this.scene.cameras.main;
      const zoomDelta = dy > 0 ? -ZOOM_STEP : ZOOM_STEP;
      camera.zoom = Phaser.Math.Clamp(camera.zoom + zoomDelta, MIN_ZOOM, MAX_ZOOM);
    });
  }

  // Finish selection and issue select command
  private finishSelection(additive: boolean): void {
    // Already in world coordinates
    const minX = Math.min(this.state.selectionStartWorldX, this.state.selectionEndWorldX);
    const maxX = Math.max(this.state.selectionStartWorldX, this.state.selectionEndWorldX);
    const minY = Math.min(this.state.selectionStartWorldY, this.state.selectionEndWorldY);
    const maxY = Math.max(this.state.selectionStartWorldY, this.state.selectionEndWorldY);

    // Find entities in selection rectangle
    const selectedIds: EntityId[] = [];

    for (const entity of this.world.getUnits()) {
      const { x, y } = entity.transform;

      // Check if entity center is in selection box
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        selectedIds.push(entity.id);
      }
    }

    // If no drag (click), check for single unit click
    // Use world coords - threshold scales with typical unit radius
    const dragThreshold = 10;
    const dragDist = Math.sqrt(
      Math.pow(this.state.selectionEndWorldX - this.state.selectionStartWorldX, 2) +
        Math.pow(this.state.selectionEndWorldY - this.state.selectionStartWorldY, 2)
    );

    if (dragDist < dragThreshold) {
      // Single click - find closest unit to click point (already in world coords)
      let closestId: EntityId | null = null;
      let closestDist = Infinity;

      for (const entity of this.world.getUnits()) {
        if (!entity.unit) continue;
        const dx = entity.transform.x - this.state.selectionStartWorldX;
        const dy = entity.transform.y - this.state.selectionStartWorldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < entity.unit.radius && dist < closestDist) {
          closestDist = dist;
          closestId = entity.id;
        }
      }

      if (closestId !== null) {
        selectedIds.length = 0;
        selectedIds.push(closestId);
      }
    }

    // Issue select command
    const command: SelectCommand = {
      type: 'select',
      tick: this.world.getTick(),
      entityIds: selectedIds,
      additive,
    };

    this.commandQueue.enqueue(command);
  }

  // Calculate total length of a path
  private getPathLength(points: WorldPoint[]): number {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      length += Math.sqrt(dx * dx + dy * dy);
    }
    return length;
  }

  // Get a point at a specific distance along the path
  private getPointAtDistance(points: WorldPoint[], targetDist: number): WorldPoint {
    if (points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return { x: points[0].x, y: points[0].y };

    let traveled = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const segmentLength = Math.sqrt(dx * dx + dy * dy);

      if (traveled + segmentLength >= targetDist) {
        // The target point is on this segment
        const remaining = targetDist - traveled;
        const t = segmentLength > 0 ? remaining / segmentLength : 0;
        return {
          x: points[i - 1].x + dx * t,
          y: points[i - 1].y + dy * t,
        };
      }
      traveled += segmentLength;
    }

    // Return the last point if we've gone past the end
    return { x: points[points.length - 1].x, y: points[points.length - 1].y };
  }

  // Update the calculated target positions along the path
  private updateLinePathTargets(unitCount: number): void {
    if (unitCount === 0 || this.state.linePathPoints.length === 0) {
      this.state.linePathTargets = [];
      return;
    }

    const pathLength = this.getPathLength(this.state.linePathPoints);
    const targets: WorldPoint[] = [];

    if (unitCount === 1) {
      // Single unit goes to the end of the path
      const lastPoint = this.state.linePathPoints[this.state.linePathPoints.length - 1];
      targets.push({ x: lastPoint.x, y: lastPoint.y });
    } else {
      // Distribute units evenly along the path
      for (let i = 0; i < unitCount; i++) {
        const t = i / (unitCount - 1); // 0 to 1
        const dist = t * pathLength;
        targets.push(this.getPointAtDistance(this.state.linePathPoints, dist));
      }
    }

    this.state.linePathTargets = targets;
  }

  // Assign units to target positions using closest distance (greedy algorithm)
  private assignUnitsToTargets(units: Entity[], targets: WorldPoint[]): Map<EntityId, WorldPoint> {
    const assignments = new Map<EntityId, WorldPoint>();
    const remainingUnits = [...units];
    const remainingTargets = [...targets];

    while (remainingUnits.length > 0 && remainingTargets.length > 0) {
      let bestUnit: Entity | null = null;
      let bestTarget: WorldPoint | null = null;
      let bestDist = Infinity;

      // Find the closest unit-target pair
      for (const unit of remainingUnits) {
        for (const target of remainingTargets) {
          const dx = unit.transform.x - target.x;
          const dy = unit.transform.y - target.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestUnit = unit;
            bestTarget = target;
          }
        }
      }

      if (bestUnit && bestTarget) {
        assignments.set(bestUnit.id, bestTarget);
        remainingUnits.splice(remainingUnits.indexOf(bestUnit), 1);
        remainingTargets.splice(remainingTargets.indexOf(bestTarget), 1);
      }
    }

    return assignments;
  }

  // Finish line path and issue move commands
  private finishLinePath(shiftHeld: boolean): void {
    const selectedUnits = this.world.getSelectedUnits();
    if (selectedUnits.length === 0) return;

    const pathLength = this.getPathLength(this.state.linePathPoints);

    // If path is very short (just a click), do a regular group move
    if (pathLength < 20) {
      const target = this.state.linePathPoints[this.state.linePathPoints.length - 1];
      const command: MoveCommand = {
        type: 'move',
        tick: this.world.getTick(),
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
    const assignments = this.assignUnitsToTargets(selectedUnits, this.state.linePathTargets);

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
      tick: this.world.getTick(),
      entityIds,
      individualTargets,
      waypointType: this.state.waypointMode,
      queue: shiftHeld,
    };
    this.commandQueue.enqueue(command);
  }

  // Draw line path preview
  private drawLinePath(): void {
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

  // Update input (keyboard camera pan)
  update(delta: number): void {
    const camera = this.scene.cameras.main;
    const panAmount = (PAN_SPEED * delta) / 1000 / camera.zoom;

    if (this.keys.W.isDown) {
      camera.scrollY -= panAmount;
    }
    if (this.keys.S.isDown) {
      camera.scrollY += panAmount;
    }
    if (this.keys.A.isDown) {
      camera.scrollX -= panAmount;
    }
    if (this.keys.D.isDown) {
      camera.scrollX += panAmount;
    }

    // Clamp camera to map bounds (only if map is larger than viewport)
    const viewWidth = camera.width / camera.zoom;
    const viewHeight = camera.height / camera.zoom;

    if (viewWidth < this.world.mapWidth) {
      const halfWidth = viewWidth / 2;
      camera.scrollX = Phaser.Math.Clamp(camera.scrollX, -halfWidth, this.world.mapWidth - halfWidth);
    } else {
      // Map fits in viewport - center it
      camera.scrollX = (this.world.mapWidth - viewWidth) / 2;
    }

    if (viewHeight < this.world.mapHeight) {
      const halfHeight = viewHeight / 2;
      camera.scrollY = Phaser.Math.Clamp(camera.scrollY, -halfHeight, this.world.mapHeight - halfHeight);
    } else {
      // Map fits in viewport - center it
      camera.scrollY = (this.world.mapHeight - viewHeight) / 2;
    }

    // Check for selection changes and reset mode to 'move'
    this.checkSelectionChange();

    // Draw selection rectangle and line path
    this.drawSelectionRect();
    this.drawLinePath();
  }

  // Check if selection changed and reset waypoint mode to 'move'
  private checkSelectionChange(): void {
    const currentSelected = this.world.getSelectedUnits();
    const currentIds = new Set(currentSelected.map((u) => u.id));

    // Check if selection changed
    let changed = currentIds.size !== this.state.previousSelectedIds.size;
    if (!changed) {
      for (const id of currentIds) {
        if (!this.state.previousSelectedIds.has(id)) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      // Reset mode to 'move' when selection changes
      this.setWaypointMode('move');
      this.state.previousSelectedIds = currentIds;
    }
  }

  // Draw selection rectangle (world space)
  private drawSelectionRect(): void {
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

  // Get current zoom level
  getZoom(): number {
    return this.scene.cameras.main.zoom;
  }

  // Clean up
  destroy(): void {
    this.selectionGraphics.destroy();
    this.linePathGraphics.destroy();
  }
}
