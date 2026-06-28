import type { EntityId } from '../sim/types';

export const FAST_CLIENT_ENTITY_ID_LIMIT = 1_000_000;

export function canIndexClientEntityId(id: EntityId): boolean {
  return Number.isInteger(id) && id >= 0 && id <= FAST_CLIENT_ENTITY_ID_LIMIT;
}
