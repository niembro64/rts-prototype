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
  assertContract(
    Math.abs(anchor.frontX - headRadius) < 1e-6,
    'turret collar must end flush with the head sphere pole — the shortest '
      + 'length that still stops the sphere poking out of its front face',
  );
  assertContract(
    Math.abs(anchor.length - headRadius) < 1e-6 &&
      Math.abs(anchor.centerX - headRadius * 0.5) < 1e-6,
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
      triangleCount > 0 && triangleCount <= 128,
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
        bodyBounds.max.z <= railShoulderZ + 0.25,
      'ribs must meet the rails at the shoulder, not overhang past them',
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
