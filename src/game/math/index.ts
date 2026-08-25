// Math utilities - re-exports

export {
  
  magnitude,
  normalizeAngle,
  clamp,
  clamp01,
  clampUnit,
  smoothstep01,
  angleDeltaAbs,
  lerp,
  lerpAngle,
  getTransformCosSin,
  isFiniteNumber,
  finiteOr,
  finiteOrZero,
} from './MathHelpers';


export {
  computeTerrainFollowVerticalThrustAccel,
} from './TerrainFollowThrust';

export {
  getBarrelOrbitAngle,
  getConeBarrelBaseOrbitRadius,
  getConeBarrelTipOrbitRadius,
  getSimpleMultiBarrelOrbitRadius,
  getMultiBarrelFiringOrbitRadius,
  getTurretBarrelDiameter,
  getTurretBarrelCenterToTipLength,
  getTurretHeadRadius,
} from './BarrelGeometry';

export { getUnitVisualTopAboveSupport } from './UnitVisualEnvelope';

export {
  type KinematicInterceptSolution,
  type KinematicState3,
  
  solveKinematicIntercept,
} from './Ballistics';

export { getTurretWorldMount } from './MountGeometry';
