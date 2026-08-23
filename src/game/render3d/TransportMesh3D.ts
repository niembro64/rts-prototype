// TransportMesh3D — the beam-carry transport's chassis: a horizontal
// squared-circle ring (the fabricator's torus vocabulary) with its FRONT
// QUARTER missing so the open center reads as a mouth, and a smoothed
// sphere cap sealing each cut end. The center stays empty — the carried
// unit hangs there in the tractor beam — and the four hover fans come
// from the ordinary drone locomotion rig, not from this builder.
//
// Chassis children live in unit-radius-1 space (x forward, y up,
// z lateral); the renderer scales the chassis group by the unit's render
// radius (times the carry-expansion factor) every frame.

import * as THREE from 'three';
import {
  createPrimitiveTorusGeometry,
  getSharedPrimitiveSphereGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

/** Ring proportions in radius-1 space. */
const TRANSPORT_RING_RADIUS = 0.92;
const TRANSPORT_RING_TUBE = 0.17;
/** Front quarter missing: the drawn arc is 3/2 π. */
const TRANSPORT_RING_ARC = Math.PI * 1.5;
/** Half of the missing quarter — the gap straddles +forward. */
const TRANSPORT_RING_GAP_HALF = Math.PI * 0.25;
const TRANSPORT_RING_HEIGHT = 0.16;
/** The end caps grow slightly past the tube so the cut reads sealed. */
const TRANSPORT_END_CAP_SCALE = 1.12;

// ONE fixed geometry tier for the whole chassis. The ring IS the
// transport's silhouette and it is a tiny mesh: per-tier variants made
// the drone visibly change shape while zooming — the shared sphere
// factory volume-compensates coarse tessellation by INFLATING radius
// (the far-tier end caps grew the chassis height ~63%), and the arc's
// major path turned polygonal. Constant geometry costs a few hundred
// triangles at worst and keeps the silhouette identical at every rung.
const TRANSPORT_GEOMETRY_TIER: PrimitiveGeometryTier = 'close';

let transportRingGeometry: THREE.TorusGeometry | null = null;

function getTransportRingGeometry(): THREE.TorusGeometry {
  if (transportRingGeometry === null) {
    transportRingGeometry = createPrimitiveTorusGeometry(
      'locomotion',
      TRANSPORT_GEOMETRY_TIER,
      TRANSPORT_RING_RADIUS,
      TRANSPORT_RING_TUBE,
      TRANSPORT_RING_ARC,
    );
    // TorusGeometry draws its arc from angle 0; rotating by the gap half
    // angle centers the MISSING quarter on local +X, which the horizontal
    // lay-down below maps onto the unit's forward axis.
    transportRingGeometry.rotateZ(TRANSPORT_RING_GAP_HALF);
  }
  return transportRingGeometry;
}

/** Build the open-ring chassis. Returns the meshes that carry the team
 *  primary material so the caller can register them for recoloring. */
export function buildTransportChassis(
  chassis: THREE.Group,
  primaryMat: THREE.Material,
  entityId: number,
  // Accepted for call-site symmetry with the other bespoke chassis
  // builders, but deliberately unused: see TRANSPORT_GEOMETRY_TIER.
  _tier: PrimitiveGeometryTier,
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];

  const ring = new THREE.Mesh(getTransportRingGeometry(), primaryMat);
  // Torus local XY plane -> chassis XZ plane (horizontal), ring axis up.
  ring.rotation.x = Math.PI / 2;
  ring.position.y = TRANSPORT_RING_HEIGHT;
  ring.userData.entityId = entityId;
  chassis.add(ring);
  meshes.push(ring);

  // Smoothed end caps at the two cut faces of the missing quarter.
  const capGeometry = getSharedPrimitiveSphereGeometry('locomotion', TRANSPORT_GEOMETRY_TIER);
  for (const side of [-1, 1] as const) {
    const angle = side * TRANSPORT_RING_GAP_HALF;
    const cap = new THREE.Mesh(capGeometry, primaryMat);
    cap.position.set(
      Math.cos(angle) * TRANSPORT_RING_RADIUS,
      TRANSPORT_RING_HEIGHT,
      Math.sin(angle) * TRANSPORT_RING_RADIUS,
    );
    cap.scale.setScalar(TRANSPORT_RING_TUBE * TRANSPORT_END_CAP_SCALE);
    cap.userData.entityId = entityId;
    chassis.add(cap);
    meshes.push(cap);
  }

  return meshes;
}
