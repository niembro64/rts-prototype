import type * as THREE from 'three';
import type { AirborneEmitterUpdate3D } from './Locomotion3D';
import type { AirborneEmitterBatch3D } from './AirborneEmitterBatch3D';

export class AirborneEmitterUpdateScratch3D {
  private readonly update: AirborneEmitterUpdate3D;

  constructor(batch: AirborneEmitterBatch3D) {
    this.update = {
      batch,
      pose: {
        parentX: 0,
        parentY: 0,
        parentZ: 0,
        parentQX: 0,
        parentQY: 0,
        parentQZ: 0,
        parentQW: 1,
      },
    };
  }

  prepare(
    parentX: number,
    parentY: number,
    parentZ: number,
    parentQuat: THREE.Quaternion,
  ): AirborneEmitterUpdate3D {
    const update = this.update;
    const pose = update.pose;
    pose.parentX = parentX;
    pose.parentY = parentY;
    pose.parentZ = parentZ;
    pose.parentQX = parentQuat.x;
    pose.parentQY = parentQuat.y;
    pose.parentQZ = parentQuat.z;
    pose.parentQW = parentQuat.w;
    return update;
  }
}
