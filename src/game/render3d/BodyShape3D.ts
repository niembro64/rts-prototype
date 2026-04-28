// BodyShape3D — per-unit-renderer 3D chassis geometry.
//
// Each 2D unit body shape maps to one or more 3D meshes. Smooth shapes
// (circle/oval/composite) become SphereGeometry scaled to spheroids so
// the silhouette reads as a real volume instead of a flat extruded disk.
// Angled shapes (polygon/rect) stay as ExtrudeGeometry prisms matching
// their 2D silhouette.
//
// Heights are proportional to each shape's horizontal dimensions — a
// wide unit is taller than a narrow one, a spherical unit's height is
// its own diameter, a flat pentagon's height is its inscribed-circle
// diameter. The turret mount-point for each renderer is the top of the
// tallest body segment, exposed via `getBodyTopY(renderer, unitRadius)`.
//
// All geometry is built in unit-radius-1 space. Callers scale the parent
// group by the unit's render radius uniformly, which multiplies both
// each part's center offset and its per-axis scale — keeping ratios
// intact so two units with different `unitRadius` still look the same
// shape, just bigger or smaller.

import * as THREE from 'three';

/** Renderer IDs — these are the `renderer` field on UnitBlueprint. */
export type BodyRendererId =
  | 'scout' | 'brawl' | 'tank' | 'burst' | 'mortar'
  | 'hippo'
  | 'beam' | 'arachnid' | 'snipe' | 'commander' | 'forceField' | 'loris';

/** A part of a composite body (e.g. arachnid abdomen + prosoma). Offsets
 *  are in unit-radius-1 space along the unit's forward axis; positive =
 *  forward, negative = backward. All composites so far are axially
 *  symmetric so no lateral offset is needed. */
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
  /** Multi-segment smooth body (e.g. arachnid = abdomen + cephalothorax).
   *  Each part is rendered as its own sphere/spheroid. */
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
  // (width=1.6). In our rect spec, lengthFrac is the forward axis,
  // widthFrac the lateral axis.
  hippo:      { kind: 'rect', lengthFrac: 0.7, widthFrac: 1.6 },
  // 2D BeamRenderer (tarantula): oval abdomen behind + circle cephalothorax
  // in front. Abdomen offset ≈ -0.65; prosoma at +0.3.
  beam: {
    kind: 'composite',
    parts: [
      { kind: 'oval',   offsetForward: -0.65, xFrac: 0.9,  zFrac: 0.65 },
      { kind: 'circle', offsetForward:  0.30, radiusFrac: 0.6 },
    ],
  },
  // 2D ArachnidRenderer (widow): massive abdomen (r=1.15 at -1.1) +
  // smaller prosoma (r=0.55 at +0.3).
  arachnid: {
    kind: 'composite',
    parts: [
      { kind: 'circle', offsetForward: -1.1, radiusFrac: 1.15 },
      { kind: 'circle', offsetForward:  0.3, radiusFrac: 0.55 },
    ],
  },
  // 2D SnipeRenderer (tick): single oval idiosoma. rx=0.5 (along body),
  // rz=0.35 (lateral).
  snipe: { kind: 'oval', xFrac: 0.5, zFrac: 0.35 },
  // 2D CommanderRenderer: oval rear + front circle prosoma.
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

/** One mesh that makes up a unit body. Positions and scales are in
 *  unit-radius-1 space — the caller multiplies both by the unit's
 *  render radius (usually by uniformly scaling the chassis parent
 *  group). Spheres use SphereGeometry; extrusions use ExtrudeGeometry
 *  built with the per-renderer height already baked into `depth`. */
export type BodyMeshPart = {
  geometry: THREE.BufferGeometry;
  /** Center X (forward, +X) in unit-radius-1 space. */
  x: number;
  /** Center Y (up, +Y) in unit-radius-1 space. For spheres this is the
   *  sphere center; for extrudes it's the bottom (geometry already
   *  extrudes +Y from y=0). */
  y: number;
  /** Center Z (lateral, +Z) in unit-radius-1 space. */
  z: number;
  /** Per-axis half-extent scale. Sphere: semi-axes. Extrude: horizontal
   *  footprint multipliers (Y is 1 — height is baked into the geometry). */
  scaleX: number;
  scaleY: number;
  scaleZ: number;
};

