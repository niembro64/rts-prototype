// CommanderModeController — shared state machine for the two
// commander-driven modes (build + D-gun), plus the command
// builders each one needs. Renderer-agnostic: no Phaser keys, no
// DOM events, no graphics. Both the 2D BuildingPlacementController
// and the 3D Input3DManager own one of these; their renderer-
// specific code (hotkeys, ghost visuals, click dispatch) calls
// through it so the behavior stays in lock-step.
//
// Mutual exclusion: entering one mode automatically exits the
// other. Callers only check preconditions they care about
// (usually "is a commander selected") before calling `enter*`.

import type { Entity, BuildingType } from '../../sim/types';
import type { StartBuildCommand, FireDGunCommand } from '../../sim/commands';
import { getSnappedBuildPosition } from './InputRenderHelper';

const BUILDING_TYPES: readonly BuildingType[] = ['solar', 'factory'];

export class CommanderModeController {
  private _buildType: BuildingType | null = null;
  private _isDGun = false;

  /** Fired when the build mode enters / exits / changes building
   *  type. Receives the new building type or null. */
  public onBuildModeChange?: (type: BuildingType | null) => void;
  /** Fired when D-gun mode toggles. */
  public onDGunModeChange?: (active: boolean) => void;

  get isInBuildMode(): boolean { return this._buildType !== null; }
  get isInDGunMode(): boolean { return this._isDGun; }
  get buildingType(): BuildingType | null { return this._buildType; }

  enterBuildMode(type: BuildingType): void {
    if (this._isDGun) {
      this._isDGun = false;
      this.onDGunModeChange?.(false);
    }
    if (this._buildType === type) return;
    this._buildType = type;
    this.onBuildModeChange?.(type);
  }

  exitBuildMode(): void {
    if (this._buildType === null) return;
    this._buildType = null;
    this.onBuildModeChange?.(null);
  }

  enterDGunMode(): void {
    if (this._buildType !== null) {
      this._buildType = null;
      this.onBuildModeChange?.(null);
    }
    if (this._isDGun) return;
    this._isDGun = true;
    this.onDGunModeChange?.(true);
  }

  exitDGunMode(): void {
    if (!this._isDGun) return;
    this._isDGun = false;
    this.onDGunModeChange?.(false);
  }

  /** Toggle D-gun mode. Callers typically gate this on "has a
   *  commander selected" since D-gun is a commander ability. */
  toggleDGunMode(): void {
    if (this._isDGun) this.exitDGunMode();
    else this.enterDGunMode();
  }

  /** Cycle through the defined building types. No-op if not
   *  already in build mode (wouldn't know what to cycle from). */
  cycleBuildingType(): void {
    if (this._buildType === null) return;
    const idx = (BUILDING_TYPES.indexOf(this._buildType) + 1) % BUILDING_TYPES.length;
    const next = BUILDING_TYPES[idx];
    if (next === this._buildType) return;
    this._buildType = next;
    this.onBuildModeChange?.(next);
  }

  /** Build a startBuild command for the current build mode's
   *  building type at the grid-snapped position. Returns null if
   *  no building type is active. */
  buildStartBuildCommand(
    commander: Entity,
    worldX: number,
    worldY: number,
    tick: number,
    queue: boolean,
  ): StartBuildCommand | null {
    if (this._buildType === null) return null;
    const snapped = getSnappedBuildPosition(worldX, worldY, this._buildType);
    return {
      type: 'startBuild',
      tick,
      builderId: commander.id,
      buildingType: this._buildType,
      gridX: snapped.gridX,
      gridY: snapped.gridY,
      queue,
    };
  }

  /** Build a fireDGun command targeting a world-space point.
   *  Unlike startBuild there's no precondition on mode state —
   *  callers are expected to only call this when isInDGunMode is
   *  true, but the command itself is always well-formed. */
  buildFireDGunCommand(
    commander: Entity,
    worldX: number,
    worldY: number,
    tick: number,
  ): FireDGunCommand {
    return {
      type: 'fireDGun',
      tick,
      commanderId: commander.id,
      targetX: worldX,
      targetY: worldY,
    };
  }
}
