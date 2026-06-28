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

// Close tier still means an RTS camera close-up, not hero-asset smoothness.
// Keep high-count roles deliberately modest; buildings/shields/HUD retain
// richer silhouettes where instance counts are lower or readability matters.
export const PRIMITIVE_GEOMETRY_QUALITY: Record<PrimitiveGeometryRole, PrimitiveRoleQuality> = {
  unitBody: {
    sphere: {
      close: { widthSegments: 12, heightSegments: 8 },
      mid: { widthSegments: 10, heightSegments: 6 },
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
      close: { radialSegments: 18 },
      mid: { radialSegments: 12 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 8, radialSegments: 20 },
      mid: { tubeSegments: 6, radialSegments: 14 },
      far: { tubeSegments: 5, radialSegments: 10 },
    },
  },
  unitDetail: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 8, heightSegments: 6 },
      far: { widthSegments: 6, heightSegments: 4 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 16 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 6, radialSegments: 16 },
      mid: { tubeSegments: 5, radialSegments: 12 },
      far: { tubeSegments: 4, radialSegments: 8 },
    },
  },
  turret: {
    sphere: {
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 8, heightSegments: 6 },
      far: { widthSegments: 6, heightSegments: 4 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 6, radialSegments: 14 },
      mid: { tubeSegments: 5, radialSegments: 10 },
      far: { tubeSegments: 4, radialSegments: 8 },
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
      close: { tubeSegments: 6, radialSegments: 12 },
      mid: { tubeSegments: 5, radialSegments: 8 },
      far: { tubeSegments: 4, radialSegments: 6 },
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
  shieldImpact: {
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
      close: { tubeSegments: 6, radialSegments: 24 },
      mid: { tubeSegments: 5, radialSegments: 16 },
      far: { tubeSegments: 4, radialSegments: 10 },
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
      close: { widthSegments: 10, heightSegments: 8 },
      mid: { widthSegments: 8, heightSegments: 6 },
      far: { widthSegments: 6, heightSegments: 4 },
    },
    cylinder: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 6 },
    },
    cone: {
      close: { radialSegments: 8 },
      mid: { radialSegments: 6 },
      far: { radialSegments: 6 },
    },
    circle: {
      close: { radialSegments: 14 },
      mid: { radialSegments: 10 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 6, radialSegments: 16 },
      mid: { tubeSegments: 5, radialSegments: 12 },
      far: { tubeSegments: 4, radialSegments: 8 },
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
  smoke: {
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
      mid: { radialSegments: 14 },
      far: { radialSegments: 8 },
    },
    torus: {
      close: { tubeSegments: 8, radialSegments: 20 },
      mid: { tubeSegments: 6, radialSegments: 14 },
      far: { tubeSegments: 5, radialSegments: 8 },
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
      close: { tubeSegments: 5, radialSegments: 8 },
      mid: { tubeSegments: 5, radialSegments: 8 },
      far: { tubeSegments: 5, radialSegments: 8 },
    },
  },
  waterSplash: {
    sphere: {
      close: { widthSegments: 5, heightSegments: 3 },
      mid: { widthSegments: 5, heightSegments: 3 },
      far: { widthSegments: 5, heightSegments: 3 },
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
      close: { tubeSegments: 6, radialSegments: 12 },
      mid: { tubeSegments: 5, radialSegments: 10 },
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