export type BodyGeomEntry = {
  parts: BodyMeshPart[];
  /** Top-Y of the tallest body part in unit-radius-1 space. Multiply by
   *  unitRadius to get the world-space height where the turret should
   *  be mounted. */
  topY: number;
  /** True when every part is a unit-sphere instance (kind = 'circle' /
   *  'oval' / composite-of-those). Smooth-body chassis can be batched
   *  through Render3DEntities' shared smooth-chassis InstancedMesh —
   *  one shared draw call covers every smooth body part across every
   *  unit, with per-instance team color and per-axis scale baked into
   *  the instance matrix. False for polygon / rect bodies (scout,
   *  brawl, tank, burst, mortar, hippo) which use ExtrudeGeometry —
   *  those still go through the per-Mesh chassis path. */
  isSmooth: boolean;
};

// A single unit sphere is reused across every smooth body part — sphere
// positioning and non-uniform scaling turn it into the final spheroid
// without needing a separate BufferGeometry per renderer.
let _unitSphere: THREE.SphereGeometry | null = null;
function getUnitSphere(): THREE.SphereGeometry {
  if (!_unitSphere) _unitSphere = new THREE.SphereGeometry(1, 24, 16);
  return _unitSphere;
}

/** Polygon extrusion height (unit-radius-1). Uses the inscribed-circle
 *  diameter (2·r·cos(π/N)) so tall-radius shapes like a pentagon rise
 *  higher than a squat triangle, while everything stays proportional
 *  to its own horizontal footprint. */
function polygonHeight(radiusFrac: number, sides: number): number {
  return 2 * radiusFrac * Math.cos(Math.PI / sides);
}

/** Rectangle extrusion height (unit-radius-1). Uses the mean of the
 *  length and width fractions — a long-and-wide body stays squat
 *  (hippo ≈ 1.15), a narrower rectangle comes out lower. */
function rectHeight(lengthFrac: number, widthFrac: number): number {
  return (lengthFrac + widthFrac) / 2;
}

/** Spheroid Y semi-axis (unit-radius-1). Mean of the two horizontal
 *  half-extents — a more-elongated oval stays taller along its long
 *  axis but drops lateral height with `zFrac`. */
function spheroidRy(xFrac: number, zFrac: number): number {
  return (xFrac + zFrac) / 2;
}

function buildCircleSpec(radiusFrac: number, offsetForward: number): BodyMeshPart {
  const r = radiusFrac;
  return {
    geometry: getUnitSphere(),
    x: offsetForward, y: r, z: 0,
    scaleX: r, scaleY: r, scaleZ: r,
  };
}

function buildOvalSpec(xFrac: number, zFrac: number, offsetForward: number): BodyMeshPart {
  const ry = spheroidRy(xFrac, zFrac);
  return {
    geometry: getUnitSphere(),
    x: offsetForward, y: ry, z: 0,
    scaleX: xFrac, scaleY: ry, scaleZ: zFrac,
  };
}

function buildEntry(spec: ShapeSpec): BodyGeomEntry {
  if (spec.kind === 'polygon') {
    const h = polygonHeight(spec.radiusFrac, spec.sides);
    const shape = buildPolygonShape(spec.sides, 1, spec.rotation);
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: h,
      bevelEnabled: false,
      steps: 1,
    });
    // Extrusion along +Z with shape in XY → rotate so the shape lands on
    // the XZ plane and extrude direction becomes +Y.
    geom.rotateX(-Math.PI / 2);
    return {
      parts: [{
        geometry: geom,
        x: 0, y: 0, z: 0,
        scaleX: spec.radiusFrac, scaleY: 1, scaleZ: spec.radiusFrac,
      }],
      topY: h,
      isSmooth: false,
    };
  }
  if (spec.kind === 'rect') {
    const h = rectHeight(spec.lengthFrac, spec.widthFrac);
    const shape = buildRectShape(1, 1);
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: h,
      bevelEnabled: false,
      steps: 1,
    });
    geom.rotateX(-Math.PI / 2);
    return {
      parts: [{
        geometry: geom,
        x: 0, y: 0, z: 0,
        scaleX: spec.lengthFrac, scaleY: 1, scaleZ: spec.widthFrac,
      }],
      topY: h,
      isSmooth: false,
    };
  }
  if (spec.kind === 'circle') {
    const part = buildCircleSpec(spec.radiusFrac, 0);
    return { parts: [part], topY: 2 * spec.radiusFrac, isSmooth: true };
  }
  if (spec.kind === 'oval') {
    const part = buildOvalSpec(spec.xFrac, spec.zFrac, 0);
    return { parts: [part], topY: 2 * spheroidRy(spec.xFrac, spec.zFrac), isSmooth: true };
  }
  // composite: each segment is its own sphere/spheroid.
  const parts: BodyMeshPart[] = [];
  let topY = 0;
  for (const p of spec.parts) {
    if (p.kind === 'circle') {
      parts.push(buildCircleSpec(p.radiusFrac, p.offsetForward));
      topY = Math.max(topY, 2 * p.radiusFrac);
    } else {
      parts.push(buildOvalSpec(p.xFrac, p.zFrac, p.offsetForward));
      topY = Math.max(topY, 2 * spheroidRy(p.xFrac, p.zFrac));
    }
  }
  return { parts, topY, isSmooth: true };
}

