// CommanderModeController — state machine for build mode and the
// commander-only D-gun mode, plus the command builders each one needs.
// No DOM events, no graphics: Input3DManager owns one of these and its
// input-specific code (hotkeys, ghost visuals, click dispatch) calls
// through it.
//
// Mutual exclusion: entering one mode automatically exits the other.
// Callers only check preconditions they care about (usually "is a
// builder selected" for build or "is a commander selected" for D-gun)
// before calling `enter*`.

import type { Entity, BuildingBlueprintId, StructureBlueprintId } from '../../sim/types';
import type { StartBuildCommand, FireDGunCommand } from '../../sim/commands';
import { getAllStructures } from '../../sim/buildConfigs';
import { getBuildMenuStructureBlueprintIdBySlotIndex } from '../buildMenuLayout';
import { getSnappedBuildPosition } from './BuildPlacementValidator';

const ALL_STRUCTURE_CONFIGS = getAllStructures();
const BUILD_MODE_BUILDING_BLUEPRINT_IDS = new Array<BuildingBlueprintId>(ALL_STRUCTURE_CONFIGS.length);
for (let i = 0; i < ALL_STRUCTURE_CONFIGS.length; i++) {
  BUILD_MODE_BUILDING_BLUEPRINT_IDS[i] = ALL_STRUCTURE_CONFIGS[i].buildingBlueprintId;
}
const DEFAULT_BUILDING_BLUEPRINT_ID: BuildingBlueprintId = BUILD_MODE_BUILDING_BLUEPRINT_IDS[0] ?? 'buildingSolar';

export function getBuildModeBuildingBlueprintIds(): readonly BuildingBlueprintId[] {
  return BUILD_MODE_BUILDING_BLUEPRINT_IDS;
}

export function getDefaultBuildModeBuildingBlueprintId(): BuildingBlueprintId {
  return DEFAULT_BUILDING_BLUEPRINT_ID;
}

export function getBuildModeBuildingBlueprintIdByIndex(
  index: number,
  allowedBuildBlueprintIds?: readonly StructureBlueprintId[],
): BuildingBlueprintId | null {
  const ids = allowedBuildBlueprintIds !== undefined
    ? allowedBuildBlueprintIds
    : BUILD_MODE_BUILDING_BLUEPRINT_IDS;
  return getBuildMenuStructureBlueprintIdBySlotIndex(index, ids);
}

export class CommanderModeController {
  private _buildBuildingBlueprintId: BuildingBlueprintId | null = null;
  private _isDGun = false;

  /** Fired when the build mode enters / exits / changes building
   *  blueprint id. Receives the new building blueprint id or null. */
  public onBuildModeChange?: (buildingBlueprintId: BuildingBlueprintId | null) => void;
  /** Fired when D-gun mode toggles. */
  public onDGunModeChange?: (active: boolean) => void;

  get isInBuildMode(): boolean { return this._buildBuildingBlueprintId !== null; }
  get isInDGunMode(): boolean { return this._isDGun; }
  get buildingBlueprintId(): BuildingBlueprintId | null { return this._buildBuildingBlueprintId; }

  enterBuildMode(buildingBlueprintId: BuildingBlueprintId): void {
    if (this._isDGun) {
      this._isDGun = false;
      this.onDGunModeChange?.(false);
    }
    if (this._buildBuildingBlueprintId === buildingBlueprintId) return;
    this._buildBuildingBlueprintId = buildingBlueprintId;
    this.onBuildModeChange?.(buildingBlueprintId);
  }

  exitBuildMode(): void {
    if (this._buildBuildingBlueprintId === null) return;
    this._buildBuildingBlueprintId = null;
    this.onBuildModeChange?.(null);
  }

  enterDGunMode(): void {
    if (this._buildBuildingBlueprintId !== null) {
      this._buildBuildingBlueprintId = null;
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

  /** Cycle through the defined building blueprint ids. No-op if not
   *  already in build mode (wouldn't know what to cycle from). */
  cycleBuildingBlueprintId(): void {
    if (this._buildBuildingBlueprintId === null) return;
    if (BUILD_MODE_BUILDING_BLUEPRINT_IDS.length === 0) return;
    const idx = (BUILD_MODE_BUILDING_BLUEPRINT_IDS.indexOf(this._buildBuildingBlueprintId) + 1) %
      BUILD_MODE_BUILDING_BLUEPRINT_IDS.length;
    const next = BUILD_MODE_BUILDING_BLUEPRINT_IDS[idx];
    if (next === this._buildBuildingBlueprintId) return;
    this._buildBuildingBlueprintId = next;
    this.onBuildModeChange?.(next);
  }

  /** Build a startBuild command for the current build mode's
   *  building blueprint at the grid-snapped position. Returns null if
   *  no building blueprint is active. */
  buildStartBuildCommand(
    builder: Entity,
    worldX: number,
    worldY: number,
    tick: number,
    queue: boolean,
    queueFront = false,
    queueInsertIndex?: number,
    rotation = 0,
  ): StartBuildCommand | null {
    if (this._buildBuildingBlueprintId === null) return null;
    const snapped = getSnappedBuildPosition(worldX, worldY, this._buildBuildingBlueprintId, rotation);
    return {
      type: 'startBuild',
      tick,
      builderId: builder.id,
      buildingBlueprintId: this._buildBuildingBlueprintId,
      gridX: snapped.gridX,
      gridY: snapped.gridY,
      rotation,
      queue,
      queueFront,
      queueInsertIndex,
    };
  }

  /** Build a fireDGun command targeting a world-space point.
   *  `worldZ` is the click altitude on the rendered 3D ground (from
   *  CursorGround.pickSim) — passed through so the d-gun handler
   *  can lay the projectile target at the actual clicked altitude
   *  instead of re-deriving it from a y=0 plane projection. Unlike
   *  startBuild there's no precondition on mode state — callers are
   *  expected to only call this when isInDGunMode is true, but the
   *  command itself is always well-formed. */
  buildFireDGunCommand(
    commander: Entity,
    worldX: number,
    worldY: number,
    tick: number,
    worldZ?: number,
  ): FireDGunCommand {
    return {
      type: 'fireDGun',
      tick,
      commanderId: commander.id,
      targetX: worldX,
      targetY: worldY,
      targetZ: worldZ,
    };
  }
}
