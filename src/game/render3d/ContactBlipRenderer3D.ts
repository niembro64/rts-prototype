// World-space radar/sonar contacts.
//
// A contact-only enemy is not the real entity and must not be drawn as one, so
// it gets a generic blip: no blueprint, no body dimensions, no team colour, no
// selection. See budget_design_philosophy.html "Sight, radar, sonar, and
// contacts are separate information tiers".
//
// The treatment is Beyond All Reason's radar-icon one. BAR's coarseness is
// PRESENTATIONAL rather than a truncated wire value: its icon shader offsets
// the drawn position by a sine of game time with a stable per-contact phase and
// draws at reduced alpha, so a contact reads as uncertain because it visibly
// shimmers. A building contact does not wobble -- a structure is stationary and
// its position really is known once anything has touched it.
//
// The extension is the medium. Each contact carries the lane that earned it, so
// a mostly-submerged body sits at the water line and reads as a sonar return
// while an above-water one sits on the ground. That is the only altitude
// information a contact grants: map position and lane, never height.

import * as THREE from 'three';
import { COLORS } from '../../colorsConfig';
import { WATER_LEVEL } from '../sim/terrain/terrainConfig';
import type { MinimapEntity } from '@/types/ui';
import type { ViewportFootprint } from '../ViewportFootprint';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { disposeMesh } from './threeUtils';

const STYLE = COLORS.effects.contactBlip;

/** Golden-ratio hash of the contact id. Any stable per-contact scramble does;
 *  this one keeps neighbouring ids visibly out of phase so a column of blips
 *  never shimmers in lockstep. */
function wobblePhase(contactId: number): number {
  return ((contactId * 0.618033988749895) % 1) * Math.PI * 2;
}

export class ContactBlipRenderer3D {
  private mesh: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private capacity: number;

  constructor(
    private readonly parent: THREE.Group,
    private readonly getTerrainHeight: (x: number, y: number) => number,
    initialCapacity = 64,
  ) {
    this.capacity = Math.max(1, initialCapacity);
    this.mesh = this.createMesh(this.capacity);
    this.parent.add(this.mesh);
  }

  private createMesh(capacity: number): THREE.InstancedMesh {
    const geometry = createPrimitiveSphereGeometry('hud', 'mid', STYLE.radius);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(STYLE.colorHex),
      transparent: true,
      opacity: STYLE.opacity,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity;
    while (next < needed) next *= 2;
    disposeMesh(this.mesh);
    this.capacity = next;
    this.mesh = this.createMesh(next);
    this.parent.add(this.mesh);
  }

  /** `nowSeconds` is presentation time; it only drives the wobble, so it never
   *  needs to agree with sim time across clients. */
  update(
    contacts: readonly MinimapEntity[] | null,
    nowSeconds: number,
    renderScope: ViewportFootprint | undefined,
  ): void {
    if (contacts === null || contacts.length === 0) {
      this.mesh.count = 0;
      return;
    }
    let needed = 0;
    for (let i = 0; i < contacts.length; i++) {
      if (contacts[i].radarOnly === true) needed++;
    }
    if (needed === 0) {
      this.mesh.count = 0;
      return;
    }
    this.ensureCapacity(needed);

    let written = 0;
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      if (contact.radarOnly !== true) continue;
      const baseX = contact.pos.x;
      const baseY = contact.pos.y;
      if (renderScope !== undefined && !renderScope.inScope(baseX, baseY, STYLE.radius + STYLE.wobbleAmplitude)) {
        continue;
      }
      // Buildings hold still: a structure's position is genuinely known.
      let x = baseX;
      let y = baseY;
      if (contact.type !== 'building') {
        const phase = wobblePhase(contact.contactId ?? i);
        const t = nowSeconds * STYLE.wobbleRadiansPerSecond;
        x += Math.sin(t + phase) * STYLE.wobbleAmplitude;
        y += Math.cos(t + phase) * STYLE.wobbleAmplitude;
      }
      // The lane decides the surface: sonar returns sit at the water line,
      // radar returns on the ground.
      const surfaceZ = contact.contactUnderwater === true
        ? WATER_LEVEL
        : Math.max(this.getTerrainHeight(baseX, baseY), WATER_LEVEL);
      this.position.set(x, y, surfaceZ + STYLE.surfaceLift);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(written, this.matrix);
      written++;
    }
    this.mesh.count = written;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  destroy(): void {
    this.dispose();
  }

  dispose(): void {
    disposeMesh(this.mesh);
  }
}
