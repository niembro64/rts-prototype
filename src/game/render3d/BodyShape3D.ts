// BodyShape3D — per-unit-renderer extruded chassis geometry.
//
// Takes each 2D unit body shape (scout = diamond, brawl = wide diamond,
// tank = pentagon, burst = triangle, mortar = hexagon, hippo = rectangle,
// everyone else = circle) and extrudes it upward into a prism, matching
// the 2D silhouette.
//
// Geometries are cached per renderer ID. Each is built at a "unit-radius"
// of 1 and extruded to CHASSIS_HEIGHT along Y. Call sites scale the mesh
// X/Z by the unit's actual radius; Y scale stays 1 to preserve chassis
// height. Each shape is already rotated so the chassis is at rotation=0
// when the unit group is at rotation=0 — the `rotation` field in the 2D
// drawPolygon call (e.g. scout's + π/4) is baked into the geometry.

import * as THREE from 'three';

/** Renderer IDs — these are the `renderer` field on UnitBlueprint. */
export type BodyRendererId =
  | 'scout' | 'brawl' | 'tank' | 'burst' | 'mortar'
  | 'hippo'
  | 'beam' | 'arachnid' | 'snipe' | 'commander' | 'forceField' | 'loris';

/** A part of a composite body (e.g. arachnid abdomen + prosoma). Offsets are
 *  in unit-radius-1 space along the unit's forward axis; positive = forward,
 *  negative = backward. All composites so far are axially symmetric so no
 *  lateral offset is needed. */
type CompositePart =
  | { kind: 'circle'; offsetForward: number; radiusFrac: number }
  | {
      kind: 'oval';
      offsetForward: number;
      /** Forward half-extent (along the unit's +X axis). */
      xFrac: number;
      /** Lateral half-extent (perpendicular to +X, in world Z). */
      zFrac: number;
    };

type ShapeSpec =
  | { kind: 'polygon'; sides: number; radiusFrac: number; rotation: number }
  | { kind: 'rect'; widthFrac: number; lengthFrac: number }
  | { kind: 'circle'; radiusFrac: number }
  /** Single ellipse — e.g. the tick's whole body. `xFrac` is the forward
   *  half-extent, `zFrac` is the lateral half-extent. */
  | { kind: 'oval'; xFrac: number; zFrac: number }
  /** Multi-segment body (e.g. arachnid spider = big abdomen + small
   *  cephalothorax). Extruded as a single geometry via ExtrudeGeometry's
   *  array-of-shapes overload. */
  | { kind: 'composite'; parts: CompositePart[] };

/** Shape table derived from each 2D unit renderer's body. Values mirror
 *  the 2D `r * 0.XX` conventions; composite offsets are in unit-radius-1
 *  units along forward/backward. */
const SHAPES: Record<BodyRendererId, ShapeSpec> = {
  // 2D: drawPolygon(x, y, r*0.55, 4, bodyRot + π/4) → diamond rotated 45°
  scout:      { kind: 'polygon', sides: 4, radiusFrac: 0.55, rotation: Math.PI / 4 },
  // 2D: drawPolygon(x, y, r*0.8, 4, bodyRot) → wide square/diamond
  brawl:      { kind: 'polygon', sides: 4, radiusFrac: 0.8,  rotation: 0 },
  // 2D: drawPolygon(x, y, r*0.85, 5, bodyRot) → pentagon hull
  tank:       { kind: 'polygon', sides: 5, radiusFrac: 0.85, rotation: 0 },
  // 2D: drawPolygon(x, y, r*0.6, 3, bodyRot + π) → triangle (pointing back)
  burst:      { kind: 'polygon', sides: 3, radiusFrac: 0.6,  rotation: Math.PI },
  // 2D: drawPolygon(x, y, r*0.55, 6, bodyRot) → hexagonal body
  mortar:     { kind: 'polygon', sides: 6, radiusFrac: 0.55, rotation: 0 },
  // 2D: drawOrientedRect(x, y, r*0.7 /*length*/, r*1.6 /*width*/, bodyRot).
  // The hippo hull is SHORT along forward (length=0.7) and WIDE sideways
  // (width=1.6) — the opposite of what a naive reading of the literals
  // suggests. In our rect spec, lengthFrac is the forward axis, widthFrac
  // the lateral axis.
  hippo:      { kind: 'rect', lengthFrac: 0.7, widthFrac: 1.6 },
  // 2D BeamRenderer (tarantula): oval abdomen behind + circle cephalothorax
  // in front. abdRx=0.65 (lateral), abdRy=0.9 (along body); abdomen offset
  // (bodyOff − 0.95) ≈ −0.65; cephalothorax radius 0.6 at bodyOff ≈ 0.3.
  beam: {
    kind: 'composite',
    parts: [
      { kind: 'oval',   offsetForward: -0.65, xFrac: 0.9,  zFrac: 0.65 },
      { kind: 'circle', offsetForward:  0.30, radiusFrac: 0.6 },
    ],
  },
  // 2D ArachnidRenderer (widow): massive abdomen behind (r=1.15, offset
  // -1.1) + smaller prosoma (r=0.55, forward offset +0.3).
  arachnid: {
    kind: 'composite',
    parts: [
      { kind: 'circle', offsetForward: -1.1, radiusFrac: 1.15 },
      { kind: 'circle', offsetForward:  0.3, radiusFrac: 0.55 },
    ],
  },
  // 2D SnipeRenderer (tick): single oval idiosoma. rx=0.35 (lateral),
  // ry=0.5 (along body). No separate cephalothorax lobe worth modeling.
  snipe: { kind: 'oval', xFrac: 0.5, zFrac: 0.35 },
  // 2D CommanderRenderer: oval rear (lateral=0.65, forward=0.7, offset
  // -0.45) + front circle prosoma (r=0.5, offset +0.4).
  commander: {
    kind: 'composite',
    parts: [
      { kind: 'oval',   offsetForward: -0.45, xFrac: 0.7, zFrac: 0.65 },
      { kind: 'circle', offsetForward:  0.4,  radiusFrac: 0.5 },
    ],
  },
  forceField: { kind: 'circle', radiusFrac: 0.55 },
  loris:      { kind: 'circle', radiusFrac: 0.55 },
};

