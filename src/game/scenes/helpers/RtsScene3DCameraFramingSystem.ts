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
      targetY: this.getSurfaceY(initialTarget.x, initialTarget.y),
      targetZ: initialTarget.y,
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
    if (defaults.focus === 'map-center') {
      this.centerCameraOnMap();
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

  private centerCameraOnMap(): void {
    const cx = this.mapWidth / 2;
    const cz = this.mapHeight / 2;
    this.threeApp.orbit.setTarget(cx, this.getSurfaceY(cx, cz), cz);
    this.hasCenteredCamera = true;
  }

  private initialTarget(focus: CameraBattleFocus): { x: number; y: number } {
    if (focus === 'map-center') {
      return { x: this.mapWidth / 2, y: this.mapHeight / 2 };
    }

    return getSpawnPositionForSeat(
      this.localSeatIndex(),
      Math.max(1, this.playerIds.length),
      this.mapWidth,
      this.mapHeight,
    );
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
    const seatIndex = CAMERA_BATTLE_DEFAULTS[this.cameraBattleKind].focus === 'map-center'
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
}
