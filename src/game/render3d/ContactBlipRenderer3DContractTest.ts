import * as THREE from 'three';
import type { MinimapEntity } from '@/types/ui';
import {
  ClientLockstepPresentation,
  PRESENTED_ENTITY_POSITION_STRIDE,
} from '../network/ClientLockstepPresentation';
import { CONTACT_MEDIUM_AIR } from '../network/contactMedium';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import type { Entity } from '../sim/types';
import { getSimWasm } from '../sim-wasm/init';
import { ContactBlipRenderer3D } from './ContactBlipRenderer3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[contact blip renderer contract] ${message}`);
}

type ProxyRendererProbe = {
  beginFrame(): void;
  pushProxy(...args: number[]): void;
  flush(): void;
  destroy(): void;
};

function assertSharedPresentationPose(): void {
  const wasm = getSimWasm();
  const views = entitySlotRegistry.getViews();
  assertContract(wasm !== undefined && wasm.presentation.hasHistory(), 'presentation history must be live');
  assertContract(views !== null, 'entity position views must be live');
  let entityId = -1;
  for (let slot = 0; slot < views.capacity; slot++) {
    if (views.entityId[slot] < 0) continue;
    entityId = views.entityId[slot];
    break;
  }
  assertContract(entityId >= 0, 'the running contract scene must contain an authoritative entity pose');

  const visibleEntity = {
    id: entityId,
    transform: { x: 0, y: 0, z: 0, rotation: 0 },
    unit: {
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      surfaceNormal: { nx: 0, ny: 0, nz: 1 },
      orientation: null,
      angularVelocity3: null,
    },
    building: null,
    projectile: null,
    combat: null,
  } as unknown as Entity;

  const presentation = new ClientLockstepPresentation();
  const now = performance.now();
  presentation.noteFixedTick(wasm.presentation.latestTick(), now - 25, 20);
  presentation.apply([visibleEntity], 1, now);
  const contactPose = new Float32Array(PRESENTED_ENTITY_POSITION_STRIDE);
  presentation.resolveEntityPositions([entityId], contactPose);
  assertContract(contactPose[0] === 1, 'the anonymous position-only lookup must resolve a live entity');
  assertContract(
    visibleEntity.transform.x === contactPose[1] &&
      visibleEntity.transform.y === contactPose[2] &&
      visibleEntity.transform.z === contactPose[3],
    'visible models and anonymous contacts must read the exact same fixed-tick pose and alpha',
  );
}

export function runContactBlipRenderer3DContractTest(): void {
  assertSharedPresentationPose();
  const renderer = new ContactBlipRenderer3D(new THREE.Group());
  const internal = renderer as unknown as {
    proxyRenderer: ProxyRendererProbe;
    tracks: Map<number, Record<string, unknown>>;
  };
  internal.proxyRenderer.destroy();

  const draws: number[][] = [];
  internal.proxyRenderer = {
    beginFrame: () => { draws.length = 0; },
    pushProxy: (...args) => { draws.push(args); },
    flush: () => {},
    destroy: () => {},
  };

  const contact: MinimapEntity = {
    pos: { x: 10, y: 20 },
    type: 'unit',
    color: '#ffffff',
    radarOnly: true,
    contactId: 77,
    contactMediumMask: CONTACT_MEDIUM_AIR,
    contactZ: 30,
  };
  let presentedX = 100;
  let presentedY = 200;
  let presentedZ = 300;
  const resolvePositions = (ids: readonly number[], out: Float32Array): void => {
    assertContract(ids.length === 1 && ids[0] === 77, 'the anonymous id must be the sole pose lookup key');
    assertContract(
      out.length >= PRESENTED_ENTITY_POSITION_STRIDE,
      'the renderer must provide one complete ephemeral pose row',
    );
    out[0] = 1;
    out[1] = presentedX;
    out[2] = presentedY;
    out[3] = presentedZ;
  };

  renderer.update(
    [contact],
    1,
    undefined,
    500,
    { timeFades: true },
    resolvePositions,
  );
  assertContract(
    draws.length === 1 && draws[0][0] === 100 && draws[0][1] === 200,
    'a blip must draw at the shared entity pose, never its stale snapshot coordinate',
  );
  assertContract(
    contact.pos.x === 100 && contact.pos.y === 200 && contact.contactZ === 300,
    'the minimap contact must publish the same shared pose as the battlefield blip',
  );

  const track = internal.tracks.get(77);
  assertContract(track !== undefined, 'the heard contact must retain fade membership');
  const forbiddenPositionState = [
    'x', 'y', 'z',
    'fromX', 'fromY', 'fromZ',
    'toX', 'toY', 'toZ',
    'velX', 'velY', 'velZ',
  ];
  assertContract(
    forbiddenPositionState.every((key) => !(key in track)),
    'contact fade state must not retain an independent location, endpoints, or velocity',
  );

  // The next membership snapshot promotes the same id to full sight. The old
  // anonymous mark is still fading, but it must follow the newly visible
  // model's current pose so the transition remains spatially co-located.
  presentedX = 140;
  presentedY = 240;
  presentedZ = 340;
  draws.length = 0;
  const visibleRow: MinimapEntity = {
    pos: { x: 140, y: 240 },
    type: 'unit',
    color: '#ff0000',
  };
  renderer.update(
    [visibleRow],
    2,
    undefined,
    100,
    { timeFades: true },
    resolvePositions,
  );
  const secondDrawX = Number(draws[0]?.[0]);
  const secondDrawY = Number(draws[0]?.[1]);
  assertContract(
    draws.length === 1 && secondDrawX === 140 && secondDrawY === 240,
    'the fading blip must stay on the current entity pose during radar-to-sight cross-fade',
  );

  renderer.dispose();
}
