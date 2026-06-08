import type { CommandQueue } from '../sim/commands';
import type { Entity, EntityId, PlayerId, BuildingBlueprintId } from '../sim/types';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import {
  buildAttackAreaCommand,
  buildAttackGroundCommand,
  buildGuardCommandAt,
  buildGuardCommandForTarget,
  buildReclaimCommandAt,
  buildReclaimCommandForTarget,
  buildRepairAreaCommand,
  type CommanderModeController,
  type InputSelectedCommands,
} from '../input/helpers';
import type { CommandCursorKind } from '../input/CommandCursors';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import type { BuildGhost3D } from './BuildGhost3D';
import { Input3DBuildPlacementState } from './Input3DBuildPlacementState';
import type { Input3DPicker } from './Input3DPicker';
import { entityCanBuild } from '../sim/builderBuildRoster';

const REPAIR_AREA_RADIUS = 220;
const ATTACK_AREA_RADIUS = 300;

type ModeClickEntitySource = {
  getUnits: () => Entity[];
  getBuildings: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
  getSelectedUnits: () => Entity[];
  getEntitySetVersion?: () => number;
  getTerrainBuildabilityGrid?: () => TerrainBuildabilityGrid | null;
};

type Input3DModeClickControllerConfig = {
  getEntitySource: () => ModeClickEntitySource;
  commandQueue: CommandQueue;
  picker: Input3DPicker;
  mode: CommanderModeController;
  selectedCommands: InputSelectedCommands;
  getTick: () => number;
  getActivePlayerId: () => PlayerId;
  getSelectedCommander: () => Entity | null;
  getSelectedBuilder: () => Entity | null;
  applyCursor: (kind: CommandCursorKind) => void;
  isRepairAreaMode: () => boolean;
  isAttackAreaMode: () => boolean;
  isAttackGroundMode: () => boolean;
  isGuardMode: () => boolean;
  isReclaimMode: () => boolean;
  isPingMode: () => boolean;
  isTowerTargetMode: () => boolean;
  exitRepairAreaMode: () => void;
  exitAttackAreaMode: () => void;
  exitAttackGroundMode: () => void;
  exitGuardMode: () => void;
  exitReclaimMode: () => void;
  exitPingMode: () => void;
  exitTowerTargetMode: () => void;
};

export class Input3DModeClickController {
  private readonly buildPlacement = new Input3DBuildPlacementState();
  private buildGhost: BuildGhost3D | null = null;

  constructor(private readonly config: Input3DModeClickControllerConfig) {}

  get active(): boolean {
    return this.config.mode.isInBuildMode ||
      this.config.mode.isInDGunMode ||
      this.config.isRepairAreaMode() ||
      this.config.isAttackAreaMode() ||
      this.config.isAttackGroundMode() ||
      this.config.isGuardMode() ||
      this.config.isReclaimMode() ||
      this.config.isPingMode() ||
      this.config.isTowerTargetMode();
  }

  get buildDiagnostics() {
    return this.buildPlacement.diagnostics;
  }

  setBuildGhost(ghost: BuildGhost3D | null): void {
    this.buildGhost = ghost;
  }

  setMapBounds(width: number, height: number, playerCount: number): void {
    this.buildPlacement.setMapBounds(width, height, playerCount);
  }

  getMapSampleBounds(): { width: number; height: number } {
    return {
      width: this.buildPlacement.width,
      height: this.buildPlacement.height,
    };
  }

  handleBuildModeChange(buildingBlueprintId: BuildingBlueprintId | null): void {
    this.buildPlacement.reset();
    if (buildingBlueprintId === null) {
      this.buildGhost?.hide();
    }
  }

  cursorKindForActiveMode(): CommandCursorKind | null {
    if (this.config.mode.isInBuildMode) {
      return this.buildPlacement.diagnostics
        ? (this.buildPlacement.diagnostics.canPlace ? 'build' : 'blocked')
        : 'build';
    }
    if (this.config.mode.isInDGunMode) return 'dgun';
    if (this.config.isRepairAreaMode()) return 'repair';
    if (this.config.isAttackAreaMode()) return 'attack';
    if (this.config.isAttackGroundMode()) return 'attack';
    if (this.config.isGuardMode()) return 'guard';
    if (this.config.isReclaimMode()) return 'reclaim';
    if (this.config.isPingMode()) return 'ping';
    if (this.config.isTowerTargetMode()) return 'attack';
    return null;
  }

