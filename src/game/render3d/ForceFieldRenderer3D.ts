// ForceFieldRenderer3D — 3D visualization for force-field turrets.
//
// A force-field turret uses the `complexSingleEmitter` barrel type and carries
// a `ForceShot` (shot.type === 'force') configured with push/pull zone ranges.
// It animates per-tick via `turret.forceField.range` (0 → 1 progress).
//
// Rendering tiers (driven by gfx.forceFieldStyle, mirroring the 2D
// ForceFieldEffect contract):
//   minimal — translucent bubble + emitter only.
//   simple  — bubble + emitter + radial particle motes (HI LOD).
//   enhanced — bubble + emitter + particles + electric arcs (MAX LOD).
//
// Particle motes are small bright spheres distributed across the bubble's
// 3D surface that drift radially through the field's depth. Electric arcs
// are short jagged BufferGeometry polylines inside the bubble that
// re-randomize every arcFlickerMs to produce a crackling read.

import * as THREE from 'three';
import type { Entity, EntityId, Turret } from '../sim/types';
import { getBodyMountTopY } from './BodyShape3D';
import { getUnitBlueprint } from '../sim/blueprints';
import { getGraphicsConfig } from '@/clientBarConfig';
import { FORCE_FIELD_VISUAL } from '../../config';
import type { ViewportFootprint } from '../ViewportFootprint';

/** How far the force-field emitter sphere is embedded into the body
 *  part it's mounted on. Expressed as a chassis-local Y offset added
 *  to the part's top:
 *
 *    insetY = -INSET_BELOW_DOME_FRAC × emitter_max_radius
 *
 *  At 0 the emitter sphere center sits exactly at the dome's top
 *  (bottom hemisphere embedded in the body, top hemisphere above).
 *  Positive values would lift the emitter; negative values sink it
 *  further. We use 0 — half-embedded — which reads as a turret
 *  emitter "sunk into the head" without disappearing entirely. */
const INSET_DEPTH_BELOW_DOME = 0;

const EMITTER_COLOR_A = 0xf0f0f0;  // idle: white
const EMITTER_COLOR_B = 0x3366ff;  // active: blue
const EMITTER_BASE_RADIUS = 4;
const EMITTER_MAX_RADIUS = 10;

// Per-LOD particle counts. The 3D field has 4π·r² worth of surface area
// vs the 2D ring's 2π·r perimeter, so we emit a bit more than the 2D
// `particleCount` baseline to keep visual density comparable.
const PARTICLE_COUNT_SIMPLE = 28;
const PARTICLE_COUNT_ENHANCED = 56;
const PARTICLE_RADIUS = 1.4;   // world units per mote

// MAX-only particle TRAILS — comet-style ghost segments behind each
// main mote, mirroring the 2D enhanced look (FORCE_FIELD_VISUAL.
// trailSegments = 3, trailFalloff = 0.45 per step). Each trail spans
// trailFrac of the radial band behind its parent mote.
const TRAIL_SEGMENTS = 3;
const TRAIL_FRAC_PER_STEP = 0.045;   // of (outer − inner)
const TRAIL_OPACITY_FALLOFF = 0.5;   // multiplier per successive trail
const TRAIL_SCALE_FALLOFF = 0.75;    // shrink factor per successive trail

// Opacity multiplier on top of push.alpha so the field reads more
// solid in 3D than the 2D translucent fill — applied uniformly to the
// bubble, particles, and arcs. Doubling from 1.0 to 2.0 makes the
// effect twice as opaque visually.
const FIELD_OPACITY_BOOST = 2.0;

// Per-LOD arc counts (enhanced only).
const ARC_COUNT_ENHANCED = 4;

