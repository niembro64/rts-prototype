import type Phaser from 'phaser';
import type { CommandQueue, StartBuildCommand, FireDGunCommand } from '../sim/commands';
import type { Entity, BuildingType } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../sim/grid';
import { getSnappedBuildPosition } from './helpers';
import { magnitude } from '../math';
import type { InputEntitySource, InputContext } from './inputBindings';
import type { InputState } from './InputState';

/**
 * BuildingPlacementController - Handles building ghost placement, building confirmation,
 * D-gun mode, and related hotkeys.
 */
export class BuildingPlacementController {
  private context: InputContext;
  private entitySource: InputEntitySource;
  private commandQueue: CommandQueue;
  private state: InputState;
  private buildGhostGraphics: Phaser.GameObjects.Graphics;
  private keys: {
    B: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
    ONE: Phaser.Input.Keyboard.Key;
    TWO: Phaser.Input.Keyboard.Key;
    ESC: Phaser.Input.Keyboard.Key;
    SHIFT: Phaser.Input.Keyboard.Key;
  };

  // Callback for UI to show build mode changes
  public onBuildModeChange?: (buildingType: BuildingType | null) => void;
  // Callback for D-gun mode changes
  public onDGunModeChange?: (active: boolean) => void;

  constructor(
    _scene: Phaser.Scene,
    context: InputContext,
    entitySource: InputEntitySource,
    commandQueue: CommandQueue,
    state: InputState,
    buildGhostGraphics: Phaser.GameObjects.Graphics,
    keys: {
      B: Phaser.Input.Keyboard.Key;
      D: Phaser.Input.Keyboard.Key;
      ONE: Phaser.Input.Keyboard.Key;
      TWO: Phaser.Input.Keyboard.Key;
      ESC: Phaser.Input.Keyboard.Key;
      SHIFT: Phaser.Input.Keyboard.Key;
    },
  ) {
    this.context = context;
    this.entitySource = entitySource;
    this.commandQueue = commandQueue;
    this.state = state;
    this.buildGhostGraphics = buildGhostGraphics;
    this.keys = keys;
  }

  setEntitySource(source: InputEntitySource): void {
    this.entitySource = source;
  }

  /** Setup building and D-gun hotkeys */
  setupBuildHotkeys(): void {
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
  hasSelectedCommander(): boolean {
    const selected = this.getSelectedUnits();
    return selected.some(e => e.commander !== undefined);
  }

  // Get selected commander
  getSelectedCommander(): Entity | null {
    const selected = this.getSelectedUnits();
    return selected.find(e => e.commander !== undefined) ?? null;
  }

  // Public method to start build mode from UI
  startBuildMode(buildingType: BuildingType): void {
    if (this.hasSelectedCommander()) {
      this.enterBuildMode(buildingType);
    }
  }

  // Public method to cancel build mode from UI
  cancelBuildMode(): void {
    this.exitBuildMode();
  }

  // Public method to toggle D-gun mode from UI
  toggleDGunMode(): void {
    if (this.hasSelectedCommander()) {
      if (this.state.isDGunMode) {
        this.exitDGunMode();
      } else {
        this.enterDGunMode();
      }
    }
  }

  // Enter build mode with a specific building type
  enterBuildMode(buildingType: BuildingType): void {
    this.state.isBuildMode = true;
    this.state.selectedBuildingType = buildingType;
    this.exitDGunMode();
    this.onBuildModeChange?.(buildingType);
  }

  // Exit build mode
  exitBuildMode(): void {
    this.state.isBuildMode = false;
    this.state.selectedBuildingType = null;
    this.buildGhostGraphics.clear();
    this.onBuildModeChange?.(null);
  }

  // Cycle between building types
  cycleBuildingType(): void {
    const types: BuildingType[] = ['solar', 'factory'];
    const currentIndex = types.indexOf(this.state.selectedBuildingType!);
    const nextIndex = (currentIndex + 1) % types.length;
    this.state.selectedBuildingType = types[nextIndex];
    this.onBuildModeChange?.(this.state.selectedBuildingType);
  }

  // Enter D-gun mode
  enterDGunMode(): void {
    this.state.isDGunMode = true;
    this.exitBuildMode();
    this.onDGunModeChange?.(true);
  }

  // Exit D-gun mode
  exitDGunMode(): void {
    this.state.isDGunMode = false;
    this.onDGunModeChange?.(false);
  }

  /** Update ghost position when pointer moves in build mode */
  updateGhostPosition(worldX: number, worldY: number): void {
    if (this.state.isBuildMode && this.state.selectedBuildingType) {
      const snapped = getSnappedBuildPosition(worldX, worldY, this.state.selectedBuildingType);
      this.state.buildGhostX = snapped.x;
      this.state.buildGhostY = snapped.y;
    }
  }

  /** Handle build click - place building */
  handleBuildClick(worldX: number, worldY: number): void {
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

  /** Handle D-gun click - fire D-gun */
  handleDGunClick(worldX: number, worldY: number): void {
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

  /** Draw build ghost preview */
  drawBuildGhost(): void {
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

  // Get current build mode state
  getBuildMode(): { active: boolean; buildingType: BuildingType | null } {
    return {
      active: this.state.isBuildMode,
      buildingType: this.state.selectedBuildingType,
    };
  }

  // Get D-gun mode state
  isDGunModeActive(): boolean {
    return this.state.isDGunMode;
  }

  destroy(): void {
    this.keys.B.removeAllListeners();
    this.keys.D.removeAllListeners();
    this.keys.ONE.removeAllListeners();
    this.keys.TWO.removeAllListeners();
    this.keys.ESC.removeAllListeners();
    this.buildGhostGraphics.destroy();
  }

  /** Get selected units (own units only) */
  private getSelectedUnits(): Entity[] {
    return this.entitySource.getUnits().filter(
      (e) => e.selectable?.selected && e.ownership?.playerId === this.context.activePlayerId
    );
  }
}
