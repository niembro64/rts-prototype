/**
 * The one rendered root pose per host, published each frame for attachments
 * that are drawn outside the host's own mesh chain.
 *
 * "One rendered root pose owns every attachment" (see
 * budget_design_philosophy.html): a rig must consume the exact batched root
 * position and quaternion used to draw its chassis, and must not
 * independently rebuild yaw, terrain tilt, or interpolation. Turrets, team
 * trim, locomotion rigs and airborne emitters all get that pose passed
 * straight down the call chain because they are drawn inside the unit loop.
 * A shield field is not — it is written into its own instanced pool later in
 * the frame — so it needs the same pose looked up by entity id instead.
 *
 * The pose published here is `UnitRenderPoseBatch3D`'s output: the lifted
 * world position and the visual parent quaternion, which already carry
 * terrain tilt, the authoritative body orientation, and presentation bank.
 * Composing a body-local mount through them therefore lands exactly where
 * the turret carrying it was drawn.
 *
 * Entries live for one frame. A host that was not posed this frame — off the
 * render scope, mesh torn down mid-rebuild — resolves to nothing rather than
 * to a stale pose, which is the failure this store exists to end: the shield
 * bubble used to read a Three.js group that only moves while its unit is
 * being drawn, and fell back to a yaw-only transform that dropped chassis
 * tilt entirely.
 */

import * as THREE from 'three';
import type { EntityId } from '../sim/types';

type HostRenderPoseEntry = {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
};

export class HostRenderPoseStore3D {
  private readonly current = new Map<EntityId, HostRenderPoseEntry>();
  private readonly pool: HostRenderPoseEntry[] = [];
  private poolIndex = 0;
  private readonly scratchQuaternion = new THREE.Quaternion();

  /** Drop last frame's poses. Called once before the unit pose loop. */
  beginFrame(): void {
    this.current.clear();
    this.poolIndex = 0;
  }

  /** Record the pose this host's chassis was drawn from this frame. */
  publish(
    entityId: EntityId,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
  ): void {
    const entry = this.pool[this.poolIndex]
      ?? (this.pool[this.poolIndex] = {
        x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1,
      });
    this.poolIndex++;
    entry.x = position.x;
    entry.y = position.y;
    entry.z = position.z;
    entry.qx = quaternion.x;
    entry.qy = quaternion.y;
    entry.qz = quaternion.z;
    entry.qw = quaternion.w;
    this.current.set(entityId, entry);
  }

  /**
   * Place a chassis-local point (three.js axes, relative to the rendered
   * root) into world space. Returns false when this host has no pose this
   * frame, so the caller can skip rather than draw somewhere wrong.
   */
  composeAttachment(
    entityId: EntityId,
    localX: number,
    localY: number,
    localZ: number,
    out: THREE.Vector3,
  ): boolean {
    const entry = this.current.get(entityId);
    if (entry === undefined) return false;
    this.scratchQuaternion.set(entry.qx, entry.qy, entry.qz, entry.qw);
    out.set(localX, localY, localZ)
      .applyQuaternion(this.scratchQuaternion);
    out.x += entry.x;
    out.y += entry.y;
    out.z += entry.z;
    return true;
  }
}
