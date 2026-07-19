import * as THREE from 'three';
import { GRAVITY } from '../../config';
import { translateLocomotion } from './Locomotion3D';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import type { EntityMesh } from './EntityMesh3D';
import { UnitDetailInstanceRenderer3D, type DyingUnitPartDelta } from './UnitDetailInstanceRenderer3D';

const DEATH_SCATTER_SPEED_MIN = 26;
const DEATH_SCATTER_SPEED_RANGE = 70;
const DEATH_SCATTER_UP_MIN = 24;
const DEATH_SCATTER_UP_RANGE = 64;
const DEATH_SCATTER_BODY_SPEED_SCALE = 0.5;
const DEATH_SCATTER_LOCOMOTION_SPEED_SCALE = 0.85;
const DEATH_SCATTER_ANGULAR_INIT = 5.5;
const DEATH_SCATTER_LINEAR_DRAG = 0.965;
const DEATH_SCATTER_ANGULAR_DRAG = 0.92;
const DEATH_SCATTER_GRAVITY_SCALE = 0.45;

type DyingUnitPartMotion = {
  vx: number;
  vy: number;
  vz: number;
  avx: number;
  avy: number;
  avz: number;
};

type DyingUnitScatter = {
  body: DyingUnitPartMotion;
  locomotion?: DyingUnitPartMotion;
  turrets: DyingUnitPartMotion[];
};

function createDyingUnitPartDelta(): DyingUnitPartDelta {
  return { dx: 0, dy: 0, dz: 0, drx: 0, dry: 0, drz: 0 };
}

export class DyingUnitScatter3D {
  private readonly dyingUnitScatter = new WeakMap<EntityMesh, DyingUnitScatter>();
  private readonly turretScatterScratch: DyingUnitPartDelta[] = [];
  private readonly deathScatterBodyDelta = createDyingUnitPartDelta();
  private readonly deathScatterLocomotionDelta = createDyingUnitPartDelta();
  private readonly deathScatterObjPos = new THREE.Vector3();
  private readonly deathScatterLocalDelta = new THREE.Vector3();
  private readonly deathScatterParentQuat = new THREE.Quaternion();

  constructor(
    private readonly legRenderer: LegInstancedRenderer,
    private readonly unitDetailInstances: UnitDetailInstanceRenderer3D,
  ) {}

  prepare(m: EntityMesh): void {
    if (this.dyingUnitScatter.has(m)) return;
    const turrets: DyingUnitPartMotion[] = [];
    for (const turret of m.turrets) {
      turrets.push(this.makeDyingPartMotionFromObject(
        m,
        turret.root,
        1,
      ));
    }
    const scatter: DyingUnitScatter = {
      body: this.makeDyingPartMotion(0, 0, DEATH_SCATTER_BODY_SPEED_SCALE),
      turrets,
    };
    if (m.locomotion) {
      scatter.locomotion = this.makeDyingPartMotionFromObject(
        m,
        m.locomotion.group,
        DEATH_SCATTER_LOCOMOTION_SPEED_SCALE,
      );
    }
    this.dyingUnitScatter.set(m, scatter);
  }

  advance(m: EntityMesh, dtMs: number): void {
    const scatter = this.dyingUnitScatter.get(m);
    if (!scatter || dtMs <= 0) return;
    const dtSec = Math.min(dtMs, 80) / 1000;
    const bodyDelta = this.stepDyingPartMotion(
      scatter.body,
      dtSec,
      this.deathScatterBodyDelta,
    );
    this.applyObjectLocalDelta(m.chassis, bodyDelta);
    if (m.mirrors) this.applyObjectLocalDelta(m.mirrors.root, bodyDelta);

    const turretDeltas = this.turretScatterScratch;
    turretDeltas.length = m.turrets.length;
    for (let i = 0; i < m.turrets.length; i++) {
      const motion = scatter.turrets[i] ?? scatter.body;
      const delta = turretDeltas[i] ?? (turretDeltas[i] = createDyingUnitPartDelta());
      this.stepDyingPartMotion(motion, dtSec, delta);
      turretDeltas[i] = delta;
      this.applyObjectLocalDelta(m.turrets[i].root, delta);
    }

    if (scatter.locomotion && m.locomotion) {
      const delta = this.stepDyingPartMotion(
        scatter.locomotion,
        dtSec,
        this.deathScatterLocomotionDelta,
      );
      this.applyObjectLocalDelta(m.locomotion.group, delta);
      translateLocomotion(
        m.locomotion,
        delta.dx,
        delta.dy,
        delta.dz,
        this.legRenderer,
      );
    }

    this.unitDetailInstances.applyDyingUnitScatter(m, bodyDelta, turretDeltas);
  }

