import type { EconomyState, EntityId, PlayerId } from './types';
import { getSimWasm } from '../sim-wasm/init';

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

const _stockpileOut = new Float64Array(2);

function requireSimWasm(context: string) {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(`${context}: sim-wasm is not initialized`);
  }
  return sim;
}

export class ResourceMovementSystem {
  beginTick(sink: ResourceMovementSink): void {
    sink.resourceMovements.length = 0;
  }

  credit(economy: EconomyState, sink: ResourceMovementSink, request: ResourceMovementRequest): number {
    const stockpile = getStockpile(economy, request.resource);
    const sim = requireSimWasm('ResourceMovementSystem.credit');
    if (sim.economyCreditStockpile(stockpile.curr, stockpile.max, request.amount, _stockpileOut) === 0) {
      throw new Error('ResourceMovementSystem.credit: economy_credit_stockpile rejected its output buffer');
    }
    const accepted = _stockpileOut[0];
    if (accepted <= 0) return 0;
    stockpile.curr = _stockpileOut[1];
    this.record(sink, request, accepted, accepted);
    return accepted;
  }

  debit(economy: EconomyState, sink: ResourceMovementSink, request: ResourceMovementRequest): number {
    const stockpile = getStockpile(economy, request.resource);
    const sim = requireSimWasm('ResourceMovementSystem.debit');
    if (sim.economyDebitStockpile(stockpile.curr, request.amount, _stockpileOut) === 0) {
      throw new Error('ResourceMovementSystem.debit: economy_debit_stockpile rejected its output buffer');
    }
    const spent = _stockpileOut[0];
    if (spent <= 0) return 0;
    stockpile.curr = _stockpileOut[1];
    this.record(sink, request, spent, -spent);
    return spent;
  }

  recordAppliedCredit(
    sink: ResourceMovementSink,
    request: ResourceMovementRequest,
    actualAmount: number,
  ): void {
    if (actualAmount <= 0) return;
    this.record(sink, request, actualAmount, actualAmount);
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
