// A raised shield is visible at every detail rung, including the one where
// its host stops being drawn.
//
// The entity detail ladder removes a MODEL: below the glyph threshold a unit
// is replaced by its strategic icon and publishes no rendered root pose. Its
// FIELD is not part of that model — it is a world-scale force surface,
// frequently an order of magnitude wider than the chassis running it, and it
// owns its own coverage rung. Gating the field on the host's rendered pose
// made the two share one threshold, so a dome hundreds of units across
// vanished the moment the ten-pixel unit under it flipped to an icon.
//
// This test pins both halves of the contract:
//   - a host with a published render pose anchors its field to that pose
//     (chassis tilt / body orientation / presentation bank all carry), and
//   - a host with NO pose this frame still draws its field, from the mount
//     origin the packet resolved off the authoritative transform.
//
// See budget_design_philosophy.html, "One Shared Entity Detail Ladder".

import * as THREE from 'three';
import { HostRenderPoseStore3D } from './HostRenderPoseStore3D';
import { ShieldRenderPacket3D, ShieldRenderer3D } from './ShieldRenderer3D';
import { SHIELD_FIELD_SHAPE_SPHERE } from './ShieldFieldShape3D';
import type { EntityId } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[shield field detail contract] ${message}`);
  }
}

const HOST_ID = 4242 as EntityId;
const HOST_X = 120;
const HOST_Y = -60;
const HOST_Z = 18;
const MOUNT_Z = 9;
const OUTER_RANGE = 260;

function pushSphereField(packet: ShieldRenderPacket3D): void {
  packet.reset();
  packet.pushRow({
    hostId: HOST_ID,
    turretIndex: 0,
    x: HOST_X,
    y: HOST_Y,
    z: HOST_Z,
    localX: 0,
    localY: MOUNT_Z,
    localZ: 0,
    targetX: HOST_X,
    targetY: HOST_Y,
    targetZ: HOST_Z,
    originX: HOST_X,
    originY: HOST_Y,
    originZ: HOST_Z + MOUNT_Z,
    progress: 1,
    outerRange: OUTER_RANGE,
    originOffsetZ: 0,
    barrierAlpha: 0.35,
    color: 0x66ccff,
    shape: SHIELD_FIELD_SHAPE_SPHERE,
  });
}

/** Every drawn field instance across the tiered pools, as world positions. */
function drawnFieldPositions(root: THREE.Group): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const matrix = new THREE.Matrix4();
  root.traverse((object) => {
    const mesh = object as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      out.push(new THREE.Vector3().setFromMatrixPosition(matrix));
    }
  });
  return out;
}

export function runShieldFieldDetailLevel3DContractTest(): void {
  const world = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 20000);
  camera.position.set(HOST_X, 1200, HOST_Y + 1200);
  camera.lookAt(HOST_X, 0, HOST_Y);
  camera.updateMatrixWorld(true);
  const hostRenderPoses = new HostRenderPoseStore3D();
  // Field surfaces are barrier-scope culled by the packet, not the renderer,
  // so this stands in for "already in scope".
  const scope = { inScope: () => true } as unknown as ViewportFootprint;
  const renderer = new ShieldRenderer3D(world, scope, camera, hostRenderPoses);
  const packet = new ShieldRenderPacket3D();

  try {
    // 1. Host drew a chassis: the field rides the published root pose.
    pushSphereField(packet);
    hostRenderPoses.beginFrame();
    const posedRootY = 33;
    hostRenderPoses.publish(
      HOST_ID,
      new THREE.Vector3(HOST_X, posedRootY, HOST_Y),
      new THREE.Quaternion(),
    );
    renderer.update(packet);
    const posed = drawnFieldPositions(world);
    assertContract(
      posed.length === 1,
      'a raised field whose host was drawn must render exactly one surface',
    );
    assertContract(
      Math.abs(posed[0].y - (posedRootY + MOUNT_Z)) < 1e-3 &&
      Math.abs(posed[0].x - HOST_X) < 1e-3 &&
      Math.abs(posed[0].z - HOST_Y) < 1e-3,
      'a drawn host anchors its field to the rendered root pose its chassis used',
    );

    // 2. Same field, same frame budget — but the host is a strategic glyph
    //    now, so nothing published a pose for it. The field must survive.
    pushSphereField(packet);
    hostRenderPoses.beginFrame();
    renderer.update(packet);
    const glyphed = drawnFieldPositions(world);
    assertContract(
      glyphed.length === 1,
      'a raised field must still render when its host drew no chassis this frame',
    );
    assertContract(
      Math.abs(glyphed[0].x - HOST_X) < 1e-3 &&
      Math.abs(glyphed[0].y - (HOST_Z + MOUNT_Z)) < 1e-3 &&
      Math.abs(glyphed[0].z - HOST_Y) < 1e-3,
      'a poseless host draws its field from the packet mount origin, not from nothing',
    );

    // 3. A collapsed field is still absent — the fallback restores the
    //    barrier's own visibility, never a barrier that is not raised.
    packet.reset();
    packet.pushRow({
      hostId: HOST_ID,
      turretIndex: 0,
      x: HOST_X,
      y: HOST_Y,
      z: HOST_Z,
      localX: 0,
      localY: MOUNT_Z,
      localZ: 0,
      targetX: HOST_X,
      targetY: HOST_Y,
      targetZ: HOST_Z,
      originX: HOST_X,
      originY: HOST_Y,
      originZ: HOST_Z + MOUNT_Z,
      progress: 0,
      outerRange: OUTER_RANGE,
      originOffsetZ: 0,
      barrierAlpha: 0.35,
      color: 0x66ccff,
      shape: SHIELD_FIELD_SHAPE_SPHERE,
    });
    hostRenderPoses.beginFrame();
    renderer.update(packet);
    assertContract(
      drawnFieldPositions(world).length === 0,
      'an unpowered field must stay invisible whether or not its host was drawn',
    );
  } finally {
    renderer.destroy();
  }
}
