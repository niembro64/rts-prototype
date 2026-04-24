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
  isPointInSlice,
} from './CollisionHelpers';

export { applyHomingSteering } from './HomingSteering';
