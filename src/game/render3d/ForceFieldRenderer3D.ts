// ForceFieldRenderer3D — 3D visualization for force-field turrets.
//
// A force-field turret uses the `complexSingleEmitter` barrel type and carries
// a `ForceShot` (shot.type === 'force') configured with push/pull zone ranges.
// It animates per-tick via `turret.forceField.range` (0 → 1 progress).
//
// Rendering:
//   - A small pulsing sphere at the turret mount, color-lerping white → blue
//     with progress, sine-pulsing at the turret's transitionTime period.
//   - A translucent outer sphere the size of the push-zone's outerRange, so
//     the force field looks like a spherical bubble enveloping the unit (a 3D
//     analogue of the 2D annular zone).

import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import { getWeaponWorldPosition } from '../math';
import type { ViewportFootprint } from '../ViewportFootprint';

// Must match Render3DEntities to keep emitter spheres roughly at the turret's
// vertical center.
const SHOT_HEIGHT = 28 + 16 / 2;   // CHASSIS_HEIGHT + TURRET_HEIGHT/2

const EMITTER_COLOR_A = 0xf0f0f0;  // idle: white
const EMITTER_COLOR_B = 0x3366ff;  // active: blue
const EMITTER_BASE_RADIUS = 4;
const EMITTER_MAX_RADIUS = 10;

function isForceFieldTurret(t: Turret): boolean {
  return (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
}

type FieldMesh = {
  emitter: THREE.Mesh;
  emitterMat: THREE.MeshBasicMaterial;
  zone: THREE.Mesh;
  zoneMat: THREE.MeshBasicMaterial;
};

export class ForceFieldRenderer3D {
  private root: THREE.Group;
  // Unit sphere reused for both the small pulsing emitter and the large
  // translucent force-field bubble (scaled per-instance).
  private sphereGeom = new THREE.SphereGeometry(1, 20, 14);
  private fields = new Map<string, FieldMesh>();
  /** RENDER: WIN/PAD/ALL visibility scope — off-screen force fields
   *  skip their per-frame animation work. */
  private scope: ViewportFootprint;

  constructor(parentWorld: THREE.Group, scope: ViewportFootprint) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope;
  }

  private acquire(key: string): FieldMesh {
    const existing = this.fields.get(key);
    if (existing) {
      existing.emitter.visible = true;
      existing.zone.visible = true;
      return existing;
    }
    const emitterMat = new THREE.MeshBasicMaterial({
      color: EMITTER_COLOR_A,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const emitter = new THREE.Mesh(this.sphereGeom, emitterMat);
    emitter.renderOrder = 8; // draw on top of the bubble
    this.root.add(emitter);

    // Spherical force-field bubble. The 2D annular push zone becomes a single
    // translucent sphere at outerRange in 3D; the inner-radius shrinkage is
    // conveyed via alpha (fades in with progress).
    const zoneMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const zone = new THREE.Mesh(this.sphereGeom, zoneMat);
    zone.renderOrder = 7;
    this.root.add(zone);

    const field: FieldMesh = { emitter, emitterMat, zone, zoneMat };
    this.fields.set(key, field);
    return field;
  }

  update(units: readonly Entity[]): void {
    const seen = new Set<string>();
    const nowSec = performance.now() / 1000;

    for (const unit of units) {
      if (!unit.turrets || !unit.unit) continue;
      // Scope gate — force-field bubbles can be large (up to ~push.outerRange
      // units across), so pad generously so a turret just off-screen with
      // its bubble reaching in still updates.
      if (!this.scope.inScope(unit.transform.x, unit.transform.y, 300)) continue;
      const cos = Math.cos(unit.transform.rotation);
      const sin = Math.sin(unit.transform.rotation);

      for (let ti = 0; ti < unit.turrets.length; ti++) {
        const turret = unit.turrets[ti];
        if (!isForceFieldTurret(turret)) continue;
        const progress = turret.forceField?.range ?? 0;
        if (progress <= 0) continue;

        const shot = turret.config.shot;
        if (shot.type !== 'force' || !shot.push) continue;

        const wp = getWeaponWorldPosition(
          unit.transform.x, unit.transform.y,
          cos, sin,
          turret.offset.x, turret.offset.y,
        );
        const key = `${unit.id}-${ti}`;
        seen.add(key);
        const field = this.acquire(key);

        // Central pulsing emitter sphere: lerp white → blue, radius scales with progress.
        const freq = (Math.PI * 2) / (shot.transitionTime / 1000);
        const pulse = (Math.sin(nowSec * freq) * 0.5 + 0.5) * progress;
        const r =
          ((EMITTER_COLOR_A >> 16) & 0xff)
          + (((EMITTER_COLOR_B >> 16) & 0xff) - ((EMITTER_COLOR_A >> 16) & 0xff)) * pulse;
        const g =
          ((EMITTER_COLOR_A >> 8) & 0xff)
          + (((EMITTER_COLOR_B >> 8) & 0xff) - ((EMITTER_COLOR_A >> 8) & 0xff)) * pulse;
        const b =
          (EMITTER_COLOR_A & 0xff)
          + ((EMITTER_COLOR_B & 0xff) - (EMITTER_COLOR_A & 0xff)) * pulse;
        field.emitterMat.color.setRGB(r / 255, g / 255, b / 255);
        const emitterRadius = EMITTER_BASE_RADIUS
          + (EMITTER_MAX_RADIUS - EMITTER_BASE_RADIUS) * progress;
        field.emitter.scale.setScalar(emitterRadius);
        field.emitter.position.set(wp.x, SHOT_HEIGHT, wp.y);

        // Spherical force-field zone — scale = outerRange (= push-zone radius
        // in sim units). Alpha fades in over the first third of progress.
        const push = shot.push;
        const outer = push.outerRange;
        if (outer > 0) {
          const fadeIn = Math.min(progress * 3, 1);
          field.zoneMat.color.set(push.color);
          field.zoneMat.opacity = push.alpha * fadeIn;
          field.zone.scale.setScalar(outer);
          field.zone.position.set(wp.x, SHOT_HEIGHT, wp.y);
          field.zone.visible = true;
        } else {
          field.zone.visible = false;
        }
      }
    }

    // Hide (but don't destroy) meshes for fields that turned off or units gone.
    for (const [key, field] of this.fields) {
      if (!seen.has(key)) {
        field.emitter.visible = false;
        field.zone.visible = false;
      }
    }
  }

  destroy(): void {
    for (const field of this.fields.values()) {
      this.root.remove(field.emitter);
      this.root.remove(field.zone);
      field.emitterMat.dispose();
      field.zoneMat.dispose();
    }
    this.fields.clear();
    this.sphereGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
