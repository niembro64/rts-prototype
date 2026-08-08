// BodyShape3D — body-shape keyed 3D chassis geometry.
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
// diameter. Turret mount points are authored directly on unit blueprints;
// this module only exposes body dimensions for chassis/leg helpers.
//
// All geometry is built in unit-radius-1 space. Callers scale the parent
// group by the unit's render radius uniformly, which multiplies both
// each part's center offset and its per-axis scale — keeping ratios
// intact so two units with different `unitRadius` still look the same
// shape, just bigger or smaller.

import * as THREE from 'three';
import type { UnitBodyShape } from '@/types/blueprints';
import {
  getBodyTopFrac,
  getUnitBodyShapeKey,
} from '../math/BodyDimensions';
import {
  createPrimitiveCylinderGeometry,
  getOrCreate,
  getSharedPrimitiveSphereGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

/** One mesh that makes up a unit body. Positions and scales are in
 *  unit-radius-1 space — the caller multiplies both by the unit's
 *  render radius (usually by uniformly scaling the chassis parent
 *  group). Spheres use SphereGeometry; extrusions use ExtrudeGeometry
 *  built with the body-shape height already baked into `depth`. */
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
  /** Optional rotation in radians around the unit's lateral (Z) axis,
   *  applied to the geometry before translation. Used by tilted
   *  cylinder parts. */
  rotZ?: number;
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
// without needing a separate BufferGeometry per body shape.
function getUnitSphere(tier: PrimitiveGeometryTier): THREE.SphereGeometry {
  return getSharedPrimitiveSphereGeometry('unitBody', tier);
}

const unitCylinders = new Map<PrimitiveGeometryTier, THREE.CylinderGeometry>();
function getUnitCylinder(tier: PrimitiveGeometryTier): THREE.CylinderGeometry {
  return getOrCreate(unitCylinders, tier, () => {
    const geometry = createPrimitiveCylinderGeometry('unitBody', tier, 1, 1, 1, 1);
    geometry.rotateZ(-Math.PI / 2);
    return geometry;
  });
}

// Unit cone — radiusTop=1, radiusBottom=0 so the tip is at −Y. Same
// rotateZ(−π/2) as the cylinder lays the long axis along +X, which
// puts the tip at −X (the rearward end of any body part using this
// geometry) and the radius-1 base at +X. Composite parts scale by
// (lengthFrac, radiusFrac, radiusFrac) just like cylinders.
const unitCones = new Map<PrimitiveGeometryTier, THREE.CylinderGeometry>();
function getUnitCone(tier: PrimitiveGeometryTier): THREE.CylinderGeometry {
  return getOrCreate(unitCones, tier, () => {
    const geometry = createPrimitiveCylinderGeometry('unitBody', tier, 1, 0, 1, 1);
    geometry.rotateZ(-Math.PI / 2);
    return geometry;
  });
}

/** Polygon extrusion height (unit-radius-1). Uses the inscribed-circle
 *  diameter (2·r·cos(π/N)) so tall-radius shapes like a pentagon rise
 *  higher than a squat triangle, while everything stays proportional
 *  to its own horizontal footprint. */
function circleYFrac(radiusFrac: number, yFrac?: number): number {
  return yFrac ?? radiusFrac;
}

let sharedUnitBox: THREE.BoxGeometry | null = null;
function unitBoxGeometry(): THREE.BoxGeometry {
  sharedUnitBox ??= new THREE.BoxGeometry(1, 1, 1);
  return sharedUnitBox;
}

function buildCircleSpec(part: { radiusFrac: number; yFrac?: number; centerYFrac?: number; offsetForward?: number; offsetLateral?: number }, tier: PrimitiveGeometryTier): BodyMeshPart {
  const halfHeight = circleYFrac(part.radiusFrac, part.yFrac);
  const centerY = part.centerYFrac ?? halfHeight;
  return {
    geometry: getUnitSphere(tier),
    x: part.offsetForward ?? 0, y: centerY, z: part.offsetLateral ?? 0,
    scaleX: part.radiusFrac, scaleY: halfHeight, scaleZ: part.radiusFrac,
  };
}

function buildOvalSpec(part: { xFrac: number; yFrac: number; zFrac: number; centerYFrac?: number; offsetForward?: number; offsetLateral?: number }, tier: PrimitiveGeometryTier): BodyMeshPart {
  // Default centre = yFrac, which seats the oval on the ground. That was the
  // only height an oval could have, so a torso stacked out of them was not
  // authorable — every other composite part already carries centerYFrac.
  return {
    geometry: getUnitSphere(tier),
    x: part.offsetForward ?? 0, y: part.centerYFrac ?? part.yFrac, z: part.offsetLateral ?? 0,
    scaleX: part.xFrac, scaleY: part.yFrac, scaleZ: part.zFrac,
  };
}

/** A flat-sided slab. The composite kit was all spheroids and bodies of
 *  revolution, which is fine for a hull and wrong for a mech: a commander is
 *  plate, and plate has edges. */
function buildBoxSpec(part: { lengthFrac: number; widthFrac: number; heightFrac: number; centerYFrac?: number; pitchRad?: number; offsetForward?: number; offsetLateral?: number }, tier: PrimitiveGeometryTier): BodyMeshPart {
  void tier;
  return {
    geometry: unitBoxGeometry(),
    x: part.offsetForward ?? 0,
    y: part.centerYFrac ?? part.heightFrac * 0.5,
    z: part.offsetLateral ?? 0,
    scaleX: part.lengthFrac, scaleY: part.heightFrac, scaleZ: part.widthFrac,
    rotZ: part.pitchRad,
  };
}

function buildCylinderSpec(part: { lengthFrac: number; radiusFrac: number; centerYFrac?: number; pitchRad?: number; offsetForward?: number; offsetLateral?: number }, tier: PrimitiveGeometryTier): BodyMeshPart {
  const y = part.centerYFrac ?? part.radiusFrac;
  return {
    geometry: getUnitCylinder(tier),
    x: part.offsetForward ?? 0, y, z: part.offsetLateral ?? 0,
    scaleX: part.lengthFrac, scaleY: part.radiusFrac, scaleZ: part.radiusFrac,
    rotZ: part.pitchRad,
  };
}

function buildConeSpec(part: { lengthFrac: number; radiusFrac: number; centerYFrac?: number; offsetForward?: number; offsetLateral?: number }, tier: PrimitiveGeometryTier): BodyMeshPart {
  const y = part.centerYFrac ?? part.radiusFrac;
  return {
    geometry: getUnitCone(tier),
    x: part.offsetForward ?? 0, y, z: part.offsetLateral ?? 0,
    scaleX: part.lengthFrac, scaleY: part.radiusFrac, scaleZ: part.radiusFrac,
  };
}


/**
 * The 2D footprint an authored prism shape occupies, in unit-radius-1 space.
 *
 * These shapes are authored as a FOOTPRINT plus a height — a hexagon 0.55
 * across, a rectangle 1.6 wide — and that footprint is what every other system
 * already reasons about: the turret's mount height, the locomotion's lateral
 * clearance, the team kit's fit. Reading the extents back off the authored
 * numbers is what keeps the rounded body agreeing with all of them.
 */
function shapeFootprint(spec: UnitBodyShape): {
  minX: number; maxX: number; minZ: number; maxZ: number;
} {
  if (spec.kind === 'polygon') {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < spec.sides; i++) {
      const a = spec.rotation + (i / spec.sides) * Math.PI * 2;
      const x = Math.cos(a);
      const y = Math.sin(a);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    // The extrusion put the shape's XY on the world XZ plane with y negated
    // (rotateX(-PI/2)), and scaled both axes by radiusFrac.
    const r = spec.radiusFrac;
    return { minX: minX * r, maxX: maxX * r, minZ: -maxY * r, maxZ: -minY * r };
  }
  // Rect and rhombus share a bounding box: the rhombus is the rect's diagonals.
  // Its corners are cut, which a spheroid rounds off anyway.
  const halfLength = spec.kind === 'rect' || spec.kind === 'rhombus'
    ? spec.lengthFrac / 2
    : 0;
  const halfWidth = spec.kind === 'rect' || spec.kind === 'rhombus'
    ? spec.widthFrac / 2
    : 0;
  return { minX: -halfLength, maxX: halfLength, minZ: -halfWidth, maxZ: halfWidth };
}

/**
 * The prism shapes, rendered as SPHEROIDS.
 *
 * A body authored as "hexagon, 0.55 across, 0.3 tall" describes how much room
 * the hull takes up, not that it is faceted. Extruding it literally gave six
 * flat walls and a flat lid, which is a different object from everything else
 * in the roster: every composite hull is already spheres and ovoids, and a
 * prism parked next to one reads as a placeholder that never got finished.
 *
 * The spheroid INSCRIBES the authored footprint's bounding box and spans its
 * full height exactly. That is the conservative fit on purpose — the body
 * never grows past the extents the blueprint declares, so the turret still
 * mounts at the same height, the treads still clear the same hull, and the
 * team kit still fits the same box. It does round the corners off, and between
 * a polygon's vertices it stands slightly proud of the old flat wall; both are
 * inherent in asking for a rounded body and neither moves the silhouette's
 * extremes, which is what size reads from.
 *
 * The win is not only that it looks like the rest of the roster. A spheroid is
 * the shared unit sphere, so these bodies join the smooth chassis instancing
 * pool, pick up the hull charts, and get a real LOD ladder — a prism had one
 * geometry at every rung because there was nothing in it to simplify.
 */
function buildEntry(spec: UnitBodyShape, tier: PrimitiveGeometryTier): BodyGeomEntry {
  const topY = getBodyTopFrac(spec);
  if (spec.kind === 'polygon' || spec.kind === 'rect' || spec.kind === 'rhombus') {
    const footprint = shapeFootprint(spec);
    const halfHeight = Math.max(1e-3, spec.heightFrac / 2);
    return {
      parts: [{
        geometry: getUnitSphere(tier),
        x: (footprint.minX + footprint.maxX) / 2,
        y: halfHeight,
        z: (footprint.minZ + footprint.maxZ) / 2,
        scaleX: Math.max(1e-3, (footprint.maxX - footprint.minX) / 2),
        scaleY: halfHeight,
        scaleZ: Math.max(1e-3, (footprint.maxZ - footprint.minZ) / 2),
      }],
      topY,
      isSmooth: true,
    };
  }
  if (spec.kind === 'circle') {
    const part = buildCircleSpec(spec, tier);
    return { parts: [part], topY, isSmooth: true };
  }
  if (spec.kind === 'oval') {
    const part = buildOvalSpec(spec, tier);
    return { parts: [part], topY, isSmooth: true };
  }
  // composite: each segment is its own sphere/spheroid/cylinder.
  const parts: BodyMeshPart[] = [];
  let isSmooth = true;
  for (const p of spec.parts) {
    if (p.kind === 'circle') {
      const part = buildCircleSpec(p, tier);
      parts.push(part);
    } else if (p.kind === 'oval') {
      const part = buildOvalSpec(p, tier);
      parts.push(part);
    } else if (p.kind === 'box') {
      parts.push(buildBoxSpec(p, tier));
      isSmooth = false;
    } else if (p.kind === 'cone') {
      const part = buildConeSpec(p, tier);
      parts.push(part);
      isSmooth = false;
    } else {
      const part = buildCylinderSpec(p, tier);
      parts.push(part);
      isSmooth = false;
    }
  }
  return { parts, topY, isSmooth };
}

const CACHE: Map<string, BodyGeomEntry> = new Map();
const EMPTY_BODY_GEOM: BodyGeomEntry = {
  parts: [],
  topY: 0,
  isSmooth: true,
};

/** Look up or build the 3D chassis geometry for an authored body shape.
 *  Returned parts live in unit-radius-1 space; call sites scale the
 *  chassis parent group by the unit's render radius so each part's
 *  offset and scale both multiply uniformly. */
export function getBodyGeom(
  bodyShape: UnitBodyShape | null,
  tier: PrimitiveGeometryTier = 'close',
): BodyGeomEntry {
  if (bodyShape === null) return EMPTY_BODY_GEOM;
  const key = `${tier}:${getUnitBodyShapeKey(bodyShape)}`;
  const cached = CACHE.get(key);
  if (cached) return cached;
  const entry = buildEntry(bodyShape, tier);
  CACHE.set(key, entry);
  return entry;
}
export function disposeBodyGeoms(): void {
  const disposed = new Set<THREE.BufferGeometry>();
  for (const entry of CACHE.values()) {
    for (const part of entry.parts) {
      if (!disposed.has(part.geometry)) {
        part.geometry.dispose();
        disposed.add(part.geometry);
      }
    }
  }
  CACHE.clear();
  unitCylinders.clear();
  unitCones.clear();
}
