type BarDefaultPointerAction =
  | 'none'
  | 'waypoint'
  | 'attack'
  | 'guard'
  | 'repair'
  | 'reclaim';

type BarPointerTargetRelationship =
  | 'none'
  | 'friendly'
  | 'enemy'
  | 'feature';

type BarDefaultPointerActionInput = {
  relationship: BarPointerTargetRelationship;
  hasWaypointSource: boolean;
  hasAttacker: boolean;
  hasBuilder: boolean;
  hasGuardSource: boolean;
  targetRepairable: boolean;
  targetGuardRepairOverride: boolean;
  targetReclaimable: boolean;
  targetIsSoleSelection: boolean;
};

/** Recoil's context-sensitive right-click command, including BAR's enabled
 *  guard-damaged-constructors and ignore-self overrides. This deliberately
 *  resolves a command category rather than a cursor name: input dispatch and
 *  cursor prediction can consume the same result. */
export function resolveBarDefaultPointerAction(
  input: BarDefaultPointerActionInput,
): BarDefaultPointerAction {
  const fallback = input.hasWaypointSource ? 'waypoint' : 'none';
  const hasCommandSource = input.hasWaypointSource ||
    input.hasAttacker || input.hasBuilder || input.hasGuardSource;
  if (!hasCommandSource || input.relationship === 'none') return fallback;

  // BAR's Ignore Self widget makes a singly-selected non-factory body
  // transparent to default commands. The caller identifies that case; the
  // ground below receives the normal waypoint instead.
  if (input.targetIsSoleSelection) return fallback;

  if (input.relationship === 'enemy') {
    if (input.hasAttacker) return 'attack';
    if (input.hasBuilder && input.targetReclaimable) return 'reclaim';
    return fallback;
  }

  if (input.relationship === 'feature') {
    return input.hasBuilder && input.targetReclaimable ? 'reclaim' : fallback;
  }

  if (input.hasBuilder && input.targetRepairable) {
    if (input.targetGuardRepairOverride) {
      return input.hasGuardSource ? 'guard' : fallback;
    }
    return 'repair';
  }
  return input.hasGuardSource ? 'guard' : fallback;
}
