import type { CameraViewBasis } from '@/types/ui';

export function cloneCameraViewBasis(source: CameraViewBasis): CameraViewBasis {
  return {
    right: { ...source.right },
    up: { ...source.up },
    towardCamera: { ...source.towardCamera },
  };
}

export function assignCameraViewBasis(
  target: CameraViewBasis,
  source: CameraViewBasis,
): void {
  target.right.x = source.right.x;
  target.right.y = source.right.y;
  target.right.z = source.right.z;
  target.up.x = source.up.x;
  target.up.y = source.up.y;
  target.up.z = source.up.z;
  target.towardCamera.x = source.towardCamera.x;
  target.towardCamera.y = source.towardCamera.y;
  target.towardCamera.z = source.towardCamera.z;
}
