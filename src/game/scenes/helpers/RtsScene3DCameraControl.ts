import type { SceneCameraState } from '@/types/game';
import type { CameraViewMode } from '@/types/client';
import { CAMERA_INITIAL_PITCH_RADIANS } from '../../../config';
import type { OrbitCamera } from '../../render3d/OrbitCamera';
import type { ThreeApp } from '../../render3d/ThreeApp';

const CAMERA_VIEW_MODE_PITCH: Record<CameraViewMode, number> = {
  overhead: Math.PI * 0.06,
  ta: Math.PI * 0.25,
  spring: CAMERA_INITIAL_PITCH_RADIANS,
};
const CAMERA_VIEW_MODE_CYCLE: readonly CameraViewMode[] = ['overhead', 'ta', 'spring'];
const VIEW_RADIUS_STEP_FACTOR = 1.125;

// Mini "camera" accessor read by GameCanvas.vue for the zoom display.
// Derives camera metrics from the 3D orbit camera so UI/legacy reads
// have a consistent axis to read.
//
// Two zoom-shaped values:
//
//   `zoom`     - Display ratio (`baseDistance / orbit.distance`). Higher = more
//                zoomed in. Used for save/restore camera state, UI/legacy
//                camera reads, and any code path that needs a multiplicative
//                scalar relative to the default framing.
//
//   `mapCenterDistance` - Rendered camera-eye distance from the map center
//                         origin point. This is what the CLIENT bar displays
//                         as ZOOM.
export type CameraShim = {
  main: {
    zoom: number;
    mapCenterDistance: number;
    scrollX: number;
    scrollY: number;
    width: number;
    height: number;
  };
};

export class RtsScene3DCameraControl {
  public readonly cameras: CameraShim = {
    main: {
      zoom: 0,
      mapCenterDistance: 0,
      scrollX: 0,
      scrollY: 0,
      width: 0,
      height: 0,
    },
  };

  constructor(
    private readonly threeApp: ThreeApp,
    private readonly baseDistance: number,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {
    Object.defineProperties(this.cameras.main, {
      zoom: {
        get: () => this.baseDistance / this.threeApp.orbit.distance,
      },
      mapCenterDistance: {
        get: () => {
          const camera = this.threeApp.camera.position;
          return Math.hypot(
            camera.x - this.mapWidth / 2,
            camera.y,
            camera.z - this.mapHeight / 2,
          );
        },
      },
      scrollX: {
        get: () => this.threeApp.orbit.target.x - this.visibleHalfWidth(),
      },
      scrollY: {
        get: () => this.threeApp.orbit.target.z - this.visibleHalfHeight(),
      },
      width: { get: () => this.threeApp.renderer.domElement.clientWidth },
      height: { get: () => this.threeApp.renderer.domElement.clientHeight },
    });
  }

  getOrbitCamera(): OrbitCamera {
    return this.threeApp.orbit;
  }

  centerOn(x: number, y: number): void {
    // Altitude-preserving jump: keep the current focus height rather than
    // hard-coding y=0, which parked the focus inside mountains and below
    // basins. The orbit camera's focus floor/ceiling then resolves any
    // terrain the destination happens to have.
    this.threeApp.orbit.setTarget(x, this.threeApp.orbit.target.y, y);
  }

  flipYaw(): void {
    const orbit = this.threeApp.orbit;
    orbit.setOrbitAngles(orbit.yaw + Math.PI, orbit.pitch);
  }

  showMapOverview(mapWidth: number, mapHeight: number, targetY = 0): void {
    const orbit = this.threeApp.orbit;
    const camera = this.threeApp.camera;
    const aspect = Math.max(camera.aspect, 0.1);
    const halfFovTan = Math.tan((camera.fov * Math.PI) / 360);
    const fitHeight = mapHeight / (2 * halfFovTan);
    const fitWidth = mapWidth / (2 * halfFovTan * aspect);
    orbit.setState({
      targetX: mapWidth / 2,
      targetY,
      targetZ: mapHeight / 2,
      distance: Math.max(this.baseDistance, fitHeight, fitWidth) * 1.12,
      yaw: orbit.yaw,
      pitch: Math.PI * 0.04,
    });
  }

  setViewMode(mode: CameraViewMode): void {
    const orbit = this.threeApp.orbit;
    orbit.setState({
      targetX: orbit.target.x,
      targetY: orbit.target.y,
      targetZ: orbit.target.z,
      distance: orbit.distance,
      yaw: orbit.yaw,
      pitch: CAMERA_VIEW_MODE_PITCH[mode],
    });
  }

  toggleViewMode(): void {
    const currentMode = this.closestViewMode(this.threeApp.orbit.pitch);
    const currentIndex = CAMERA_VIEW_MODE_CYCLE.indexOf(currentMode);
    const nextMode = CAMERA_VIEW_MODE_CYCLE[(currentIndex + 1) % CAMERA_VIEW_MODE_CYCLE.length] ?? 'ta';
    this.setViewMode(nextMode);
  }

  changeViewRadius(direction: 1 | -1): void {
    const orbit = this.threeApp.orbit;
    const factor = direction > 0 ? VIEW_RADIUS_STEP_FACTOR : 1 / VIEW_RADIUS_STEP_FACTOR;
    orbit.setDistance(orbit.distance * factor);
  }

  captureState(): SceneCameraState {
    const orbit = this.threeApp.orbit;
    return {
      x: orbit.target.x,
      y: orbit.target.z,
      zoom: this.baseDistance / orbit.distance,
      targetZ: orbit.target.y,
      yaw: orbit.yaw,
      pitch: orbit.pitch,
    };
  }

  applyState(state: SceneCameraState): void {
    const orbit = this.threeApp.orbit;
    orbit.setState({
      targetX: state.x,
      targetY: state.targetZ ?? 0,
      targetZ: state.y,
      distance: this.baseDistance / Math.max(state.zoom, 0.001),
      yaw: state.yaw ?? orbit.yaw,
      pitch: state.pitch ?? orbit.pitch,
    });
  }

  private visibleHalfWidth(): number {
    const cam = this.threeApp.camera;
    const vFov = (cam.fov * Math.PI) / 180;
    const halfHeight = Math.tan(vFov / 2) * this.threeApp.orbit.distance;
    return halfHeight * cam.aspect;
  }

  private visibleHalfHeight(): number {
    const cam = this.threeApp.camera;
    const vFov = (cam.fov * Math.PI) / 180;
    return Math.tan(vFov / 2) * this.threeApp.orbit.distance;
  }

  private closestViewMode(pitch: number): CameraViewMode {
    let closestMode: CameraViewMode = CAMERA_VIEW_MODE_CYCLE[0] ?? 'ta';
    let closestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < CAMERA_VIEW_MODE_CYCLE.length; i++) {
      const mode = CAMERA_VIEW_MODE_CYCLE[i];
      const delta = Math.abs(CAMERA_VIEW_MODE_PITCH[mode] - pitch);
      if (delta < closestDelta) {
        closestMode = mode;
        closestDelta = delta;
      }
    }
    return closestMode;
  }
}
