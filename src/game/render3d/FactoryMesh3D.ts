import * as THREE from 'three';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  getBuildingBlueprint,
} from '../sim/blueprints';
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
import { disposeConstructionEmitterGeoms } from './ConstructionEmitterMesh3D';
import type { BuildingShape } from './BuildingShape3D';
import {
  cylinderGeom,
  detail,
} from './BuildingMeshPrimitives3D';
import { FABRICATOR_TORUS_HOVER_HEIGHT, fabricatorTorusRingRadius } from '../sim/blueprints';

// Unit torus (ring radius 1, tube 0.22) for the hovering fabricator body. Scaled
// per-instance to the footprint and laid flat (horizontal ring) at hover height.
const fabricatorTorusGeom = new THREE.TorusGeometry(1, 0.22, 12, 32);

/** Factory-only "what's being built" visualizer. Lives at the factory's
 *  centered build bay (not on the turret) and shows the
 *  forming unit as a translucent ghost orb with sparks. This is
 *  conceptually separate from the construction emitter rig that lives on
 *  the turretConstruction — the emitter is shared with commanders and
 *  construction aircraft via the standard turret-mesh path. */
export type FactoryBuildSpotRig = {
  unitGhost: THREE.Mesh;
  unitCore: THREE.Mesh;
  sparks: THREE.Mesh[];
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

/** Factory chassis. Just the team-colored primary body and the
 *  build-spot ghost orb / sparks. The factory's construction emitter
 *  (towers + sprays) is NOT created here — it rides on the
 *  factory's `turretConstruction` like any other turret-mounted emitter,
 *  built by the standard TurretMesh3D path. */
export function buildFactoryMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  // The fabricator is a hovering TORUS, not a body shell — render bodyless and
  // hang the ring (+ its under-slung spawn / construction pylons) in the air.
  const primary = new THREE.Mesh(cylinderGeom, primaryMat);
  const details: BuildingShape['details'] = [];
  const blueprint = getBuildingBlueprint('towerFabricator');

  // Hovering torus body: a flat (horizontal) team-colored ring at the spawn
  // height, sized to the footprint. The unit shell appears in its center and
  // free-falls through the open middle while the down-pointing pylons finish it.
  const torus = new THREE.Mesh(fabricatorTorusGeom, primaryMat);
  const ringRadius = fabricatorTorusRingRadius(width, depth);
  torus.scale.set(ringRadius, ringRadius, ringRadius);
  torus.rotation.x = Math.PI / 2;
  torus.position.y = FABRICATOR_TORUS_HOVER_HEIGHT;
  details.push(detail(torus, 'medium', undefined, 'static'));

  // Build-bay visuals. These follow the FORMING UNIT (not the tower)
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
    bodyless: true,
    height: blueprint.visualHeight ?? DEFAULT_BUILDING_VISUAL_HEIGHT,
    factoryBuildSpotRig: {
      unitGhost,
      unitCore,
      sparks,
    },
  };
}

export function disposeFactoryMeshGeoms(): void {
  constructionOrbGeom.dispose();
  fabricatorTorusGeom.dispose();
  disposeConstructionEmitterGeoms();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionPulseMat.dispose();
  constructionSparkMat.dispose();
}
