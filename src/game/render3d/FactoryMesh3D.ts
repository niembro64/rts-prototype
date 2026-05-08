import * as THREE from 'three';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  getBuildingBlueprint,
} from '../sim/blueprints';
import { getTurretConfig } from '../sim/turretConfigs';
import {
  BUILD_BUBBLE_GHOST_COLOR_HEX,
  BUILD_BUBBLE_GHOST_OPACITY,
  BUILD_BUBBLE_CORE_COLOR_HEX,
  BUILD_BUBBLE_CORE_OPACITY,
  BUILD_BUBBLE_PULSE_COLOR_HEX,
  BUILD_BUBBLE_PULSE_OPACITY,
  BUILD_BUBBLE_SPARK_COLOR_HEX,
  BUILD_BUBBLE_SPARK_OPACITY,
} from '@/shellConfig';
import {
  buildConstructionEmitterRigFromTurretConfig,
  disposeConstructionEmitterGeoms,
  type ConstructionTowerOrbitPart,
} from './ConstructionEmitterMesh3D';
import type { BuildingShape } from './BuildingShape3D';
import {
  cylinderGeom,
  detail,
} from './BuildingMeshPrimitives3D';

export type FactoryConstructionRig = {
  group: THREE.Group;
  unitGhost: THREE.Mesh;
  unitCore: THREE.Mesh;
  sparks: THREE.Mesh[];
  /** The three resource "showers" — translucent cylinders surrounding
   *  the factory's three structural pylons. Each fills bottom-up with
   *  its resource's transfer-rate fraction (0..1):
   *    showers[0] = energy (yellow)
   *    showers[1] = mana   (cyan)
   *    showers[2] = metal  (copper)
   *  `pylonHeight` and `pylonBaseY` (the pylon's bottom edge in
   *  chassis-local Y) are stored so the per-frame update can scale
   *  each shower with the live rate without re-deriving metrics. */
  showers: THREE.Mesh[];
  /** Visible tower pieces that orbit the emitter center only while
   *  construction is active. The fabricator and commander emitter both
   *  use the same tower part list so the animation contract cannot
   *  drift between them. */
  towerOrbitParts: ConstructionTowerOrbitPart[];
  showerRadius: number;
  pylonHeight: number;
  pylonBaseY: number;
  /** Chassis-local position of each pylon's top, in the same order
   *  as `showers` (energy / mana / metal). The per-frame update
   *  uses these as the SOURCE of the per-resource colored build
   *  sprays — each spray runs from a pylon top to the build spot. */
  pylonTopsLocal: THREE.Vector3[];
  /** Immutable pylon-top positions before orbital tower spin. The
   *  renderer rotates these into `pylonTopsLocal` with the same phase
   *  used for the visible tower pieces. */
  pylonTopBaseLocals: THREE.Vector3[];
  sprayTravelSpeed: number;
  sprayParticleRadius: number;
  /** Smoothed transfer-rate fractions (0..1), one per resource in
   *  the same order as `showers`. The renderer EMAs the live sim
   *  rates into these so the showers + sprays don't pop on per-tick
   *  step changes. Zeroed at rig creation. */
  smoothedRates: { energy: number; mana: number; metal: number };
  /** Second-stage display EMA layered on top of `smoothedRates`. Drives
   *  the visible shower height + build-spray emission so motion eases
   *  in/out of changes instead of tracking the first stage 1:1. */
  displaySmoothedRates: { energy: number; mana: number; metal: number };
  towerSpinAmount: number;
  /** Second-stage display EMA layered on top of `towerSpinAmount`. The
   *  visible tower spin uses this so spin-up / spin-down eases in. */
  displayTowerSpinAmount: number;
  towerSpinPhase: number;
};

