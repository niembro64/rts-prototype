// wireFieldDecoders - shared readers for entity wire-row field groups.
//
// Several decode paths (the full row, the movement delta, the typed rows, and
// the entity factory that builds a fresh entity) all read the SAME fields at
// the SAME offsets out of an entity wire row. Those offsets are a hard
// contract with the encoder: one path reading base + 28 where another reads
// base + 27 is a silent, hard-to-see corruption, so each field group is read
// in exactly one place here rather than restated at every call site.

import { dequantizeRotation as deqRot } from './snapshotQuantization';
import { NO_ENTITY_ID } from '../sim/types';
import type { BuilderWorkStationRuntime } from '../sim/types';

/** A decode target that carries an optional body orientation quaternion. */
type OrientationTarget = {
  orientation: { x: number; y: number; z: number; w: number } | null;
};

/** Read the body orientation quaternion (present flag at base + 27, xyzw at
 *  base + 28..31). Reuses the target's existing quaternion object when there
 *  is one so a steady-state entity does not allocate per snapshot. */
export function readWireOrientationInto(
  target: OrientationTarget,
  values: Float64Array | number[],
  base: number,
): void {
  if (values[base + 27] !== 0) {
    let orientation = target.orientation;
    if (orientation === null) {
      orientation = { x: 0, y: 0, z: 0, w: 1 };
      target.orientation = orientation;
    }
    orientation.x = values[base + 28];
    orientation.y = values[base + 29];
    orientation.z = values[base + 30];
    orientation.w = values[base + 31];
  } else {
    target.orientation = null;
  }
}

/** Read the builder work-station pose block (base + 69..76). The caller is
 *  responsible for the presence gate at base + 68. */
export function readWireWorkStationInto(
  station: BuilderWorkStationRuntime,
  values: Float64Array | number[],
  base: number,
): void {
  station.localYaw = deqRot(values[base + 69]);
  station.localPitch = deqRot(values[base + 70]);
  station.localYawVelocity = deqRot(values[base + 71]);
  station.localPitchVelocity = deqRot(values[base + 72]);
  station.targetEntityId = values[base + 73] !== 0 ? 0 : NO_ENTITY_ID;
  station.aligned = values[base + 74] !== 0;
  station.targetWorldYaw = deqRot(values[base + 75]);
  station.targetWorldPitch = deqRot(values[base + 76]);
}
