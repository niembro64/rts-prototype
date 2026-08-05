import {
  createFormikBodyOrnamentGeometry,
  createFormikTurretAnchorGeometry,
  getFormikTurretAnchorProfile,
} from './FormikOrnament3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[formik ornament contract] ${message}`);
}

export function runFormikOrnament3DContractTest(): void {
  const headRadius = 32;
  const anchor = getFormikTurretAnchorProfile(headRadius);
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
    'turret collar must enclose the Formik three-barrel cluster',
  );

  const body = createFormikBodyOrnamentGeometry();
  const collar = createFormikTurretAnchorGeometry();
  try {
    const bodyBounds = body.boundingBox;
    assertContract(bodyBounds !== null, 'body strokes expose bounds');
    assertContract(
      bodyBounds.min.x < -1.25 && bodyBounds.max.x > 0.9,
      'longitudinal strokes span the Formik abdomen through forward lobe',
    );
    assertContract(
      bodyBounds.min.z < -0.5 && bodyBounds.max.z > 0.5,
      'transverse strokes span both shoulders',
    );
    // Extruded triangles, not tubes: the whole kit is a handful of prisms.
    // A round-tube version of the same four strokes cost ~600.
    const triangleCount = body.getAttribute('position').count / 3;
    assertContract(
      triangleCount > 0 && triangleCount <= 256,
      `body ornament must stay a low-poly prism kit — got ${triangleCount} triangles`,
    );
    assertContract(
      body.getIndex() === null,
      'ridge sweeps are authored non-indexed so each facet keeps a hard edge',
    );

    // The ribs terminate ON rail vertices, which is what makes the four
    // strokes read as one frame. If they ever drift apart the joins open up,
    // so pin that the rib endpoints are still inside the rail's own span.
    const railShoulderZ = 0.45;
    assertContract(
      bodyBounds.max.z >= railShoulderZ &&
        bodyBounds.max.z <= railShoulderZ + 0.35,
      'ribs must meet the rails at the shoulder, not overhang past them',
    );

    // The straps must have real thickness — a flat ribbon reads as a decal
    // from the RTS camera, which is the whole reason they are geometry.
    const strapDepth = bodyBounds.max.y - bodyBounds.min.y;
    assertContract(
      strapDepth > 0.75,
      `strap kit must stand off the hull with visible bulk — got ${strapDepth.toFixed(2)}`,
    );

    // ENCLOSED VOLUME. This is the check that matters, and the one whose
    // absence let a fully inverted kit ship: the shells were closed and the
    // bounds were correct, but every triangle was wound backwards, so the
    // renderer culled the outside of every strap and left only interior
    // back-faces. On screen that reads as a set of flat planes, not a solid.
    //
    // Summing (1/6)·a·(b×c) over a closed, outward-wound shell yields its
    // enclosed volume. Inverted winding makes it negative; a flattened
    // ribbon makes it ~0. Both failures are caught by one number.
    const positions = body.getAttribute('position').array;
    let signedVolume = 0;
    for (let i = 0; i + 8 < positions.length; i += 9) {
      const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
      signedVolume += (
        ax * (by * cz - bz * cy) -
        ay * (bx * cz - bz * cx) +
        az * (bx * cy - by * cx)
      ) / 6;
    }
    assertContract(
      signedVolume > 0.6,
      'strap kit must enclose real outward-wound volume — got '
        + `${signedVolume.toFixed(3)} (negative means inverted winding, `
        + 'near zero means it collapsed to flat planes)',
    );

    const collarBounds = collar.boundingBox;
    assertContract(collarBounds !== null, 'turret collar exposes bounds');
    const collarX = collarBounds.max.x - collarBounds.min.x;
    const collarY = collarBounds.max.y - collarBounds.min.y;
    assertContract(
      Math.abs(collarX - 1) < 0.05 && collarY > 1.9,
      'turret collar unit geometry is aligned along local +X',
    );
  } finally {
    body.dispose();
    collar.dispose();
  }
}