export type BodyGeomEntry = {
  geometry: THREE.BufferGeometry;
  /** Horizontal scale multiplier to apply to the mesh so the visual radius
   *  comes out correct. For polygons/circles: radius · radiusFrac. For
   *  rects: separate X and Z handled by `scaleX` and `scaleZ` (same
   *  convention, but different values). The mesh code uses these directly. */
  radiusFrac: number;
  /** For rectangles only — the X-axis (forward) scale fraction. */
  scaleX?: number;
  /** For rectangles only — the Z-axis (sideways) scale fraction. */
  scaleZ?: number;
};

const CACHE: Map<string, BodyGeomEntry> = new Map();

/** Look up or build an extruded chassis geometry for a 2D renderer ID. The
 *  geometry sits from y=0 to y=height and is scaled horizontally by the
 *  caller using `mesh.scale.set(radius · radiusFrac, 1, radius · radiusFrac)`
 *  for polygons/circles. Rectangles use scaleX/scaleZ explicitly. */
export function getBodyGeom(
  renderer: string,
  height: number,
): BodyGeomEntry {
  const spec = SHAPES[renderer as BodyRendererId] ?? SHAPES.arachnid;
  const key = `${renderer}|${height}`;
  const cached = CACHE.get(key);
  if (cached) return cached;

  // `shapes` can be a single Shape or Shape[]; ExtrudeGeometry accepts both.
  let shapes: THREE.Shape | THREE.Shape[];
  let radiusFrac = 1;
  let scaleX: number | undefined;
  let scaleZ: number | undefined;

  if (spec.kind === 'polygon') {
    shapes = buildPolygonShape(spec.sides, 1, spec.rotation);
    radiusFrac = spec.radiusFrac;
  } else if (spec.kind === 'circle') {
    shapes = buildCircleShape(1, 24);
    radiusFrac = spec.radiusFrac;
  } else if (spec.kind === 'oval') {
    // Oval = unit circle with separate X/Z scale. Caller scales mesh by
    // radius · xFrac (forward) and radius · zFrac (lateral).
    shapes = buildCircleShape(1, 24);
    radiusFrac = 1;
    scaleX = spec.xFrac;
    scaleZ = spec.zFrac;
  } else if (spec.kind === 'composite') {
    // Multi-segment body. Each part's vertices are baked in at unit-
    // radius-1 coordinates (with its declared offset already applied),
    // so the mesh's uniform `radius` scale enlarges everything correctly.
    shapes = buildCompositeShapes(spec.parts);
    radiusFrac = 1;
  } else {
    // Rectangle — unit shape is ±0.5 on each axis; caller scales by
    // radius · lengthFrac (forward = X) and radius · widthFrac (side = Z).
    shapes = buildRectShape(1, 1);
    radiusFrac = 1;
    scaleX = spec.lengthFrac;
    scaleZ = spec.widthFrac;
  }

  const geom = new THREE.ExtrudeGeometry(shapes, {
    depth: height,
    bevelEnabled: false,
    steps: 1,
  });
  // ExtrudeGeometry extrudes along +Z with the shape in the XY plane. Rotate
  // -π/2 around X so the shape lands on the XZ ground plane and the extrude
  // direction becomes +Y (up).
  geom.rotateX(-Math.PI / 2);

  const entry: BodyGeomEntry = {
    geometry: geom,
    radiusFrac,
    scaleX,
    scaleZ,
  };
  CACHE.set(key, entry);
  return entry;
}

