// RtsScene helpers - re-exports

export { createUnitBody, createMatterBodies, applyUnitVelocities } from './PhysicsHelpers';
export {
  getExplosionRadius,
  handleAudioEvent,
  handleUnitDeaths,
  handleBuildingDeaths,
  handleGameOver,
} from './DeathEffectsHandler';
export { spawnBackgroundUnit, spawnBackgroundUnits } from './BackgroundBattle';
export {
  type UIEntitySource,
  type SelectionInfo,
  type EconomyInfo,
  type MinimapEntity,
  type MinimapData,
  type InputState,
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './UIUpdateManager';