const CACHE: Map<string, BodyGeomEntry> = new Map();

/** Look up or build the 3D chassis geometry for a 2D renderer ID.
 *  Returned parts live in unit-radius-1 space; call sites scale the
 *  chassis parent group by the unit's render radius so each part's
 *  offset and scale both multiply uniformly. */
export function getBodyGeom(renderer: string): BodyGeomEntry {
  const cached = CACHE.get(renderer);
  if (cached) return cached;
  const spec = SHAPES[renderer as BodyRendererId] ?? SHAPES.arachnid;
  const entry = buildEntry(spec);
  CACHE.set(renderer, entry);
  return entry;
}

/** World-space Y of the body top for the given renderer + unit radius.
 *  Used by the turret-mount path so each unit type's turret sits on
 *  its own body instead of a shared CHASSIS_HEIGHT constant. */
export function getBodyTopY(renderer: string, unitRadius: number): number {
  return getBodyGeom(renderer).topY * unitRadius;
}

/** World-space Y of the body top AT the chassis-local (mountX, mountZ)
 *  position. For composite bodies (arachnid / commander / beam) this
 *  picks the per-PART top so a turret mounted on the small front
 *  prosoma sits on the prosoma's top — not floating at the global
 *  body top, which is the (much taller) abdomen on the widow.
 *
 *  Single-part bodies fall through to the global topY (same value as
 *  `getBodyTopY`).
 *
 *  `mountX` / `mountZ` are CHASSIS-LOCAL forward / lateral offsets in
 *  WORLD units (i.e. already multiplied by unitRadius — same units as
 *  `turret.offset.x` / `turret.offset.y` after `unitDefinitions.ts`
 *  scales `chassisMount.{x,y} * radius`). The match is by Euclidean
 *  distance to each part's center; ties go to the first-listed part
 *  but BodyShape3D's composite specs are well-separated so ties
 *  don't actually arise.
 *
 *  Composite bodies are guaranteed all-circle/oval (BodyShape3D's
 *  `composite` spec only accepts `circle` and `oval` parts), so for
 *  every composite part `top y = part.y + part.scaleY` in unit-
 *  radius-1 space. */
export function getBodyMountTopY(
  renderer: string,
  unitRadius: number,
  mountX: number,
  mountZ: number,
): number {
  const entry = getBodyGeom(renderer);
  if (entry.parts.length <= 1) return entry.topY * unitRadius;
  let bestDist = Infinity;
  let bestTopY = entry.topY;
  for (const part of entry.parts) {
    const px = part.x * unitRadius;
    const pz = part.z * unitRadius;
    const dx = mountX - px;
    const dz = mountZ - pz;
    const dist = Math.hypot(dx, dz);
    if (dist < bestDist) {
      bestDist = dist;
      bestTopY = part.y + part.scaleY;
    }
  }
  return bestTopY * unitRadius;
}

function buildPolygonShape(sides: number, radius: number, rotation: number): THREE.Shape {
  // Matches 2D drawPolygon: vertices at angle = rotation + (i/sides)·2π.
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    pts.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return new THREE.Shape(pts);
}

