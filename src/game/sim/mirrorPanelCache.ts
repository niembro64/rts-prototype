// Mirror panel cache builder — single source of truth for the
// per-unit `entity.unit.mirrorPanels` array. Called once at entity
// creation by both the authoritative sim (WorldState.createUnitFromBlueprint)
// and the client-side hydration path (NetworkEntityFactory.createUnitFromNetwork)
// so beam-vs-mirror collision uses the exact same canonical rectangles
// on host and client.
//
// The mirror panel is a square slab of side `2 × bodyRadius`, mounted
// at ARM'S LENGTH from the turret body sphere along the turret's
// facing direction. The arm length is also `bodyRadius` — so the
// panel's near edge touches the unit body and the panel center sits
// at the body's outer edge. Vertical position comes from the mirror
// turret's blueprint-authored 3D mount so panel collision and visuals
// stay attached to the same pivot as the turret.
// Attachment cylinder + offset are rendered together; the sim only
// needs the panel center offset (offsetX = bodyRadius, offsetY = 0)
// and angle = 0 (panel normal = turret yaw direction).

import type { CachedMirrorPanel } from '../../types/sim';
import type { UnitBlueprint } from '../../types/blueprints';
import { getTurretBlueprint } from './blueprints';

/** Forward arm length (from turret body center to panel center) as a
 *  multiple of unit bodyRadius. 1.0 puts the panel center at the body
 *  edge — visually the arm clears the body sphere and the panel sits
 *  flush against the body's outer surface. */
export const MIRROR_ARM_LENGTH_FRAC = 1.0;

/** Mirror panel size multiplier. Scales BOTH the sim collision
 *  rectangle (`halfWidth` / `halfHeight`) and the rendered plane —
 *  Render3DEntities reads `mirrorPanels[0].halfWidth` directly so a
 *  bump here flows through to the visual panel without any other
 *  edit. 1.0 = legacy "panel side = 2 × bodyRadius"; 2.0 = doubles
 *  every linear dimension (4× area), the current value the user
 *  asked for. The arm length doesn't scale with this — the panel
 *  center still sits at the body's outer edge — so a >1 multiplier
 *  intentionally lets the panel near-edge cross into the body
 *  silhouette, which is what gives the bigger panel its extra reach
 *  without floating off into space. */
export const MIRROR_PANEL_SIZE_MULT = 2.0;

/** Mutates `panelsOut` (push), returns the bound radius the caller
 *  should assign to `unit.mirrorBoundRadius`. Returns 0 when the
 *  blueprint declares no mirror-bearing turrets. */
export function buildMirrorPanelCache(
  bp: UnitBlueprint,
  panelsOut: CachedMirrorPanel[],
): number {
  const unitBodyRadius = bp.bodyRadius;
  const halfSide = unitBodyRadius * MIRROR_PANEL_SIZE_MULT;
  const armLength = unitBodyRadius * MIRROR_ARM_LENGTH_FRAC;
  let mirrorBoundRadius = 0;

  for (const mount of bp.turrets) {
    const tb = getTurretBlueprint(mount.turretId);
    if (!tb.mirrorPanels) continue;
    const centerY = mount.mount.z * unitBodyRadius;
    const baseY = centerY - halfSide;
    const topY = centerY + halfSide;

    for (let i = 0; i < tb.mirrorPanels.length; i++) {
      panelsOut.push({
        halfWidth: halfSide,
        halfHeight: halfSide,
        // Panel center sits forward of the turret pivot by armLength
        // along the turret's local +X axis. The world-space yaw of
        // that offset is the mirror turret's rotation, applied at
        // collision time in MirrorPanelHit.findClosestPanelHit.
        offsetX: armLength,
        offsetY: 0,
        angle: 0,
        baseY,
        topY,
      });
      // Bound radius covers everything from the unit center out to
      // the far edge of the panel: arm length + half-diagonal of the
      // square. Conservative, but it's only used for broadphase
      // culling so a slight over-estimate is fine.
      const farEdge = armLength + halfSide;
      if (farEdge > mirrorBoundRadius) mirrorBoundRadius = farEdge;
    }
  }

  return mirrorBoundRadius;
}