  private makeDyingPartMotionFromObject(
    m: EntityMesh,
    obj: THREE.Object3D,
    speedScale: number,
  ): DyingUnitPartMotion {
    obj.getWorldPosition(this.deathScatterObjPos);
    return this.makeDyingPartMotion(
      this.deathScatterObjPos.x - m.group.position.x,
      this.deathScatterObjPos.z - m.group.position.z,
      speedScale,
    );
  }

  private makeDyingPartMotion(
    offsetX: number,
    offsetZ: number,
    speedScale: number,
  ): DyingUnitPartMotion {
    let dirX = offsetX;
    let dirZ = offsetZ;
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-3) {
      dirX /= len;
      dirZ /= len;
      const jitter = (Math.random() - 0.5) * 0.9;
      const c = Math.cos(jitter);
      const s = Math.sin(jitter);
      const jx = dirX * c - dirZ * s;
      dirZ = dirX * s + dirZ * c;
      dirX = jx;
    } else {
      const angle = Math.random() * Math.PI * 2;
      dirX = Math.cos(angle);
      dirZ = Math.sin(angle);
    }
    const speed = (DEATH_SCATTER_SPEED_MIN + Math.random() * DEATH_SCATTER_SPEED_RANGE) * speedScale;
    return {
      vx: dirX * speed,
      vy: DEATH_SCATTER_UP_MIN + Math.random() * DEATH_SCATTER_UP_RANGE,
      vz: dirZ * speed,
      avx: (Math.random() - 0.5) * DEATH_SCATTER_ANGULAR_INIT * 2,
      avy: (Math.random() - 0.5) * DEATH_SCATTER_ANGULAR_INIT * 2,
      avz: (Math.random() - 0.5) * DEATH_SCATTER_ANGULAR_INIT * 2,
    };
  }

  private stepDyingPartMotion(
    motion: DyingUnitPartMotion,
    dtSec: number,
    out: DyingUnitPartDelta,
  ): DyingUnitPartDelta {
    out.dx = motion.vx * dtSec;
    out.dy = motion.vy * dtSec;
    out.dz = motion.vz * dtSec;
    out.drx = motion.avx * dtSec;
    out.dry = motion.avy * dtSec;
    out.drz = motion.avz * dtSec;
    motion.vy -= GRAVITY * DEATH_SCATTER_GRAVITY_SCALE * dtSec;
    const linearDrag = Math.pow(DEATH_SCATTER_LINEAR_DRAG, dtSec * 60);
    motion.vx *= linearDrag;
    motion.vy *= linearDrag;
    motion.vz *= linearDrag;
    const angularRetention = Math.pow(DEATH_SCATTER_ANGULAR_DRAG, dtSec * 60);
    motion.avx *= angularRetention;
    motion.avy *= angularRetention;
    motion.avz *= angularRetention;
    return out;
  }

  private applyObjectLocalDelta(obj: THREE.Object3D, delta: DyingUnitPartDelta): void {
    this.deathScatterLocalDelta.set(delta.dx, delta.dy, delta.dz);
    if (obj.parent) {
      obj.parent.getWorldQuaternion(this.deathScatterParentQuat);
      this.deathScatterParentQuat.invert();
      this.deathScatterLocalDelta.applyQuaternion(this.deathScatterParentQuat);
    }
    obj.position.add(this.deathScatterLocalDelta);
    obj.rotation.x += delta.drx;
    obj.rotation.y += delta.dry;
    obj.rotation.z += delta.drz;
  }
}
