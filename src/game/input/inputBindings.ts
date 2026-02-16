import Phaser from 'phaser';
import { CommandQueue, type SelectCommand, type MoveCommand, type WaypointTarget, type StartBuildCommand, type FireDGunCommand, type RepairCommand, type SetFactoryWaypointsCommand } from '../sim/commands';
import type { Entity, EntityId, PlayerId, WaypointType, BuildingType } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../sim/grid';
import { ZOOM_MIN, ZOOM_MAX, ZOOM_FACTOR, CAMERA_PAN_MULTIPLIER } from '../../config';
import {
  type WorldPoint,
  getPathLength,
  calculateLinePathTargets,
  assignUnitsToTargets,
  WAYPOINT_COLORS,
  getSnappedBuildPosition,
  performSelection,
  findRepairTargetAt,
} from './helpers';
import { magnitude } from '../math';

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
  // Building placement mode
  isBuildMode: boolean;
  selectedBuildingType: BuildingType | null;
  buildGhostX: number;
  buildGhostY: number;
  canPlaceBuilding: boolean;
  // D-gun mode
  isDGunMode: boolean;
}

// Camera constraints imported from config.ts: ZOOM_MIN, ZOOM_MAX, ZOOM_STEP

export class InputManager {
  private scene: Phaser.Scene;
  private context: InputContext;  // Used for tick, activePlayerId
  private entitySource: InputEntitySource;  // Used for entity queries (can be WorldState or ClientViewState)
  private commandQueue: CommandQueue;
  private state: InputState;
  private selectionGraphics: Phaser.GameObjects.Graphics;
  private linePathGraphics: Phaser.GameObjects.Graphics;
  private buildGhostGraphics: Phaser.GameObjects.Graphics;
  private keys: {
    M: Phaser.Input.Keyboard.Key;
    F: Phaser.Input.Keyboard.Key;
    H: Phaser.Input.Keyboard.Key;
    B: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
    ONE: Phaser.Input.Keyboard.Key;
    TWO: Phaser.Input.Keyboard.Key;
    ESC: Phaser.Input.Keyboard.Key;
    SHIFT: Phaser.Input.Keyboard.Key;
  };

  // Callback for UI to show waypoint mode changes
  public onWaypointModeChange?: (mode: WaypointType) => void;
  // Callback for UI to show build mode changes
  public onBuildModeChange?: (buildingType: BuildingType | null) => void;
  // Callback for D-gun mode changes
  public onDGunModeChange?: (active: boolean) => void;

  constructor(scene: Phaser.Scene, context: InputContext, entitySource: InputEntitySource, commandQueue: CommandQueue) {
    this.scene = scene;
    this.context = context;
    this.entitySource = entitySource;
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
      isBuildMode: false,
      selectedBuildingType: null,
      buildGhostX: 0,
      buildGhostY: 0,
      canPlaceBuilding: false,
      isDGunMode: false,
    };

    // Selection rectangle graphics (world-space, drawn over entities)
    this.selectionGraphics = scene.add.graphics();
    this.selectionGraphics.setDepth(1000);

    // Line path graphics for line move command
    this.linePathGraphics = scene.add.graphics();
    this.linePathGraphics.setDepth(1000);

    // Build ghost graphics
    this.buildGhostGraphics = scene.add.graphics();
    this.buildGhostGraphics.setDepth(999);

    // Setup keyboard
    const keyboard = scene.input.keyboard;
    if (!keyboard) {
      throw new Error('Keyboard input not available');
    }

