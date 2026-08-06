// TeamOrnament3D — the team-coloured kit every host in the game wears.
//
// Team colour is carried by ADDED GEOMETRY, never by recolouring a body: the
// body keeps the player colour and the ornament carries the ally-team colour,
// so a unit reads as its alliance without giving up its owner. See
// "Team ornamentation is one kit vocabulary on every host" in
// budget_design_philosophy.html.
//
// There is exactly one kit design — swept shoulder rails tied together by
// arched cross ribs, seated into the hull with a spine ridge, plus a collar
// ringing every turret where its barrels emerge. The Formik is where that kit
// was drawn, and its proportions are kept here as the REFERENCE PROFILE, but
// nothing branches on the Formik: the rail and rib shapes are normalized, and
// fitting them to a host's own extents is what dresses a scout, a Queen, a
// factory and a torpedo tower in the same design.
//
// The kit is authored in the HOST'S OWN SPACE and instanced with a single
// uniform scale, rather than authored once and stretched per instance. That
// costs one pool per distinct body profile and buys the thing that matters:
// the strap's cross-section stays square. Stretching one normalized kit to fit
// a long hull squashes the section by the hull's aspect ratio, and the straps
// stop reading as bolted-on armour and start reading as painted lines.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import { BAND_CAP_ZONES } from './SurfaceChart3D';
import { remapChartedCylinderUvs } from './ChartedCylinderUv3D';

/**
 * The turret collar runs from the turret's own centre out to the head
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
const TURRET_COLLAR_BACK_X_FRAC = 0;
const TURRET_COLLAR_FRONT_X_FRAC = 1.18;
const TURRET_COLLAR_RADIUS_FRAC = 0.76;

/**
 * Collar sides per detail tier. The collar is a plain cylinder, so its
 * silhouette cost is entirely in this number and it can be tuned freely:
 * 16 reads as round up close, 8 is the shape shipped before this ladder
 * existed, and 4 is a square — which is all that survives a few pixels
 * wide anyway. Triangles come out at 4n (2 per side quad, n per cap).
 */
