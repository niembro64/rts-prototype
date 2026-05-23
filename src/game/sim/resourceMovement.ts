import type { EconomyState, EntityId, PlayerId } from './types';

export type ResourceKind = 'energy' | 'metal';
export type ResourceMovementDirection = 'inbound' | 'outbound';
export type ResourceMovementReason =
  | 'baseIncome'
  | 'production'
  | 'construction'
  | 'repair'
  | 'conversion'
  | 'refund'
  | 'reclaim'
  | 'ability';

export type ResourceMovement = {
  playerId: PlayerId;
  sourceEntityId: EntityId | null;
  targetEntityId: EntityId | null;
  resource: ResourceKind;
  amount: number;
  amountPerSecond: number;
  direction: ResourceMovementDirection;
  stockpileDelta: number;
  reason: ResourceMovementReason;
};

export type ResourceMovementSink = {
  resourceMovements: ResourceMovement[];
};

export type ResourceMovementRequest = {
  playerId: PlayerId;
  sourceEntityId: EntityId | null;
  targetEntityId: EntityId | null;
  resource: ResourceKind;
  amount: number;
  amountPerSecond: number;
  direction: ResourceMovementDirection;
  reason: ResourceMovementReason;
};

function getStockpile(economy: EconomyState, resource: ResourceKind): { curr: number; max: number } {
  return resource === 'energy' ? economy.stockpile : economy.metal.stockpile;
}

function normalizeAmount(amount: number): number {
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

export class ResourceMovementSystem {
  beginTick(sink: ResourceMovementSink): void {
    sink.resourceMovements.length = 0;
  }

  credit(economy: EconomyState, sink: ResourceMovementSink, request: ResourceMovementRequest): number {
    const requested = normalizeAmount(request.amount);
    if (requested <= 0) return 0;
    const stockpile = getStockpile(economy, request.resource);
    const accepted = Math.max(0, Math.min(requested, stockpile.max - stockpile.curr));
    if (accepted <= 0) return 0;
    stockpile.curr += accepted;
    this.record(sink, request, accepted, accepted);
    return accepted;
  }

  debit(economy: EconomyState, sink: ResourceMovementSink, request: ResourceMovementRequest): number {
    const requested = normalizeAmount(request.amount);
    if (requested <= 0) return 0;
    const stockpile = getStockpile(economy, request.resource);
    const spent = Math.max(0, Math.min(requested, stockpile.curr));
    if (spent <= 0) return 0;
    stockpile.curr -= spent;
    this.record(sink, request, spent, -spent);
    return spent;
  }

  private record(
    sink: ResourceMovementSink,
    request: ResourceMovementRequest,
    actualAmount: number,
    stockpileDelta: number,
  ): void {
    const scale = request.amount > 0 ? actualAmount / request.amount : 0;
    sink.resourceMovements.push({
      playerId: request.playerId,
      sourceEntityId: request.sourceEntityId,
      targetEntityId: request.targetEntityId,
      resource: request.resource,
      amount: actualAmount,
      amountPerSecond: Math.max(0, request.amountPerSecond) * scale,
      direction: request.direction,
      stockpileDelta,
      reason: request.reason,
    });
  }
}

export const resourceMovementSystem = new ResourceMovementSystem();
