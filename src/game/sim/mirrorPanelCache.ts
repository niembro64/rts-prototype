// Mirror panel cache builder — single source of truth for the
// per-unit `entity.unit.mirrorPanels` array. Called once at entity
// creation by both the authoritative sim (WorldState.createUnitFromBlueprint)
// and the client-side hydration path (NetworkEntityFactory.createUnitFromNetwork)
// so beam-vs-mirror collision uses the exact same canonical rectangles
// on host and client.
//
// The panel is REGULARIZED — a perfect square flat plane whose side
// length equals its vertical span (topY − baseY). Per-host bodyRadius
// scales the column with the mirror-host turret's declared size.

import type { CachedMirrorPanel } from '../../types/sim';
import type { UnitBlueprint } from '../../types/blueprints';
import { MIRROR_BASE_Y, MIRROR_EXTRA_HEIGHT } from '../../config';
import { getBodyTopY } from '../math/BodyDimensions';
import { turretHeadRadiusFromBodyRadius } from '../math';
import { getTurretBlueprint } from './blueprints';

/** Mutates `panelsOut` (push), returns the bound radius the caller
 *  should assign to `unit.mirrorBoundRadius`. Returns 0 when the
 *  blueprint declares no mirror-bearing turrets. */
export function buildMirrorPanelCache(
  bp: UnitBlueprint,
  panelsOut: CachedMirrorPanel[],
): number {
  const unitScale = bp.unitRadiusCollider.scale;
  const rendererId = bp.renderer ?? 'arachnid';
  const baseY = MIRROR_BASE_Y;
  const bodyTop = getBodyTopY(rendererId, unitScale);
  let mirrorBoundRadius = 0;

  for (const mount of bp.turrets) {
    const tb = getTurretBlueprint(mount.turretId);
    if (!tb.mirrorPanels) continue;
    const hostHeadRadius = turretHeadRadiusFromBodyRadius(unitScale, tb.bodyRadius);
    const topY = bodyTop + 2 * hostHeadRadius + MIRROR_EXTRA_HEIGHT;
    const halfSide = (topY - baseY) / 2;

    for (const p of tb.mirrorPanels) {
      panelsOut.push({
        halfWidth: halfSide,
        halfHeight: halfSide,
        offsetX: p.offsetX,
        offsetY: p.offsetY,
        angle: p.angle,
        baseY,
        topY,
      });
      const dist = Math.sqrt(p.offsetX * p.offsetX + p.offsetY * p.offsetY) + halfSide;
      if (dist > mirrorBoundRadius) mirrorBoundRadius = dist;
    }
  }

  return mirrorBoundRadius;
}
