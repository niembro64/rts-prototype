import type { SceneCameraState } from '@/types/game';
import type { OrbitCamera } from '../../render3d/OrbitCamera';
import type { ThreeApp } from '../../render3d/ThreeApp';

// Mini "camera" accessor read by GameCanvas.vue for the zoom display.
// Derives a scalar zoom number from the 3D orbit distance so UI sliders
// have a consistent axis to read.
//
// Two zoom-shaped values:
//
//   `zoom`     - Display ratio (`baseDistance / orbit.distance`). Higher = more
//                zoomed in. Used for save/restore camera state, UI/legacy
//                camera reads, and any code path that needs a multiplicative
//                scalar relative to the default framing.
//
//   `altitude` - Camera world Y, i.e. distance from the y=0 ground plane along
//                its normal. Smaller = closer to surface, larger = farther up.
export type CameraShim = {
  main: {
    zoom: number;
    altitude: number;
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
      altitude: 0,
      scrollX: 0,
      scrollY: 0,
      width: 0,
      height: 0,
    },
  };

  constructor(
    private readonly threeApp: ThreeApp,
    private readonly baseDistance: number,
  ) {
    Object.defineProperties(this.cameras.main, {
      zoom: {
        get: () => this.baseDistance / this.threeApp.orbit.distance,
      },
      altitude: {
        get: () => this.threeApp.camera.position.y,
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
    this.threeApp.orbit.setTarget(x, 0, y);
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
}
