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
import type { GroundRing3D } from './GroundRing3D';
import {
  getBarrelOrbitAngle,
  getConeBarrelBaseOrbitRadius,
  getConeBarrelTipOrbitRadius,
  getSimpleMultiBarrelOrbitRadius,
  getTurretBarrelCenterToTipLength,
  getTurretBarrelDiameter,
  getTurretHeadRadius,
  turretBarrelFollowsBeam,
} from '../math';
import {
  buildConstructionEmitterRigFromTurretConfig,
  type ConstructionEmitterRig,
} from './ConstructionEmitterMesh3D';
import { TURRET_BLUEPRINTS } from '../sim/blueprints/turrets';
import { featureVisibleAtDetail, geometryTierForDetail } from './EntityDetailLevel3D';
import {
  getSharedPrimitiveCylinderGeometry,
  getSharedPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';

export type TurretMesh = {
  root: THREE.Group;
  /** Absent for:
   *   - shields (the glowing sphere is the whole visual)
   *   - units routing the head through the shared `turretHeadInstanced`
   *     InstancedMesh (deps.skipHead=true) — caller sets `headSlot`
   *     and the per-frame writer fills the slot with the head's
   *     world transform + team color. */
  head?: THREE.Mesh;
  /** Slot index in Render3DEntities.turretHeadInstanced when the head
   *  is rendered via the shared InstancedMesh. Undefined for hidden
   *  heads (shield / compact effects) and for the per-
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
  /** True when these barrels were built with the tapered cone geometry.
   *  Tells the alloc + per-frame writer to route through the cone
   *  instanced pool instead of the cylinder pool. */
  barrelUsesCone?: boolean;
  /** True for head-only turrets: the per-frame writer treats the head as
   *  body geometry, so it stays on the player primary color while aim
   *  state changes. Ray turret heads still track the beam direction. */
  headOnly?: boolean;
  /** True for ray turrets whose head is posed from the last beam direction
   *  (`TurretBeamAimCache3D`) instead of the sim's turret aim. Set iff
   *  `turretBarrelFollowsBeam(config)`. */
  barrelFollowsBeam?: boolean;
  /** True for visible shield-sphere emitter cores. The
   *  per-frame writer drives the active shield pulse on these heads. */
  shieldEmitterCore?: boolean;
  /** Unique material for per-Mesh shield-emitter fallbacks. Instanced
   *  heads carry the pulse through instanceColor instead. */
  shieldEmitterPulseMat?: THREE.Material;
  /** Pitch pivot (rotation.z = pitch) — tilts firing direction up/down.
   *  Parent of spinGroup. */
  pitchGroup?: THREE.Group;
  /** Spin pivot, nested INSIDE pitchGroup so its local +X is the
   *  already-pitched firing axis — spin rotates the barrel cluster
   *  around the real pitched direction, not around world-X. */
  spinGroup?: THREE.Group;
  /** Visual-only construction turret rig. Built from the turret
   *  blueprint instead of bespoke commander/factory art. */
  constructionEmitter?: ConstructionEmitterRig;
  /** Per-mesh render caches used by the building/tower renderer to avoid
   *  repeating static scenegraph/material writes on active turret hosts. */
  cachedRootVisible?: boolean;
  cachedHeadMaterial?: THREE.Material;
  cachedBarrelMaterial?: THREE.Material;
  cachedSpinRotationX?: number;
  /** Per-turret TURR CIR overlay circles (filled in by the range-ring
   *  update path; nothing built here). */
  rangeRings?: {
    trackAcquire?: GroundRing3D;
    trackRelease?: GroundRing3D;
    engageAcquire?: GroundRing3D;
    engageRelease?: GroundRing3D;
    engageMinAcquire?: GroundRing3D;
    engageMinRelease?: GroundRing3D;
  };
};

type TurretMesh3DDeps = {
  headGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  /** Barrel geometry for authored single-cone barrels. */
  coneBarrelGeom: THREE.CylinderGeometry;
  /** Resolved primary (player color) material for this unit. */
  primaryMat: THREE.Material;
  /** Neutral barrel material. Turret heads/bodies use the team mid color;
   *  barrels stay visually distinct across all LOD rungs. */
  turretAccentMat: THREE.Material;
  /** Optional starting material for visible shield emitter cores. Shield
   *  turrets normally render through ShieldRenderer3D only, but shield
   *  sphere emitters can request a small physical core so the mount is
   *  readable. */
  shieldEmitterMat?: THREE.Material;
  showShieldEmitterCore?: boolean;
  /** When true, skip building the per-Mesh head sphere — the caller
   *  is rendering the head through the shared InstancedMesh path
   *  instead. Barrels still build and pivot at headRadius regardless,
   *  same as the existing hideHead-but-with-barrels path. */
  skipHead?: boolean;
  /** When true, BUILD the per-barrel Mesh objects but DON'T attach
   *  them to spinGroup — the caller is rendering barrels through the
   *  shared instanced barrel pools and reads the Mesh's position /
   *  quaternion / scale as the per-barrel base transform.
   *  The Meshes still live in TurretMesh.barrels[] as data carriers
   *  but are never drawn directly. */
  skipBarrels?: boolean;
  /** Binary host visual detail: HIGH/full mesh or LOW/proxy fallback.
   *  Gameplay aim and projectile origins remain unchanged. */
  detailLevel?: number;
};

// Scratch vectors reused across all turret builds — module-local so
// nothing allocates per call.
const _barrelUp = new THREE.Vector3();
const _barrelDir = new THREE.Vector3();

export function buildTurretMesh3D(
  parent: THREE.Group,
  turret: Turret,
  gfx: GraphicsConfig,
  deps: TurretMesh3DDeps,
): TurretMesh {
  const root = new THREE.Group();
  const barrel = turret.config.barrel;
  const isShield = barrel?.type === 'complexSingleEmitter';
  const headRadius = getTurretHeadRadius(turret.config);
  const headOnly = turret.config.headOnly === true;
  const detailLevel = deps.detailLevel ?? 1;
  // Beam (ray) turrets stay head-only on the wire and visually: the beam
  // cylinder itself originates at the turret mount center.
  const followsBeam = turretBarrelFollowsBeam(turret.config);

  if (turret.config.constructionEmitter !== null) {
    // Resource-pylon turrets render only their own resource's pylon; a
    // constructionEmitter with no resourcePylon falls back to the energy+metal
    // pair. Read the resource off the blueprint registry (not the runtime
    // TurretConfig, which doesn't carry pylon data).
    const pylonResource =
      TURRET_BLUEPRINTS[turret.config.turretBlueprintId]?.resourcePylon?.resource ?? null;
    const constructionEmitter = buildConstructionEmitterRigFromTurretConfig(
      turret.config,
      turret.config.visualVariant ?? undefined,
      deps.primaryMat,
      pylonResource,
    );
    root.add(constructionEmitter.group);
    parent.add(root);
    return {
      root,
      headRadius,
      barrels: [],
      constructionEmitter,
    };
  }

  // Skip the head sphere entirely for:
  //  - turretStyle='none': no body, no barrels — chassis only.
  //  - shield turrets at any detail: the ShieldRenderer3D's glowing
  //    sphere is the whole visual.
  //  - radius.other: null → headRadius 0: the explicit "draw no body
  //    sphere" signal (barrels collapse to nothing too, since they scale
  //    off this radius).
  //  - deps.skipHead=true: the caller is rendering the head through the
  //    shared `turretHeadInstanced` InstancedMesh path — see
  //    Render3DEntities.allocTurretHeadSlot.
  const turretOff = gfx.turretStyle === 'none';
  const showShieldEmitterCore = isShield && deps.showShieldEmitterCore === true;
  const noBodySphere = headRadius <= 0;
  const hideHead =
    turretOff ||
    gfx.turretStyle === 'simple' ||
    !featureVisibleAtDetail('turretHead', detailLevel) ||
    (isShield && !showShieldEmitterCore) ||
    noBodySphere;
  const skipHeadMesh = hideHead || deps.skipHead === true;

  // Resolved head radius drives BOTH the sphere mesh size AND its
  // attachment height. Computed up front so the barrel block can pivot
  // at the head center even when the head itself is hidden.
  let head: THREE.Mesh | undefined;
  let shieldEmitterPulseMat: THREE.Material | undefined;
  if (!skipHeadMesh) {
    const baseHeadMat = showShieldEmitterCore
      ? deps.shieldEmitterMat ?? deps.primaryMat
      : deps.primaryMat;
    const headMat = showShieldEmitterCore ? baseHeadMat.clone() : baseHeadMat;
    if (showShieldEmitterCore) shieldEmitterPulseMat = headMat;
    // Per-Mesh heads (towers, commanders, pool-exhaustion fallback) take
    // the host's geometry tier: the passed close-tier sphere at full
    // detail, a tier-shared sphere below it.
    const headTier = geometryTierForDetail(detailLevel);
    const headGeom = headTier === 'close'
      ? deps.headGeom
      : getSharedPrimitiveSphereGeometry('turret', headTier);
    head = new THREE.Mesh(headGeom, headMat);
    head.scale.setScalar(headRadius);
    head.position.set(0, headRadius, 0);
    root.add(head);
  }

  // Cache headRadius on the returned mesh whenever the head is
  // visible (per-Mesh OR via the instanced path) so the per-frame
  // writer can read the resolved value without re-calling
  // getTurretHeadRadius. Hidden heads (shield / turret-off)
  // don't need it — leave headRadius undefined.
  const cachedHeadRadius = hideHead ? undefined : headRadius;

  const barrels: THREE.Mesh[] = [];
  // Head-only turrets stop here as a bare head sphere. Ray turrets keep
  // barrelFollowsBeam so the pose pass can still point the head along the
  // last fired beam, but there is no cone, muzzle ball, or barrel offset.
  if (!barrel || isShield || turretOff || headOnly) {
    parent.add(root);
    return {
      root,
      head,
      headRadius: cachedHeadRadius,
      barrels,
      headOnly,
      barrelFollowsBeam: followsBeam,
      shieldEmitterCore: showShieldEmitterCore,
      shieldEmitterPulseMat,
    };
  }

  // Barrel pivots through the head's center, so its Y in turret-root
  // local space is the head radius.
  const barrelCenterY = headRadius;

  // Barrel thickness resolves from the runtime turret config, whose
  // shot and barrel were built from the turret + shot blueprints.
  const diameter = getTurretBarrelDiameter(turret.config);
  // CylinderGeometry is unit radius = 1, so physical radius = scale.x = diameter/2.
  const cylRadius = diameter / 2;

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
  // Cone barrels narrow to a point at the muzzle. Authored explicitly
  // per turret via `barrel.type === 'singleConeBarrel'`; everything
  // else (including the multi-barrel clusters) uses the uniform cylinder
  // geometry.
  const barrelUsesCone = barrel.type === 'singleConeBarrel';
  // Per-Mesh barrels (towers etc.) take the host's geometry tier, same
  // rule as the head sphere above. Cone barrels keep the passed geometry
  // (their beam-wave layers derive from it).
  const barrelTier = geometryTierForDetail(detailLevel);
  const segmentGeom = barrelUsesCone
    ? deps.coneBarrelGeom
    : barrelTier === 'close'
      ? deps.barrelGeom
      : getSharedPrimitiveCylinderGeometry('turret', barrelTier);
  const pushSegment = (
    baseX: number, baseY: number, baseZ: number,
    tipX: number, tipY: number, tipZ: number,
  ): void => {
    const dx = tipX - baseX;
    const dy = tipY - baseY;
    const dz = tipZ - baseZ;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-4) return;
    const m = new THREE.Mesh(segmentGeom, deps.turretAccentMat);
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

  // Barrel length and multi-barrel orbits are authored against the
  // TURRET HEAD radius, not the host unit's body radius. That keeps
  // every instance of the same turret blueprint rendering at the same
  // size regardless of which unit mounts it.
  const barrelScale = headRadius;
  const length = getTurretBarrelCenterToTipLength(turret.config);
  // barrelLength=0 (e.g. shield panel host) → no visible barrel.
  if (length < 1e-4) {
    parent.add(root);
    return {
      root, head, headRadius: cachedHeadRadius, barrels, pitchGroup, spinGroup,
      headOnly, barrelFollowsBeam: followsBeam,
    };
  }

  if (barrel.type === 'singleCylinderBarrel' || barrel.type === 'singleConeBarrel') {
    pushSegment(0, parentBaseY, 0, length, parentBaseY, 0);
  } else if (barrel.type === 'simpleMultiBarrel') {
    // Parallel barrels arranged in a YZ circle around the firing axis.
    const secondaryBarrelsVisible = featureVisibleAtDetail('barrelSecondary', detailLevel);
    if (!secondaryBarrelsVisible) {
      pushSegment(0, parentBaseY, 0, length, parentBaseY, 0);
    }
    const orbitR = getSimpleMultiBarrelOrbitRadius(barrel, barrelScale);
    const n = secondaryBarrelsVisible ? barrel.barrelCount : 0;
    for (let i = 0; i < n; i++) {
      const a = getBarrelOrbitAngle(i, n);
      const oy = Math.cos(a) * orbitR;
      const oz = Math.sin(a) * orbitR;
      pushSegment(0, parentBaseY + oy, oz, length, parentBaseY + oy, oz);
    }
  } else if (barrel.type === 'coneMultiBarrel') {
    // Barrels diverge from base orbit to a wider tip orbit.
    const secondaryBarrelsVisible = featureVisibleAtDetail('barrelSecondary', detailLevel);
    if (!secondaryBarrelsVisible) {
      pushSegment(0, parentBaseY, 0, length, parentBaseY, 0);
    }
    const baseOrbitR = getConeBarrelBaseOrbitRadius(barrel, barrelScale);
    const tipOrbitR = getConeBarrelTipOrbitRadius(
      barrel,
      barrelScale,
      length,
      turret.config.spread?.angle,
    );
    const n = secondaryBarrelsVisible ? barrel.barrelCount : 0;
    for (let i = 0; i < n; i++) {
      const a = getBarrelOrbitAngle(i, n);
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      pushSegment(
        0, parentBaseY + cosA * baseOrbitR, sinA * baseOrbitR,
        length, parentBaseY + cosA * tipOrbitR, sinA * tipOrbitR,
      );
    }
  }

  parent.add(root);
  return {
    root, head, headRadius: cachedHeadRadius, barrels, pitchGroup, spinGroup,
    barrelUsesCone, headOnly, barrelFollowsBeam: followsBeam,
  };
}
