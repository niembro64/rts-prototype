import { getCameraSmoothMode } from '@/clientBarConfig';
import {
  LOBBY_PREVIEW_SPIN_RATE,
  ZOOM_INITIAL_DEMO,
  ZOOM_INITIAL_GAME,
  ZOOM_INITIAL_LOBBY_PREVIEW,
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
    private readonly backgroundMode: boolean,
    private readonly lobbyPreview: boolean,
  ) {}

  seedInitialCamera(): void {
    const initialZoom = this.lobbyPreview
      ? ZOOM_INITIAL_LOBBY_PREVIEW
      : this.backgroundMode ? ZOOM_INITIAL_DEMO : ZOOM_INITIAL_GAME;
    const framesLocalCommander = !this.backgroundMode && !this.lobbyPreview;
    const seatIndex = framesLocalCommander
      ? Math.max(0, this.playerIds.indexOf(this.getLocalPlayerId()))
      : 0;
    const initialTarget = framesLocalCommander
      ? getSpawnPositionForSeat(
          seatIndex,
          Math.max(1, this.playerIds.length),
          this.mapWidth,
          this.mapHeight,
        )
      : { x: this.mapWidth / 2, y: this.mapHeight / 2 };

    this.threeApp.orbit.setState({
      targetX: initialTarget.x,
      targetY: 0,
      targetZ: initialTarget.y,
      distance: this.baseDistance / initialZoom,
      yaw: this.povYawForLocalSeat(),
      pitch: this.threeApp.orbit.pitch,
    });
    this.threeApp.orbit.setSmoothTau(this.cameraSmoothTauSec());
  }

  tickCameraSmoothing(deltaSec: number): void {
    this.threeApp.orbit.setSmoothTau(this.cameraSmoothTauSec());
    this.threeApp.orbit.tick(deltaSec);
    if (this.lobbyPreview) {
      this.threeApp.orbit.setOrbitAngles(
        this.threeApp.orbit.yaw + LOBBY_PREVIEW_SPIN_RATE * deltaSec,
        this.threeApp.orbit.pitch,
      );
    }
  }

  centerAfterFirstSnapshot(units: readonly Entity[]): void {
    if (this.hasCenteredCamera) return;
    if (this.backgroundMode || this.lobbyPreview) {
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
    this.threeApp.orbit.setTarget(cx, 0, cz);

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
    this.threeApp.orbit.setTarget(this.mapWidth / 2, 0, this.mapHeight / 2);
    this.hasCenteredCamera = true;
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
    const seatIndex = this.lobbyPreview
      ? 0
      : Math.max(0, this.playerIds.indexOf(this.getLocalPlayerId()));
    const angle = getPlayerBaseAngle(seatIndex, playerCount);
    const forwardSimX = -Math.cos(angle);
    const forwardSimY = -Math.sin(angle);
    return Math.atan2(-forwardSimX, forwardSimY);
  }
}