function buildRectShape(width: number, length: number): THREE.Shape {
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
 *  direction, `thickness` along the normal, standing full body height.
 *  `yaw` is the rotation around Y that lays the edge tangent to the shape. */
export type BodyEdgeTemplate = {
  x: number;
  z: number;
  yaw: number;
  length: number;
  /** Depth (perpendicular to the edge, in world units). */
  thickness: number;
  /** World-space height of this slab (matches the body segment it's
   *  derived from). */
  height: number;
};

/** Approximate the 3D chassis as a set of edge slabs, one per polygon
 *  side (or four sides for rectangles, or N tangent chunks for circles).
 *  Each edge sits at the polygon perimeter at the unit's visual radius
 *  and has a length matching the true edge length of the shape.
 *
 *  Used by Debris3D to produce "body chunk" pieces the same size and
 *  position as the panels of the source chassis, not generic small boxes. */
export function getBodyEdgeTemplates(
  renderer: string,
  unitRadius: number,
): BodyEdgeTemplate[] {
  const spec = SHAPES[renderer as BodyRendererId] ?? SHAPES.arachnid;
  const out: BodyEdgeTemplate[] = [];

  if (spec.kind === 'polygon') {
    const r = unitRadius * spec.radiusFrac;
    const sides = spec.sides;
    const edgeLen = 2 * r * Math.sin(Math.PI / sides);
    const midR = r * Math.cos(Math.PI / sides);
    const height = polygonHeight(spec.radiusFrac, sides) * unitRadius;
    for (let i = 0; i < sides; i++) {
      const a = spec.rotation + ((i + 0.5) / sides) * Math.PI * 2;
      out.push({
        x: Math.cos(a) * midR,
        // Shape-Y maps to world-−Z after the extrude+rotate pipeline.
        z: -Math.sin(a) * midR,
        yaw: Math.PI / 2 - a,
        length: edgeLen,
        thickness: Math.max(2, unitRadius * 0.08),
        height,
      });
    }
  } else if (spec.kind === 'rect') {
    const length = unitRadius * spec.lengthFrac;
    const width = unitRadius * spec.widthFrac;
    const thickness = Math.max(2, unitRadius * 0.08);
    const height = rectHeight(spec.lengthFrac, spec.widthFrac) * unitRadius;
    out.push({ x:  length / 2, z: 0, yaw: Math.PI / 2, length: width,  thickness, height });
    out.push({ x: -length / 2, z: 0, yaw: Math.PI / 2, length: width,  thickness, height });
    out.push({ x: 0, z:  width / 2, yaw: 0,            length: length, thickness, height });
    out.push({ x: 0, z: -width / 2, yaw: 0,            length: length, thickness, height });
  } else if (spec.kind === 'circle') {
    const height = 2 * spec.radiusFrac * unitRadius;
    pushCircleEdges(out, 0, unitRadius * spec.radiusFrac, unitRadius, height);
  } else if (spec.kind === 'oval') {
    const height = 2 * spheroidRy(spec.xFrac, spec.zFrac) * unitRadius;
    pushOvalEdges(
      out,
      /* offsetX */ 0,
      /* xR */ unitRadius * spec.xFrac,
      /* zR */ unitRadius * spec.zFrac,
      unitRadius,
      height,
    );
  } else if (spec.kind === 'composite') {
    for (const part of spec.parts) {
      const offsetX = part.offsetForward * unitRadius;
      if (part.kind === 'circle') {
        const height = 2 * part.radiusFrac * unitRadius;
        pushCircleEdges(out, offsetX, part.radiusFrac * unitRadius, unitRadius, height);
      } else {
        const height = 2 * spheroidRy(part.xFrac, part.zFrac) * unitRadius;
        pushOvalEdges(
          out,
          offsetX,
          part.xFrac * unitRadius,
          part.zFrac * unitRadius,
          unitRadius,
          height,
        );
      }
    }
  }

  return out;
}

function pushCircleEdges(
  out: BodyEdgeTemplate[],
  offsetX: number,
  r: number,
  unitRadius: number,
  height: number,
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
      height,
    });
  }
}

function pushOvalEdges(
  out: BodyEdgeTemplate[],
  offsetX: number,
  xR: number,
  zR: number,
  unitRadius: number,
  height: number,
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
      height,
    });
  }
}

export function disposeBodyGeoms(): void {
  for (const entry of CACHE.values()) {
    for (const part of entry.parts) {
      if (part.geometry !== _unitSphere) part.geometry.dispose();
    }
  }
  CACHE.clear();
  if (_unitSphere) {
    _unitSphere.dispose();
    _unitSphere = null;
  }
}
