import Phaser from 'phaser';
import { CommandQueue } from '../sim/commands';
import type { Entity, EntityId, PlayerId, WaypointType, BuildingType } from '../sim/types';
import { SelectionController } from './SelectionController';
import { BuildingPlacementController } from './BuildingPlacementController';
import { CameraController } from './CameraController';
import { CommandController } from './CommandController';
import { type InputState, createInitialInputState } from './InputState';

/**
 * InputEntitySource - Interface for entity queries used by InputManager
 * Both WorldState and ClientViewState implement this interface
 */
export interface InputEntitySource {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  getEntity(id: EntityId): Entity | undefined;
  getAllEntities(): Entity[];
}

/**
 * InputContext - Provides tick and player info without requiring WorldState
 * Decouples InputManager from the simulation layer
 */
export interface InputContext {
  getTick(): number;
  activePlayerId: PlayerId;
}

export class InputManager {
  private scene: Phaser.Scene;
  private state: InputState;

  // Sub-controllers
  private selectionController: SelectionController;
  private buildingController: BuildingPlacementController;
  private cameraController: CameraController;
  private commandController: CommandController;

  // Stored for cleanup
  private keys: { M: Phaser.Input.Keyboard.Key; F: Phaser.Input.Keyboard.Key; H: Phaser.Input.Keyboard.Key };
  private pointerDownHandler!: (p: Phaser.Input.Pointer) => void;
  private pointerMoveHandler!: (p: Phaser.Input.Pointer) => void;
  private pointerUpHandler!: (p: Phaser.Input.Pointer) => void;
  private contextMenuHandler!: (e: Event) => void;

  // Callback for UI to show waypoint mode changes
  public get onWaypointModeChange(): ((mode: WaypointType) => void) | undefined {
    return this.selectionController.onWaypointModeChange;
  }
  public set onWaypointModeChange(cb: ((mode: WaypointType) => void) | undefined) {
    this.selectionController.onWaypointModeChange = cb;
  }

  // Callback for UI to show build mode changes
  public get onBuildModeChange(): ((buildingType: BuildingType | null) => void) | undefined {
    return this.buildingController.onBuildModeChange;
  }
  public set onBuildModeChange(cb: ((buildingType: BuildingType | null) => void) | undefined) {
    this.buildingController.onBuildModeChange = cb;
  }

  // Callback for D-gun mode changes
  public get onDGunModeChange(): ((active: boolean) => void) | undefined {
    return this.buildingController.onDGunModeChange;
  }
  public set onDGunModeChange(cb: ((active: boolean) => void) | undefined) {
    this.buildingController.onDGunModeChange = cb;
  }

