import type * as THREE from 'three';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import {
  REFERENCE_ORNAMENT_PROFILE,
  createHostOrnamentGeometry,
  createTurretCollarGeometry,
  getTurretCollarProfile,
  hostOrnamentProfile,
  ornamentProfileKey,
} from './TeamOrnament3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[team ornament contract] ${message}`);
}

const TIERS: readonly PrimitiveGeometryTier[] = ['close', 'mid', 'far'];

/** Triangle ceilings per tier. The kit is TRIM: it may never cost more than
 *  the thing it decorates. For reference, at each tier the Formik body is
 *  504 / 192 / 48 triangles and its turret (head + three barrels) is
 *  236 / 84 / 42. */
const STRAP_TRIANGLE_BUDGET: Record<PrimitiveGeometryTier, number> = {
  close: 256,
  mid: 128,
  far: 48,
};

/** A capped cylinder of N radial segments is 4N triangles: 2N on the side,
 *  N per cap. The collar's own ladder is 16 / 8 / 4 sides. */
const COLLAR_TRIANGLES: Record<PrimitiveGeometryTier, number> = {
  close: 64,
  mid: 32,
  far: 16,
};

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return index !== null
    ? index.count / 3
    : geometry.getAttribute('position').count / 3;
}

/**
 * ENCLOSED VOLUME. This is the check that matters, and the one whose absence
 * let a fully inverted kit ship: the shells were closed and the bounds were
 * correct, but every triangle was wound backwards, so the renderer culled the
 * outside of every strap and left only interior back-faces. On screen that
 * reads as a set of flat planes, not a solid.
 *
 * Summing (1/6)·a·(b×c) over a closed, outward-wound shell yields its enclosed
 * volume. Inverted winding makes it negative; a flattened ribbon makes it ~0.
 * Both failures are caught by one number.
 */
function signedVolume(geometry: THREE.BufferGeometry): number {
  const positions = geometry.getAttribute('position').array;
  let volume = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    volume += (
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx)
    ) / 6;
  }
  return volume;
}

export function runTeamOrnament3DContractTest(): void {
  const headRadius = 32;
  const anchor = getTurretCollarProfile(headRadius);
  // One cylinder, centre of the turret out to the head sphere's pole.
  assertContract(
    anchor.backX === 0,
    'turret collar must start at the turret centre, not partway along it',
  );
  // Past the pole, not level with it: a cap sitting exactly on the sphere's
  // forward pole is tangent to it, and two surfaces meeting at a point
  // z-fight into the sphere appearing to poke through the collar face.
  assertContract(
    anchor.frontX > headRadius * 1.05,
    'turret collar must clear the head sphere pole, not sit tangent to it',
  );
  assertContract(
    Math.abs(anchor.length - (anchor.frontX - anchor.backX)) < 1e-6 &&
      Math.abs(anchor.centerX - (anchor.frontX + anchor.backX) * 0.5) < 1e-6,
    'collar length and centre must follow from its two ends',
  );
  assertContract(
    anchor.radius >= headRadius * 0.7,
    'turret collar must enclose the barrel cluster it rings',
  );

  // The profile is tier-independent: only the side count changes with LOD, so
  // a unit crossing a rung keeps the exact same collar silhouette and mount.
  let previousStrapTriangles = Infinity;
  let previousCollarTriangles = Infinity;

  for (const tier of TIERS) {
    const body = createHostOrnamentGeometry(REFERENCE_ORNAMENT_PROFILE, tier);
    const collar = createTurretCollarGeometry(tier);
    try {
      const bodyBounds = body.boundingBox;
      assertContract(bodyBounds !== null, `body strokes expose bounds (${tier})`);
      // Every rung keeps the same silhouette envelope — the kit gets cheaper,
      // never shorter, so a unit crossing a rung doesn't visibly grow or
      // shrink its trim.
      assertContract(
        bodyBounds.min.x < -1.25 && bodyBounds.max.x > 0.9,
        `longitudinal strokes span the Formik abdomen through forward lobe (${tier})`,
      );
      assertContract(
        bodyBounds.min.z < -0.5 && bodyBounds.max.z > 0.5,
        `transverse strokes span both shoulders (${tier})`,
      );

      // Extruded prisms, not tubes: the whole kit is a handful of straps.
      // A round-tube version of the same four strokes cost ~600 at close.
      const strapTriangles = triangleCount(body);
      assertContract(
        strapTriangles > 0 && strapTriangles <= STRAP_TRIANGLE_BUDGET[tier],
        `body ornament must stay inside its ${tier} budget of `
          + `${STRAP_TRIANGLE_BUDGET[tier]} triangles — got ${strapTriangles}`,
      );
      // An LOD ladder that doesn't descend isn't a ladder. This is what
      // catches a tier plan that silently falls back to the close section.
      assertContract(
        strapTriangles < previousStrapTriangles,
        `body ornament must get strictly cheaper at ${tier} — got `
          + `${strapTriangles} against ${previousStrapTriangles}`,
      );
      previousStrapTriangles = strapTriangles;

      assertContract(
        body.getIndex() === null,
        `ridge sweeps are authored non-indexed so each facet keeps a hard edge (${tier})`,
      );

      // The ribs terminate ON rail vertices, which is what makes the four
      // strokes read as one frame. If they ever drift apart the joins open up,
      // so pin that the rib endpoints are still inside the rail's own span.
      const railShoulderZ = 0.45;
      assertContract(
        bodyBounds.max.z >= railShoulderZ &&
          bodyBounds.max.z <= railShoulderZ + 0.35,
        `ribs must meet the rails at the shoulder, not overhang past them (${tier})`,
      );

      // The straps must have real thickness — a flat ribbon reads as a decal
      // from the RTS camera, which is the whole reason they are geometry. The
      // far tier trades the strap's flat top for a fin, but the standoff
      // height it sweeps through is the same.
      const strapDepth = bodyBounds.max.y - bodyBounds.min.y;
      assertContract(
        strapDepth > 0.75,
        `strap kit must stand off the hull with visible bulk at ${tier} — `
          + `got ${strapDepth.toFixed(2)}`,
      );

      const volume = signedVolume(body);
      // Solid at every rung; the close tier additionally has to carry the
      // full strap section, which is most of the kit's mass.
      const minimumVolume = tier === 'close' ? 0.6 : 0.2;
      assertContract(
        volume > minimumVolume,
        `strap kit must enclose real outward-wound volume at ${tier} — got `
          + `${volume.toFixed(3)} (negative means inverted winding, near zero `
          + 'means it collapsed to flat planes)',
      );

      const collarTriangles = triangleCount(collar);
      assertContract(
        collarTriangles === COLLAR_TRIANGLES[tier],
        `turret collar must be a ${COLLAR_TRIANGLES[tier] / 4}-sided cylinder `
          + `at ${tier} — got ${collarTriangles} triangles`,
      );
      assertContract(
        collarTriangles < previousCollarTriangles,
        `turret collar must get strictly cheaper at ${tier}`,
      );
      previousCollarTriangles = collarTriangles;

      const collarBounds = collar.boundingBox;
      assertContract(collarBounds !== null, `turret collar exposes bounds (${tier})`);
      const collarX = collarBounds.max.x - collarBounds.min.x;
      const collarY = collarBounds.max.y - collarBounds.min.y;
      assertContract(
        Math.abs(collarX - 1) < 0.05 && collarY > 1.9,
        `turret collar unit geometry is aligned along local +X (${tier})`,
      );
    } finally {
      body.dispose();
      collar.dispose();
    }
  }

  checkKitFitsEveryHost();
}

