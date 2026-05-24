import { getCameraSmoothMode } from '@/clientBarConfig';
import {
  CAMERA_BATTLE_DEFAULTS,
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
    private readonly getSurfaceY: (x: number, z: number) => number,
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
    this.threeApp.orbit.tick(deltaSec);
    if (defaults.autoRotate && defaults.autoRotateRate !== 0) {
      this.threeApp.orbit.setOrbitAngles(
        this.threeApp.orbit.yaw + defaults.autoRotateRate * deltaSec,
        this.threeApp.orbit.pitch,
      );
    }
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
    const commander = units.find(
      (entity) => isCommander(entity) && entity.ownership?.playerId === localPlayerId,
    );
    if (!commander) return;

    const cx = commander.transform.x;
    const cz = commander.transform.y;
    this.threeApp.orbit.setTarget(cx, this.getSurfaceY(cx, cz), cz);

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
      y: this.getSurfaceY(spawn.x, spawn.y),
      z: spawn.y,
    };
  }

  private mapOriginTarget(focus: MapOriginCameraFocus): CameraTarget {
    const x = this.mapWidth / 2;
    const z = this.mapHeight / 2;
    return {
      x,
      y: focus === 'map-origin-use-map-height' ? this.getSurfaceY(x, z) : 0,
      z,
    };
  }

  private cameraSmoothTauSec(): number {
    switch (getCameraSmoothMode()) {
      case 'fast': return 0.05;
      case 'mid': return 0.12;
      case 'slow': return 0.4;
      case 'snap':
      default: return 0;
    }
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
