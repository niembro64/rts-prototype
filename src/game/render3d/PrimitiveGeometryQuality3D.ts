import * as THREE from 'three';

export type PrimitiveGeometryTier = 'close' | 'mid' | 'far';
export type PrimitiveGeometryRole =
  | 'unitBody'
  | 'unitDetail'
  | 'turret'
  | 'projectile'
  | 'beam'
  | 'shield'
  | 'shieldImpact'
  | 'building'
  | 'locomotion'
  | 'effect'
  | 'smoke'
  | 'fog'
  | 'waterSplash'
  | 'environment'
  | 'hud'
  | 'debug';

type SphereSegments = {
  widthSegments: number;
  heightSegments: number;
};

type RadialSegments = {
  radialSegments: number;
};

type TorusSegments = {
  radialSegments: number;
};

type PrimitiveRoleQuality = {
  sphere: Record<PrimitiveGeometryTier, SphereSegments>;
  cylinder: Record<PrimitiveGeometryTier, RadialSegments>;
  cone: Record<PrimitiveGeometryTier, RadialSegments>;
  circle: Record<PrimitiveGeometryTier, RadialSegments>;
  torus: Record<PrimitiveGeometryTier, TorusSegments>;
};

// Close tier still means an RTS camera close-up, not hero-asset smoothness.
// Keep high-count roles deliberately modest; buildings/shields/HUD retain
// richer silhouettes where instance counts are lower or readability matters.
export const PRIMITIVE_GEOMETRY_QUALITY: Record<PrimitiveGeometryRole, PrimitiveRoleQuality> = {
  unitBody: {
    sphere: {
      close: { widthSegments: 12, heightSegments: 8 },
      mid: { widthSegments: 8, heightSegments: 5 },
      far: { widthSegments: 4, heightSegments: 3 },
    },
    cylinder: {
      close: { radialSegments: 10 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 3 },
    },
    cone: {
      close: { radialSegments: 10 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 3 },
    },
    circle: {
      close: { radialSegments: 18 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 20 },
      mid: { radialSegments: 14 },
      far: { radialSegments: 10 },
    },
  },
  unitDetail: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 6, heightSegments: 4 },
      far: { widthSegments: 3, heightSegments: 2 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 4 },
      far: { radialSegments: 3 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 4 },
      far: { radialSegments: 3 },
    },
    circle: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
  },
  turret: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 6, heightSegments: 4 },
      far: { widthSegments: 3, heightSegments: 2 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 4 },
      far: { radialSegments: 3 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 4 },
      far: { radialSegments: 3 },
    },
    circle: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
  },
  projectile: {
    sphere: {
      close: { widthSegments: 8, heightSegments: 6 },
      mid: { widthSegments: 6, heightSegments: 4 },
      far: { widthSegments: 5, heightSegments: 3 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 5 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 5 },
    },
    circle: {
      close: { radialSegments: 12 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    torus: {
      close: { radialSegments: 12 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
  },
  beam: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 8, heightSegments: 6 },
      far: { widthSegments: 4, heightSegments: 3 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 3 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 3 },
    },
    circle: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
  },
  shield: {
    sphere: {
      close: { widthSegments: 16, heightSegments: 10 },
      mid: { widthSegments: 10, heightSegments: 7 },
      far: { widthSegments: 6, heightSegments: 4 },
    },
    cylinder: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 4 },
    },
    cone: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
    circle: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 16 },
      far: { radialSegments: 10 },
    },
    torus: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 16 },
      far: { radialSegments: 10 },
    },
  },
  shieldImpact: {
    sphere: {
      close: { widthSegments: 16, heightSegments: 10 },
      mid: { widthSegments: 8, heightSegments: 5 },
      far: { widthSegments: 4, heightSegments: 3 },
    },
    cylinder: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 4 },
    },
    cone: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
    circle: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 4 },
    },
    torus: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 4 },
    },
  },
  building: {
    sphere: {
      close: { widthSegments: 14, heightSegments: 10 },
      mid: { widthSegments: 10, heightSegments: 7 },
      far: { widthSegments: 5, heightSegments: 3 },
    },
    cylinder: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 4 },
    },
    cone: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 4 },
    },
    circle: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 16 },
      far: { radialSegments: 10 },
    },
    torus: {
      close: { radialSegments: 28 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 6 },
    },
  },
  locomotion: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 6, heightSegments: 4 },
      far: { widthSegments: 3, heightSegments: 2 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 4 },
      far: { radialSegments: 3 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 4 },
      far: { radialSegments: 3 },
    },
    circle: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
  },
  effect: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 6, heightSegments: 4 },
      far: { widthSegments: 4, heightSegments: 3 },
    },
    cylinder: {
      close: { radialSegments: 10 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 3 },
    },
    cone: {
      close: { radialSegments: 10 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 20 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 20 },
      mid: { radialSegments: 14 },
      far: { radialSegments: 8 },
    },
  },
  smoke: {
    sphere: {
      close: { widthSegments: 12, heightSegments: 8 },
      mid: { widthSegments: 6, heightSegments: 4 },
      far: { widthSegments: 4, heightSegments: 3 },
    },
    cylinder: {
      close: { radialSegments: 10 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 10 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 20 },
      mid: { radialSegments: 14 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 20 },
      mid: { radialSegments: 14 },
      far: { radialSegments: 8 },
    },
  },
  fog: {
    sphere: {
      close: { widthSegments: 8, heightSegments: 6 },
      mid: { widthSegments: 6, heightSegments: 4 },
      far: { widthSegments: 3, heightSegments: 3 },
    },
    cylinder: {
      close: { radialSegments: 6 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 6 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 8 },
    },
  },
  waterSplash: {
    sphere: {
      close: { widthSegments: 5, heightSegments: 3 },
      mid: { widthSegments: 4, heightSegments: 3 },
      far: { widthSegments: 3, heightSegments: 2 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 12 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 12 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
  },
  environment: {
    sphere: {
      close: { widthSegments: 8, heightSegments: 6 },
      mid: { widthSegments: 5, heightSegments: 4 },
      far: { widthSegments: 3, heightSegments: 2 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 3 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 3 },
    },
    circle: {
      close: { radialSegments: 12 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 3 },
    },
    torus: {
      close: { radialSegments: 12 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
  },
  hud: {
    sphere: {
      close: { widthSegments: 12, heightSegments: 8 },
      mid: { widthSegments: 8, heightSegments: 6 },
      far: { widthSegments: 6, heightSegments: 4 },
    },
    cylinder: {
      close: { radialSegments: 12 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 12 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 16 },
      far: { radialSegments: 10 },
    },
    torus: {
      close: { radialSegments: 20 },
      mid: { radialSegments: 14 },
      far: { radialSegments: 8 },
    },
  },
  debug: {
    sphere: {
      close: { widthSegments: 12, heightSegments: 8 },
      mid: { widthSegments: 8, heightSegments: 6 },
      far: { widthSegments: 6, heightSegments: 4 },
    },
    cylinder: {
      close: { radialSegments: 10 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 10 },
      mid: { radialSegments: 8 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 20 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
  },
};

const sharedGeometry = new Map<string, THREE.BufferGeometry>();

/** Every torus in the renderer uses a four-sided tube. Four radial samples
 * extrude a square around the major ring instead of spending triangles on a
 * circular tube. The tube is expanded just enough to retain the authored
 * circular-tube volume, so lower geometry cost does not make the part look
 * starved. */
export const SQUARE_TORUS_CROSS_SECTION_SEGMENTS = 4;
const SQUARE_TORUS_CROSS_SECTION_ROTATION_RAD = Math.PI / 4;

function keyOf(parts: readonly unknown[]): string {
  return parts.join(':');
}

function quality(role: PrimitiveGeometryRole): PrimitiveRoleQuality {
  return PRIMITIVE_GEOMETRY_QUALITY[role];
}

/** Enclosed volume of a consistently wound triangle mesh. This deliberately
 * reads the submitted triangles rather than a bounding box, making it useful
 * for auditing low-poly substitutions against their analytic source shape. */
export function geometryEnclosedVolume(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triangleCount = (index?.count ?? position.count) / 3;
  let sixVolume = 0;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const ia = index ? index.getX(triangle * 3) : triangle * 3;
    const ib = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
    const ic = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
    const ax = position.getX(ia);
    const ay = position.getY(ia);
    const az = position.getZ(ia);
    const bx = position.getX(ib);
    const by = position.getY(ib);
    const bz = position.getZ(ib);
    const cx = position.getX(ic);
    const cy = position.getY(ic);
    const cz = position.getZ(ic);
    sixVolume += ax * (by * cz - bz * cy)
      + ay * (bz * cx - bx * cz)
      + az * (bx * cy - by * cx);
  }
  return Math.abs(sixVolume) / 6;
}

/** Uniformly expand a closed low-poly solid to a target volume. Positions,
 * normals and bounds are kept coherent; authored mesh transforms do not need
 * tier-specific compensation. */
export function preserveGeometryVolume(
  geometry: THREE.BufferGeometry,
  targetVolume: number,
): void {
  const actualVolume = geometryEnclosedVolume(geometry);
  if (!(targetVolume > 0) || !(actualVolume > 1e-12)) return;
  const scale = Math.cbrt(targetVolume / actualVolume);
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

function regularPolygonAreaScale(segments: number): number {
  const polygonArea = segments * Math.sin(Math.PI * 2 / segments) * 0.5;
  return Math.sqrt(Math.PI / polygonArea);
}

export function createPrimitiveSphereGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
): THREE.SphereGeometry {
  const q = quality(role).sphere[tier];
  const geometry = new THREE.SphereGeometry(radius, q.widthSegments, q.heightSegments);
  preserveGeometryVolume(geometry, Math.PI * 4 / 3 * radius ** 3);
  return geometry;
}

export function createPrimitiveCylinderGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radiusTop = 1,
  radiusBottom = radiusTop,
  height = 1,
  heightSegments = 1,
  openEnded = false,
): THREE.CylinderGeometry {
  const q = quality(role).cylinder[tier];
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    q.radialSegments,
    heightSegments,
    openEnded,
  );
  const radialScale = regularPolygonAreaScale(q.radialSegments);
  geometry.scale(radialScale, 1, radialScale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Lowest-cost leg segment: a capped triangular prism whose cross-section is
 * an equilateral triangle. Its local axis is +Y, matching every other leg
 * segment geometry, so the existing world-space IK transforms apply without
 * any LOD-specific pose code. */
export function createExtrudedEquilateralTriangleGeometry(
  radius = 1,
  height = 1,
): THREE.BufferGeometry {
  const halfHeight = height / 2;
  const ring = [0, 1, 2].map((index) => {
    const angle = Math.PI / 2 + index * Math.PI * 2 / 3;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const;
  });
  const vertices: number[] = [];
  const push = (a: number, ay: number, b: number, by: number, c: number, cy: number): void => {
    vertices.push(ring[a][0], ay, ring[a][1]);
    vertices.push(ring[b][0], by, ring[b][1]);
    vertices.push(ring[c][0], cy, ring[c][1]);
  };
  // One triangle per cap, then two triangles for each rectangular side.
  push(2, halfHeight, 1, halfHeight, 0, halfHeight);
  push(0, -halfHeight, 1, -halfHeight, 2, -halfHeight);
  for (let side = 0; side < 3; side++) {
    const next = (side + 1) % 3;
    push(side, -halfHeight, next, halfHeight, next, -halfHeight);
    push(side, -halfHeight, side, halfHeight, next, halfHeight);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(16 * 3), 2));
  geometry.computeVertexNormals();
  const radialScale = regularPolygonAreaScale(3);
  geometry.scale(radialScale, 1, radialScale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Lowest-cost joint/foot solid. Detail 0 keeps the same joint transforms and
 * footprint scaling, substituting only four triangular faces for a sphere. */
export function createPrimitiveTetrahedronGeometry(
  radius = 1,
): THREE.TetrahedronGeometry {
  const geometry = new THREE.TetrahedronGeometry(radius, 0);
  preserveGeometryVolume(geometry, Math.PI * 4 / 3 * radius ** 3);
  return geometry;
}

export function getSharedExtrudedEquilateralTriangleGeometry(
  radius = 1,
  height = 1,
): THREE.BufferGeometry {
  const key = keyOf(['equilateral-triangle-prism', radius, height]);
  let geometry = sharedGeometry.get(key);
  if (geometry === undefined) {
    geometry = createExtrudedEquilateralTriangleGeometry(radius, height);
    sharedGeometry.set(key, geometry);
  }
  return geometry;
}

export function getSharedPrimitiveTetrahedronGeometry(
  radius = 1,
): THREE.TetrahedronGeometry {
  const key = keyOf(['tetrahedron', radius]);
  let geometry = sharedGeometry.get(key) as THREE.TetrahedronGeometry | undefined;
  if (geometry === undefined) {
    geometry = createPrimitiveTetrahedronGeometry(radius);
    sharedGeometry.set(key, geometry);
  }
  return geometry;
}

export function createPrimitiveConeGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
  height = 1,
  heightSegments = 1,
  openEnded = false,
): THREE.ConeGeometry {
  const q = quality(role).cone[tier];
  const geometry = new THREE.ConeGeometry(
    radius, height, q.radialSegments, heightSegments, openEnded,
  );
  const radialScale = regularPolygonAreaScale(q.radialSegments);
  geometry.scale(radialScale, 1, radialScale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createPrimitiveCircleGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
): THREE.CircleGeometry {
  const q = quality(role).circle[tier];
  return new THREE.CircleGeometry(radius, q.radialSegments);
}

export function createPrimitiveRingGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  innerRadius = 0.9,
  outerRadius = 1,
): THREE.RingGeometry {
  const q = quality(role).circle[tier];
  return new THREE.RingGeometry(innerRadius, outerRadius, q.radialSegments);
}

export function createPrimitiveTorusGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
  tube = 0.1,
): THREE.TorusGeometry {
  const q = quality(role).torus[tier];
  const geometry = new THREE.TorusGeometry(
    radius,
    tube,
    SQUARE_TORUS_CROSS_SECTION_SEGMENTS,
    q.radialSegments,
  );
  const position = geometry.getAttribute('position');
  const rotationCos = Math.cos(SQUARE_TORUS_CROSS_SECTION_ROTATION_RAD);
  const rotationSin = Math.sin(SQUARE_TORUS_CROSS_SECTION_ROTATION_RAD);
  // TorusGeometry starts a four-point tube at 0°, so its connected vertices
  // form a diamond. Rotate each point in its local radial/Z cross-section by
  // 45° to put the square's faces (rather than its corners) on the cardinal
  // axes. This changes only tube orientation, not the major ring placement.
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const angle = Math.atan2(y, x);
    const radialOffset = Math.hypot(x, y) - radius;
    const rotatedRadialOffset = radialOffset * rotationCos - z * rotationSin;
    const rotatedZ = radialOffset * rotationSin + z * rotationCos;
    position.setXYZ(
      i,
      Math.cos(angle) * (radius + rotatedRadialOffset),
      Math.sin(angle) * (radius + rotatedRadialOffset),
      rotatedZ,
    );
  }
  // Correct both the square tube's smaller inscribed area and the polygonal
  // major path in one pass. Moving each vertex away from its major-ring
  // center changes tube area without inflating the torus hole or ring radius.
  const actualVolume = geometryEnclosedVolume(geometry);
  const targetVolume = Math.PI * 2 * Math.PI * radius * tube * tube;
  if (actualVolume > 1e-12 && targetVolume > 0) {
    const tubeScale = Math.sqrt(targetVolume / actualVolume);
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const angle = Math.atan2(y, x);
      const centerX = Math.cos(angle) * radius;
      const centerY = Math.sin(angle) * radius;
      position.setXYZ(
        i,
        centerX + (x - centerX) * tubeScale,
        centerY + (y - centerY) * tubeScale,
        z * tubeScale,
      );
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function getSharedPrimitiveSphereGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
): THREE.SphereGeometry {
  const key = keyOf(['sphere', role, tier, radius]);
  let geom = sharedGeometry.get(key) as THREE.SphereGeometry | undefined;
  if (geom === undefined) {
    geom = createPrimitiveSphereGeometry(role, tier, radius);
    sharedGeometry.set(key, geom);
  }
  return geom;
}

export function getSharedPrimitiveCylinderGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radiusTop = 1,
  radiusBottom = radiusTop,
  height = 1,
  heightSegments = 1,
  openEnded = false,
): THREE.CylinderGeometry {
  const key = keyOf([
    'cylinder',
    role,
    tier,
    radiusTop,
    radiusBottom,
    height,
    heightSegments,
    openEnded ? 1 : 0,
  ]);
  let geom = sharedGeometry.get(key) as THREE.CylinderGeometry | undefined;
  if (geom === undefined) {
    geom = createPrimitiveCylinderGeometry(
      role,
      tier,
      radiusTop,
      radiusBottom,
      height,
      heightSegments,
      openEnded,
    );
    sharedGeometry.set(key, geom);
  }
  return geom;
}

export function getSharedPrimitiveConeGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
  height = 1,
  heightSegments = 1,
  openEnded = false,
): THREE.ConeGeometry {
  const key = keyOf(['cone', role, tier, radius, height, heightSegments, openEnded ? 1 : 0]);
  let geom = sharedGeometry.get(key) as THREE.ConeGeometry | undefined;
  if (geom === undefined) {
    geom = createPrimitiveConeGeometry(role, tier, radius, height, heightSegments, openEnded);
    sharedGeometry.set(key, geom);
  }
  return geom;
}

export function getSharedPrimitiveCircleGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
): THREE.CircleGeometry {
  const key = keyOf(['circle', role, tier, radius]);
  let geom = sharedGeometry.get(key) as THREE.CircleGeometry | undefined;
  if (geom === undefined) {
    geom = createPrimitiveCircleGeometry(role, tier, radius);
    sharedGeometry.set(key, geom);
  }
  return geom;
}

export function getSharedPrimitiveRingGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  innerRadius = 0.9,
  outerRadius = 1,
): THREE.RingGeometry {
  const key = keyOf(['ring', role, tier, innerRadius, outerRadius]);
  let geom = sharedGeometry.get(key) as THREE.RingGeometry | undefined;
  if (geom === undefined) {
    geom = createPrimitiveRingGeometry(role, tier, innerRadius, outerRadius);
    sharedGeometry.set(key, geom);
  }
  return geom;
}

export function getSharedPrimitiveTorusGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
  tube = 0.1,
): THREE.TorusGeometry {
  const key = keyOf(['torus', role, tier, radius, tube]);
  let geom = sharedGeometry.get(key) as THREE.TorusGeometry | undefined;
  if (geom === undefined) {
    geom = createPrimitiveTorusGeometry(role, tier, radius, tube);
    sharedGeometry.set(key, geom);
  }
  return geom;
}