const TURRET_COLLAR_RADIAL_SEGMENTS: Record<PrimitiveGeometryTier, number> = {
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
 *
 * The ladder never sheds the TEAM COLOUR, which is the one thing the kit
 * exists to carry; it only sheds bulk.
 */
type StrapTierPlan = { section: 'strap' | 'fin'; ribs: boolean; railSamples: number };
const STRAP_TIER_PLAN: Record<PrimitiveGeometryTier, StrapTierPlan> = {
  close: { section: 'strap', ribs: true, railSamples: 6 },
  mid: { section: 'fin', ribs: true, railSamples: 6 },
  far: { section: 'fin', ribs: false, railSamples: 3 },
};

export type TurretCollarProfile = {
  centerX: number;
  length: number;
  radius: number;
  backX: number;
  frontX: number;
};

export function getTurretCollarProfile(headRadius: number): TurretCollarProfile {
  const backX = headRadius * TURRET_COLLAR_BACK_X_FRAC;
  const frontX = headRadius * TURRET_COLLAR_FRONT_X_FRAC;
  return {
    centerX: (backX + frontX) * 0.5,
    length: frontX - backX,
    radius: headRadius * TURRET_COLLAR_RADIUS_FRAC,
    backX,
    frontX,
  };
}

// ── The kit's shape, normalized ──────────────────────────────────────────
//
// One rail sample per entry, running back to front. `t` is the fraction along
// the host's fore-aft span, `y` is a fraction of its top height, and `z` a
// fraction of its half-width. These are the Formik's authored rail, divided
// through by the Formik's own extents — so handing this the Formik's profile
// reproduces the original kit exactly, and handing it anything else fits the
// same line to that hull.

type RailSample = { t: number; y: number; z: number };

const RAIL_SHAPE: readonly RailSample[] = [
  { t: 0.000, y: 0.966, z: 0.533 },
  { t: 0.199, y: 1.000, z: 1.000 },
  { t: 0.456, y: 0.703, z: 0.889 },
  { t: 0.646, y: 0.821, z: 0.822 },
  { t: 0.836, y: 0.697, z: 0.533 },
  { t: 1.000, y: 0.524, z: 0.200 },
];

/** Cross-ribs, as (rail sample index, apex height as a fraction of top). The
 *  ribs START and END on rail vertices — same position, same outward
 *  direction — so the strokes meet flush and the whole thing reads as one
 *  connected frame instead of four separate decals. */
const RIB_SHAPE: readonly (readonly [number, number])[] = [
  [1, 1.145],
  [3, 0.952],
];

/** Height of the spine the outward direction radiates from, as a fraction of
 *  the host's top. Every ridge's apex points away from this axis, so the frame
 *  reads as bolted onto the hull rather than laid flat across it. */
const SPINE_Y_FRAC = 0.345;

/** Cross-section of a SPIKY STRAP: a broad band lifted off the hull with a
 *  spine ridge running down it. A bare triangle read as a thin fin from the
 *  RTS camera; the band gives the ornament real mass, and the spine keeps
 *  the hard specular line that made the triangle read well up close.
 *
 *  All four are in the host's own units and are multiplied by the profile's
 *  `section`, so a scout's straps and a Queen's straps are each proportionate
 *  to the body they are bolted to. */
const RIDGE_HALF_WIDTH = 0.22;
/** How far the strap's flat shoulders stand off the hull — its thickness.
 *  This is the number that decides whether the kit reads as armour plate or
 *  as paint; it wants to be a real fraction of the spike, not a hairline. */
const RIDGE_STRAP_THICKNESS = 0.16;
/** How far the spine rises above those shoulders. */
const RIDGE_SPIKE_HEIGHT = 0.22;
/** How far the base sinks under the surface, so the strap looks seated. */
const RIDGE_SINK = 0.06;

/**
 * A host's ornament fit: where the rails run on THIS body.
 *
 * Everything is in the host's own instancing space — unit-radius-1 for units,
 * world units for structures — and the kit is scaled by one uniform factor
 * when it is placed.
 */
export type HostOrnamentProfile = {
  /** Rearmost rail point along the host's forward axis. */
  backX: number;
  /** Foremost rail point. */
  frontX: number;
  /** Height the rails ride at — the body's own top. */
  topY: number;
  /** Lateral half-span the shoulders reach. */
  halfWidth: number;
  /** Multiplier on the strap's cross-section. 1 is the Formik's. */
  section: number;
};

/** The Formik's own fit — the reference every other host's kit is the same
 *  design as. Kept explicit so the reference is a value you can read and
 *  compare against, not a shape buried in a table of fractions. */
export const REFERENCE_ORNAMENT_PROFILE: HostOrnamentProfile = {
  backX: -1.31,
  frontX: 0.95,
  topY: 1.45,
  halfWidth: 0.45,
  section: 1,
};

/**
 * Fit the kit to a host whose body occupies the given extents.
 *
 * The insets are what keep the rails ON the hull rather than hanging off its
 * ends: a rail that ran the full length of the silhouette would leave both
 * caps floating in air at the nose and tail, where the body has already
 * curved away. The fractions below are the Formik's own — its body spans
 * roughly -1.6 to 1.2 and the rails sit inside that — so the reference unit
 * lands back on its authored kit and everything else is fitted the same way.
 */
export function hostOrnamentProfile(bounds: {
  minX: number;
  maxX: number;
  halfWidth: number;
  topY: number;
}): HostOrnamentProfile {
  const backX = bounds.minX * 0.82;
  const frontX = bounds.maxX * 0.79;
  const halfWidth = Math.max(1e-3, bounds.halfWidth * 0.66);
  const topY = Math.max(1e-3, bounds.topY);
  // The section scales with the SMALLER of the body's two cross-body extents.
  // Scaling it off the length would give a long thin hull straps wider than
  // the hull itself.
  const section = Math.max(0.15, Math.min(halfWidth / 0.45, topY / 1.45));
  return { backX, frontX, topY, halfWidth, section };
}

/** Pool identity for a profile. Two hosts whose kits would be visually
 *  identical must share one pool, or a roster of near-identical bodies turns
 *  into a roster of draw calls. Quantized for exactly that reason. */
export function ornamentProfileKey(profile: HostOrnamentProfile): string {
  const q = (value: number): string => value.toFixed(2);
  return `${q(profile.backX)}/${q(profile.frontX)}/${q(profile.topY)}`
    + `/${q(profile.halfWidth)}/${q(profile.section)}`;
}

const _tangent = new THREE.Vector3();
const _outward = new THREE.Vector3();
const _side = new THREE.Vector3();

/** Outward from the hull spine, with the along-body component removed. */
function outwardAt(
  point: THREE.Vector3,
  spineY: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.set(0, point.y - spineY, point.z);
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
  spineY: number,
  scale: number,
): THREE.BufferGeometry {
  const halfWidth = RIDGE_HALF_WIDTH * scale;
  const shoulder = RIDGE_STRAP_THICKNESS * scale;
  const spike = RIDGE_SPIKE_HEIGHT * scale;
  const sink = RIDGE_SINK * scale;
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < path.length; i++) {
    const point = path[i];
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    _tangent.subVectors(next, prev);
    if (_tangent.lengthSq() < 1e-8) _tangent.set(1, 0, 0);
    _tangent.normalize();
    outwardAt(point, spineY, _outward);
    // Re-orthogonalize so a curving path cannot shear the cross-section.
    _side.crossVectors(_outward, _tangent);
    if (_side.lengthSq() < 1e-8) _side.set(0, 0, 1);
    _side.normalize();
    // Spine first, then around the section in one consistent cyclic order
    // so every quad below is wound the same way and normals face outward.
    if (section === 'fin') {
      // Spine plus the two sunk base corners: the strap's outline without
      // its thickness, for tiers where that thickness is sub-pixel.
      rings.push([
        point.clone().addScaledVector(_outward, shoulder + spike),
        point.clone().addScaledVector(_side, halfWidth)
          .addScaledVector(_outward, -sink),
        point.clone().addScaledVector(_side, -halfWidth)
          .addScaledVector(_outward, -sink),
      ]);
      continue;
    }
    rings.push([
      point.clone().addScaledVector(_outward, shoulder + spike),
      point.clone().addScaledVector(_side, halfWidth)
        .addScaledVector(_outward, shoulder),
      point.clone().addScaledVector(_side, halfWidth)
        .addScaledVector(_outward, -sink),
      point.clone().addScaledVector(_side, -halfWidth)
        .addScaledVector(_outward, -sink),
      point.clone().addScaledVector(_side, -halfWidth)
        .addScaledVector(_outward, shoulder),
    ]);
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const ringSize = rings[0].length;

  // A swept ribbon carries its own parameterization for free: u is arc length
  // along the path, v is position around the cross-section. That is exactly
  // what the livery chart needs, so the piping band lands along the run of the
  // strap without any unwrap step. Arc length rather than ring index keeps the
  // piping evenly spaced when the rail's samples are not.
  const arc: number[] = [0];
  for (let i = 1; i < rings.length; i++) {
    arc.push(arc[i - 1] + rings[i][0].distanceTo(rings[i - 1][0]));
  }
  const totalArc = arc[arc.length - 1] || 1;
  const ringU = arc.map((value) => value / totalArc);
  const ringV = (k: number): number => k / ringSize;

  const push = (v: THREE.Vector3, u: number, vv: number): void => {
    positions.push(v.x, v.y, v.z);
    uvs.push(u, vv);
  };
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    const ua = ringU[i];
    const ub = ringU[i + 1];
    for (let k = 0; k < ringSize; k++) {
      const k2 = (k + 1) % ringSize;
      const va = ringV(k);
      // The wrap-around quad must not send v backwards to 0, or the band is
      // sampled in reverse across that one facet.
      const vb = k2 === 0 ? 1 : ringV(k2);
      // Wound so the face normal points AWAY from the sweep axis. Reversed,
      // the renderer culls the outside of every strap and leaves only the
      // interior back-faces, which reads as a set of flat planes rather
      // than a solid — see the signed-volume check in the contract test.
      push(a[k], ua, va); push(b[k], ub, va); push(a[k2], ua, vb);
      push(a[k2], ua, vb); push(b[k], ub, va); push(b[k2], ub, vb);
    }
  }
  // End caps keep the ridge solid where it terminates in open air. Where a
  // rib meets a rail the cap is buried inside the rail and costs nothing
  // visually.
  const first = rings[0];
  const last = rings[rings.length - 1];
  for (let k = 1; k + 1 < ringSize; k++) {
    // Start cap faces back along the sweep, end cap faces forward.
    push(first[0], 0, ringV(0)); push(first[k], 0, ringV(k)); push(first[k + 1], 0, ringV(k + 1));
    push(last[0], 1, ringV(0)); push(last[k + 1], 1, ringV(k + 1)); push(last[k], 1, ringV(k));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** Shoulder rail path for one side, fitted to a profile. The rib paths below
 *  reuse these exact points, which is what welds the frame into a single
 *  piece. */
function railPath(
  profile: HostOrnamentProfile,
  side: -1 | 1,
  samples: number,
): THREE.Vector3[] {
  const span = profile.frontX - profile.backX;
  const full = RAIL_SHAPE.map((sample) => new THREE.Vector3(
    profile.backX + span * sample.t,
    profile.topY * sample.y,
    side * profile.halfWidth * sample.z,
  ));
  if (samples >= full.length) return full;
  // Keep both ends and drop interior samples evenly, so a coarser rail
  // still spans tail to nose on the same line.
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < samples; i++) {
    out.push(full[Math.round((i * (full.length - 1)) / (samples - 1))]);
  }
  return out;
}

/**
 * The host's team-coloured exoskeleton: two shoulder rails tied together by
 * two arched cross-ribs.
 *
 * Every ridge is an extruded section whose spine faces away from the hull, so
 * the kit reads as a hard chitinous frame rather than piping.
 *
 * Authored in the host's own space and instanced by TeamTrimRenderer3D.
 */
export function createHostOrnamentGeometry(
  profile: HostOrnamentProfile = REFERENCE_ORNAMENT_PROFILE,
  tier: PrimitiveGeometryTier = 'close',
): THREE.BufferGeometry {
  const plan = STRAP_TIER_PLAN[tier];
  const spineY = profile.topY * SPINE_Y_FRAC;
  const left = railPath(profile, -1, plan.railSamples);
  const right = railPath(profile, 1, plan.railSamples);
  const pieces: THREE.BufferGeometry[] = [
    ridge(left, plan.section, spineY, profile.section),
    ridge(right, plan.section, spineY, profile.section),
  ];

  if (plan.ribs) {
    for (const [railIndex, apexY] of RIB_SHAPE) {
      pieces.push(ridge([
        left[railIndex].clone(),
        new THREE.Vector3(left[railIndex].x, profile.topY * apexY, 0),
        right[railIndex].clone(),
      ], plan.section, spineY, profile.section));
    }
  }

  const geometry = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  if (geometry === null) {
    throw new Error('Failed to merge host team ornament geometry');
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Unit cylinder with its long axis along the turret/barrel +X direction,
 * at this tier's side count (see TURRET_COLLAR_RADIAL_SEGMENTS).
 *
 * This deliberately does NOT go through the shared `turret` cylinder role:
 * that role's counts are tuned for barrels, and the collar is a much larger
 * silhouette that wants its own ladder — 16 up close where it reads as a
 * ring around the head, down to a plain square once it is a few pixels
 * wide.
 */
export function createTurretCollarGeometry(
  tier: PrimitiveGeometryTier = 'close',
): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(
    1,
    1,
    1,
    TURRET_COLLAR_RADIAL_SEGMENTS[tier],
    1,
    false,
  );
  // BEFORE the rotate. The cap remap identifies faces by their normal pointing
  // along the cylinder's axis, and rotateZ turns that axis from +Y to +X — run
  // it afterwards and every vertex looks like wall.
  const capZone = BAND_CAP_ZONES.liveryChevron;
  if (capZone !== undefined) remapChartedCylinderUvs(geometry, capZone);
  geometry.rotateZ(-Math.PI / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
