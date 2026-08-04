import { getCameraFollowMode, getCameraSmoothMode } from '@/clientBarConfig';
import {
  CAMERA_BATTLE_DEFAULTS,
  CAMERA_BAR_SPRING_HALF_LIFE_SECONDS,
  CAMERA_SMOOTH_TAU_SECONDS,
  CAMERA_TRANSITION_MODE,
  type CameraBattleKind,
  type CameraBattleFocus,
} from '../../../config';
import type { ThreeApp } from '../../render3d/ThreeApp';
import { isCommander } from '../../sim/combat/combatUtils';
import { getSeatBaseAngle, getSpawnPositionForSeat } from '../../sim/spawn';
import type { TeamRoster } from '../../sim/teamRoster';
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
    /** Same assignment the host used, rebuilt from the same inputs, so the
     *  camera pre-frames on the commander the host will actually spawn. */
    private readonly getTeamRoster: () => TeamRoster,
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
    this.threeApp.orbit.setTransitionSeconds(this.cameraTransitionSeconds());
  }

  tickCameraSmoothing(deltaSec: number): void {
    const defaults = CAMERA_BATTLE_DEFAULTS[this.cameraBattleKind];
    this.threeApp.orbit.setTransitionSeconds(this.cameraTransitionSeconds());
    // Push follow into controller state before the transition tick so it
    // shares the same EMA as pan, orbit, and zoom.
    this.applyCameraFollow();
    if (defaults.autoRotate && defaults.autoRotateRate !== 0) {
      this.threeApp.orbit.rotateYawBy(defaults.autoRotateRate * deltaSec);
    }
    this.threeApp.orbit.tick(deltaSec);
  }

  /** Drive the orbit camera's smooth destination from the CLIENT-bar
   *  camera-follow mode. Only acts while exactly one unit is selected;
   *  otherwise (or in 'free') it cancels only a yaw destination previously
   *  owned by follow-behind, leaving manual yaw EMA input untouched. */
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
      this.getTeamRoster(),
      this.getLocalPlayerId(),
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

  private cameraTransitionSeconds(): number {
    const mode = getCameraSmoothMode();
    return CAMERA_TRANSITION_MODE === 'bar-spring-dampened'
      ? CAMERA_BAR_SPRING_HALF_LIFE_SECONDS[mode]
      : CAMERA_SMOOTH_TAU_SECONDS[mode];
  }

  private povYawForLocalSeat(): number {
    const roster = this.getTeamRoster();
    const seatPlayerId =
      this.isMapOriginFocus(CAMERA_BATTLE_DEFAULTS[this.cameraBattleKind].focus)
        ? roster.playerIds[0] ?? this.getLocalPlayerId()
        : this.getLocalPlayerId();
    const angle = getSeatBaseAngle(roster, seatPlayerId);
    const forwardSimX = -Math.cos(angle);
    const forwardSimY = -Math.sin(angle);
    return Math.atan2(-forwardSimX, forwardSimY);
  }

  private isMapOriginFocus(focus: CameraBattleFocus): focus is MapOriginCameraFocus {
    return focus === 'map-origin-use-map-height'
      || focus === 'map-origin-map-height-agnostic';
  }
}
