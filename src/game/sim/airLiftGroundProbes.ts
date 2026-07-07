export const AIR_LIFT_FORWARD_GROUND_PROBE_COUNT = 4;
export const AIR_LIFT_BODY_GROUND_PROBE_COUNT = 3;
export const AIR_LIFT_DIRECT_GROUND_PROBE_COUNT = 1;
export const AIR_LIFT_TOTAL_GROUND_PROBE_COUNT =
  AIR_LIFT_DIRECT_GROUND_PROBE_COUNT +
  AIR_LIFT_FORWARD_GROUND_PROBE_COUNT +
  AIR_LIFT_BODY_GROUND_PROBE_COUNT;

export type AirLiftGroundProbeKind = 'direct' | 'forward' | 'left' | 'right' | 'rear';

export function getAirLiftGroundProbeSpacing(aheadDistance: number): number {
  return Number.isFinite(aheadDistance) && aheadDistance > 0
    ? aheadDistance / AIR_LIFT_FORWARD_GROUND_PROBE_COUNT
    : 0;
}

export function forEachAirLiftGroundProbePoint(
  bodyX: number,
  bodyY: number,
  forwardX: number,
  forwardY: number,
  aheadDistance: number,
  visit: (x: number, y: number, kind: AirLiftGroundProbeKind) => void,
): number {
  if (!Number.isFinite(bodyX) || !Number.isFinite(bodyY)) return 0;

  let count = 0;
  const emit = (x: number, y: number, kind: AirLiftGroundProbeKind): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    visit(x, y, kind);
    count++;
  };

  emit(bodyX, bodyY, 'direct');

  if (!Number.isFinite(forwardX) || !Number.isFinite(forwardY)) {
    return count;
  }

  const probeSpacing = getAirLiftGroundProbeSpacing(aheadDistance);
  if (probeSpacing > 0) {
    for (let step = 1; step <= AIR_LIFT_FORWARD_GROUND_PROBE_COUNT; step++) {
      emit(
        bodyX + forwardX * probeSpacing * step,
        bodyY + forwardY * probeSpacing * step,
        'forward',
      );
    }

    const leftX = -forwardY;
    const leftY = forwardX;
    emit(bodyX + leftX * probeSpacing, bodyY + leftY * probeSpacing, 'left');
    emit(bodyX - leftX * probeSpacing, bodyY - leftY * probeSpacing, 'right');
    emit(bodyX - forwardX * probeSpacing, bodyY - forwardY * probeSpacing, 'rear');
  }

  return count;
}
