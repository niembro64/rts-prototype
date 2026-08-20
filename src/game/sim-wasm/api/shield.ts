// Simulation WASM shield API surface.

export interface ShieldSurfacePoolApi {
  /** Reset all surfaces (field surfaces + panel units + panels). */
  clear: () => void;
  /** Number of field surfaces currently stamped. */
  count: () => number;
  /** ── Spherical / infinite-cylinder fields ── */
  setFieldCount: (count: number) => void;
  setField: (
    idx: number,
    id: number,
    ownerEntityId: number,
    prevCenterX: number,
    prevCenterY: number,
    prevCenterZ: number,
    prevAxisEndX: number,
    prevAxisEndY: number,
    prevAxisEndZ: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    axisEndX: number,
    axisEndY: number,
    axisEndZ: number,
    radius: number,
    shape: number,
    plasmaReflectionMode: number,
    rocketReflectionMode: number,
    beamReflectionMode: number,
    laserReflectionMode: number,
  ) => void;
  readonly idPtr: () => number;
  readonly ownerEntityIdPtr: () => number;
  readonly centerXPtr: () => number;
  readonly centerYPtr: () => number;
  readonly centerZPtr: () => number;
  readonly radiusPtr: () => number;
  /** ── Rect-panel shape ── per-mirror-unit pose + broad radius +
   *  slope-aware pivot + [panel_start, panel_count) range; per-panel
   *  arm-length, lateral offset, panel yaw offset, base/top Y in
   *  chassis-local space, and half-width. The Rust kernels walk these
   *  so TS no longer precomputes a per-(turret, candidate) mask. */
  setUnitCount: (count: number) => void;
  setPanelCount: (count: number) => void;
  setUnit: (
    idx: number,
    unitEntityId: number,
    unitX: number,
    unitY: number,
    unitZ: number,
    unitGroundZ: number,
    unitBroadRadius: number,
    shieldPanelYaw: number,
    shieldPanelPitch: number,
    pivotX: number,
    pivotY: number,
    pivotZ: number,
    panelStart: number,
    panelCount: number,
  ) => void;
  setPanel: (
    idx: number,
    armLength: number,
    offsetY: number,
    panelAngle: number,
    baseY: number,
    topY: number,
    halfWidth: number,
    plasmaReflectionMode: number,
    rocketReflectionMode: number,
    beamReflectionMode: number,
    laserReflectionMode: number,
  ) => void;
  setPanelMaterialMode: (reflectionMode: number) => void;
  /** AIM-08.2 — direct-segment shield clearance. Returns 1 if the
   *  segment (sx,sy,sz)→(tx,ty,tz) crosses at most `maxCrossings` shield
   *  surface boundaries, 0 otherwise. `includeSpheres` / `includePanels`
   *  restrict the query to one shape (e.g. a passive panel turret skips
   *  panels so it can't block its own sightline class). Pass -1 as
   *  `excludeOwnerEntityId` to consider every surface. Endpoint grazes
   *  within SHIELD_GRAZE_EPS don't count. */
  readonly clearanceSegment: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    excludeOwnerEntityId: number,
    maxCrossings: number,
    includeSpheres: number,
    includePanels: number,
  ) => number;
  /** AIM-08.2 — ballistic-arc shield clearance against BOTH shapes of the
   *  one force material. Approximates the parabola
   *  `pos = launch + v·t − 0.5·g·ẑ·t²` from 0..flightTime, with the same
   *  boundary-crossing rule as the segment kernel. Returns 1 if total
   *  crossings ≤ `maxCrossings`, 0 otherwise.
   *
   *  Not on a live path: the shipped gate is the straight segment, and this
   *  is the kernel for the descending-leg refinement the design doc leaves
   *  as allowed future work. */
  readonly clearanceArc: (
    launchX: number, launchY: number, launchZ: number,
    launchVx: number, launchVy: number, launchVz: number,
    flightTime: number,
    excludeOwnerEntityId: number,
    maxCrossings: number,
    includeSpheres: number,
    includePanels: number,
  ) => number;
}

/** Phase 10 D.3j — entity-DTO encoder kernels. Byte-equal port of
 *  stateSerializerEntities.ts:serializeEntitySnapshot's output as
 *  encoded by @msgpack/msgpack with `ignoreUndefined: true`. The
 *  port lands one field group per commit; basic envelope here is
 *  the always-present `{id, type, pos, rotation, playerId}` plus
   *  the optional legacy `changedFields` sparse-record mask. Output lands in the
 *  shared D.2 MessagePack writer scratch; read via writerPtr/Len. */
