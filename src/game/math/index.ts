// Math utilities - re-exports

export {
  distanceSquared,
  distance,
  magnitudeSquared,
  magnitude,
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
  rayBoxIntersectionT,
  isPointInSlice,
} from './CollisionHelpers';

export { applyHomingSteering } from './HomingSteering';

export {
  type BarrelEndpoint,
  getBarrelTip,
  countBarrels,
} from './BarrelGeometry';

export {
  type BallisticSolution,
  ballisticSolutions,
  solveBallisticPitch,
} from './Ballistics';
