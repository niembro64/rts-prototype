import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';

/** The Formik and its rapid mortar are intentionally a matched visual kit. */
export const FORMIK_UNIT_BLUEPRINT_ID = 'unitFormik';
export const FORMIK_TURRET_BLUEPRINT_ID = 'turretMortarFast';

/**
 * The mortar collar runs from the turret's own centre out to the head
 * sphere's forward pole — one cylinder, no floating drum.
 *
 * The back sits at x = 0 — the head sphere's own centre, which is the
 * turret's centre of rotation — so the barrels genuinely originate there
 * instead of appearing to start partway along the axis.
 *
 * The front clears the sphere's forward pole rather than meeting it. Ending
 * exactly AT the pole (x = headRadius) makes the cap tangent to the sphere:
 * two surfaces touching at a single point, which z-fights and reads as the
 * sphere poking through the collar's face. The margin below puts the cap in
 * open air past the pole, so every bit of sphere surface inside the collar
 * radius is genuinely covered by it.
 */
const TURRET_ANCHOR_BACK_X_FRAC = 0;
const TURRET_ANCHOR_FRONT_X_FRAC = 1.18;
const TURRET_ANCHOR_RADIUS_FRAC = 0.76;

/**
 * Collar sides per detail tier. The collar is a plain cylinder, so its
 * silhouette cost is entirely in this number and it can be tuned freely:
 * 16 reads as round up close, 8 is the shape shipped before this ladder
 * existed, and 4 is a square — which is all that survives a few pixels
 * wide anyway. Triangles come out at 4n (2 per side quad, n per cap).
 */
const TURRET_ANCHOR_RADIAL_SEGMENTS: Record<PrimitiveGeometryTier, number> = {
  close: 16,
  mid: 8,
  far: 4,
};

/**
 * Strap detail per tier. `strap` is the full five-vertex section; `fin`
 * collapses it to the bare spine triangle, which keeps the ornament's
 * line and colour while shedding its thickness — the right trade once the
 * unit is small enough that the thickness is sub-pixel. `far` also drops
 * the cross-ribs, leaving the two rails that carry the team colour.
 */
type StrapTierPlan = { section: 'strap' | 'fin'; ribs: boolean; railSamples: number };
const STRAP_TIER_PLAN: Record<PrimitiveGeometryTier, StrapTierPlan> = {
  close: { section: 'strap', ribs: true, railSamples: 6 },
  mid: { section: 'fin', ribs: true, railSamples: 6 },
  far: { section: 'fin', ribs: false, railSamples: 3 },
};

export type FormikTurretAnchorProfile = {
  centerX: number;
  length: number;
  radius: number;
  backX: number;
  frontX: number;
};

export function getFormikTurretAnchorProfile(
  headRadius: number,
): FormikTurretAnchorProfile {
  const backX = headRadius * TURRET_ANCHOR_BACK_X_FRAC;
  const frontX = headRadius * TURRET_ANCHOR_FRONT_X_FRAC;
  return {
    centerX: (backX + frontX) * 0.5,
    length: frontX - backX,
    radius: headRadius * TURRET_ANCHOR_RADIUS_FRAC,
    backX,
    frontX,
  };
}

/** Spine height the outward direction radiates from, in chassis space.
 *  Every ridge's apex points away from this axis, so the frame reads as
 *  bolted onto the hull rather than laid flat across it. */
const SPINE_Y = 0.5;
/** Cross-section of a SPIKY STRAP: a broad band lifted off the hull with a
 *  spine ridge running down it. A bare triangle read as a thin fin from the
 *  RTS camera; the band gives the ornament real mass, and the spine keeps
 *  the hard specular line that made the triangle read well up close. */
const RIDGE_HALF_WIDTH = 0.22;
/** How far the strap's flat shoulders stand off the hull — its thickness.
 *  This is the number that decides whether the kit reads as armour plate or
 *  as paint; it wants to be a real fraction of the spike, not a hairline. */
const RIDGE_STRAP_THICKNESS = 0.16;
/** How far the spine rises above those shoulders. */
const RIDGE_SPIKE_HEIGHT = 0.22;
/** How far the base sinks under the surface, so the strap looks seated. */
const RIDGE_SINK = 0.06;

const _tangent = new THREE.Vector3();
const _outward = new THREE.Vector3();
const _side = new THREE.Vector3();

/** Outward from the hull spine, with the along-body component removed. */
function outwardAt(point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, point.y - SPINE_Y, point.z);
  if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
  return out.normalize();
}

/**
 * Sweep the spiky-strap cross-section along `path`, spine pointing away from
 * the hull.
 *
 * Five vertices per ring — spine, two shoulders, two sunk base corners — so
 * five quads per segment plus a 3-triangle cap at each end. Still a fraction
 * of what a round tube costs, and unlike a bare triangle it has visible
 * thickness from every angle instead of vanishing edge-on.
 */
