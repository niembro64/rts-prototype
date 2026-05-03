// Turret mesh builder (3D). Free function so EntityRenderer doesn't
// have to host this 200-line method on its already-busy class.
//
// Builds: a turret root group at (0,0,0) parented to `parent`, an
// optional head sphere, and 0..N barrel cylinders nested under
// pitchGroup → spinGroup. The renderer's per-tick update writes into
// pitchGroup.rotation.z (pitch) and spinGroup.rotation.x (gatling
// spin); barrel positions/orientations are baked at build time.
//
// Vertical layout assumes the parent places root at
// blueprintMount.z - headRadius: the head center and barrels pivot at
// y=headRadius inside this root.

import * as THREE from 'three';
import type { Turret } from '../sim/types';
import type { GraphicsConfig } from '@/types/graphics';
import { getTurretHeadRadius } from '../math';
import { TURRET_HEIGHT } from '../../config';

const BARREL_MIN_THICKNESS = 2;

export type TurretMesh = {
  root: THREE.Group;
  /** Absent for:
   *   - force fields (the glowing sphere is the whole visual)
   *   - units routing the head through the shared `turretHeadInstanced`
   *     InstancedMesh (deps.skipHead=true) — caller sets `headSlot`
   *     and the per-frame writer fills the slot with the head's
   *     world transform + team color. */
  head?: THREE.Mesh;
  /** Slot index in Render3DEntities.turretHeadInstanced when the head
   *  is rendered via the shared InstancedMesh. Undefined for hidden
   *  heads (force-field / min-tier) and for the per-
   *  Mesh fallback (when the cap is exhausted). The caller assigns
   *  this after buildTurretMesh3D returns. */
  headSlot?: number;
  /** Cached head sphere radius in world units. Set whenever a head
   *  exists (per-Mesh OR instanced) so the per-frame writer doesn't
   *  re-call getTurretHeadRadius — the value is constant per-turret
   *  (depends on unitRadius + turret config, neither of which change). */
  headRadius?: number;
  /** Barrel cylinder Mesh objects. When `deps.skipBarrels` was true
   *  these are NOT in the scene — they're kept here purely as data
   *  carriers (.position / .quaternion / .scale set by pushSegment
   *  hold the per-barrel base transform within spinGroup-local), and
   *  the shared `barrelInstanced` InstancedMesh does the rendering.
   *  When `deps.skipBarrels` was false (cap exhausted on alloc), the
   *  Meshes are parented to spinGroup and render normally. */
  barrels: THREE.Mesh[];
  /** Slot index into Render3DEntities.barrelInstanced for each barrel
   *  in `barrels`, set after alloc by the caller (Render3DEntities).
   *  `barrelSlots[i]` is the slot for `barrels[i]`. Empty when no
   *  barrels are routed through the InstancedMesh path (per-Mesh
   *  fallback). */
  barrelSlots?: number[];
  /** Pitch pivot (rotation.z = pitch) — tilts firing direction up/down.
   *  Parent of spinGroup. */
  pitchGroup?: THREE.Group;
  /** Spin pivot, nested INSIDE pitchGroup so its local +X is the
   *  already-pitched firing axis — spin rotates the barrel cluster
   *  around the real pitched direction, not around world-X. */
  spinGroup?: THREE.Group;
  /** Per-turret TURR RAD overlay spheres (filled in by the range-ring
   *  update path; nothing built here). */
  rangeRings?: {
    trackAcquire?: THREE.LineSegments;
    trackRelease?: THREE.LineSegments;
    engageAcquire?: THREE.LineSegments;
    engageRelease?: THREE.LineSegments;
    engageMinAcquire?: THREE.LineSegments;
    engageMinRelease?: THREE.LineSegments;
  };
};

