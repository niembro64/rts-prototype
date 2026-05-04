// Math utilities - re-exports

export {
  distanceSquared,
  distance,
  distanceSquared3,
  distance3,
  magnitudeSquared,
  magnitude,
  magnitude3,
  normalizeAngle,
  clamp,
  clamp01,
  lerp,
  angleDiff,
  lerpAngle,
  normalizeAndScale,
  directionTo,
  getWeaponWorldPosition,
  getTransformCosSin,
} from './MathHelpers';

export {
  lineCircleIntersectionT,
  lineSphereIntersectionT,
  lineLineIntersectionT,
  lineRectIntersectionT,
  rayVerticalRectIntersectionT,
  rayTiltedRectIntersectionT,
  rayBoxIntersectionT,
  isPointInSlice,
} from './CollisionHelpers';

export { applyHomingSteering } from './HomingSteering';

export {
  type BarrelEndpoint,
  getBarrelTip,
  countBarrels,
  getTurretBarrelDiameter,
  getTurretBarrelCenterToTipLength,
  getTurretHeadRadius,
  turretHeadRadiusFromBodyRadius,
  TURRET_BARREL_MIN_DIAMETER,
} from './BarrelGeometry';

export {
  type BallisticSolution,
  ballisticSolutions,
  solveBallisticPitch,
  computeInterceptTime,
} from './Ballistics';
