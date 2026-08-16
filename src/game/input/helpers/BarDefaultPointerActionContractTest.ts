import { resolveBarDefaultPointerAction } from './BarDefaultPointerAction';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`BAR pointer-action contract failed: ${message}`);
}

const base = {
  relationship: 'friendly' as const,
  hasWaypointSource: true,
  hasAttacker: false,
  hasBuilder: false,
  hasGuardSource: true,
  targetRepairable: false,
  targetGuardRepairOverride: false,
  targetReclaimable: true,
  targetIsSoleSelection: false,
};

export function runBarDefaultPointerActionContractTest(): void {
  assertContract(
    resolveBarDefaultPointerAction({
      ...base,
      relationship: 'enemy',
      hasAttacker: true,
    }) === 'attack',
    'an attack-capable selection must Attack an enemy unit or building',
  );
  assertContract(
    resolveBarDefaultPointerAction({
      ...base,
      relationship: 'enemy',
      hasBuilder: true,
      hasGuardSource: false,
    }) === 'reclaim',
    'a non-attacking builder must Reclaim a reclaimable enemy',
  );
  assertContract(
    resolveBarDefaultPointerAction({
      ...base,
      relationship: 'enemy',
      hasBuilder: true,
      hasGuardSource: false,
      targetReclaimable: false,
    }) === 'waypoint',
    'a non-attacking selection must fall back to its waypoint over a non-reclaimable enemy',
  );
  assertContract(
    resolveBarDefaultPointerAction(base) === 'guard',
    'a completed allied entity must default to Guard',
  );
  assertContract(
    resolveBarDefaultPointerAction({
      ...base,
      hasBuilder: true,
      targetRepairable: true,
    }) === 'repair',
    'a builder must Repair a damaged or unfinished allied entity',
  );
  assertContract(
    resolveBarDefaultPointerAction({
      ...base,
      hasBuilder: true,
      targetRepairable: true,
      targetGuardRepairOverride: true,
    }) === 'guard',
    'BAR must rewrite Repair to Guard for a completed damaged constructor or factory',
  );
  assertContract(
    resolveBarDefaultPointerAction({
      ...base,
      targetIsSoleSelection: true,
    }) === 'waypoint',
    'a singly-selected unit targeting itself must fall through to Move',
  );
  assertContract(
    resolveBarDefaultPointerAction({
      ...base,
      relationship: 'feature',
      hasBuilder: true,
      hasGuardSource: false,
    }) === 'reclaim',
    'a builder must Reclaim a reclaimable feature',
  );
  assertContract(
    resolveBarDefaultPointerAction({
      ...base,
      hasWaypointSource: false,
      hasGuardSource: false,
      relationship: 'none',
    }) === 'none',
    'an empty selection must retain the normal game cursor',
  );
}
