import Phaser from 'phaser';
import type { WorldState } from '../sim/WorldState';
import { CommandQueue, type SelectCommand, type MoveCommand } from '../sim/commands';
import type { EntityId } from '../sim/types';

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
}

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
  private keys: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  };

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
    };

    // Selection rectangle graphics (world-space, drawn over entities)
    this.selectionGraphics = scene.add.graphics();
    this.selectionGraphics.setDepth(1000);

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
    };

    this.setupPointerEvents();
    this.setupWheelEvent();
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
        // Issue move command
        this.handleRightClick(p);
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

  // Handle right click for move command
  private handleRightClick(pointer: Phaser.Input.Pointer): void {
    const selectedUnits = this.world.getSelectedUnits();
    if (selectedUnits.length === 0) return;

    const camera = this.scene.cameras.main;
    const worldPoint = camera.getWorldPoint(pointer.x, pointer.y);

    const command: MoveCommand = {
      type: 'move',
      tick: this.world.getTick(),
      entityIds: selectedUnits.map((e) => e.id),
      targetX: worldPoint.x,
      targetY: worldPoint.y,
    };

    this.commandQueue.enqueue(command);
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

    // Draw selection rectangle
    this.drawSelectionRect();
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
  }
}