export type TurretMesh3DDeps = {
  headGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  barrelMat: THREE.Material;
  /** Resolved primary (player color) material for this unit. */
  primaryMat: THREE.Material;
  /** When true, skip building the per-Mesh head sphere — the caller
   *  is rendering the head through the shared InstancedMesh path
   *  instead. Barrels still build and pivot at headRadius regardless,
   *  same as the existing hideHead-but-with-barrels path. */
  skipHead?: boolean;
  /** When true, BUILD the per-barrel Mesh objects but DON'T attach
   *  them to spinGroup — the caller is rendering barrels through the
   *  shared `barrelInstanced` InstancedMesh and reads the Mesh's
   *  position / quaternion / scale as the per-barrel base transform.
   *  The Meshes still live in TurretMesh.barrels[] as data carriers
   *  but are never drawn directly. */
  skipBarrels?: boolean;
};

// Scratch vectors reused across all turret builds — module-local so
// nothing allocates per call.
const _barrelUp = new THREE.Vector3();
const _barrelDir = new THREE.Vector3();

export function buildTurretMesh3D(
  parent: THREE.Group,
  turret: Turret,
  unitRadius: number,
  gfx: GraphicsConfig,
  deps: TurretMesh3DDeps,
): TurretMesh {
  const root = new THREE.Group();
  const barrel = turret.config.barrel;
  const isForceField = barrel?.type === 'complexSingleEmitter';

  // Skip the head sphere entirely for:
  //  - turretStyle='none' (min LOD): no body, no barrels — chassis only.
  //  - force-field turrets at ANY LOD: the ForceFieldRenderer3D's glowing
  //    sphere is the whole visual.
  //  - deps.skipHead=true: the caller is rendering the head through the
  //    shared `turretHeadInstanced` InstancedMesh path — see
  //    Render3DEntities.allocTurretHeadSlot.
  const turretOff = gfx.turretStyle === 'none';
  const hideHead = turretOff || isForceField;
  const skipHeadMesh = hideHead || deps.skipHead === true;

  // Resolved head radius drives BOTH the sphere mesh size AND its
  // attachment height. Computed up front so the barrel block can pivot
  // at the head center even when the head itself is hidden.
  const headRadius = getTurretHeadRadius(unitRadius, turret.config);

  let head: THREE.Mesh | undefined;
  if (!skipHeadMesh) {
    head = new THREE.Mesh(deps.headGeom, deps.primaryMat);
    head.scale.setScalar(headRadius);
    head.position.set(0, headRadius, 0);
    root.add(head);
  }

  // Cache headRadius on the returned mesh whenever the head is
  // visible (per-Mesh OR via the instanced path) so the per-frame
  // writer can read the resolved value without re-calling
  // getTurretHeadRadius. Hidden heads (force-field / turret-off)
  // don't need it — leave headRadius undefined.
  const cachedHeadRadius = hideHead ? undefined : headRadius;

  const barrels: THREE.Mesh[] = [];
  if (!barrel || isForceField || turretOff) {
    parent.add(root);
    return { root, head, headRadius: cachedHeadRadius, barrels };
  }

  // Barrel pivots through the head's center, so its Y in turret-root
  // local space is the head radius.
  const barrelCenterY = headRadius;

  // Barrel thickness is the shot width (for line shots) falling back to the
  // blueprint-derived barrelThickness. Matches the 2D single-barrel path.
  const shot = turret.config.shot;
  const shotWidth =
    shot && (shot.type === 'beam' || shot.type === 'laser')
      ? shot.width
      : undefined;
  const diameter =
    (barrel.type === 'simpleSingleBarrel' ? shotWidth : undefined)
    ?? barrel.barrelThickness
    ?? BARREL_MIN_THICKNESS;
  // CylinderGeometry is unit radius = 1, so physical radius = scale.x = diameter/2.
  const cylRadius = Math.max(diameter, BARREL_MIN_THICKNESS) / 2;

  // Two nested pivots so pitch and spin don't fight each other:
  //
  //   root
  //   └── pitchGroup   — rotation.z = pitch (tilts firing direction)
  //       └── spinGroup — rotation.x = gatling spin
  //           └── barrel meshes
  //
  // Because spinGroup is a child of pitchGroup, spinGroup's local +X
  // is ALREADY the pitched firing direction. Rotating around its
  // local +X therefore spins the barrel cluster around its real 3D
  // firing axis at any pitch.
  const pitchGroup = new THREE.Group();
  pitchGroup.position.set(0, barrelCenterY, 0);
  root.add(pitchGroup);
  const spinGroup = new THREE.Group();
  pitchGroup.add(spinGroup);
  const barrelParent: THREE.Object3D = spinGroup;
  // Barrels attach to spinGroup at Y=0 — pitchGroup's position already
  // lifts everything to barrelCenterY.
  const parentBaseY = 0;

  // Place one cylinder segment spanning (base) → (tip) in local coords. Used
  // for straight (gatling) and cone (shotgun) barrels alike. The Mesh is
  // built either way (its position / quaternion / scale carry the per-
  // barrel base transform read by Render3DEntities' instance writer).
  // When `deps.skipBarrels` is true the Mesh is built but NOT attached
  // to spinGroup — kept in `barrels[]` purely as a data carrier; the
  // shared `barrelInstanced` InstancedMesh does the rendering.
  const pushSegment = (
    baseX: number, baseY: number, baseZ: number,
    tipX: number, tipY: number, tipZ: number,
  ): void => {
    const dx = tipX - baseX;
    const dy = tipY - baseY;
    const dz = tipZ - baseZ;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-4) return;
    const m = new THREE.Mesh(deps.barrelGeom, deps.barrelMat);
    m.scale.set(cylRadius, length, cylRadius);
    m.position.set(
      (baseX + tipX) / 2,
      (baseY + tipY) / 2,
      (baseZ + tipZ) / 2,
    );
    // Align cylinder's default +Y axis with the (base→tip) direction.
    _barrelUp.set(0, 1, 0);
    _barrelDir.set(dx / length, dy / length, dz / length);
    m.quaternion.setFromUnitVectors(_barrelUp, _barrelDir);
    if (!deps.skipBarrels) barrelParent.add(m);
    barrels.push(m);
  };

  const length = unitRadius * barrel.barrelLength;
  // barrelLength=0 (e.g. commander's d-gun "emitter") → no visible barrel.
  if (length < 1e-4) {
    parent.add(root);
    return { root, head, headRadius: cachedHeadRadius, barrels, pitchGroup, spinGroup };
  }

  if (barrel.type === 'simpleSingleBarrel') {
    pushSegment(0, parentBaseY, 0, length, parentBaseY, 0);
  } else if (barrel.type === 'simpleMultiBarrel') {
    // Parallel barrels arranged in a YZ circle around the firing axis.
    const orbitR = Math.min(barrel.orbitRadius * unitRadius, TURRET_HEIGHT * 0.45);
    const n = barrel.barrelCount;
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) / n * Math.PI * 2;
      const oy = Math.cos(a) * orbitR;
      const oz = Math.sin(a) * orbitR;
      pushSegment(0, parentBaseY + oy, oz, length, parentBaseY + oy, oz);
    }
  } else if (barrel.type === 'coneMultiBarrel') {
    // Barrels diverge from base orbit to a wider tip orbit.
    const baseOrbitR = Math.min(barrel.baseOrbit * unitRadius, TURRET_HEIGHT * 0.35);
    const tipOrbitR = barrel.tipOrbit !== undefined
      ? barrel.tipOrbit * unitRadius
      : Math.min(
          baseOrbitR + length * Math.tan((turret.config.spread?.angle ?? Math.PI / 5) / 2),
          TURRET_HEIGHT * 0.9,
        );
    const n = barrel.barrelCount;
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) / n * Math.PI * 2;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      pushSegment(
        0, parentBaseY + cosA * baseOrbitR, sinA * baseOrbitR,
        length, parentBaseY + cosA * tipOrbitR, sinA * tipOrbitR,
      );
    }
  }

  parent.add(root);
  return { root, head, headRadius: cachedHeadRadius, barrels, pitchGroup, spinGroup };
}