  constructor(scene: Phaser.Scene, context: InputContext, entitySource: InputEntitySource, commandQueue: CommandQueue) {
    this.scene = scene;
    this.state = createInitialInputState();

    // Graphics objects
    const selectionGraphics = scene.add.graphics();
    selectionGraphics.setDepth(1000);

    const linePathGraphics = scene.add.graphics();
    linePathGraphics.setDepth(1000);

    const buildGhostGraphics = scene.add.graphics();
    buildGhostGraphics.setDepth(999);

    // Setup keyboard
    const keyboard = scene.input.keyboard;
    if (!keyboard) {
      throw new Error('Keyboard input not available');
    }

    const keys = {
      M: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M),
      F: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F),
      H: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.H),
      B: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.B),
      D: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      ONE: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ONE),
      TWO: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TWO),
      ESC: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC),
      SHIFT: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT),
    };

    // Create sub-controllers
    this.selectionController = new SelectionController(
      scene, context, entitySource, commandQueue, this.state, selectionGraphics,
    );

    this.buildingController = new BuildingPlacementController(
      scene, context, entitySource, commandQueue, this.state, buildGhostGraphics,
      { B: keys.B, D: keys.D, ONE: keys.ONE, TWO: keys.TWO, ESC: keys.ESC, SHIFT: keys.SHIFT },
    );

    this.cameraController = new CameraController(scene, this.state);

    this.commandController = new CommandController(
      scene, context, entitySource, commandQueue, this.state, linePathGraphics,
      this.selectionController, this.buildingController, keys.SHIFT,
    );

    // Store keys for cleanup
    this.keys = { M: keys.M, F: keys.F, H: keys.H };

    // Setup event handlers
    this.setupPointerEvents();
    this.cameraController.setupWheelEvent();
    this.setupModeHotkeys(keys);
    this.buildingController.setupBuildHotkeys();
  }

  // Setup waypoint mode hotkeys
  private setupModeHotkeys(keys: { M: Phaser.Input.Keyboard.Key; F: Phaser.Input.Keyboard.Key; H: Phaser.Input.Keyboard.Key }): void {
    keys.M.on('down', () => {
      this.selectionController.setWaypointMode('move');
    });
    keys.F.on('down', () => {
      this.selectionController.setWaypointMode('fight');
    });
    keys.H.on('down', () => {
      this.selectionController.setWaypointMode('patrol');
    });
  }

  // Set waypoint mode and notify UI
  public setWaypointMode(mode: WaypointType): void {
    this.selectionController.setWaypointMode(mode);
  }

  // Get current waypoint mode
  public getWaypointMode(): WaypointType {
    return this.selectionController.getWaypointMode();
  }

  // Get current input state (for UI)
  public getState(): Readonly<InputState> {
    return this.state;
  }

  /**
   * Set the entity source for input detection
   * Allows switching between WorldState (simulation) and ClientViewState (client view)
   */
  public setEntitySource(source: InputEntitySource): void {
    this.selectionController.setEntitySource(source);
    this.buildingController.setEntitySource(source);
    this.commandController.setEntitySource(source);
  }

  // Public method to start build mode from UI
  public startBuildMode(buildingType: BuildingType): void {
    this.buildingController.startBuildMode(buildingType);
  }

  // Public method to cancel build mode from UI
  public cancelBuildMode(): void {
    this.buildingController.cancelBuildMode();
  }

  // Public method to toggle D-gun mode from UI
  public toggleDGunMode(): void {
    this.buildingController.toggleDGunMode();
  }

  // Public method to queue unit at factory from UI
  public queueUnitAtFactory(factoryId: number, weaponId: string): void {
    this.commandController.queueUnitAtFactory(factoryId, weaponId);
  }

  // Public method to cancel queue item at factory from UI
  public cancelQueueItemAtFactory(factoryId: number, index: number): void {
    this.commandController.cancelQueueItemAtFactory(factoryId, index);
  }

  private setupPointerEvents(): void {
    const pointer = this.scene.input;

    // Pointer down
    this.pointerDownHandler = (p: Phaser.Input.Pointer) => {
      if (p.leftButtonDown()) {
        const camera = this.scene.cameras.main;
        const worldPoint = camera.getWorldPoint(p.x, p.y);

        // Handle build mode placement
        if (this.state.isBuildMode && this.state.selectedBuildingType) {
          this.buildingController.handleBuildClick(worldPoint.x, worldPoint.y);
          return;
        }

        // Handle D-gun mode firing
        if (this.state.isDGunMode) {
          this.buildingController.handleDGunClick(worldPoint.x, worldPoint.y);
          return;
        }

        // Start selection drag
        this.selectionController.startDrag(worldPoint.x, worldPoint.y);
      } else if (p.middleButtonDown()) {
        // Start camera pan
        this.cameraController.startPan(p.x, p.y);
      } else if (p.rightButtonDown()) {
        const camera = this.scene.cameras.main;
        const worldPoint = camera.getWorldPoint(p.x, p.y);
        this.commandController.handleRightClickDown(worldPoint.x, worldPoint.y);
      }
    };
    pointer.on('pointerdown', this.pointerDownHandler);

    // Pointer move
    this.pointerMoveHandler = (p: Phaser.Input.Pointer) => {
      const camera = this.scene.cameras.main;
      const worldPoint = camera.getWorldPoint(p.x, p.y);

      // Update ghost position in build mode
      this.buildingController.updateGhostPosition(worldPoint.x, worldPoint.y);

      if (this.state.isDraggingSelection) {
        this.selectionController.updateDrag(worldPoint.x, worldPoint.y);
      }

      if (this.state.isPanningCamera) {
        this.cameraController.updatePan(p.x, p.y);
      }

      if (this.state.isDrawingLinePath) {
        this.commandController.handleLinePathMove(worldPoint.x, worldPoint.y);
      }
    };
    pointer.on('pointermove', this.pointerMoveHandler);

    // Pointer up
    this.pointerUpHandler = (p: Phaser.Input.Pointer) => {
      if (this.state.isDraggingSelection && !p.leftButtonDown()) {
        this.selectionController.endDrag(p.event.shiftKey);
      }

      if (this.state.isPanningCamera && !p.middleButtonDown()) {
        this.cameraController.endPan();
      }

      if (this.state.isDrawingLinePath && !p.rightButtonDown()) {
        this.commandController.endLinePath(p.event.shiftKey);
      }
    };
    pointer.on('pointerup', this.pointerUpHandler);

    // Disable context menu
    this.contextMenuHandler = (e: Event) => {
      e.preventDefault();
    };
    this.scene.game.canvas.addEventListener('contextmenu', this.contextMenuHandler);
  }

  // Update input
  update(_delta: number): void {
    // Camera bounds are handled by Phaser's camera.setBounds() in RtsScene
    // No manual constraint logic needed

    // Check for selection changes and reset mode to 'move'
    this.selectionController.checkSelectionChange();

    // Draw selection rectangle and line path
    this.selectionController.drawSelectionRect();
    this.commandController.drawLinePath();
    this.buildingController.drawBuildGhost();
  }

  // Get current zoom level
  getZoom(): number {
    return this.cameraController.getZoom();
  }

  // Get current build mode state
  public getBuildMode(): { active: boolean; buildingType: BuildingType | null } {
    return this.buildingController.getBuildMode();
  }

  // Get D-gun mode state
  public isDGunModeActive(): boolean {
    return this.buildingController.isDGunModeActive();
  }

  // Clean up
  destroy(): void {
    // Remove keyboard listeners
    this.keys.M.removeAllListeners();
    this.keys.F.removeAllListeners();
    this.keys.H.removeAllListeners();

    // Remove pointer listeners
    this.scene.input.off('pointerdown', this.pointerDownHandler);
    this.scene.input.off('pointermove', this.pointerMoveHandler);
    this.scene.input.off('pointerup', this.pointerUpHandler);

    // Remove canvas contextmenu listener
    this.scene.game.canvas.removeEventListener('contextmenu', this.contextMenuHandler);

    // Destroy sub-controllers
    this.cameraController.destroy();
    this.selectionController.destroy();
    this.buildingController.destroy();
    this.commandController.destroy();
  }
}
