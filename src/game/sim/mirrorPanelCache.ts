// Mirror panel cache builder — single source of truth for the
// per-unit `entity.unit.mirrorPanels` array. Called once at entity
// creation by both the authoritative sim (WorldState.createUnitFromBlueprint)
// and the client-side hydration path (NetworkEntityFactory.createUnitFromNetwork)
// so beam-vs-mirror collision uses the exact same canonical rectangles
// on host and client.
//
// The mirror panel is a square slab sized from radius.body, mounted at
// ARM'S LENGTH from the turret body sphere along the turret's facing
// direction. Vertical position comes from the mirror turret's
// blueprint-authored 3D mount so panel collision and visuals stay
// attached to the same pivot as the turret.
// Visual side support rails are rendered from the same panel sizing;
// the sim only needs the panel center offset (offsetX = arm length,
// offsetY = 0) and angle = 0 (panel normal = turret yaw direction).

import type { CachedMirrorPanel } from '../../types/sim';
import type { UnitBlueprint } from '../../types/blueprints';
import { getTurretBlueprint } from './blueprints';

/** Forward arm length (from turret body center to panel center) as a
 *  multiple of unit radius.body. 1.0 puts the panel center at the
 *  body edge; bigger values stretch the support rails further out. */
export const MIRROR_ARM_LENGTH_MULT = 1.8;

/** Mirror panel size multiplier. Scales BOTH the sim collision
 *  rectangle (`halfWidth` / `halfHeight`) and the rendered plane —
 *  Render3DEntities reads `mirrorPanels[0].halfWidth` directly so a
 *  bump here flows through to the visual panel without any other
 *  edit. 1.0 = legacy "panel side = 2 × radius.body". */
export const MIRROR_PANEL_SIZE_MULT = 2.0;

/** Compute the rigid mirror arm's panel CENTER in world coords by
 *  extending an arm of length `armLength` from `(pivotX, pivotY,
 *  pivotZ)` along the 3D direction
 *
 *      a(α, β) = (cos α · cos β,  sin α · cos β,  sin β)
 *
 *  where α = mirrorYaw and β = mirrorPitch.
 *
 *  SINGLE SOURCE OF TRUTH for the rigid-arm extend formula — shared
 *  by the aim solver (iterating panel-center for bisector refinement),
 *  the panel hit test (collision), and the debris emitter (so dead
 *  Lorises drop debris in the same spot the live panel was). The
 *  PIVOT itself is computed differently per call site (the aim solver
 *  uses a chassis-tilt-aware mount from resolveWeaponWorldMount; the
 *  hit test and debris use the upright body-mid-Z anchor) so the
 *  pivot stays at the call site, but the arm extension lives here.
 *
 *  `out` is mutated and returned to keep this allocation-free in the
 *  per-tick aim-solver loop. */
export function getMirrorPanelCenter(
  pivotX: number, pivotY: number, pivotZ: number,
  armLength: number,
  mirrorYaw: number, mirrorPitch: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const cosYaw = Math.cos(mirrorYaw);
  const sinYaw = Math.sin(mirrorYaw);
  const cosPitch = Math.cos(mirrorPitch);
  const sinPitch = Math.sin(mirrorPitch);
  out.x = pivotX + cosYaw * cosPitch * armLength;
  out.y = pivotY + sinYaw * cosPitch * armLength;
  out.z = pivotZ + sinPitch * armLength;
  return out;
}

/** Mutates `panelsOut` (push), returns the bound radius the caller
 *  should assign to `unit.mirrorBoundRadius`. Returns 0 when the
 *  blueprint declares no mirror-bearing turrets. */
export function buildMirrorPanelCache(
  bp: UnitBlueprint,
  panelsOut: CachedMirrorPanel[],
): number {
  const unitBodyRadius = bp.radius.body;
  const halfSide = unitBodyRadius * MIRROR_PANEL_SIZE_MULT;
  const armLength = unitBodyRadius * MIRROR_ARM_LENGTH_MULT;
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