function ridge(
  path: readonly THREE.Vector3[],
  section: 'strap' | 'fin',
): THREE.BufferGeometry {
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < path.length; i++) {
    const point = path[i];
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    _tangent.subVectors(next, prev);
    if (_tangent.lengthSq() < 1e-8) _tangent.set(1, 0, 0);
    _tangent.normalize();
    outwardAt(point, _outward);
    // Re-orthogonalize so a curving path cannot shear the cross-section.
    _side.crossVectors(_outward, _tangent);
    if (_side.lengthSq() < 1e-8) _side.set(0, 0, 1);
    _side.normalize();
    // Spine first, then around the section in one consistent cyclic order
    // so every quad below is wound the same way and normals face outward.
    const shoulder = RIDGE_STRAP_THICKNESS;
    if (section === 'fin') {
      // Spine plus the two sunk base corners: the strap's outline without
      // its thickness, for tiers where that thickness is sub-pixel.
      rings.push([
        point.clone().addScaledVector(_outward, shoulder + RIDGE_SPIKE_HEIGHT),
        point.clone().addScaledVector(_side, RIDGE_HALF_WIDTH)
          .addScaledVector(_outward, -RIDGE_SINK),
        point.clone().addScaledVector(_side, -RIDGE_HALF_WIDTH)
          .addScaledVector(_outward, -RIDGE_SINK),
      ]);
      continue;
    }
    rings.push([
      point.clone().addScaledVector(_outward, shoulder + RIDGE_SPIKE_HEIGHT),
      point.clone().addScaledVector(_side, RIDGE_HALF_WIDTH)
        .addScaledVector(_outward, shoulder),
      point.clone().addScaledVector(_side, RIDGE_HALF_WIDTH)
        .addScaledVector(_outward, -RIDGE_SINK),
      point.clone().addScaledVector(_side, -RIDGE_HALF_WIDTH)
        .addScaledVector(_outward, -RIDGE_SINK),
      point.clone().addScaledVector(_side, -RIDGE_HALF_WIDTH)
        .addScaledVector(_outward, shoulder),
    ]);
  }

  const positions: number[] = [];
  const push = (v: THREE.Vector3): void => {
    positions.push(v.x, v.y, v.z);
  };
  const ringSize = rings[0].length;
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    for (let k = 0; k < ringSize; k++) {
      const k2 = (k + 1) % ringSize;
      // Wound so the face normal points AWAY from the sweep axis. Reversed,
      // the renderer culls the outside of every strap and leaves only the
      // interior back-faces, which reads as a set of flat planes rather
      // than a solid — see the signed-volume check in the contract test.
      push(a[k]); push(b[k]); push(a[k2]);
      push(a[k2]); push(b[k]); push(b[k2]);
    }
  }
  // End caps keep the ridge solid where it terminates in open air. Where a
  // rib meets a rail the cap is buried inside the rail and costs nothing
  // visually.
  const first = rings[0];
  const last = rings[rings.length - 1];
  for (let k = 1; k + 1 < ringSize; k++) {
    // Start cap faces back along the sweep, end cap faces forward.
    push(first[0]); push(first[k]); push(first[k + 1]);
    push(last[0]); push(last[k + 1]); push(last[k]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Shoulder rail path for one side. The rib paths below reuse these exact
 *  points, which is what welds the frame into a single piece. */
function railPath(side: -1 | 1, samples: number): THREE.Vector3[] {
  const full = [
    new THREE.Vector3(-1.31, 1.40, side * 0.24),
    new THREE.Vector3(-0.86, 1.45, side * 0.45),
    new THREE.Vector3(-0.28, 1.02, side * 0.40),
    new THREE.Vector3(0.15, 1.19, side * 0.37),
    new THREE.Vector3(0.58, 1.01, side * 0.24),
    new THREE.Vector3(0.95, 0.76, side * 0.09),
  ];
  if (samples >= full.length) return full;
  // Keep both ends and drop interior samples evenly, so a coarser rail
  // still spans abdomen to forward lobe on the same line.
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < samples; i++) {
    out.push(full[Math.round((i * (full.length - 1)) / (samples - 1))]);
  }
  return out;
}

/**
 * The Formik's team-colored exoskeleton: two shoulder rails tied together by
 * two arched cross-ribs.
 *
 * Every ridge is an extruded triangle whose point faces away from the hull,
 * so the kit reads as a hard chitinous frame rather than piping. The ribs
 * START and END on rail vertices — same position, same outward direction —
 * so the four strokes meet flush and the whole thing reads as one connected
 * frame instead of four separate decals.
 *
 * Authored in unit-radius-1 chassis space and instanced by
 * TeamTrimRenderer3D.
 */
export function createFormikBodyOrnamentGeometry(
  tier: PrimitiveGeometryTier = 'close',
): THREE.BufferGeometry {
  const plan = STRAP_TIER_PLAN[tier];
  const left = railPath(-1, plan.railSamples);
  const right = railPath(1, plan.railSamples);
  const pieces: THREE.BufferGeometry[] = [
    ridge(left, plan.section),
    ridge(right, plan.section),
  ];

  // Cross-ribs over the rear and middle lobes. Index 1 and 3 are the rail
  // vertices they join, so the endpoints coincide exactly.
  if (plan.ribs) {
    for (const [railIndex, apexY] of [[1, 1.66], [3, 1.38]] as const) {
      pieces.push(ridge([
        left[railIndex].clone(),
        new THREE.Vector3(left[railIndex].x, apexY, 0),
        right[railIndex].clone(),
      ], plan.section));
    }
  }

  const geometry = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  if (geometry === null) {
    throw new Error('Failed to merge Formik body ornament geometry');
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Unit cylinder with its long axis along the turret/barrel +X direction,
 * at this tier's side count (see TURRET_ANCHOR_RADIAL_SEGMENTS).
 *
 * This deliberately does NOT go through the shared `turret` cylinder role:
 * that role's counts are tuned for barrels, and the collar is a much larger
 * silhouette that wants its own ladder — 16 up close where it reads as a
 * ring around the head, down to a plain square once it is a few pixels
 * wide.
 */
export function createFormikTurretAnchorGeometry(
  tier: PrimitiveGeometryTier = 'close',
): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(
    1,
    1,
    1,
    TURRET_ANCHOR_RADIAL_SEGMENTS[tier],
    1,
    false,
  );
  geometry.rotateZ(-Math.PI / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
