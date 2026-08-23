// TractorBeamVisual3D — the transport's gravity beam.
//
// Not a nano spray: a SOLID TRANSPARENT VOLUME. One soft additive blob
// per carrying transport that always fills the ring's inner cylinder and
// reaches down to envelop the held unit. Every dimension is eased per
// frame — the blob GROWS out of the ring to grab a unit and retracts
// smoothly on release; nothing ever snaps to a new shape.
//
// Data channel: the same beam pairs the ring's carry-expansion reads
// (transport id -> passenger id, derived from the transport-sourced
// sprays). The pose loop hands this renderer smoothed world anchors for
// both ends each frame, so the volume rides exactly what the meshes do.

import * as THREE from 'three';
import type { EntityId } from '../sim/types';
import {
  getSharedPrimitiveCylinderGeometry,
  getSharedPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';

const BEAM_COLOR = 0x7fd6ff;
const BEAM_OPACITY = 0.22;
/** Per-frame ease factor (per ms) for every animated dimension. */
const BEAM_EASE_PER_MS = 0.006;
/** The blob dies once its envelope has shrunk under this length. */
const BEAM_RETRACT_EPSILON = 1.5;

const beamMaterial = new THREE.MeshBasicMaterial({
  color: BEAM_COLOR,
  transparent: true,
  opacity: BEAM_OPACITY,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const unitCylinder = getSharedPrimitiveCylinderGeometry('beam', 'close', 1, 1, 1, 1, true);
const unitSphere = getSharedPrimitiveSphereGeometry('beam', 'close');

export type TractorBeamAnchor = {
  topX: number;
  topY: number;
  topZ: number;
  /** Inner-cylinder radius of the (possibly carry-expanded) ring. */
  ringRadius: number;
  bottomX: number;
  bottomY: number;
  bottomZ: number;
  /** The held unit's volume radius the blob should envelop. */
  holdRadius: number;
};

type BeamState = {
  group: THREE.Group;
  tube: THREE.Mesh;
  throat: THREE.Mesh;
  grip: THREE.Mesh;
  // Eased current values.
  topX: number; topY: number; topZ: number;
  bottomX: number; bottomY: number; bottomZ: number;
  ringRadius: number;
  holdRadius: number;
  releasing: boolean;
};

const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

export class TractorBeamVisual3D {
  private readonly parent: THREE.Group;
  private readonly beams = new Map<EntityId, BeamState>();

  constructor(parent: THREE.Group) {
    this.parent = parent;
  }

  /** Called once per frame with this frame's live anchors (world coords,
   *  three.js axes). Transports absent from the map ease shut. */
  update(anchors: ReadonlyMap<EntityId, TractorBeamAnchor> | null, dtMs: number): void {
    const ease = Math.min(1, dtMs * BEAM_EASE_PER_MS);

    if (anchors !== null) {
      for (const [transportId, anchor] of anchors) {
        let beam = this.beams.get(transportId);
        if (beam === undefined) {
          // Born collapsed AT the ring so the first frames read as the
          // field reaching out of the ring toward the unit.
          beam = this.createBeam(anchor);
          this.beams.set(transportId, beam);
        }
        beam.releasing = false;
        beam.topX += (anchor.topX - beam.topX) * ease;
        beam.topY += (anchor.topY - beam.topY) * ease;
        beam.topZ += (anchor.topZ - beam.topZ) * ease;
        beam.bottomX += (anchor.bottomX - beam.bottomX) * ease;
        beam.bottomY += (anchor.bottomY - beam.bottomY) * ease;
        beam.bottomZ += (anchor.bottomZ - beam.bottomZ) * ease;
        beam.ringRadius += (anchor.ringRadius - beam.ringRadius) * ease;
        beam.holdRadius += (anchor.holdRadius - beam.holdRadius) * ease;
      }
    }

    for (const [transportId, beam] of this.beams) {
      if (beam.releasing || anchors === null || !anchors.has(transportId)) {
        // Released: the grip lets go — the envelope eases back up into
        // the ring and the blob evaporates once it is fully home.
        beam.releasing = true;
        beam.bottomX += (beam.topX - beam.bottomX) * ease;
        beam.bottomY += (beam.topY - beam.bottomY) * ease;
        beam.bottomZ += (beam.topZ - beam.bottomZ) * ease;
        beam.holdRadius += (0 - beam.holdRadius) * ease;
        const dx = beam.bottomX - beam.topX;
        const dy = beam.bottomY - beam.topY;
        const dz = beam.bottomZ - beam.topZ;
        if (dx * dx + dy * dy + dz * dz < BEAM_RETRACT_EPSILON * BEAM_RETRACT_EPSILON) {
          this.disposeBeam(transportId, beam);
          continue;
        }
      }
      this.poseBeam(beam);
    }
  }

  destroy(): void {
    for (const [transportId, beam] of this.beams) this.disposeBeam(transportId, beam);
  }

  private createBeam(anchor: TractorBeamAnchor): BeamState {
    const group = new THREE.Group();
    const tube = new THREE.Mesh(unitCylinder, beamMaterial);
    const throat = new THREE.Mesh(unitSphere, beamMaterial);
    const grip = new THREE.Mesh(unitSphere, beamMaterial);
    for (const mesh of [tube, throat, grip]) {
      mesh.renderOrder = 6;
      group.add(mesh);
    }
    this.parent.add(group);
    return {
      group,
      tube,
      throat,
      grip,
      topX: anchor.topX,
      topY: anchor.topY,
      topZ: anchor.topZ,
      bottomX: anchor.topX,
      bottomY: anchor.topY - 1,
      bottomZ: anchor.topZ,
      ringRadius: anchor.ringRadius * 0.4,
      holdRadius: 0,
      releasing: false,
    };
  }

  /** Capsule blob between the eased endpoints: a soft dome filling the
   *  ring interior, a tapered tube reaching to the unit, and a grip
   *  bulb enveloping the held volume. */
  private poseBeam(beam: BeamState): void {
    _dir.set(
      beam.bottomX - beam.topX,
      beam.bottomY - beam.topY,
      beam.bottomZ - beam.topZ,
    );
    const length = Math.max(0.5, _dir.length());
    _dir.normalize();
    _quat.setFromUnitVectors(_up, _dir);

    beam.group.position.set(beam.topX, beam.topY, beam.topZ);
    beam.group.quaternion.copy(_quat);

    // Tube: from the ring plane down to the grip, radius blending the
    // ring interior into the held volume.
    const tubeRadius = Math.max(0.5, (beam.ringRadius + beam.holdRadius) * 0.5);
    beam.tube.scale.set(tubeRadius, length, tubeRadius);
    beam.tube.position.set(0, -length / 2, 0);
    beam.tube.rotation.x = Math.PI;

    // Throat: dome filling the ring's open center.
    const throatRadius = Math.max(0.5, beam.ringRadius);
    beam.throat.scale.set(throatRadius, throatRadius * 0.55, throatRadius);
    beam.throat.position.set(0, 0, 0);

    // Grip: the bulb that envelops the carried unit.
    const gripRadius = Math.max(0.5, beam.holdRadius);
    beam.grip.scale.setScalar(gripRadius);
    beam.grip.position.set(0, -length, 0);
  }

  private disposeBeam(transportId: EntityId, beam: BeamState): void {
    this.parent.remove(beam.group);
    this.beams.delete(transportId);
  }
}
