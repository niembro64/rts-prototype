import Phaser from 'phaser';
import type { WorldState } from '../sim/WorldState';
import { CommandQueue, type SelectCommand, type MoveCommand, type WaypointTarget, type StartBuildCommand, type FireDGunCommand, type RepairCommand, type SetFactoryWaypointsCommand } from '../sim/commands';
import type { Entity, EntityId, WaypointType, BuildingType } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../sim/grid';

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
  // Building placement mode
  isBuildMode: boolean;
  selectedBuildingType: BuildingType | null;
  buildGhostX: number;
  buildGhostY: number;
  canPlaceBuilding: boolean;
  // D-gun mode
  isDGunMode: boolean;
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

export class InputManager {
  private scene: Phaser.Scene;
  private world: WorldState;  // Used for tick, activePlayerId, map dimensions
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

  constructor(scene: Phaser.Scene, world: WorldState, commandQueue: CommandQueue) {
    this.scene = scene;
    this.world = world;
    this.entitySource = world;  // Default to using WorldState for entity queries
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
   * Commands still use this.world for tick/playerId (always the simulation)
   */
  public setEntitySource(source: InputEntitySource): void {
    this.entitySource = source;
  }

  /**
   * Get selected units from current entity source
   * Uses world.activePlayerId for filtering
   */
  private getSelectedUnits(): Entity[] {
    return this.entitySource.getUnits().filter(
      (e) => e.selectable?.selected && e.ownership?.playerId === this.world.activePlayerId
    );
  }

  /**
   * Get selected factories from current entity source
   * Uses world.activePlayerId for filtering
   */
  private getSelectedFactories(): Entity[] {
    return this.entitySource.getBuildings().filter(
      (e) => e.selectable?.selected && e.factory !== undefined && e.ownership?.playerId === this.world.activePlayerId
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
      tick: this.world.getTick(),
      factoryId: factoryId,
      weaponId: weaponId,
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
  private findRepairTargetAt(worldX: number, worldY: number, playerId: number): Entity | null {
    // Check buildings first (incomplete ones owned by player)
    const allBuildings = this.entitySource.getBuildings();
    console.log('[findRepairTarget] Checking buildings:', {
      totalBuildings: allBuildings.length,
      lookingForPlayerId: playerId,
      clickPos: { x: worldX, y: worldY },
    });
    for (const building of allBuildings) {
      const skipReason: string[] = [];
      if (building.ownership?.playerId !== playerId) skipReason.push(`wrong owner (${building.ownership?.playerId})`);
      if (!building.buildable) skipReason.push('no buildable');
      else if (building.buildable.isComplete) skipReason.push('complete');
      else if (building.buildable.isGhost) skipReason.push('ghost');
      if (!building.building) skipReason.push('no building component');

      if (skipReason.length > 0) {
        console.log(`[findRepairTarget] Skipping building ${building.id}:`, skipReason.join(', '));
        continue;
      }
      if (building.ownership?.playerId !== playerId) continue;
      if (!building.buildable || building.buildable.isComplete || building.buildable.isGhost) continue;
      if (!building.building) continue;

      const { x, y } = building.transform;
      const halfW = building.building.width / 2;
      const halfH = building.building.height / 2;

      if (worldX >= x - halfW && worldX <= x + halfW &&
          worldY >= y - halfH && worldY <= y + halfH) {
        return building;
      }
    }

    // Check units (damaged friendly units)
    for (const unit of this.entitySource.getUnits()) {
      if (unit.ownership?.playerId !== playerId) continue;
      if (!unit.unit || unit.unit.hp >= unit.unit.maxHp || unit.unit.hp <= 0) continue;

      const dx = unit.transform.x - worldX;
      const dy = unit.transform.y - worldY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= unit.unit.collisionRadius) {
        return unit;
      }
    }

    return null;
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

  // Get snapped world position for building placement
  private getSnappedBuildPosition(worldX: number, worldY: number, buildingType: BuildingType): { x: number; y: number; gridX: number; gridY: number } {
    const config = getBuildingConfig(buildingType);
    const gridX = Math.floor(worldX / GRID_CELL_SIZE);
    const gridY = Math.floor(worldY / GRID_CELL_SIZE);

    // Center of building
    const x = gridX * GRID_CELL_SIZE + (config.gridWidth * GRID_CELL_SIZE) / 2;
    const y = gridY * GRID_CELL_SIZE + (config.gridHeight * GRID_CELL_SIZE) / 2;

    return { x, y, gridX, gridY };
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
          const repairTarget = this.findRepairTargetAt(worldPoint.x, worldPoint.y, commander.ownership.playerId);
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
              tick: this.world.getTick(),
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
        const snapped = this.getSnappedBuildPosition(worldPoint.x, worldPoint.y, this.state.selectedBuildingType);
        this.state.buildGhostX = snapped.x;
        this.state.buildGhostY = snapped.y;
      }

      if (this.state.isDraggingSelection) {
        // Convert to world coords immediately
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

    // Debug: log entity source info
    const units = this.entitySource.getUnits();
    console.log(`[Selection] EntitySource has ${units.length} units, activePlayerId: ${this.world.activePlayerId}`);
    console.log(`[Selection] Click area: (${minX.toFixed(0)}, ${minY.toFixed(0)}) to (${maxX.toFixed(0)}, ${maxY.toFixed(0)})`);

    // Find entities in selection rectangle
    const selectedIds: EntityId[] = [];

    // Select units in rectangle
    for (const entity of this.entitySource.getUnits()) {
      const { x, y } = entity.transform;
      // Only select units owned by active player
      if (entity.ownership?.playerId !== this.world.activePlayerId) {
        // Debug: log skipped units
        console.log(`[Selection] Skipped unit ${entity.id} - owner ${entity.ownership?.playerId} != active ${this.world.activePlayerId}`);
        continue;
      }

      // Check if entity center is in selection box
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        console.log(`[Selection] Found unit ${entity.id} at (${x.toFixed(0)}, ${y.toFixed(0)})`);
        selectedIds.push(entity.id);
      }
    }

    // Select buildings in rectangle (only if no units selected - prioritize units)
    if (selectedIds.length === 0) {
      for (const entity of this.entitySource.getBuildings()) {
        const { x, y } = entity.transform;
        // Only select buildings owned by active player
        if (entity.ownership?.playerId !== this.world.activePlayerId) continue;

        // Check if entity center is in selection box
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          selectedIds.push(entity.id);
        }
      }
    }

    // If no drag (click), check for single entity click
    // Use world coords - threshold scales with typical unit radius
    const dragThreshold = 10;
    const dragDist = Math.sqrt(
      Math.pow(this.state.selectionEndWorldX - this.state.selectionStartWorldX, 2) +
        Math.pow(this.state.selectionEndWorldY - this.state.selectionStartWorldY, 2)
    );

    if (dragDist < dragThreshold) {
      // Single click - find closest entity to click point
      let closestId: EntityId | null = null;
      let closestDist = Infinity;

      // Check units first
      for (const entity of this.entitySource.getUnits()) {
        if (!entity.unit) continue;
        if (entity.ownership?.playerId !== this.world.activePlayerId) continue;

        const dx = entity.transform.x - this.state.selectionStartWorldX;
        const dy = entity.transform.y - this.state.selectionStartWorldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < entity.unit.collisionRadius && dist < closestDist) {
          closestDist = dist;
          closestId = entity.id;
        }
      }

      // Check buildings if no unit was clicked
      if (closestId === null) {
        for (const entity of this.entitySource.getBuildings()) {
          if (!entity.building) continue;
          if (entity.ownership?.playerId !== this.world.activePlayerId) continue;

          const { x, y } = entity.transform;
          const halfW = entity.building.width / 2;
          const halfH = entity.building.height / 2;
          const clickX = this.state.selectionStartWorldX;
          const clickY = this.state.selectionStartWorldY;

          // Check if click is inside building bounds
          if (clickX >= x - halfW && clickX <= x + halfW &&
              clickY >= y - halfH && clickY <= y + halfH) {
            // Calculate distance to center for tie-breaking
            const dx = x - clickX;
            const dy = y - clickY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < closestDist) {
              closestDist = dist;
              closestId = entity.id;
            }
          }
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

    console.log(`[Selection] Enqueueing select command:`, { entityIds: selectedIds, additive });
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
      const repairTarget = this.findRepairTargetAt(finalPoint.x, finalPoint.y, commander.ownership.playerId);
      if (repairTarget) {
        // Issue repair command instead of move command
        const command: RepairCommand = {
          type: 'repair',
          tick: this.world.getTick(),
          commanderId: commander.id,
          targetId: repairTarget.id,
          queue: shiftHeld,
        };
        this.commandQueue.enqueue(command);
        return;
      }
    }

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
        tick: this.world.getTick(),
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
    const camera = this.scene.cameras.main;
    // Allow camera to see outside the map, but with reasonable limits
    const viewWidth = camera.width / camera.zoom;
    const viewHeight = camera.height / camera.zoom;
    const margin = 500; // How far outside the map we can see

    // Clamp with margin around the map
    const minX = -margin - viewWidth / 2;
    const maxX = this.world.mapWidth + margin - viewWidth / 2;
    const minY = -margin - viewHeight / 2;
    const maxY = this.world.mapHeight + margin - viewHeight / 2;

    camera.scrollX = Phaser.Math.Clamp(camera.scrollX, minX, maxX);
    camera.scrollY = Phaser.Math.Clamp(camera.scrollY, minY, maxY);

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

    const snapped = this.getSnappedBuildPosition(worldX, worldY, this.state.selectedBuildingType);

    // Issue start build command (shift = queue, no shift = replace)
    const command: StartBuildCommand = {
      type: 'startBuild',
      tick: this.world.getTick(),
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
      tick: this.world.getTick(),
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
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inRange = dist <= range;

      if (!inRange) {
        // Show line to building with warning color
        this.buildGhostGraphics.lineStyle(1, 0xff4444, 0.5);
        this.buildGhostGraphics.lineBetween(cx, cy, x, y);
      }
    }
  }

  // Check if selection changed and reset waypoint mode to 'move'
  private checkSelectionChange(): void {
    const currentSelected = this.getSelectedUnits();
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