function isForceFieldTurret(t: Turret): boolean {
  return (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
}

type FieldMesh = {
  emitter: THREE.Mesh;
  emitterMat: THREE.MeshBasicMaterial;
  zone: THREE.Mesh;
  zoneMat: THREE.MeshBasicMaterial;
  // Particle motes. Allocated lazily up to PARTICLE_COUNT_ENHANCED. Per
  // frame we show only the LOD-appropriate prefix.
  particles: THREE.Mesh[];
  particleMat: THREE.MeshBasicMaterial;
  // MAX-only ghost trails behind each particle. Allocated lazily;
  // index = particleIdx × TRAIL_SEGMENTS + trailIdx. Each trail uses
  // its own material because the opacity decays per trail step.
  trailMeshes: THREE.Mesh[];
  trailMats: THREE.MeshBasicMaterial[];
  // Electric arc geometry, allocated only on first 'enhanced' frame.
  arcGeom?: THREE.BufferGeometry;
  arcMat?: THREE.LineBasicMaterial;
  arcLines?: THREE.LineSegments;
  arcLastFlickerMs: number;
};

/** Deterministic 0..1 hash used by the particle layout + arc jitter so each
 *  field has stable angular slots without per-frame allocation. Same shape
 *  the 2D effect uses, with an additional seed mixed in. */
function fieldHash(n: number, seed: number): number {
  let h = (n | 0) * 2654435761 + (seed | 0) * 1597334677;
  h = ((h >>> 16) ^ h) * 45679;
  return ((h >>> 16) ^ h) / 4294967296 + 0.5;
}

export class ForceFieldRenderer3D {
  private root: THREE.Group;
  // Unit sphere reused for the bubble, the emitter, and the particle motes.
  private sphereGeom = new THREE.SphereGeometry(1, 20, 14);
  private particleSphereGeom = new THREE.SphereGeometry(1, 6, 4);
  private fields = new Map<string, FieldMesh>();
  /** Reused across `update()` calls to track which fields are still
   *  active this frame (everything not in here gets pruned). Allocating
   *  a fresh Set per frame is wasted GC pressure — clear-and-reuse. */
  private _seenFieldKeys = new Set<string>();
  /** RENDER: WIN/PAD/ALL visibility scope — off-screen force fields
   *  skip their per-frame animation work. */
  private scope: ViewportFootprint;
  /** Look up the unit's yaw subgroup. Force-field meshes attach to
   *  this group like a regular turret root — the scenegraph chain
   *  (group → yawGroup → field meshes) handles position, tilt, and
   *  yaw automatically, so the field stays glued to its host through
   *  every kind of motion the unit can do. Returns undefined when
   *  the unit's mesh hasn't been built yet (off-scope at scene
   *  start) or was torn down (LOD flip mid-frame); we skip the field
   *  for that frame and re-acquire when the mesh is back. */
  private getYawGroup: (eid: EntityId) => THREE.Group | undefined;

  constructor(
    parentWorld: THREE.Group,
    scope: ViewportFootprint,
    getYawGroup: (eid: EntityId) => THREE.Group | undefined,
  ) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope;
    this.getYawGroup = getYawGroup;
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

    // Bright particle material, additive so motes pop over the bubble.
    const particleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const field: FieldMesh = {
      emitter,
      emitterMat,
      zone,
      zoneMat,
      particles: [],
      particleMat,
      trailMeshes: [],
      trailMats: [],
      arcLastFlickerMs: 0,
    };
    this.fields.set(key, field);
    return field;
  }

  /** Lazily allocate particle meshes up to the requested count.
   *  New meshes parent to the SAME group the field's emitter is in —
   *  after reparentFieldTo, that's the host unit's yawGroup, so motes
   *  spawn directly into the chassis-local frame. */
  private ensureParticles(field: FieldMesh, count: number): void {
    while (field.particles.length < count) {
      const mesh = new THREE.Mesh(this.particleSphereGeom, field.particleMat);
      mesh.renderOrder = 9;
      mesh.visible = false;
      (field.emitter.parent ?? this.root).add(mesh);
      field.particles.push(mesh);
    }
  }

  /** Lazily allocate the per-particle ghost trail meshes (MAX only).
   *  Each main particle gets TRAIL_SEGMENTS ghosts; each ghost has its
   *  own material so opacity decays per step. Color set per frame so
   *  trails inherit field tint when the field switches teams. */
  private ensureTrails(field: FieldMesh, particleCount: number, color: number): void {
    const required = particleCount * TRAIL_SEGMENTS;
    while (field.trailMeshes.length < required) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.particleSphereGeom, mat);
      mesh.renderOrder = 9;
      mesh.visible = false;
      (field.emitter.parent ?? this.root).add(mesh);
      field.trailMeshes.push(mesh);
      field.trailMats.push(mat);
    }
  }

  /** Reparent every mesh in a FieldMesh from its current parent (the
   *  renderer's `root` group on first frame, or the previous host's
   *  yawGroup after a LOD-flip rebuild) onto `target` (the current
   *  host's yawGroup). Particles and trails are lazily allocated, so
   *  this iterates the live arrays — newly-allocated meshes inside
   *  ensureParticles / ensureTrails parent to `field.emitter.parent`
   *  (which by then equals `target`), so they land in the right
   *  group from birth. */
  private reparentFieldTo(field: FieldMesh, target: THREE.Group): void {
    const move = (m: THREE.Object3D | undefined): void => {
      if (!m) return;
      if (m.parent === target) return;
      m.parent?.remove(m);
      target.add(m);
    };
    move(field.emitter);
    move(field.zone);
    for (const p of field.particles) move(p);
    for (const tr of field.trailMeshes) move(tr);
    move(field.arcLines);
  }

  /** Lazily allocate the arc LineSegments mesh + supporting buffers. */
  private ensureArcs(field: FieldMesh): void {
    if (field.arcLines) return;
    const v = FORCE_FIELD_VISUAL;
    // 2 endpoints per segment × arcSegments segments × ARC_COUNT vertices,
    // 3 floats each.
    const totalVerts = ARC_COUNT_ENHANCED * v.arcSegments * 2;
    const positions = new Float32Array(totalVerts * 3);
    const arcGeom = new THREE.BufferGeometry();
    arcGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    const arcMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: v.arcOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const arcLines = new THREE.LineSegments(arcGeom, arcMat);
    arcLines.renderOrder = 10;
    arcLines.frustumCulled = false;
    // Same parent rule as ensureParticles / ensureTrails — land in the
    // host yawGroup if the field is already attached, otherwise the
    // renderer's root (will be moved on first reparent).
    (field.emitter.parent ?? this.root).add(arcLines);
    field.arcGeom = arcGeom;
    field.arcMat = arcMat;
    field.arcLines = arcLines;
  }

  update(units: readonly Entity[]): void {
    const seen = this._seenFieldKeys;
    seen.clear();
    const nowMs = performance.now();
    const nowSec = nowMs / 1000;

    const gfx = getGraphicsConfig();
    const style = gfx.forceFieldStyle;
    const wantParticles = style === 'simple' || style === 'enhanced';
    const wantArcs = style === 'enhanced';
    const particleCount = style === 'enhanced' ? PARTICLE_COUNT_ENHANCED
      : style === 'simple' ? PARTICLE_COUNT_SIMPLE
      : 0;

    for (const unit of units) {
      if (!unit.turrets || !unit.unit) continue;
      // Scope gate — force-field bubbles can be large (up to ~push.outerRange
      // units across), so pad generously so a turret just off-screen with
      // its bubble reaching in still updates.
      if (!this.scope.inScope(unit.transform.x, unit.transform.y, 300)) continue;

      // Force-field meshes attach to the unit's yaw subgroup like a
      // regular turret root — the scenegraph chain (group → yawGroup →
      // field meshes) handles position + tilt + yaw automatically. If
      // the unit's mesh hasn't been built yet (off-scope at scene
      // start) or was torn down (LOD flip mid-frame), skip; we'll
      // re-acquire when it's back.
      const yawGroup = this.getYawGroup(unit.id);
      if (!yawGroup) continue;

      for (let ti = 0; ti < unit.turrets.length; ti++) {
        const turret = unit.turrets[ti];
        if (!isForceFieldTurret(turret)) continue;
        const progress = turret.forceField?.range ?? 0;
        if (progress <= 0) continue;

        const shot = turret.config.shot;
        if (shot.type !== 'force' || !shot.push) continue;

        const key = `${unit.id}-${ti}`;
        seen.add(key);
        const field = this.acquire(key);

        // Chassis-local mount position. Force-field emitter sphere
        // is positioned to sit ON the body part the chassisMount
        // points at, INSET into it — emitter center at the dome's
        // top so the bottom hemisphere is embedded in the body and
        // the top hemisphere reads as a glowing dome jutting out.
        // (A regular turret head adds +headRadius to lift the
        // sphere clear of the dome; force fields skip that lift on
        // purpose — the "head" of a force-field unit IS the emitter,
        // not a stack of turret + dome.)
        //
        // `getBodyMountTopY(renderer, radius, offsetX, offsetZ)`
        // finds the body part nearest the mount and returns ITS top
        // y in world units — for the widow (arachnid composite) the
        // force-field mount at chassisMount (0.3, 0) lands on the
        // prosoma (front sphere, top y ≈ 1.1·radius), not the
        // taller abdomen. For the daddy (forceField renderer, single
        // circle body) it returns the global topY since there's
        // only one part. Both units get the "inset emitter on top of
        // the body" look from one formula.
        //
        // turret.offset is already in world units (chassisMount.{x,y}
        // × radius, baked at unit-creation time). yawGroup has scale
        // 1, so its local space is in world units relative to the
        // chassis-bottom origin — these chassis-local coords write
        // straight into emitter / zone / particle / arc positions
        // and the scenegraph chain places them in world.
        const unitRadius = unit.unit.unitRadiusCollider.scale;
        let rendererId = 'arachnid';
        try { rendererId = getUnitBlueprint(unit.unit.unitType).renderer ?? 'arachnid'; }
        catch { /* keep fallback */ }
        const mountTopY = getBodyMountTopY(
          rendererId, unitRadius,
          turret.offset.x, turret.offset.y,
        );
        const localX = turret.offset.x;
        const localY = mountTopY + INSET_DEPTH_BELOW_DOME;
        const localZ = turret.offset.y;

        // Reparent every field mesh to the unit's yawGroup if not
        // already there — handles first-frame attachment AND LOD
        // rebuilds (which create a new yawGroup and would leave the
        // field stranded on the old one). Cheap when steady state:
        // one identity check per mesh per frame.
        if (field.emitter.parent !== yawGroup) {
          this.reparentFieldTo(field, yawGroup);
        }

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
        field.emitter.position.set(localX, localY, localZ);

        // Spherical force-field zone — scale = outerRange (= push-zone radius
        // in sim units). Alpha fades in over the first third of progress.
        const push = shot.push;
        const outer = push.outerRange;
        const inner = push.innerRange;
        // Chassis-local field center; particles + arcs orbit relative
        // to this. Same coords for emitter / zone / motes / arcs so
        // they all live in the same yawGroup-local frame and the
        // scenegraph chain transforms them together.
        const cx = localX;
        const cy = localY;
        const cz = localZ;
        if (outer <= 0) {
          field.zone.visible = false;
          for (const p of field.particles) p.visible = false;
          if (field.arcLines) field.arcLines.visible = false;
          continue;
        }
        const fadeIn = Math.min(progress * 3, 1);
        field.zoneMat.color.set(push.color);
        field.zoneMat.opacity = push.alpha * fadeIn * FIELD_OPACITY_BOOST;
        field.zone.scale.setScalar(outer);
        field.zone.position.set(cx, cy, cz);
        field.zone.visible = true;

        // ── Particle motes (HI / MAX LOD) ──
        // Each particle has a stable angular slot on the bubble's surface
        // (random-but-deterministic theta/phi via fieldHash) and a phase
        // that scrolls a radial fraction over time. Inner→outer travel
        // (matches 2D's `pushOutward = false` default — particles head
        // toward the bubble's interior).
        if (wantParticles && particleCount > 0) {
          this.ensureParticles(field, particleCount);
          const v = FORCE_FIELD_VISUAL;
          const seed = (unit.id * 31 + ti) | 0;
          const speed = v.particleSpeed * (style === 'enhanced' ? 1.5 : 1);
          const radialBand = Math.max(outer - inner, 1);
          // Tint particles with the field's color so they read as part of
          // the same effect (not generic white).
          field.particleMat.color.set(push.color);
          field.particleMat.opacity = push.alpha * 4 * fadeIn * FIELD_OPACITY_BOOST;
          // MAX-only: ghost trails behind each mote, fading per step.
          if (wantArcs) this.ensureTrails(field, particleCount, push.color);
          const baseTrailOpacity = field.particleMat.opacity;
          for (let pi = 0; pi < field.particles.length; pi++) {
            const mote = field.particles[pi];
            if (pi >= particleCount) {
              mote.visible = false;
              for (let t = 0; t < TRAIL_SEGMENTS; t++) {
                const trail = field.trailMeshes[pi * TRAIL_SEGMENTS + t];
                if (trail) trail.visible = false;
              }
              continue;
            }
            // Even-ish distribution on a 2-sphere: theta ∈ [0, 2π),
            // phi via acos(2u − 1) so we don't pole-cluster.
            const theta = fieldHash(pi * 9181, seed) * Math.PI * 2;
            const phi = Math.acos(2 * fieldHash(pi * 5953 + 1, seed) - 1);
            const offset = fieldHash(pi * 2143 + 2, seed);
            const cycle = (nowSec * speed * 0.5 + offset) % 1;
            const rxy = Math.sin(phi);
            const dirX = Math.cos(theta) * rxy;
            const dirY = Math.cos(phi);
            const dirZ = Math.sin(theta) * rxy;
            const radius = inner + radialBand * cycle;
            mote.position.set(cx + dirX * radius, cy + dirY * radius, cz + dirZ * radius);
            mote.scale.setScalar(PARTICLE_RADIUS);
            mote.visible = true;

            // Place each ghost behind the mote at progressively earlier
            // cycle fractions (wrapping mod 1 keeps trails on the same
            // radial spoke when the mote loops back to inner).
            if (wantArcs) {
              for (let t = 1; t <= TRAIL_SEGMENTS; t++) {
                const idx = pi * TRAIL_SEGMENTS + (t - 1);
                const trail = field.trailMeshes[idx];
                const trailMat = field.trailMats[idx];
                if (!trail || !trailMat) continue;
                const trailFrac = ((cycle - TRAIL_FRAC_PER_STEP * t) + 1) % 1;
                const trailRadius = inner + radialBand * trailFrac;
                trail.position.set(
                  cx + dirX * trailRadius,
                  cy + dirY * trailRadius,
                  cz + dirZ * trailRadius,
                );
                trail.scale.setScalar(PARTICLE_RADIUS * Math.pow(TRAIL_SCALE_FALLOFF, t));
                trailMat.color.set(push.color);
                trailMat.opacity = baseTrailOpacity * Math.pow(TRAIL_OPACITY_FALLOFF, t);
                trail.visible = true;
              }
            } else {
              for (let t = 0; t < TRAIL_SEGMENTS; t++) {
                const trail = field.trailMeshes[pi * TRAIL_SEGMENTS + t];
                if (trail) trail.visible = false;
              }
            }
          }
        } else {
          for (const p of field.particles) p.visible = false;
          for (const tr of field.trailMeshes) tr.visible = false;
        }

        // ── Electric arcs (MAX LOD only) ──
        // Short jagged polylines inside the bubble that re-randomize every
        // arcFlickerMs. Each arc is a chain of arcSegments line-segments
        // (LineSegments expects 2 verts per segment, so we emit pairs of
        // [endPrev, endCur] for s ∈ [1, segments]).
        if (wantArcs) {
          this.ensureArcs(field);
          const arcLines = field.arcLines!;
          const arcGeom = field.arcGeom!;
          const arcMat = field.arcMat!;
          arcLines.visible = true;
          arcMat.color.set(push.color);
          arcMat.opacity = FORCE_FIELD_VISUAL.arcOpacity * fadeIn * FIELD_OPACITY_BOOST;
          const v = FORCE_FIELD_VISUAL;
          const flickerSeed = Math.floor(nowMs / v.arcFlickerMs);
          const positions = arcGeom.attributes.position.array as Float32Array;
          const arcBand = Math.max(outer - inner, 1);
          const fieldSeed = (unit.id * 31 + ti + flickerSeed * 137) | 0;

          let writeIdx = 0;
          for (let arc = 0; arc < ARC_COUNT_ENHANCED; arc++) {
            const arcSeed = fieldSeed + arc * 1009;
            // Pick a random axis for the arc (3D direction) and a length
            // along the radial band. Each segment offsets the running
            // endpoint by jitter perpendicular to the axis.
            const axisTheta = fieldHash(arcSeed, 7) * Math.PI * 2;
            const axisPhi = Math.acos(2 * fieldHash(arcSeed, 11) - 1);
            const axRxy = Math.sin(axisPhi);
            const axX = Math.cos(axisTheta) * axRxy;
            const axY = Math.cos(axisPhi);
            const axZ = Math.sin(axisTheta) * axRxy;
            const r0 = inner + arcBand * fieldHash(arcSeed, 17);
            const r1 = inner + arcBand * fieldHash(arcSeed, 23);
            const rStart = Math.min(r0, r1);
            const rEnd   = Math.max(r0, r1);
            const startX = cx + axX * rStart;
            const startY = cy + axY * rStart;
            const startZ = cz + axZ * rStart;
            const endX   = cx + axX * rEnd;
            const endY   = cy + axY * rEnd;
            const endZ   = cz + axZ * rEnd;

            let prevX = startX, prevY = startY, prevZ = startZ;
            for (let s = 1; s <= v.arcSegments; s++) {
              const t = s / v.arcSegments;
              const baseX = startX + (endX - startX) * t;
              const baseY = startY + (endY - startY) * t;
              const baseZ = startZ + (endZ - startZ) * t;
              // Bell-shaped jitter: 0 at endpoints, max in the middle.
              const bell = Math.sin(t * Math.PI);
              const j1 = (fieldHash(arcSeed, 100 + s) - 0.5) * 2 * v.arcJitter * bell;
              const j2 = (fieldHash(arcSeed, 200 + s) - 0.5) * 2 * v.arcJitter * bell;
              // Two perpendicular axes to the arc: pick world up cross axis,
              // then axis cross that, normalized. Cheap-but-stable basis.
              let perp1X = -axZ, perp1Y = 0, perp1Z = axX;
              const perp1Len = Math.hypot(perp1X, perp1Y, perp1Z) || 1;
              perp1X /= perp1Len; perp1Z /= perp1Len;
              const perp2X = axY * perp1Z - axZ * perp1Y;
              const perp2Y = axZ * perp1X - axX * perp1Z;
              const perp2Z = axX * perp1Y - axY * perp1X;
              const px = baseX + perp1X * j1 + perp2X * j2;
              const py = baseY + perp1Y * j1 + perp2Y * j2;
              const pz = baseZ + perp1Z * j1 + perp2Z * j2;

              positions[writeIdx++] = prevX; positions[writeIdx++] = prevY; positions[writeIdx++] = prevZ;
              positions[writeIdx++] = px;    positions[writeIdx++] = py;    positions[writeIdx++] = pz;
              prevX = px; prevY = py; prevZ = pz;
            }
          }
          // Zero-fill any unused trailing buffer space (defensive — count
          // is fixed so this is a no-op in steady state).
          for (let i = writeIdx; i < positions.length; i++) positions[i] = 0;
          arcGeom.attributes.position.needsUpdate = true;
          field.arcLastFlickerMs = nowMs;
        } else if (field.arcLines) {
          field.arcLines.visible = false;
        }
      }
    }

    // Tear down meshes for fields that turned off or whose unit is
    // gone. Meshes can live on the renderer's root OR a host unit's
    // yawGroup, so detach via the actual parent each one happens to
    // be on.
    for (const [key, field] of this.fields) {
      if (seen.has(key)) continue;
      field.emitter.parent?.remove(field.emitter);
      field.zone.parent?.remove(field.zone);
      for (const p of field.particles) p.parent?.remove(p);
      for (const tr of field.trailMeshes) tr.parent?.remove(tr);
      field.arcLines?.parent?.remove(field.arcLines);
      field.emitterMat.dispose();
      field.zoneMat.dispose();
      field.particleMat.dispose();
      for (const tm of field.trailMats) tm.dispose();
      if (field.arcGeom) field.arcGeom.dispose();
      if (field.arcMat) field.arcMat.dispose();
      this.fields.delete(key);
    }
  }

  destroy(): void {
    for (const field of this.fields.values()) {
      field.emitter.parent?.remove(field.emitter);
      field.zone.parent?.remove(field.zone);
      for (const p of field.particles) p.parent?.remove(p);
      for (const tr of field.trailMeshes) tr.parent?.remove(tr);
      field.arcLines?.parent?.remove(field.arcLines);
      field.emitterMat.dispose();
      field.zoneMat.dispose();
      field.particleMat.dispose();
      for (const tm of field.trailMats) tm.dispose();
      if (field.arcGeom) field.arcGeom.dispose();
      if (field.arcMat) field.arcMat.dispose();
    }
    this.fields.clear();
    this.sphereGeom.dispose();
    this.particleSphereGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
