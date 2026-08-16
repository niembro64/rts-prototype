import type { EntityId } from '../sim/types';
import { monotonicNowMs } from '../time';

const DEFAULT_HOVER_RAYCAST_INTERVAL_MS = 50;

type Input3DHoverTargets = {
  hovered: EntityId | null;
  selectable: EntityId | null;
};

type ResolveHoverTargets = (
  clientX: number,
  clientY: number,
) => Input3DHoverTargets;

export class Input3DHoverState {
  hoveredEntityId: EntityId | null = null;
  hoveredSelectableEntityId: EntityId | null = null;
  lastClientX = Number.NaN;
  lastClientY = Number.NaN;
  private lastRaycastMs = 0;

  constructor(private readonly raycastIntervalMs = DEFAULT_HOVER_RAYCAST_INTERVAL_MS) {}

  clearTargets(): void {
    this.hoveredEntityId = null;
    this.hoveredSelectableEntityId = null;
  }

  hasClientPoint(clientX: number, clientY: number): boolean {
    return this.lastClientX === clientX && this.lastClientY === clientY;
  }

  hasFiniteClientPoint(): boolean {
    return Number.isFinite(this.lastClientX) && Number.isFinite(this.lastClientY);
  }

  update(
    clientX: number,
    clientY: number,
    resolveTargets: ResolveHoverTargets,
  ): void {
    const now = monotonicNowMs();
    if (now - this.lastRaycastMs < this.raycastIntervalMs) return;
    this.lastRaycastMs = now;
    this.lastClientX = clientX;
    this.lastClientY = clientY;
    const targets = resolveTargets(clientX, clientY);
    this.hoveredEntityId = targets.hovered;
    this.hoveredSelectableEntityId = targets.selectable;
  }
}