  handleMouseDown(e: MouseEvent): boolean {
    if (!this.active) return false;
    e.preventDefault();
    if (e.button === 0) {
      this.handleLeftClick(e);
    } else if (e.button === 2) {
      this.handleRightCancel();
    }
    return true;
  }

  handleMouseMove(e: MouseEvent): boolean {
    const buildingBlueprintId = this.config.mode.buildingBlueprintId;
    if (buildingBlueprintId !== null) {
      this.updateBuildPreview(e, buildingBlueprintId);
      return true;
    }
    const cursor = this.cursorKindForActiveMode();
    if (cursor !== null) {
      this.config.applyCursor(cursor);
      return true;
    }
    return false;
  }

  private handleLeftClick(e: MouseEvent): void {
    if (this.config.mode.isInBuildMode) this.handleBuildClick(e);
    else if (this.config.mode.isInDGunMode) this.handleDGunClick(e);
    else if (this.config.isRepairAreaMode()) this.handleRepairAreaClick(e);
    else if (this.config.isAttackAreaMode()) this.handleAttackAreaClick(e);
    else if (this.config.isAttackGroundMode()) this.handleAttackGroundClick(e);
    else if (this.config.isGuardMode()) this.handleGuardClick(e);
    else if (this.config.isReclaimMode()) this.handleReclaimClick(e);
    else if (this.config.isTowerTargetMode()) this.handleTowerTargetClick(e);
    else this.handlePingClick(e);
  }

  private handleRightCancel(): void {
    if (this.config.mode.isInBuildMode) this.config.mode.exitBuildMode();
    else if (this.config.mode.isInDGunMode) this.config.mode.exitDGunMode();
    else if (this.config.isRepairAreaMode()) this.config.exitRepairAreaMode();
    else if (this.config.isAttackAreaMode()) this.config.exitAttackAreaMode();
    else if (this.config.isAttackGroundMode()) this.config.exitAttackGroundMode();
    else if (this.config.isGuardMode()) this.config.exitGuardMode();
    else if (this.config.isReclaimMode()) this.config.exitReclaimMode();
    else if (this.config.isTowerTargetMode()) this.config.exitTowerTargetMode();
    else this.config.exitPingMode();
  }

  private updateBuildPreview(e: MouseEvent, buildingBlueprintId: BuildingBlueprintId): void {
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (world) {
      const builder = this.config.getSelectedBuilder();
      if (!entityCanBuild(builder, buildingBlueprintId)) {
        this.config.applyCursor('blocked');
        this.buildGhost?.hide();
        return;
      }
      const diagnostics = this.validateBuildPlacement(buildingBlueprintId, world.x, world.y);
      this.config.applyCursor(diagnostics.canPlace ? 'build' : 'blocked');
      this.buildGhost?.setTarget(
        buildingBlueprintId,
        world.x,
        world.y,
        builder,
        this.buildPlacement.canPlace,
        diagnostics,
      );
    } else {
      this.buildPlacement.clearDiagnostics();
      this.config.applyCursor('blocked');
    }
  }

