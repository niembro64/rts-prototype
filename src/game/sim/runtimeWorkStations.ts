import { NO_ENTITY_ID, type Builder } from './types';
import { getUnitBlueprint } from './blueprints';

/** Build a host-owned Builder component and, when authored, its independent
 * articulated QueryWork station. Weapon and work stations may share a parent
 * claim group, but never share their local joint state. */
export function createRuntimeBuilder(
  unitBlueprintId: string,
  lowPriority = false,
  currentBuildTarget = NO_ENTITY_ID,
): Builder {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const builder = blueprint.builder;
  if (builder === null) {
    throw new Error(`createRuntimeBuilder: ${unitBlueprintId} is not a builder`);
  }
  const emitter = blueprint.workEmitter;
  const articulation = emitter?.articulation ?? null;
  return {
    buildRange: builder.buildRange,
    lowPriority,
    currentBuildTarget,
    workStation: articulation === null
      ? null
      : {
          localYaw: articulation.restYaw,
          localPitch: articulation.restPitch,
          localYawVelocity: 0,
          localPitchVelocity: 0,
          idleMs: articulation.restoreDelayMs,
          targetWorldYaw: 0,
          targetWorldPitch: articulation.restPitch,
          targetEntityId: NO_ENTITY_ID,
          aligned: !emitter!.requiresAlignmentForWork,
          worldPosition: { x: 0, y: 0, z: 0 },
          worldVelocity: { x: 0, y: 0, z: 0 },
          worldPosTick: -1,
        },
  };
}