/**
 * ONE KIT, MANY FITS.
 *
 * The kit is a design, not a model: the same rails and ribs have to land on a
 * scout, a Queen and a factory, each time inside that host's own envelope. The
 * failure this catches is a kit authored against one body and instanced onto
 * every other — rails hanging off the nose of a short hull, or buried inside a
 * long one — which is exactly what a single normalized kit stretched per
 * instance produces.
 */
function checkKitFitsEveryHost(): void {
  const hosts: { label: string; minX: number; maxX: number; halfWidth: number; topY: number }[] = [
    { label: 'reference walker', minX: -1.6, maxX: 1.2, halfWidth: 0.68, topY: 1.45 },
    { label: 'stubby scout', minX: -0.9, maxX: 0.9, halfWidth: 0.9, topY: 0.7 },
    { label: 'long hull', minX: -2.4, maxX: 2.4, halfWidth: 0.6, topY: 0.9 },
    { label: 'structure box', minX: -30, maxX: 30, halfWidth: 30, topY: 22 },
  ];
  const keys = new Set<string>();
  for (const host of hosts) {
    const profile = hostOrnamentProfile(host);
    keys.add(ornamentProfileKey(profile));
    const geometry = createHostOrnamentGeometry(profile, 'close');
    try {
      const bounds = geometry.boundingBox;
      assertContract(bounds !== null, `${host.label} kit exposes bounds`);
      // Inside the host's own silhouette, both ends and both shoulders. The
      // slack is the strap's own section, which legitimately stands proud.
      const slack = profile.section * 0.5;
      assertContract(
        bounds.min.x >= host.minX - slack && bounds.max.x <= host.maxX + slack,
        `${host.label} kit runs past the hull it is bolted to `
          + `(${bounds.min.x.toFixed(2)}..${bounds.max.x.toFixed(2)} against `
          + `${host.minX}..${host.maxX})`,
      );
      assertContract(
        Math.abs(bounds.min.z) <= host.halfWidth + slack &&
          bounds.max.z <= host.halfWidth + slack,
        `${host.label} kit overhangs the hull's shoulders`,
      );
      // It has to actually reach the roof — a kit that collapsed toward the
      // spine would still pass the containment checks above.
      assertContract(
        bounds.max.y > host.topY * 0.7,
        `${host.label} kit must ride the body's top, not sink into it `
          + `(${bounds.max.y.toFixed(2)} against a top of ${host.topY})`,
      );
      // The straps keep a real section at every size, or the kit reads as
      // paint on a big host and as a lump on a small one.
      const strapDepth = bounds.max.y - bounds.min.y;
      assertContract(
        strapDepth > profile.section * 0.5,
        `${host.label} kit lost its section (${strapDepth.toFixed(2)})`,
      );
    } finally {
      geometry.dispose();
    }
  }
  assertContract(
    keys.size === hosts.length,
    'distinct body shapes must resolve to distinct ornament pools — two '
      + 'shapes sharing a key would wear each other\'s kit',
  );
  // ...and the converse: the same shape must land in ONE pool, or a roster of
  // identical units becomes a roster of draw calls.
  assertContract(
    ornamentProfileKey(hostOrnamentProfile(hosts[0]))
      === ornamentProfileKey(hostOrnamentProfile({ ...hosts[0] })),
    'identical body extents must resolve to one ornament pool',
  );
}
