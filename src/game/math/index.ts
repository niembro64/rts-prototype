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
} from './MathHelpers';

export {
  lineCircleIntersectionT,
  lineLineIntersectionT,
  lineRectIntersectionT,
  isPointInSlice,
} from './CollisionHelpers';

export { applyHomingSteering } from './HomingSteering';