  private handleBuildClick(e: MouseEvent): void {
    const builder = this.config.getSelectedBuilder();
    if (!builder) {
      this.config.mode.exitBuildMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const buildingBlueprintId = this.config.mode.buildingBlueprintId;
    if (buildingBlueprintId === null) return;
    if (!entityCanBuild(builder, buildingBlueprintId)) {
      this.config.applyCursor('blocked');
      return;
    }
    const diagnostics = this.validateBuildPlacement(buildingBlueprintId, world.x, world.y);
    this.config.applyCursor(diagnostics.canPlace ? 'build' : 'blocked');
    this.buildGhost?.setTarget(
      buildingBlueprintId, world.x, world.y,
      builder,
      diagnostics.canPlace,
      diagnostics,
    );
    if (!diagnostics.canPlace) {
      debugLog(GAME_DIAGNOSTICS.commandPlans, 'Blocked invalid build placement', {
        buildingBlueprintId,
        reason: diagnostics.failureReason,
        metalFraction: diagnostics.metalFraction,
      });
      return;
    }
    const cmd = this.config.mode.buildStartBuildCommand(
      builder, world.x, world.y,
      this.config.getTick(), e.shiftKey,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    if (!e.shiftKey) this.config.mode.exitBuildMode();
  }

  private validateBuildPlacement(
    buildingBlueprintId: BuildingBlueprintId,
    worldX: number,
    worldY: number,
  ) {
    return this.buildPlacement.validate(
      buildingBlueprintId,
      worldX,
      worldY,
      this.config.getEntitySource(),
    );
  }

  private handleDGunClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.mode.exitDGunMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = this.config.mode.buildFireDGunCommand(
      commander, world.x, world.y, this.config.getTick(), world.z,
    );
    this.config.commandQueue.enqueue(cmd);
  }

  private handleRepairAreaClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.exitRepairAreaMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = buildRepairAreaCommand(
      commander,
      world.x,
      world.y,
      REPAIR_AREA_RADIUS,
      this.config.getTick(),
      e.shiftKey,
      world.z,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('repair');
    if (!e.shiftKey) this.config.exitRepairAreaMode();
  }

  private handleAttackAreaClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitAttackAreaMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = buildAttackAreaCommand(
      selectedUnits,
      world.x,
      world.y,
      ATTACK_AREA_RADIUS,
      this.config.getTick(),
      e.shiftKey,
      world.z,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('attack');
    if (!e.shiftKey) this.config.exitAttackAreaMode();
  }

  private handleAttackGroundClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitAttackGroundMode();
      return;
    }
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = buildAttackGroundCommand(
      selectedUnits,
      world.x,
      world.y,
      this.config.getTick(),
      e.shiftKey,
      world.z,
    );
    if (!cmd) return;
    this.config.commandQueue.enqueue(cmd);
    this.config.applyCursor('attack');
    if (!e.shiftKey) this.config.exitAttackGroundMode();
  }

  private handlePingClick(e: MouseEvent): void {
    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    this.config.commandQueue.enqueue({
      type: 'ping',
      tick: this.config.getTick(),
      targetX: world.x,
      targetY: world.y,
      targetZ: world.z,
    });
    this.config.applyCursor('ping');
    if (!e.shiftKey) this.config.exitPingMode();
  }

  private handleGuardClick(e: MouseEvent): void {
    const selectedUnits = this.config.getEntitySource().getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.config.exitGuardMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;

    const meshGuardCmd = buildGuardCommandForTarget(
      entityHit,
      selectedUnits,
      this.config.getActivePlayerId(),
      tick,
      e.shiftKey,
    );
    if (meshGuardCmd) {
      this.config.commandQueue.enqueue(meshGuardCmd);
      this.config.applyCursor('guard');
      if (!e.shiftKey) this.config.exitGuardMode();
      return;
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const guardCmd = buildGuardCommandAt(
      this.config.getEntitySource(),
      world.x,
      world.y,
      selectedUnits,
      this.config.getActivePlayerId(),
      tick,
      e.shiftKey,
    );
    if (!guardCmd) return;
    this.config.commandQueue.enqueue(guardCmd);
    this.config.applyCursor('guard');
    if (!e.shiftKey) this.config.exitGuardMode();
  }

  private handleReclaimClick(e: MouseEvent): void {
    const commander = this.config.getSelectedCommander();
    if (!commander) {
      this.config.exitReclaimMode();
      return;
    }
    const tick = this.config.getTick();
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.config.getEntitySource().getEntity(entityHitId)
      : null;

    const meshReclaimCmd = buildReclaimCommandForTarget(
      entityHit,
      commander,
      tick,
      e.shiftKey,
    );
    if (meshReclaimCmd) {
      this.config.commandQueue.enqueue(meshReclaimCmd);
      this.config.applyCursor('reclaim');
      if (!e.shiftKey) this.config.exitReclaimMode();
      return;
    }

    const world = this.config.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const reclaimCmd = buildReclaimCommandAt(
      this.config.getEntitySource(),
      world.x,
      world.y,
      commander,
      tick,
      e.shiftKey,
    );
    if (!reclaimCmd) return;
    this.config.commandQueue.enqueue(reclaimCmd);
    this.config.applyCursor('reclaim');
    if (!e.shiftKey) this.config.exitReclaimMode();
  }

  private handleTowerTargetClick(e: MouseEvent): void {
    const entityHitId = this.config.picker.raycastEntity(e.clientX, e.clientY);
    if (entityHitId === null) return;
    this.config.selectedCommands.setTowerTarget(entityHitId);
    if (!e.shiftKey) this.config.exitTowerTargetMode();
  }
}
