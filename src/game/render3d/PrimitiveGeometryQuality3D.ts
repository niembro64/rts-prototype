import * as THREE from 'three';

export type PrimitiveGeometryTier = 'close' | 'mid' | 'far';
export type PrimitiveGeometryRole =
  | 'unitBody'
  | 'unitDetail'
  | 'turret'
  | 'projectile'
  | 'beam'
  | 'shield'
  | 'building'
  | 'locomotion'
  | 'effect'
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
  tubeSegments: number;
  radialSegments: number;
};

type PrimitiveRoleQuality = {
  sphere: Record<PrimitiveGeometryTier, SphereSegments>;
  cylinder: Record<PrimitiveGeometryTier, RadialSegments>;
  cone: Record<PrimitiveGeometryTier, RadialSegments>;
  circle: Record<PrimitiveGeometryTier, RadialSegments>;
  torus: Record<PrimitiveGeometryTier, TorusSegments>;
};

export const PRIMITIVE_GEOMETRY_QUALITY: Record<PrimitiveGeometryRole, PrimitiveRoleQuality> = {
  unitBody: {
    sphere: {
      close: { widthSegments: 18, heightSegments: 12 },
      mid: { widthSegments: 12, heightSegments: 8 },
      far: { widthSegments: 8, heightSegments: 6 },
    },
    cylinder: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 16 },
      far: { radialSegments: 10 },
    },
    torus: {
      close: { tubeSegments: 10, radialSegments: 28 },
      mid: { tubeSegments: 8, radialSegments: 20 },
      far: { tubeSegments: 6, radialSegments: 12 },
    },
  },
  unitDetail: {
    sphere: {
      close: { widthSegments: 14, heightSegments: 10 },
      mid: { widthSegments: 10, heightSegments: 8 },
      far: { widthSegments: 8, heightSegments: 6 },
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
      close: { radialSegments: 20 },
      mid: { radialSegments: 14 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 10, radialSegments: 24 },
      mid: { tubeSegments: 8, radialSegments: 18 },
      far: { tubeSegments: 6, radialSegments: 12 },
    },
  },
  turret: {
    sphere: {
      close: { widthSegments: 14, heightSegments: 10 },
      mid: { widthSegments: 10, heightSegments: 8 },
      far: { widthSegments: 8, heightSegments: 6 },
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
      close: { radialSegments: 18 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 8, radialSegments: 20 },
      mid: { tubeSegments: 6, radialSegments: 16 },
      far: { tubeSegments: 5, radialSegments: 10 },
    },
  },
  projectile: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
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
      close: { radialSegments: 16 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 8, radialSegments: 18 },
      mid: { tubeSegments: 6, radialSegments: 12 },
      far: { tubeSegments: 5, radialSegments: 8 },
    },
  },
  beam: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 8, heightSegments: 6 },
      far: { widthSegments: 6, heightSegments: 4 },
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
      close: { radialSegments: 16 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 8, radialSegments: 16 },
      mid: { tubeSegments: 6, radialSegments: 12 },
      far: { tubeSegments: 5, radialSegments: 8 },
    },
  },
  shield: {
    sphere: {
      close: { widthSegments: 16, heightSegments: 10 },
      mid: { widthSegments: 12, heightSegments: 8 },
      far: { widthSegments: 8, heightSegments: 6 },
    },
    cylinder: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 16 },
      far: { radialSegments: 10 },
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
      close: { tubeSegments: 10, radialSegments: 24 },
      mid: { tubeSegments: 8, radialSegments: 16 },
      far: { tubeSegments: 6, radialSegments: 10 },
    },
  },
  building: {
    sphere: {
      close: { widthSegments: 14, heightSegments: 10 },
      mid: { widthSegments: 10, heightSegments: 8 },
      far: { widthSegments: 8, heightSegments: 6 },
    },
    cylinder: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 24 },
      mid: { radialSegments: 16 },
      far: { radialSegments: 10 },
    },
    torus: {
      close: { tubeSegments: 10, radialSegments: 28 },
      mid: { tubeSegments: 8, radialSegments: 20 },
      far: { tubeSegments: 6, radialSegments: 12 },
    },
  },
  locomotion: {
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
      close: { radialSegments: 18 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 10, radialSegments: 28 },
      mid: { tubeSegments: 8, radialSegments: 20 },
      far: { tubeSegments: 6, radialSegments: 12 },
    },
  },
  effect: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
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
      mid: { radialSegments: 14 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 8, radialSegments: 20 },
      mid: { tubeSegments: 6, radialSegments: 14 },
      far: { tubeSegments: 5, radialSegments: 8 },
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
      close: { tubeSegments: 8, radialSegments: 20 },
      mid: { tubeSegments: 6, radialSegments: 14 },
      far: { tubeSegments: 5, radialSegments: 8 },
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
      close: { tubeSegments: 8, radialSegments: 16 },
      mid: { tubeSegments: 6, radialSegments: 12 },
      far: { tubeSegments: 5, radialSegments: 8 },
    },
  },
};

const sharedGeometry = new Map<string, THREE.BufferGeometry>();

function keyOf(parts: readonly unknown[]): string {
  return parts.join(':');
}

function quality(role: PrimitiveGeometryRole): PrimitiveRoleQuality {
  return PRIMITIVE_GEOMETRY_QUALITY[role];
}

export function createPrimitiveSphereGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
): THREE.SphereGeometry {
  const q = quality(role).sphere[tier];
  return new THREE.SphereGeometry(radius, q.widthSegments, q.heightSegments);
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
  return new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    q.radialSegments,
    heightSegments,
    openEnded,
  );
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
  return new THREE.ConeGeometry(radius, height, q.radialSegments, heightSegments, openEnded);
}

export function createPrimitiveCircleGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
): THREE.CircleGeometry {
  const q = quality(role).circle[tier];
  return new THREE.CircleGeometry(radius, q.radialSegments);
}

export function createPrimitiveTorusGeometry(
  role: PrimitiveGeometryRole,
  tier: PrimitiveGeometryTier = 'close',
  radius = 1,
  tube = 0.1,
): THREE.TorusGeometry {
  const q = quality(role).torus[tier];
  return new THREE.TorusGeometry(radius, tube, q.tubeSegments, q.radialSegments);
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
