import { getUnitLocomotion } from './index';
import {
  UNIT_LOCOMOTION_CONTACT_FIELDS,
  UNIT_LOCOMOTION_FLUID_RESISTANCE_FIELDS,
  UNIT_LOCOMOTION_SURFACE_LIFT_RESPONSE_FIELDS,
  UNIT_LOCOMOTION_PROPULSION_FIELDS,
  getUnitLocomotionPreset,
} from '../unitLocomotionPresetConfig';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water lift locomotion contract] ${message}`);
}

export function runUnitWaterLiftLocomotionContractTest(): void {
  for (const presetId of ['flippers', 'swim']) {
    const preset = getUnitLocomotionPreset(presetId);
    for (const field of UNIT_LOCOMOTION_PROPULSION_FIELDS) {
      assertContract(
        Object.prototype.hasOwnProperty.call(preset.physics.ground.propulsion, field),
        `${presetId}.ground.propulsion must explicitly own ${field}`,
      );
    }
    for (const field of UNIT_LOCOMOTION_CONTACT_FIELDS) {
      assertContract(
        Object.prototype.hasOwnProperty.call(preset.physics.ground.contact, field),
        `${presetId}.ground.contact must explicitly own ${field}`,
      );
    }
    for (const mediumName of ['air', 'water'] as const) {
      const medium = preset.physics[mediumName];
      for (const field of UNIT_LOCOMOTION_PROPULSION_FIELDS) {
        assertContract(
          Object.prototype.hasOwnProperty.call(medium.propulsion, field),
          `${presetId}.${mediumName}.propulsion must explicitly own ${field}`,
        );
      }
      for (const field of UNIT_LOCOMOTION_FLUID_RESISTANCE_FIELDS) {
        assertContract(
          Object.prototype.hasOwnProperty.call(medium.resistance, field),
          `${presetId}.${mediumName}.resistance must explicitly own ${field}`,
        );
      }
      for (const field of UNIT_LOCOMOTION_SURFACE_LIFT_RESPONSE_FIELDS) {
        assertContract(
          Object.prototype.hasOwnProperty.call(medium.surfaceLiftResponse, field),
          `${presetId}.${mediumName}.surfaceLiftResponse must explicitly own ${field}`,
        );
      }
    }
  }

  for (const [unitBlueprintId, presetId] of [
    ['unitSeaTurtle', 'flippers'],
    ['unitOrca', 'swim'],
  ] as const) {
    const locomotion = getUnitLocomotion(unitBlueprintId);
    assertContract(locomotion.physicsPresetId === presetId, `${unitBlueprintId} must use ${presetId}`);
    const lift = locomotion.physics.water.lift;
    assertContract(
      lift.liftForceFromGroundSurface > 0,
      `${unitBlueprintId} must author water lift force from ground surface`,
    );
    assertContract(
      lift.liftForceFromWaterSurface === 0,
      `${unitBlueprintId} water physics must not source lift from water surface`,
    );
    assertContract(
      lift.randomizationAmount === 0.99,
      `${unitBlueprintId} must preserve the historical water-lift randomization`,
    );
    assertContract(
      lift.ema === 0.97,
      `${unitBlueprintId} must preserve the historical strong water-lift EMA`,
    );
  }
}