function buildPolygonShape(sides: number, radius: number, rotation: number): THREE.Shape {
  // Matches 2D drawPolygon: vertices at angle = rotation + (i/sides)·2π,
  // with X = cos(a)·r, Y = sin(a)·r. That XY plane becomes XZ after the
  // -π/2 rotation around X done by getBodyGeom.
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    pts.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return new THREE.Shape(pts);
}

function buildCircleShape(radius: number, segments: number): THREE.Shape {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return new THREE.Shape(pts);
}

/** Build a list of Shapes for a composite body (e.g. abdomen + prosoma).
 *  Each part's vertices are pre-translated by its `offsetForward` so
 *  ExtrudeGeometry extrudes the full composite in one call without needing
 *  per-part transforms. All offsets are along shape-X (the unit's forward
 *  axis after the extrude+rotate pipeline). */
function buildCompositeShapes(parts: CompositePart[]): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  for (const p of parts) {
    const pts: THREE.Vector2[] = [];
    const segments = 24;
    if (p.kind === 'circle') {
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push(new THREE.Vector2(
          p.offsetForward + Math.cos(a) * p.radiusFrac,
          Math.sin(a) * p.radiusFrac,
        ));
      }
    } else {
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push(new THREE.Vector2(
          p.offsetForward + Math.cos(a) * p.xFrac,
          Math.sin(a) * p.zFrac,
        ));
      }
    }
    shapes.push(new THREE.Shape(pts));
  }
  return shapes;
}

function buildRectShape(width: number, length: number): THREE.Shape {
  // Same extents 2D drawOrientedRect uses — half-extents in both directions.
  const hw = width / 2;
  const hl = length / 2;
  return new THREE.Shape([
    new THREE.Vector2(-hl, -hw),
    new THREE.Vector2( hl, -hw),
    new THREE.Vector2( hl,  hw),
    new THREE.Vector2(-hl,  hw),
  ]);
}

/** One 3D edge slab that represents a side of the unit's extruded body.
 *  Centered at (x, z) in unit-local coords, `length` along the edge
 *  direction, `thickness` along the normal, standing full chassis height.
 *  `yaw` is the rotation around Y that lays the edge tangent to the shape. */
export type BodyEdgeTemplate = {
  x: number;
  z: number;
  yaw: number;
  length: number;
  /** Depth (perpendicular to the edge, in world units). */
  thickness: number;
};

/** Approximate the 3D chassis as a set of edge slabs, one per polygon side
 *  (or four sides for rectangles, or N tangent chunks for circles). Each
 *  edge sits at the polygon perimeter at the unit's visual radius and has
 *  a length matching the true edge length of the shape — so a tank pentagon
 *  emits five pentagon edges, a scout diamond emits four, a circle-bodied
 *  unit emits a ring of tangent chunks.
 *
 *  Used by Debris3D to produce "body chunk" pieces the same size and
 *  position as the panels of the source chassis, not generic small boxes. */
