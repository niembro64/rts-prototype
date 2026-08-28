import * as THREE from 'three';
import {
  getVolumeToggle,
  setVolumeToggle,
  VOLUME_TYPES,
} from '@/clientBarConfig';
import type { VolumeType } from '@/types/client';
import type { ClientViewState } from '../network/ClientViewState';
import type { OverlayLineSystem } from './OverlayLineSystem';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';

/** Renderer scaffold shared by the VOLUMES-bar overlay contract tests: a
 *  SelectionOverlayRenderer3D over a stub 512x512 view whose selection set
 *  the test controls, with every VOLUMES toggle captured up front.
 *  `restoreAndDispose` puts the toggles back and disposes everything the
 *  scaffold created — call it in the test's `finally`. */
export function createSelectionOverlayFixture(): {
  renderer: SelectionOverlayRenderer3D;
  selectedIds: Set<number>;
  radiusSphereGeom: THREE.WireframeGeometry;
  restoreAndDispose: () => void;
} {
  const previous = new Map<VolumeType, boolean>();
  for (const type of VOLUME_TYPES) previous.set(type, getVolumeToggle(type));

  const sphereSourceGeom = createPrimitiveSphereGeometry('debug', 'close');
  const radiusSphereGeom = new THREE.WireframeGeometry(sphereSourceGeom);
  const selectedIds = new Set<number>();
  const renderer = new SelectionOverlayRenderer3D({
    world: new THREE.Group(),
    clientViewState: {
      getMapWidth: () => 512,
      getMapHeight: () => 512,
      getSelectedIds: () => selectedIds,
    } as unknown as ClientViewState,
    radiusSphereGeom,
    overlayLines: undefined as unknown as OverlayLineSystem,
  });

  return {
    renderer,
    selectedIds,
    radiusSphereGeom,
    restoreAndDispose: () => {
      for (const type of VOLUME_TYPES) setVolumeToggle(type, previous.get(type) ?? false);
      renderer.dispose();
      radiusSphereGeom.dispose();
      sphereSourceGeom.dispose();
    },
  };
}
