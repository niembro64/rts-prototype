import { COLORS } from '@/colorsConfig';
import type { Entity, PlayerId } from '../sim/types';
import { getPlayerColors } from '../sim/types';
import {
  entityBodyColorHex,
  entityBodyColorHexForPlayer,
  entityHeadOnlyTurretHeadColorHex,
  entityInstanceColorHex,
  entityInstanceColorHexForPlayer,
  entityTeamMidColorHexForPlayer,
  entityTurretAccentColorHex,
  turretAccentColorHexForPlayer,
} from './EntityInstanceColor3D';
import {
  locomotionPieceColorFromPrimary,
  locomotionPieceColorHex,
} from './colorUtils';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[entity instance color 3d contract] ${message}`);
  }
}

function unitWithOwner(playerId: PlayerId | undefined): Entity {
  return {
    id: 9101,
    type: 'unit',
    entitySlotId: -1,
    transform: { x: 0, y: 0, z: 0, rotation: 0, rotCos: null, rotSin: null },
    ownership: playerId !== undefined ? { playerId } : undefined,
    unit: null,
    building: null,
    projectile: null,
    builder: null,
    commander: null,
    factory: null,
    transport: null,
  } as Entity;
}

export function runEntityInstanceColor3DContractTest(): void {
  const playerId = 2 as PlayerId;
  const teamMid = getPlayerColors(playerId).primary;
  const lightVariant = 0xffffff;
  const darkVariant = 0x000000;
  const entity = unitWithOwner(playerId);

  assertContract(
    entityTeamMidColorHexForPlayer(playerId) === teamMid,
    'named team-mid helper must resolve the player primary/mid color',
  );
  assertContract(
    entityBodyColorHexForPlayer(playerId) === teamMid &&
      entityInstanceColorHexForPlayer(playerId) === teamMid,
    'body and instanced colors must collapse to the team mid color',
  );
  assertContract(
    entityBodyColorHex(entity) === teamMid &&
      entityInstanceColorHex(entity) === teamMid,
    'entity body and instance helpers must use the owning team mid color',
  );
  assertContract(
    locomotionPieceColorHex(lightVariant, playerId) === teamMid &&
      locomotionPieceColorHex(darkVariant, playerId) === teamMid,
    'locomotion light/dark authored variants must collapse to team mid',
  );
  assertContract(
    locomotionPieceColorFromPrimary(lightVariant, teamMid) === teamMid &&
      locomotionPieceColorFromPrimary(darkVariant, teamMid) === teamMid,
    'locomotion primary-color fast path must ignore authored light/dark variants',
  );
  assertContract(
    entityHeadOnlyTurretHeadColorHex(entity, undefined) === teamMid,
    'turret heads/bodies must share the team mid color',
  );
  assertContract(
    entityTurretAccentColorHex(entity) === COLORS.units.turret.barrel.colorHex &&
      turretAccentColorHexForPlayer(playerId) === COLORS.units.turret.barrel.colorHex,
    'barrels stay on the neutral barrel accent instead of team mid',
  );
  assertContract(
    entityTeamMidColorHexForPlayer(undefined) === COLORS.units.neutral.colorHex,
    'ownerless units keep the neutral fallback',
  );
}
