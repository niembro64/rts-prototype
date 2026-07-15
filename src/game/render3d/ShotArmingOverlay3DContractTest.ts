import * as THREE from 'three';
import {
  getUnitRadiusToggle,
  setUnitRadiusToggle,
  UNIT_RADIUS_TYPES,
} from '@/clientBarConfig';
import type { UnitRadiusType } from '@/types/client';
import { WorldState } from '../sim/WorldState';
import { getUnitBlueprint } from '../sim/blueprints';
import { getHostShotArmingRadius } from '../sim/combat/shotArming';
import { readNetworkUnitRadius } from '../network/unitSnapshotFields';
import type { ClientViewState } from '../network/ClientViewState';
import type { EntityMesh } from './EntityMesh3D';
import type { OverlayLineSystem } from './OverlayLineSystem';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[shot arming overlay contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(`[shot arming overlay contract] ${message}: expected ${expected}, got ${actual}`);
  }
}

export function runShotArmingOverlay3DContractTest(): void {
  const previous = new Map<UnitRadiusType, boolean>();
  for (const type of UNIT_RADIUS_TYPES) previous.set(type, getUnitRadiusToggle(type));

  const sphereSourceGeom = createPrimitiveSphereGeometry('debug', 'close');
  const radiusSphereGeom = new THREE.WireframeGeometry(sphereSourceGeom);
  const renderer = new SelectionOverlayRenderer3D({
    world: new THREE.Group(),
    clientViewState: {
      getMapWidth: () => 512,
      getMapHeight: () => 512,
      getSelectedIds: () => new Set<number>(),
    } as unknown as ClientViewState,
    radiusSphereGeom,
    overlayLines: undefined as unknown as OverlayLineSystem,
  });

  try {
    for (const type of UNIT_RADIUS_TYPES) setUnitRadiusToggle(type, type === 'shotArmingRadius');
    renderer.beginFrame();

    const host = new WorldState(7831, 512, 512).createUnitFromBlueprint(
      120,
      140,
      1,
      'unitFormik',
    );
    assertContract(host.unit !== null, 'overlay host must carry a unit component');
    // Reproduce live-client hydration: unit radius DTOs omit immutable ARM,
    // which must be restored from the locally shared blueprint.
    host.unit.radius = readNetworkUnitRadius(null, getUnitBlueprint('unitFormik').radius);
    const mesh = {
      group: new THREE.Group(),
      turrets: [],
    } as unknown as EntityMesh;
    renderer.updateUnitRadiusRings(mesh, host);

    const armMesh = mesh.radiusRings?.shotArmingRadius;
    assertContract(armMesh !== undefined, 'ARM toggle must create a host sphere mesh');
    assertContract(armMesh.visible, 'ARM host sphere mesh must be visible while its button is active');
    assertNear(
      armMesh.scale.x,
      getHostShotArmingRadius(host),
      'ARM mesh scale must equal the authoritative authored host radius',
    );
    assertNear(
      armMesh.scale.x,
      host.unit.radius.collision * 1.5,
      'ARM mesh must be 1.5 times the host collision sphere',
    );

    setUnitRadiusToggle('shotArmingRadius', false);
    renderer.beginFrame();
    renderer.updateUnitRadiusRings(mesh, host);
    assertContract(!armMesh.visible, 'ARM host sphere mesh must hide when its button is inactive');
  } finally {
    for (const type of UNIT_RADIUS_TYPES) setUnitRadiusToggle(type, previous.get(type) ?? false);
    renderer.dispose();
    radiusSphereGeom.dispose();
    sphereSourceGeom.dispose();
  }
}
