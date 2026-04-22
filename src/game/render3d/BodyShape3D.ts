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

type ShapeSpec =
  | { kind: 'polygon'; sides: number; radiusFrac: number; rotation: number }
  | { kind: 'rect'; widthFrac: number; lengthFrac: number }
  | { kind: 'circle'; radiusFrac: number };

/** Shape table derived from each 2D unit renderer's outermost body shape.
 *  radiusFrac is relative to the unit's visual radius (matches the 2D
 *  `r * 0.XX` convention). rotation is the intrinsic polygon rotation in
 *  radians (the bodyRot-independent part from drawPolygon's `rotation` arg). */
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
  // 2D: drawOrientedRect(x, y, r*0.7, r*1.6, bodyRot) — tall rectangle
  hippo:      { kind: 'rect', widthFrac: 0.7, lengthFrac: 1.6 },
  // Circle-bodied renderers from 2D:
  beam:       { kind: 'circle', radiusFrac: 0.6 },
  arachnid:   { kind: 'circle', radiusFrac: 0.6 },
  snipe:      { kind: 'circle', radiusFrac: 0.55 },
  commander:  { kind: 'circle', radiusFrac: 0.5 },
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

  let shape: THREE.Shape;
  let radiusFrac = 1;
  let scaleX: number | undefined;
  let scaleZ: number | undefined;

  if (spec.kind === 'polygon') {
    shape = buildPolygonShape(spec.sides, 1, spec.rotation);
    radiusFrac = spec.radiusFrac;
  } else if (spec.kind === 'circle') {
    shape = buildCircleShape(1, 24);
    radiusFrac = spec.radiusFrac;
  } else {
    // Rectangle — unit shape is ±0.5 on each axis; caller scales by
    // radius · lengthFrac (forward = X) and radius · widthFrac (side = Z).
    shape = buildRectShape(1, 1);
    radiusFrac = 1;
    scaleX = spec.lengthFrac;
    scaleZ = spec.widthFrac;
  }

  const geom = new THREE.ExtrudeGeometry(shape, {
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

export function disposeBodyGeoms(): void {
  for (const entry of CACHE.values()) entry.geometry.dispose();
  CACHE.clear();
}
