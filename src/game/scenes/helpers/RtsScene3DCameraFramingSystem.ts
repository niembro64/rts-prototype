import { getCameraFollowMode, getCameraSmoothMode } from '@/clientBarConfig';
import {
  CAMERA_BATTLE_DEFAULTS,
  CAMERA_SMOOTH_TAU_SECONDS,
  type CameraBattleKind,
  type CameraBattleFocus,
} from '../../../config';
import type { ThreeApp } from '../../render3d/ThreeApp';
import { isCommander } from '../../sim/combat/combatUtils';
import { getPlayerBaseAngle, getSpawnPositionForSeat } from '../../sim/spawn';
import type { Entity, PlayerId } from '../../sim/types';

type CameraTarget = {
  x: number;
  y: number;
  z: number;
};
type MapOriginCameraFocus = Extract<
  CameraBattleFocus,
  'map-origin-use-map-height' | 'map-origin-map-height-agnostic'
>;

export class RtsScene3DCameraFramingSystem {
  private hasCenteredCamera = false;

  constructor(
    private readonly threeApp: ThreeApp,
    private readonly baseDistance: number,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
    private readonly playerIds: readonly PlayerId[],
    private readonly getLocalPlayerId: () => PlayerId,
    private readonly cameraBattleKind: CameraBattleKind,
    private readonly getTerrainY: (x: number, z: number) => number,
    private readonly getSelectedUnits: () => readonly Entity[],
  ) {}

  seedInitialCamera(): void {
    const defaults = CAMERA_BATTLE_DEFAULTS[this.cameraBattleKind];
    const initialTarget = this.initialTarget(defaults.focus);

    this.threeApp.orbit.setState({
      targetX: initialTarget.x,
      targetY: initialTarget.y,
      targetZ: initialTarget.z,
      distance: this.baseDistance / defaults.zoom,
      yaw: this.povYawForLocalSeat(),
      pitch: this.threeApp.orbit.pitch,
    });
    this.threeApp.orbit.setSmoothTau(this.cameraSmoothTauSec());
  }

  tickCameraSmoothing(deltaSec: number): void {
    const defaults = CAMERA_BATTLE_DEFAULTS[this.cameraBattleKind];
    this.threeApp.orbit.setSmoothTau(this.cameraSmoothTauSec());
    // Push the follow destination into the orbit to-state BEFORE the EMA
    // step, so following rides the same camera-smooth half-life as
    // pan/zoom and mode switches transition smoothly (see followStep).
    this.applyCameraFollow();
    this.threeApp.orbit.tick(deltaSec);
    if (defaults.autoRotate && defaults.autoRotateRate !== 0) {
      this.threeApp.orbit.rotateYawBy(defaults.autoRotateRate * deltaSec);
    }
  }

  /** Drive the orbit camera's smooth destination from the CLIENT-bar
   *  camera-follow mode. Only acts while exactly one unit is selected;
   *  otherwise (or in 'free') it just pins the eased-yaw destination to
   *  the current yaw so a just-ended follow-behind ease stops cleanly
   *  and manual control stays inert. */
  private applyCameraFollow(): void {
    const orbit = this.threeApp.orbit;
    const mode = getCameraFollowMode();
    if (mode === 'free') {
      orbit.syncToYaw();
      return;
    }
    const units = this.getSelectedUnits();
    if (units.length !== 1) {
      orbit.syncToYaw();
      return;
    }
    const t = units[0].transform;
    // Target the unit's body center. sim (x, y, z) → world (x, z, y):
    // sim x/y are the horizontal plane, sim z is up. Distance and pitch
    // are left untouched by followStep, so the camera keeps its standoff.
    const behindYaw = mode === 'follow-behind'
      ? this.behindYaw(t.rotation)
      : null;
    orbit.followStep(t.x, t.z, t.y, behindYaw);
  }

  /** Orbit yaw that parks the camera directly behind a unit, looking
   *  down its forward axis. A unit's forward in world (X, Z) is
   *  (cos rot, sin rot) — the sim banking kernel's v_forward basis —
   *  and the orbit eye's ground offset from target is (sin yaw, -cos yaw).
   *  Placing the eye on the opposite side of the unit solves to this. */
  private behindYaw(rotation: number): number {
    return Math.atan2(-Math.cos(rotation), Math.sin(rotation));
  }

  centerAfterFirstSnapshot(units: readonly Entity[]): void {
    if (this.hasCenteredCamera) return;
    const defaults = CAMERA_BATTLE_DEFAULTS[this.cameraBattleKind];
    if (this.isMapOriginFocus(defaults.focus)) {
      this.centerCameraOnMapOrigin(defaults.focus);
    } else {
      this.centerCameraOnCommander(units);
    }
  }

  private centerCameraOnCommander(units: readonly Entity[]): void {
    const localPlayerId = this.getLocalPlayerId();
    let commander: Entity | undefined;
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (!isCommander(entity) || entity.ownership?.playerId !== localPlayerId) continue;
      commander = entity;
      break;
    }
    if (!commander) return;

    const cx = commander.transform.x;
    const cz = commander.transform.y;
    this.threeApp.orbit.setTarget(cx, this.getTerrainY(cx, cz), cz);

    const forwardX = this.mapWidth / 2 - cx;
    const forwardZ = this.mapHeight / 2 - cz;
    if (forwardX * forwardX + forwardZ * forwardZ > 1) {
      this.threeApp.orbit.setOrbitAngles(
        Math.atan2(-forwardX, forwardZ),
        this.threeApp.orbit.pitch,
      );
    }
    this.hasCenteredCamera = true;
  }

  private centerCameraOnMapOrigin(focus: MapOriginCameraFocus): void {
    const target = this.mapOriginTarget(focus);
    this.threeApp.orbit.setTarget(target.x, target.y, target.z);
    this.hasCenteredCamera = true;
  }

  private initialTarget(focus: CameraBattleFocus): CameraTarget {
    if (this.isMapOriginFocus(focus)) {
      return this.mapOriginTarget(focus);
    }

    const spawn = getSpawnPositionForSeat(
      this.localSeatIndex(),
      Math.max(1, this.playerIds.length),
      this.mapWidth,
      this.mapHeight,
    );
    return {
      x: spawn.x,
      y: this.getTerrainY(spawn.x, spawn.y),
      z: spawn.y,
    };
  }

  private mapOriginTarget(focus: MapOriginCameraFocus): CameraTarget {
    const x = this.mapWidth / 2;
    const z = this.mapHeight / 2;
    return {
      x,
      y: focus === 'map-origin-use-map-height' ? this.getTerrainY(x, z) : 0,
      z,
    };
  }

  private cameraSmoothTauSec(): number {
    return CAMERA_SMOOTH_TAU_SECONDS[getCameraSmoothMode()];
  }

  private povYawForLocalSeat(): number {
    const playerCount = Math.max(1, this.playerIds.length);
    const seatIndex = this.isMapOriginFocus(CAMERA_BATTLE_DEFAULTS[this.cameraBattleKind].focus)
      ? 0
      : this.localSeatIndex();
    const angle = getPlayerBaseAngle(seatIndex, playerCount);
    const forwardSimX = -Math.cos(angle);
    const forwardSimY = -Math.sin(angle);
    return Math.atan2(-forwardSimX, forwardSimY);
  }

  private localSeatIndex(): number {
    return Math.max(0, this.playerIds.indexOf(this.getLocalPlayerId()));
  }

  private isMapOriginFocus(focus: CameraBattleFocus): focus is MapOriginCameraFocus {
    return focus === 'map-origin-use-map-height'
      || focus === 'map-origin-map-height-agnostic';
  }
}
