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
 *  multiple of unit bodyRadius. 1.0 puts the panel center at the
 *  body edge; bigger values stretch the arm further out. Bumped up
 *  to 5 as a debug knob — the longer the arm, the more visible the
 *  rigid yaw + pitch sweep is, which makes it obvious whether the
 *  ball-joint math (MirrorAimSolver, MirrorPanelHit, the renderer's
 *  single-quaternion root rotation) all agree on where the panel
 *  ends up in 3D. Dial back when you're done verifying. */
export const MIRROR_ARM_LENGTH_FRAC = 1.2;

/** Mirror panel size multiplier. Scales BOTH the sim collision
 *  rectangle (`halfWidth` / `halfHeight`) and the rendered plane —
 *  Render3DEntities reads `mirrorPanels[0].halfWidth` directly so a
 *  bump here flows through to the visual panel without any other
 *  edit. 1.0 = legacy "panel side = 2 × bodyRadius". Cranked to 4
 *  for the same debug-visibility reason as MIRROR_ARM_LENGTH_FRAC:
 *  a panel that's 8 × bodyRadius on a side is impossible to miss
 *  during yaw / pitch sweeps. */
export const MIRROR_PANEL_SIZE_MULT = 4.0;

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