export function getBodyEdgeTemplates(
  renderer: string,
  unitRadius: number,
): BodyEdgeTemplate[] {
  const spec = SHAPES[renderer as BodyRendererId] ?? SHAPES.arachnid;
  const out: BodyEdgeTemplate[] = [];

  // The extruded chassis geometry in getBodyGeom() builds its shape in the
  // XY plane then applies geom.rotateX(-π/2), which maps shape (x, y, 0) to
  // world (x, 0, -y). So a shape-space vertex at angle `a` (i.e. cos(a),
  // sin(a)) lands at world position (cos(a), 0, -sin(a)). Edge midpoints
  // and tangent directions must use the same Z negation — otherwise the
  // debris edges end up mirrored across the unit's forward axis.
  if (spec.kind === 'polygon') {
    const r = unitRadius * spec.radiusFrac;
    const sides = spec.sides;
    const edgeLen = 2 * r * Math.sin(Math.PI / sides);
    const midR = r * Math.cos(Math.PI / sides);
    for (let i = 0; i < sides; i++) {
      const a = spec.rotation + ((i + 0.5) / sides) * Math.PI * 2;
      out.push({
        x: Math.cos(a) * midR,
        // Z is negated because ExtrudeGeometry + rotateX(-π/2) maps shape-Y
        // onto world-−Z.
        z: -Math.sin(a) * midR,
        // Edge tangent in world (after the same Z negation) is
        // (sin(a), 0, cos(a)); the yaw that rotates the slab's +X axis to
        // match is π/2 − a.
        yaw: Math.PI / 2 - a,
        length: edgeLen,
        thickness: Math.max(2, unitRadius * 0.08),
      });
    }
  } else if (spec.kind === 'rect') {
    const length = unitRadius * spec.lengthFrac;   // along X (forward)
    const width = unitRadius * spec.widthFrac;     // along Z (side)
    const thickness = Math.max(2, unitRadius * 0.08);
    // Four sides of the rectangle — two long (front/back) and two short
    // (left/right). Each slab sits along the edge it represents.
    out.push({ x:  length / 2, z: 0, yaw: Math.PI / 2, length: width,  thickness });
    out.push({ x: -length / 2, z: 0, yaw: Math.PI / 2, length: width,  thickness });
    out.push({ x: 0, z:  width / 2, yaw: 0,            length: length, thickness });
    out.push({ x: 0, z: -width / 2, yaw: 0,            length: length, thickness });
  } else if (spec.kind === 'circle') {
    // Circle body — 10 tangent chunks around the perimeter. Same Z-negation
    // + yaw convention as the polygon case so tangents line up with the
    // extruded geometry.
    pushCircleEdges(out, 0, unitRadius * spec.radiusFrac, unitRadius);
  } else if (spec.kind === 'oval') {
    // Single ellipse — tangent edges at varying lengths around the
    // ellipse perimeter.
    pushOvalEdges(
      out,
      /* offsetX */ 0,
      /* xR */ unitRadius * spec.xFrac,
      /* zR */ unitRadius * spec.zFrac,
      unitRadius,
    );
  } else if (spec.kind === 'composite') {
    // Each part contributes its own edge ring at its forward offset.
    for (const part of spec.parts) {
      const offsetX = part.offsetForward * unitRadius;
      if (part.kind === 'circle') {
        pushCircleEdges(out, offsetX, part.radiusFrac * unitRadius, unitRadius);
      } else {
        pushOvalEdges(
          out,
          offsetX,
          part.xFrac * unitRadius,
          part.zFrac * unitRadius,
          unitRadius,
        );
      }
    }
  }

  return out;
}

/** Push tangent edges around a circle of radius `r` centered at (offsetX, 0)
 *  in unit-local space, into `out`. */
function pushCircleEdges(
  out: BodyEdgeTemplate[],
  offsetX: number,
  r: number,
  unitRadius: number,
): void {
  const sides = 10;
  const edgeLen = 2 * r * Math.sin(Math.PI / sides);
  const midR = r * Math.cos(Math.PI / sides);
  for (let i = 0; i < sides; i++) {
    const a = ((i + 0.5) / sides) * Math.PI * 2;
    out.push({
      x: offsetX + Math.cos(a) * midR,
      z: -Math.sin(a) * midR,
      yaw: Math.PI / 2 - a,
      length: edgeLen,
      thickness: Math.max(2, unitRadius * 0.08),
    });
  }
}

/** Push tangent edges around an ellipse with half-extents (xR, zR) centered
 *  at (offsetX, 0). Uses the discrete perimeter between N evenly-spaced
 *  parametric points, so each edge's length matches the local ellipse
 *  curvature — longer edges where the ellipse is straighter. */
function pushOvalEdges(
  out: BodyEdgeTemplate[],
  offsetX: number,
  xR: number,
  zR: number,
  unitRadius: number,
): void {
  const segments = 12;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = offsetX + Math.cos(a0) * xR;
    const z0 = -Math.sin(a0) * zR;
    const x1 = offsetX + Math.cos(a1) * xR;
    const z1 = -Math.sin(a1) * zR;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const length = Math.hypot(dx, dz);
    out.push({
      x: (x0 + x1) / 2,
      z: (z0 + z1) / 2,
      yaw: Math.atan2(dz, dx),
      length,
      thickness: Math.max(2, unitRadius * 0.08),
    });
  }
}

export function disposeBodyGeoms(): void {
  for (const entry of CACHE.values()) entry.geometry.dispose();
  CACHE.clear();
}