// Build-bubble materials. Strictly whitish/grayish per shellConfig —
// no team color, no amber, no cyan glass. All four mats are kept as
// separate THREE.Material instances so the four roles (ghost shell,
// core orb, travelling pulses, sparks) can be tuned independently
// from shellConfig without recompiling shaders.
const constructionGhostMat = new THREE.MeshBasicMaterial({
  color: BUILD_BUBBLE_GHOST_COLOR_HEX,
  transparent: true,
  opacity: BUILD_BUBBLE_GHOST_OPACITY,
  depthWrite: false,
});
const constructionCoreMat = new THREE.MeshBasicMaterial({
  color: BUILD_BUBBLE_CORE_COLOR_HEX,
  transparent: true,
  opacity: BUILD_BUBBLE_CORE_OPACITY,
  depthWrite: false,
});
// Pulses get their own material so the travelling-orb tint can drift
// from the static-core tint without one knob driving both. (Same
// pattern factory had before the rename to whitish-only.)
const constructionPulseMat = new THREE.MeshBasicMaterial({
  color: BUILD_BUBBLE_PULSE_COLOR_HEX,
  transparent: true,
  opacity: BUILD_BUBBLE_PULSE_OPACITY,
  depthWrite: false,
});
const constructionSparkMat = new THREE.MeshBasicMaterial({
  color: BUILD_BUBBLE_SPARK_COLOR_HEX,
  transparent: true,
  opacity: BUILD_BUBBLE_SPARK_OPACITY,
  depthWrite: false,
});
const constructionOrbGeom = new THREE.SphereGeometry(1, 12, 8);

/** Factory: compact radial construction tower.
 *
 *  The tower is the large version of the same shared three-pylon
 *  construction emitter used by the commander's build turret:
 *  dark-gray resource pillars, team-colored bases, black/white
 *  construction bands on those bases, fixed resource endcaps, and
 *  live resource showers/sprays. The unitGhost + unitCore + sparks
 *  remain at the BUILD SPOT, visualizing the forming unit. */
export function buildFactoryMesh(
  _width: number,
  _depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(cylinderGeom, primaryMat);
  const details: BuildingShape['details'] = [];
  const blueprint = getBuildingBlueprint('factory');
  const constructionMount = blueprint.turrets?.find((mount) => mount.turretId === 'constructionTurret');
  if (!constructionMount) {
    throw new Error('Factory blueprint must mount a constructionTurret');
  }
  const constructionConfig = getTurretConfig(constructionMount.turretId);
  const constructionRig = buildConstructionEmitterRigFromTurretConfig(
    constructionConfig,
    constructionMount.visualVariant,
    primaryMat,
  );
  constructionRig.group.position.set(
    constructionMount.mount.x,
    constructionMount.mount.z - constructionConfig.radius.body,
    constructionMount.mount.y,
  );
  constructionRig.group.visible = false;

  // Build-spot visuals. These follow the FORMING UNIT (not the tower)
  // so they stay even after the central tower pieces were removed.
  const unitGhost = new THREE.Mesh(constructionOrbGeom, constructionGhostMat);
  unitGhost.visible = false;
  details.push(detail(unitGhost, 'medium', undefined, 'factoryUnitGhost'));

  const unitCore = new THREE.Mesh(constructionOrbGeom, constructionCoreMat);
  unitCore.visible = false;
  details.push(detail(unitCore, 'high', undefined, 'factoryUnitCore'));

  const sparks: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const spark = new THREE.Mesh(constructionOrbGeom, constructionSparkMat);
    spark.visible = false;
    sparks.push(spark);
    details.push(detail(spark, 'max', undefined, 'factorySpark'));
  }

  return {
    primary,
    details,
    height: blueprint.visualHeight ?? DEFAULT_BUILDING_VISUAL_HEIGHT,
    factoryRig: {
      group: constructionRig.group,
      unitGhost,
      unitCore,
      sparks,
      showers: constructionRig.showers,
      towerOrbitParts: constructionRig.towerOrbitParts,
      showerRadius: constructionRig.showerRadius,
      pylonHeight: constructionRig.pylonHeight,
      pylonBaseY: constructionRig.pylonBaseY,
      pylonTopsLocal: constructionRig.pylonTopsLocal,
      pylonTopBaseLocals: constructionRig.pylonTopBaseLocals,
      sprayTravelSpeed: constructionRig.sprayTravelSpeed,
      sprayParticleRadius: constructionRig.sprayParticleRadius,
      smoothedRates: { energy: 0, mana: 0, metal: 0 },
      displaySmoothedRates: { energy: 0, mana: 0, metal: 0 },
      towerSpinAmount: 0,
      displayTowerSpinAmount: 0,
      towerSpinPhase: 0,
    },
  };
}

export function disposeFactoryMeshGeoms(): void {
  constructionOrbGeom.dispose();
  disposeConstructionEmitterGeoms();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionPulseMat.dispose();
  constructionSparkMat.dispose();
}
