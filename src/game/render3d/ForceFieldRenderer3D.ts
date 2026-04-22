// ForceFieldRenderer3D — 3D visualization for force-field turrets.
//
// A force-field turret uses the `complexSingleEmitter` barrel type and carries
// a `ForceShot` (shot.type === 'force') configured with push/pull zone ranges.
// It animates per-tick via `turret.forceField.range` (0 → 1 progress).
//
// Rendering mirrors the 2D TurretRenderer behavior:
//   - A small pulsing sphere at the turret mount, color-lerping white → blue
//     with progress, sine-pulsing at the turret's transitionTime period.
//   - A translucent flat "ring" on the ground for the push zone, with the
//     inner radius shrinking from outerRange to innerRange as progress → 1.

import * as THREE from 'three';
import type { Entity, Turret } from '../sim/types';
import { getWeaponWorldPosition } from '../math';

// Must match Render3DEntities to keep emitter spheres roughly at the turret's
// vertical center; the push ring always lies on the ground (y=0).
const SHOT_HEIGHT = 28 + 16 / 2;   // CHASSIS_HEIGHT + TURRET_HEIGHT/2
const RING_Y = 1;                  // just above ground to avoid z-fight

const EMITTER_COLOR_A = 0xf0f0f0;  // idle: white
const EMITTER_COLOR_B = 0x3366ff;  // active: blue
const EMITTER_BASE_RADIUS = 4;
const EMITTER_MAX_RADIUS = 10;
const RING_SEGMENTS = 48;

function isForceFieldTurret(t: Turret): boolean {
  return (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
}

type FieldMesh = {
  sphere: THREE.Mesh;
  sphereMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  /** Cached inner/outer so we don't rebuild RingGeometry unnecessarily. */
  cachedInner: number;
  cachedOuter: number;
};

export class ForceFieldRenderer3D {
  private root: THREE.Group;
  private sphereGeom = new THREE.SphereGeometry(1, 12, 10);
  private fields = new Map<string, FieldMesh>();

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
  }

  private acquire(key: string): FieldMesh {
    const existing = this.fields.get(key);
    if (existing) {
      existing.sphere.visible = true;
      existing.ring.visible = true;
      return existing;
    }
    const sphereMat = new THREE.MeshBasicMaterial({
      color: EMITTER_COLOR_A,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(this.sphereGeom, sphereMat);
    sphere.renderOrder = 7;
    this.root.add(sphere);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    // Placeholder ring; geometry is (re)built on demand when inner/outer change.
    const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.01, RING_SEGMENTS), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 6;
    this.root.add(ring);

    const field: FieldMesh = {
      sphere, sphereMat, ring, ringMat,
      cachedInner: -1, cachedOuter: -1,
    };
    this.fields.set(key, field);
    return field;
  }

  update(units: readonly Entity[]): void {
    const seen = new Set<string>();
    const nowSec = performance.now() / 1000;

    for (const unit of units) {
      if (!unit.turrets || !unit.unit) continue;
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

        // Central pulsing sphere: lerp white → blue, radius scales with progress.
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
        field.sphereMat.color.setRGB(r / 255, g / 255, b / 255);
        const sphereRadius = EMITTER_BASE_RADIUS
          + (EMITTER_MAX_RADIUS - EMITTER_BASE_RADIUS) * progress;
        field.sphere.scale.setScalar(sphereRadius);
        field.sphere.position.set(wp.x, SHOT_HEIGHT, wp.y);

        // Push zone ring — inner radius shrinks from outer → innerRange with progress.
        const push = shot.push;
        const outer = push.outerRange;
        const inner = push.outerRange - (push.outerRange - push.innerRange) * progress;
        if (outer > inner && outer > 0) {
          if (
            Math.abs(inner - field.cachedInner) > 0.5
            || Math.abs(outer - field.cachedOuter) > 0.5
          ) {
            field.ring.geometry.dispose();
            field.ring.geometry = new THREE.RingGeometry(inner, outer, RING_SEGMENTS);
            field.cachedInner = inner;
            field.cachedOuter = outer;
          }
          field.ring.position.set(wp.x, RING_Y, wp.y);
          const fadeIn = Math.min(progress * 3, 1);
          field.ringMat.color.set(push.color);
          field.ringMat.opacity = push.alpha * fadeIn;
          field.ring.visible = true;
        } else {
          field.ring.visible = false;
        }
      }
    }

    // Hide (but don't destroy) meshes for fields that turned off or units gone.
    for (const [key, field] of this.fields) {
      if (!seen.has(key)) {
        field.sphere.visible = false;
        field.ring.visible = false;
      }
    }
  }

  destroy(): void {
    for (const field of this.fields.values()) {
      this.root.remove(field.sphere);
      this.root.remove(field.ring);
      field.sphereMat.dispose();
      field.ringMat.dispose();
      field.ring.geometry.dispose();
    }
    this.fields.clear();
    this.sphereGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
