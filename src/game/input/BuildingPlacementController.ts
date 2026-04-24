import type Phaser from '../PhaserCompat';
import type { CommandQueue } from '../sim/commands';
import type { Entity, BuildingType } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../sim/grid';
import {
  getSnappedBuildPosition,
  handleEscape,
  CommanderModeController,
  canPlaceBuildingAt,
} from './helpers';
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

  // Shared mode state machine — also owned by Input3DManager so the
  // two renderers can't drift on enter/exit semantics.
  private mode = new CommanderModeController();

  // Map bounds for client-side build placement validation. Set via
  // setMapBounds; until then the validator treats the world as
  // unbounded, which means off-map ghosts still render green. That's
  // only visible before the scene calls setMapBounds in startup.
  private mapWidth = Infinity;
  private mapHeight = Infinity;

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

    // Sync mode state into InputState + forward UI callbacks. The
    // controller owns the truth; these handlers keep the legacy
    // flags (still read by UIUpdateManager / CameraController) in
    // lock-step so no consumer has to change.
    this.mode.onBuildModeChange = (type) => {
      this.state.isBuildMode = type !== null;
      this.state.selectedBuildingType = type;
      if (type === null) this.buildGhostGraphics.clear();
      this.onBuildModeChange?.(type);
    };
    this.mode.onDGunModeChange = (active) => {
      this.state.isDGunMode = active;
      this.onDGunModeChange?.(active);
    };
  }

  setEntitySource(source: InputEntitySource): void {
    this.entitySource = source;
  }

  /** Scene hook — feeds the client-side placement validator so the
   *  build ghost turns red at the map edge. */
  setMapBounds(width: number, height: number): void {
    this.mapWidth = width;
    this.mapHeight = height;
  }

  /** Setup building and D-gun hotkeys */
  setupBuildHotkeys(): void {
    // B: enter build mode (or cycle if already in one).
    this.keys.B.on('down', () => {
      if (!this.hasSelectedCommander()) return;
      if (!this.mode.isInBuildMode) this.mode.enterBuildMode('solar');
      else this.mode.cycleBuildingType();
    });

    // 1 / 2: directly pick a building type.
    this.keys.ONE.on('down', () => {
      if (this.mode.isInBuildMode || this.hasSelectedCommander()) {
        this.mode.enterBuildMode('solar');
      }
    });
    this.keys.TWO.on('down', () => {
      if (this.mode.isInBuildMode || this.hasSelectedCommander()) {
        this.mode.enterBuildMode('factory');
      }
    });

    // ESC: cancel active mode first (build → d-gun), else clear
    // selection. Shared via handleEscape so 2D and 3D ordering match.
    this.keys.ESC.on('down', () => {
      handleEscape(
        [
          { isActive: () => this.mode.isInBuildMode, cancel: () => this.mode.exitBuildMode() },
          { isActive: () => this.mode.isInDGunMode, cancel: () => this.mode.exitDGunMode() },
        ],
        this.commandQueue,
        this.context.getTick(),
      );
    });

    // D: toggle D-gun mode.
    this.keys.D.on('down', () => {
      if (this.hasSelectedCommander()) this.mode.toggleDGunMode();
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

  // UI-facing wrappers — all delegate to the shared controller.
  startBuildMode(buildingType: BuildingType): void {
    if (this.hasSelectedCommander()) this.mode.enterBuildMode(buildingType);
  }
  cancelBuildMode(): void { this.mode.exitBuildMode(); }
  toggleDGunMode(): void {
    if (this.hasSelectedCommander()) this.mode.toggleDGunMode();
  }
  enterBuildMode(type: BuildingType): void { this.mode.enterBuildMode(type); }
  exitBuildMode(): void { this.mode.exitBuildMode(); }
  enterDGunMode(): void { this.mode.enterDGunMode(); }
  exitDGunMode(): void { this.mode.exitDGunMode(); }
  cycleBuildingType(): void { this.mode.cycleBuildingType(); }

  /** Update ghost position when pointer moves in build mode */
  updateGhostPosition(worldX: number, worldY: number): void {
    const type = this.mode.buildingType;
    if (type !== null) {
      const snapped = getSnappedBuildPosition(worldX, worldY, type);
      this.state.buildGhostX = snapped.x;
      this.state.buildGhostY = snapped.y;
    }
  }

  /** Handle build click - place building */
  handleBuildClick(worldX: number, worldY: number): void {
    const commander = this.getSelectedCommander();
    if (!commander) return;
    const shiftHeld = this.keys.SHIFT.isDown;
    const cmd = this.mode.buildStartBuildCommand(
      commander, worldX, worldY,
      this.context.getTick(), shiftHeld,
    );
    if (!cmd) return;
    this.commandQueue.enqueue(cmd);
    // Shift = keep placing; otherwise exit build mode.
    if (!shiftHeld) this.mode.exitBuildMode();
  }

  /** Handle D-gun click - fire D-gun. Stays in D-gun mode for rapid
   *  firing (exit with ESC or the D key or UI button). */
  handleDGunClick(worldX: number, worldY: number): void {
    const commander = this.getSelectedCommander();
    if (!commander) return;
    this.commandQueue.enqueue(
      this.mode.buildFireDGunCommand(commander, worldX, worldY, this.context.getTick()),
    );
  }

  /** Draw build ghost preview */
  drawBuildGhost(): void {
    this.buildGhostGraphics.clear();

    const type = this.mode.buildingType;
    if (type === null) return;

    const config = getBuildingConfig(type);
    const width = config.gridWidth * GRID_CELL_SIZE;
    const height = config.gridHeight * GRID_CELL_SIZE;
    const x = this.state.buildGhostX;
    const y = this.state.buildGhostY;
    const left = x - width / 2;
    const top = y - height / 2;

    const canPlace = canPlaceBuildingAt(
      type, x, y, this.mapWidth, this.mapHeight,
      this.entitySource.getBuildings(),
    );

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
      active: this.mode.isInBuildMode,
      buildingType: this.mode.buildingType,
    };
  }

  // Get D-gun mode state
  isDGunModeActive(): boolean {
    return this.mode.isInDGunMode;
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