    this.keys = {
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

    this.setupPointerEvents();
    this.setupWheelEvent();
    this.setupModeHotkeys();
    this.setupBuildHotkeys();
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
  public setWaypointMode(mode: WaypointType): void {
    if (this.state.waypointMode !== mode) {
      this.state.waypointMode = mode;
      this.onWaypointModeChange?.(mode);
    }
  }

  // Get current waypoint mode
  public getWaypointMode(): WaypointType {
    return this.state.waypointMode;
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
    this.entitySource = source;
  }

  /**
   * Get selected units from current entity source
   */
  private getSelectedUnits(): Entity[] {
    return this.entitySource.getUnits().filter(
      (e) => e.selectable?.selected && e.ownership?.playerId === this.context.activePlayerId
    );
  }

  /**
   * Get selected factories from current entity source
   */
  private getSelectedFactories(): Entity[] {
    return this.entitySource.getBuildings().filter(
      (e) => e.selectable?.selected && e.factory !== undefined && e.ownership?.playerId === this.context.activePlayerId
    );
  }

  // Public method to start build mode from UI
  public startBuildMode(buildingType: BuildingType): void {
    if (this.hasSelectedCommander()) {
      this.enterBuildMode(buildingType);
    }
  }

  // Public method to cancel build mode from UI
  public cancelBuildMode(): void {
    this.exitBuildMode();
  }

  // Public method to toggle D-gun mode from UI
  public toggleDGunMode(): void {
    if (this.hasSelectedCommander()) {
      if (this.state.isDGunMode) {
        this.exitDGunMode();
      } else {
        this.enterDGunMode();
      }
    }
  }

  // Public method to queue unit at factory from UI
  public queueUnitAtFactory(factoryId: number, weaponId: string): void {
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

  // Public method to cancel queue item at factory from UI
  public cancelQueueItemAtFactory(factoryId: number, index: number): void {
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

  // Setup building hotkeys
  private setupBuildHotkeys(): void {
    // B key enters build mode (shows menu or cycles)
    this.keys.B.on('down', () => {
      if (this.hasSelectedCommander()) {
        if (!this.state.isBuildMode) {
          // Enter build mode with solar as default
          this.enterBuildMode('solar');
        } else {
          // Already in build mode, cycle building type
          this.cycleBuildingType();
        }
      }
    });

    // 1 key selects solar panel
    this.keys.ONE.on('down', () => {
      if (this.state.isBuildMode || this.hasSelectedCommander()) {
        this.enterBuildMode('solar');
      }
    });

    // 2 key selects factory
    this.keys.TWO.on('down', () => {
      if (this.state.isBuildMode || this.hasSelectedCommander()) {
        this.enterBuildMode('factory');
      }
    });

    // ESC cancels build mode
    this.keys.ESC.on('down', () => {
      if (this.state.isBuildMode) {
        this.exitBuildMode();
      }
      if (this.state.isDGunMode) {
        this.exitDGunMode();
      }
    });

    // D key activates D-gun mode
    this.keys.D.on('down', () => {
      if (this.hasSelectedCommander()) {
        if (!this.state.isDGunMode) {
          this.enterDGunMode();
        } else {
          this.exitDGunMode();
        }
      }
    });
  }

  // Check if a commander is selected
  private hasSelectedCommander(): boolean {
    const selected = this.getSelectedUnits();
    return selected.some(e => e.commander !== undefined);
  }

  // Get selected commander
  private getSelectedCommander(): Entity | null {
    const selected = this.getSelectedUnits();
    return selected.find(e => e.commander !== undefined) ?? null;
  }

  // Find a repairable target at a world position (incomplete building or damaged friendly unit)
  private findRepairTarget(worldX: number, worldY: number, playerId: number): Entity | null {
    return findRepairTargetAt(this.entitySource, worldX, worldY, playerId);
  }

  // Enter build mode with a specific building type
  private enterBuildMode(buildingType: BuildingType): void {
    this.state.isBuildMode = true;
    this.state.selectedBuildingType = buildingType;
    this.exitDGunMode();
    this.onBuildModeChange?.(buildingType);
  }

  // Exit build mode
  private exitBuildMode(): void {
    this.state.isBuildMode = false;
    this.state.selectedBuildingType = null;
    this.buildGhostGraphics.clear();
    this.onBuildModeChange?.(null);
  }

  // Cycle between building types
  private cycleBuildingType(): void {
    const types: BuildingType[] = ['solar', 'factory'];
    const currentIndex = types.indexOf(this.state.selectedBuildingType!);
    const nextIndex = (currentIndex + 1) % types.length;
    this.state.selectedBuildingType = types[nextIndex];
    this.onBuildModeChange?.(this.state.selectedBuildingType);
  }

  // Enter D-gun mode
  private enterDGunMode(): void {
    this.state.isDGunMode = true;
    this.exitBuildMode();
    this.onDGunModeChange?.(true);
  }

  // Exit D-gun mode
  private exitDGunMode(): void {
    this.state.isDGunMode = false;
    this.onDGunModeChange?.(false);
  }

  private setupPointerEvents(): void {
    const pointer = this.scene.input;

    // Pointer down
    pointer.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.leftButtonDown()) {
        const camera = this.scene.cameras.main;
        const worldPoint = camera.getWorldPoint(p.x, p.y);

        // Handle build mode placement
        if (this.state.isBuildMode && this.state.selectedBuildingType) {
          this.handleBuildClick(worldPoint.x, worldPoint.y);
          return;
        }

        // Handle D-gun mode firing
        if (this.state.isDGunMode) {
          this.handleDGunClick(worldPoint.x, worldPoint.y);
          return;
        }

        // Start selection drag - convert to world coords immediately
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
        // Cancel build/D-gun mode on right click
        if (this.state.isBuildMode) {
          this.exitBuildMode();
          return;
        }
        if (this.state.isDGunMode) {
          this.exitDGunMode();
          return;
        }

        const camera = this.scene.cameras.main;
        const worldPoint = camera.getWorldPoint(p.x, p.y);

        // Check if commander is selected and right-clicking on a repair target
        const commander = this.getSelectedCommander();
        if (commander?.ownership) {
          const repairTarget = this.findRepairTarget(worldPoint.x, worldPoint.y, commander.ownership.playerId);
          console.log('[Input] Repair target check:', {
            hasCommander: !!commander,
            playerId: commander.ownership.playerId,
            clickPos: { x: worldPoint.x, y: worldPoint.y },
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
              queue: this.keys.SHIFT.isDown,
            };
            console.log('[Input] Creating RepairCommand:', command);
            this.commandQueue.enqueue(command);
            return;
          }
        }

        // Start line path drawing if units are selected
        const selectedUnits = this.getSelectedUnits();
        if (selectedUnits.length > 0) {
          this.state.isDrawingLinePath = true;
          this.state.linePathPoints = [{ x: worldPoint.x, y: worldPoint.y }];
          this.state.linePathTargets = [];
          this.updateLinePathTargets(selectedUnits.length);
        } else {
          // Check if factories are selected - start factory waypoint mode
          const selectedFactories = this.getSelectedFactories();
          if (selectedFactories.length > 0) {
            this.state.isDrawingLinePath = true;
            this.state.linePathPoints = [{ x: worldPoint.x, y: worldPoint.y }];
            this.state.linePathTargets = [{ x: worldPoint.x, y: worldPoint.y }];
          }
        }
      }
    });

    // Pointer move
    pointer.on('pointermove', (p: Phaser.Input.Pointer) => {
      const camera = this.scene.cameras.main;
      const worldPoint = camera.getWorldPoint(p.x, p.y);

      // Update ghost position in build mode
      if (this.state.isBuildMode && this.state.selectedBuildingType) {
        const snapped = getSnappedBuildPosition(worldPoint.x, worldPoint.y, this.state.selectedBuildingType);
        this.state.buildGhostX = snapped.x;
        this.state.buildGhostY = snapped.y;
      }

      if (this.state.isDraggingSelection) {
        // Convert to world coords immediately
        this.state.selectionEndWorldX = worldPoint.x;
        this.state.selectionEndWorldY = worldPoint.y;
      }

      if (this.state.isPanningCamera) {
        // Camera moves in the direction of mouse movement (like Beyond All Reason)
        const dx = (p.x - this.state.panStartX) * CAMERA_PAN_MULTIPLIER;
        const dy = (p.y - this.state.panStartY) * CAMERA_PAN_MULTIPLIER;
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
        const dist = magnitude(dx, dy);
        if (dist > 10) {
          this.state.linePathPoints.push({ x: worldPoint.x, y: worldPoint.y });
          const selectedUnits = this.getSelectedUnits();
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
    this.scene.input.on('wheel', (pointer: Phaser.Input.Pointer, _gos: unknown, _dx: number, dy: number) => {
      const camera = this.scene.cameras.main;
      const oldZoom = camera.zoom;

      // Calculate new zoom level
      const newZoom = dy > 0
        ? oldZoom / ZOOM_FACTOR  // Scroll down = zoom out
        : oldZoom * ZOOM_FACTOR; // Scroll up = zoom in
      const clampedZoom = Phaser.Math.Clamp(newZoom, ZOOM_MIN, ZOOM_MAX);

      // Skip if zoom didn't change (at min/max)
      if (clampedZoom === oldZoom) return;

      // Cursor offset from screen center (Phaser camera is centered by default)
      const cursorOffsetX = pointer.x - camera.width / 2;
      const cursorOffsetY = pointer.y - camera.height / 2;

      // Calculate world point under cursor with current zoom
      // Formula: worldX = scrollX + cursorOffset / zoom
      const worldX = camera.scrollX + cursorOffsetX / oldZoom;
      const worldY = camera.scrollY + cursorOffsetY / oldZoom;

      // Calculate new scroll to keep same world point under cursor after zoom
      // We want: worldX = newScrollX + cursorOffset / newZoom
      // So: newScrollX = worldX - cursorOffset / newZoom
      camera.scrollX = worldX - cursorOffsetX / clampedZoom;
      camera.scrollY = worldY - cursorOffsetY / clampedZoom;
      camera.zoom = clampedZoom;
    });
  }

  // Finish selection and issue select command
  private finishSelection(additive: boolean): void {
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

  // Update the calculated target positions along the path
  private updateLinePathTargets(unitCount: number): void {
    this.state.linePathTargets = calculateLinePathTargets(this.state.linePathPoints, unitCount);
  }

  // Finish line path and issue move commands (for units or factory waypoints)
  private finishLinePath(shiftHeld: boolean): void {
    const selectedUnits = this.getSelectedUnits();

    // Handle factory waypoints if no units selected
    if (selectedUnits.length === 0) {
      const selectedFactories = this.getSelectedFactories();
      if (selectedFactories.length > 0) {
        this.finishFactoryWaypoints(shiftHeld);
      }
      return;
    }

    // Check if commander is ending waypoint on a repair target (incomplete building)
    const commander = this.getSelectedCommander();
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

  // Finish setting factory waypoints
  private finishFactoryWaypoints(shiftHeld: boolean): void {
    const selectedFactories = this.getSelectedFactories();
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

  // Update input
  update(_delta: number): void {
    // Camera bounds are handled by Phaser's camera.setBounds() in RtsScene
    // No manual constraint logic needed

    // Check for selection changes and reset mode to 'move'
    this.checkSelectionChange();

    // Draw selection rectangle and line path
    this.drawSelectionRect();
    this.drawLinePath();
    this.drawBuildGhost();
  }

  // Handle build click - place building
  private handleBuildClick(worldX: number, worldY: number): void {
    const commander = this.getSelectedCommander();
    if (!commander || !this.state.selectedBuildingType) return;

    const snapped = getSnappedBuildPosition(worldX, worldY, this.state.selectedBuildingType);

    // Issue start build command (shift = queue, no shift = replace)
    const command: StartBuildCommand = {
      type: 'startBuild',
      tick: this.context.getTick(),
      builderId: commander.id,
      buildingType: this.state.selectedBuildingType,
      gridX: snapped.gridX,
      gridY: snapped.gridY,
      queue: this.keys.SHIFT.isDown,
    };

    this.commandQueue.enqueue(command);

    // Only exit build mode if shift is NOT held (shift = continue placing same building)
    if (!this.keys.SHIFT.isDown) {
      this.exitBuildMode();
    }
  }

  // Handle D-gun click - fire D-gun
  private handleDGunClick(worldX: number, worldY: number): void {
    const commander = this.getSelectedCommander();
    if (!commander) return;

    // Issue fire D-gun command
    const command: FireDGunCommand = {
      type: 'fireDGun',
      tick: this.context.getTick(),
      commanderId: commander.id,
      targetX: worldX,
      targetY: worldY,
    };

    this.commandQueue.enqueue(command);

    // Stay in D-gun mode for rapid firing (exit with ESC or right-click)
  }

  // Draw build ghost preview
  private drawBuildGhost(): void {
    this.buildGhostGraphics.clear();

    if (!this.state.isBuildMode || !this.state.selectedBuildingType) return;

    const config = getBuildingConfig(this.state.selectedBuildingType);
    const width = config.gridWidth * GRID_CELL_SIZE;
    const height = config.gridHeight * GRID_CELL_SIZE;
    const x = this.state.buildGhostX;
    const y = this.state.buildGhostY;
    const left = x - width / 2;
    const top = y - height / 2;

    // TODO: Check if placement is valid via construction system
    const canPlace = true; // Placeholder

    // Ghost fill
    const ghostColor = canPlace ? 0x88ff88 : 0xff4444;
    this.buildGhostGraphics.fillStyle(ghostColor, 0.3);
    this.buildGhostGraphics.fillRect(left, top, width, height);

    // Ghost outline
    this.buildGhostGraphics.lineStyle(2, ghostColor, 0.8);
    this.buildGhostGraphics.strokeRect(left, top, width, height);

    // Grid lines
    this.buildGhostGraphics.lineStyle(1, ghostColor, 0.4);
    for (let gx = left; gx <= left + width; gx += GRID_CELL_SIZE) {
      this.buildGhostGraphics.lineBetween(gx, top, gx, top + height);
    }
    for (let gy = top; gy <= top + height; gy += GRID_CELL_SIZE) {
      this.buildGhostGraphics.lineBetween(left, gy, left + width, gy);
    }

    // Commander range indicator
    const commander = this.getSelectedCommander();
    if (commander?.builder) {
      const cx = commander.transform.x;
      const cy = commander.transform.y;
      const range = commander.builder.buildRange;

      // Draw range circle
      this.buildGhostGraphics.lineStyle(1, 0x00ff00, 0.3);
      this.buildGhostGraphics.strokeCircle(cx, cy, range);

      // Check if building is in range
      const dx = x - cx;
      const dy = y - cy;
      const dist = magnitude(dx, dy);
      const inRange = dist <= range;

      if (!inRange) {
        // Show line to building with warning color
        this.buildGhostGraphics.lineStyle(1, 0xff4444, 0.5);
        this.buildGhostGraphics.lineBetween(cx, cy, x, y);
      }
    }
  }

  // Check if selection changed and reset waypoint mode to 'move'.
  // Zero-allocation: iterates cached units array directly instead of .filter() + .map() + new Set().
  private checkSelectionChange(): void {
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
    this.buildGhostGraphics.destroy();
  }

  // Get current build mode state
  public getBuildMode(): { active: boolean; buildingType: BuildingType | null } {
    return {
      active: this.state.isBuildMode,
      buildingType: this.state.selectedBuildingType,
    };
  }

  // Get D-gun mode state
  public isDGunModeActive(): boolean {
    return this.state.isDGunMode;
  }
}
