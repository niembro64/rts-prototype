import * as THREE from 'three';
import type { SimDeathContext } from '@/types/combat';
import { GRAVITY } from '../../config';
import type { EntityMesh } from './EntityMesh3D';

/**
 * The render-side form of the force that killed an entity.  It deliberately
 * uses the same three force inputs as combat knockback / impact effects: the
 * penetration direction, the attack magnitude, and the projectile velocity.
 * The victim's velocity is inherited separately so moving debris keeps its
 * momentum instead of stopping dead at the moment it breaks apart. `seed`
 * makes the presentation-only per-piece variation replay-stable.
 */
export type EntityDeathBlast3D = Readonly<{
  seed: number;
  pushX: number;
  pushZ: number;
  inheritedX: number;
  inheritedZ: number;
}>;

export type EntityDeathPartDelta3D = {
  dx: number;
  dy: number;
  dz: number;
  drx: number;
  dry: number;
  drz: number;
};

/** One independently movable, already-textured part of the live entity. */
export type EntityDeathRenderablePart3D = {
  /** Snapshot of the part centre in world coordinates at death. */
  worldPosition: THREE.Vector3;
  /** Apply one world-space translation plus an intentionally local tumble. */
  applyDelta(delta: EntityDeathPartDelta3D): void;
};

type EntityDeathPartMotion3D = {
  part: EntityDeathRenderablePart3D;
  vx: number;
  vy: number;
  vz: number;
  avx: number;
  avy: number;
  avz: number;
};

type EntityDeathDisassemblyState3D = {
  parts: EntityDeathPartMotion3D[];
};

const RANDOM_SPEED_MIN = 30;
const RANDOM_SPEED_RANGE = 80;
const RANDOM_DIRECTION_WEIGHT_MIN = 0.72;
const RANDOM_DIRECTION_WEIGHT_RANGE = 0.24;
const KILL_FORCE_SPEED_SCALE = 0.2;
const KILL_FORCE_SPEED_MAX = 48;
const SPEED_SCALE_MIN = 0.76;
const SPEED_SCALE_RANGE = 0.52;
const RADIAL_SPEED = 18;
const UP_SPEED_MIN = 34;
const UP_SPEED_RANGE = 76;
const ANGULAR_SPEED_MIN = 3;
const ANGULAR_SPEED_RANGE = 9;
const LINEAR_DRAG = 0.965;
const ANGULAR_DRAG = 0.92;
const GRAVITY_SCALE = 0.42;
const MAX_STEP_MS = 80;

const _meshWorldPosition = new THREE.Vector3();
const _rootWorldPosition = new THREE.Vector3();
const _inverseRootMatrix = new THREE.Matrix4();
const _localDelta = new THREE.Vector3();

export function entityDeathBlastFromContext3D(
  context: SimDeathContext,
  seed: number = 0,
): EntityDeathBlast3D {
  const attackPush = Math.min(Math.max(0, context.attackMagnitude) * 2, 200);
  return {
    seed: seed >>> 0,
    pushX: context.hitDir.x * attackPush + context.projectileVel.x * 0.3,
    pushZ: context.hitDir.y * attackPush + context.projectileVel.y * 0.3,
    inheritedX: context.unitVel.x * 0.5,
    inheritedZ: context.unitVel.y * 0.5,
  };
}

/**
 * Turn every visible per-Mesh surface into an independent death part without
 * replacing its geometry or material.  Reparenting each mesh to the entity
 * root preserves its exact world pose while severing animation-rig parenting,
 * so blades, barrels, hull plates, building ornaments, and authored details
 * can all fly separately and keep their real surface charts during the fade.
 */
function captureEntityMeshDeathParts3D(
  mesh: EntityMesh,
): EntityDeathRenderablePart3D[] {
  mesh.group.updateWorldMatrix(true, true);
  const candidates: THREE.Mesh[] = [];
  mesh.group.traverse((object) => {
    if (object === mesh.group) return;
    const candidate = object as THREE.Mesh;
    if (candidate.isMesh !== true) return;
    if ((candidate as THREE.InstancedMesh).isInstancedMesh === true) return;
    if (!isEffectivelyVisible(candidate, mesh.group)) return;
    if (!hasVisibleMaterial(candidate.material)) return;
    candidates.push(candidate);
  });

  // Snapshot first. Attaching a parent changes the descendant hierarchy, and
  // mutating that hierarchy while traversing it would otherwise skip parts.
  const parts: EntityDeathRenderablePart3D[] = [];
  for (const candidate of candidates) {
    candidate.getWorldPosition(_meshWorldPosition);
    const worldPosition = _meshWorldPosition.clone();
    mesh.group.attach(candidate);
    // Building pose batching intentionally disables matrixAutoUpdate while
    // alive. Death motion owns these objects now and needs ordinary transforms.
    candidate.matrixAutoUpdate = true;
    candidate.updateMatrix();
    parts.push({
      worldPosition,
      applyDelta: (delta): void => {
        mesh.group.updateWorldMatrix(true, false);
        _inverseRootMatrix.copy(mesh.group.matrixWorld).invert();
        const e = _inverseRootMatrix.elements;
        _localDelta.set(
          e[0] * delta.dx + e[4] * delta.dy + e[8] * delta.dz,
          e[1] * delta.dx + e[5] * delta.dy + e[9] * delta.dz,
          e[2] * delta.dx + e[6] * delta.dy + e[10] * delta.dz,
        );
        candidate.position.add(_localDelta);
        candidate.rotation.x += delta.drx;
        candidate.rotation.y += delta.dry;
        candidate.rotation.z += delta.drz;
      },
    });
  }
  return parts;
}

function isEffectivelyVisible(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let cursor: THREE.Object3D | null = object;
  while (cursor !== null) {
    if (!cursor.visible) return false;
    if (cursor === root) return true;
    cursor = cursor.parent;
  }
  return false;
}

function hasVisibleMaterial(material: THREE.Material | THREE.Material[]): boolean {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((entry) => (
    entry.visible &&
    entry.opacity > 0 &&
    // Invisible rig pivots use colorWrite=false and must not become phantom
    // blast pieces merely because they happen to be implemented as Meshes.
    entry.colorWrite !== false
  ));
}

/**
 * Physics/lifecycle shared by units and buildings.  Callers supply any
 * renderer-owned instanced parts in addition to the actual Mesh descendants;
 * all of them receive their own random motion with the same blast bias.
 */
export class EntityDeathDisassembly3D {
  private readonly states = new WeakMap<EntityMesh, EntityDeathDisassemblyState3D>();
  private readonly delta: EntityDeathPartDelta3D = {
    dx: 0, dy: 0, dz: 0, drx: 0, dry: 0, drz: 0,
  };

  prepare(
    mesh: EntityMesh,
    blast: EntityDeathBlast3D,
    rendererParts: readonly EntityDeathRenderablePart3D[] = [],
  ): number {
    if (this.states.has(mesh)) return 0;
    const parts = [
      ...captureEntityMeshDeathParts3D(mesh),
      ...rendererParts,
    ];
    mesh.group.getWorldPosition(_rootWorldPosition);
    const entityX = _rootWorldPosition.x;
    const entityZ = _rootWorldPosition.z;
    const motions: EntityDeathPartMotion3D[] = [];
    for (let i = 0; i < parts.length; i++) {
      motions.push(this.createMotion(parts[i], blast, entityX, entityZ, i));
    }
    this.states.set(mesh, { parts: motions });
    return motions.length;
  }

  advance(mesh: EntityMesh, dtMs: number): void {
    const state = this.states.get(mesh);
    if (state === undefined || dtMs <= 0) return;
    const dtSec = Math.min(dtMs, MAX_STEP_MS) / 1000;
    const linearRetention = Math.pow(LINEAR_DRAG, dtSec * 60);
    const angularRetention = Math.pow(ANGULAR_DRAG, dtSec * 60);
    for (const motion of state.parts) {
      const delta = this.delta;
      delta.dx = motion.vx * dtSec;
      delta.dy = motion.vy * dtSec;
      delta.dz = motion.vz * dtSec;
      delta.drx = motion.avx * dtSec;
      delta.dry = motion.avy * dtSec;
      delta.drz = motion.avz * dtSec;
      motion.part.applyDelta(delta);
      motion.vy -= GRAVITY * GRAVITY_SCALE * dtSec;
      motion.vx *= linearRetention;
      motion.vy *= linearRetention;
      motion.vz *= linearRetention;
      motion.avx *= angularRetention;
      motion.avy *= angularRetention;
      motion.avz *= angularRetention;
    }
  }

  forget(mesh: EntityMesh): void {
    this.states.delete(mesh);
  }

  private createMotion(
    part: EntityDeathRenderablePart3D,
    blast: EntityDeathBlast3D,
    entityX: number,
    entityZ: number,
    partIndex: number,
  ): EntityDeathPartMotion3D {
    const angle = deathPartRandom(blast.seed, partIndex, 0) * Math.PI * 2;
    let randomDirectionX = Math.cos(angle);
    let randomDirectionZ = Math.sin(angle);
    let radialX = part.worldPosition.x - entityX;
    let radialZ = part.worldPosition.z - entityZ;
    const radialLength = Math.hypot(radialX, radialZ);
    if (radialLength > 1e-4) {
      radialX /= radialLength;
      radialZ /= radialLength;
      // Random motion may travel anywhere in the outward hemisphere, but it
      // must not make an exterior plate appear to implode through the host.
      const inwardDot = randomDirectionX * radialX + randomDirectionZ * radialZ;
      if (inwardDot < 0) {
        randomDirectionX -= 2 * inwardDot * radialX;
        randomDirectionZ -= 2 * inwardDot * radialZ;
      }
    } else {
      radialX = randomDirectionX;
      radialZ = randomDirectionZ;
    }

    const killForceLength = Math.hypot(blast.pushX, blast.pushZ);
    const killDirectionX = killForceLength > 1e-4
      ? blast.pushX / killForceLength
      : randomDirectionX;
    const killDirectionZ = killForceLength > 1e-4
      ? blast.pushZ / killForceLength
      : randomDirectionZ;
    // Each part gets its own blend. Random direction deliberately owns most
    // of the ratio; the killing force supplies a smaller coherent lean so the
    // hit remains readable without turning the breakup into a uniform cone.
    const randomDirectionWeight = RANDOM_DIRECTION_WEIGHT_MIN +
      deathPartRandom(blast.seed, partIndex, 1) * RANDOM_DIRECTION_WEIGHT_RANGE;
    const killDirectionWeight = 1 - randomDirectionWeight;
    let launchDirectionX =
      randomDirectionX * randomDirectionWeight + killDirectionX * killDirectionWeight;
    let launchDirectionZ =
      randomDirectionZ * randomDirectionWeight + killDirectionZ * killDirectionWeight;
    const launchDirectionLength = Math.hypot(launchDirectionX, launchDirectionZ);
    if (launchDirectionLength > 1e-4) {
      launchDirectionX /= launchDirectionLength;
      launchDirectionZ /= launchDirectionLength;
    } else {
      launchDirectionX = randomDirectionX;
      launchDirectionZ = randomDirectionZ;
    }

    const randomSpeed = RANDOM_SPEED_MIN +
      deathPartRandom(blast.seed, partIndex, 2) * RANDOM_SPEED_RANGE;
    const killForceSpeed = Math.min(killForceLength * KILL_FORCE_SPEED_SCALE, KILL_FORCE_SPEED_MAX);
    const speedScale = SPEED_SCALE_MIN +
      deathPartRandom(blast.seed, partIndex, 3) * SPEED_SCALE_RANGE;
    const launchSpeed = (randomSpeed + killForceSpeed) * speedScale;

    // Independent random axis and magnitude keep similarly-shaped neighboring
    // pieces from tumbling in lockstep.
    const spinAzimuth = deathPartRandom(blast.seed, partIndex, 4) * Math.PI * 2;
    const spinAxisY = deathPartRandom(blast.seed, partIndex, 5) * 2 - 1;
    const spinAxisHorizontal = Math.sqrt(Math.max(0, 1 - spinAxisY * spinAxisY));
    const spinSpeed = ANGULAR_SPEED_MIN +
      deathPartRandom(blast.seed, partIndex, 6) * ANGULAR_SPEED_RANGE;
    return {
      part,
      vx:
        launchDirectionX * launchSpeed +
        radialX * RADIAL_SPEED +
        blast.inheritedX,
      vy: UP_SPEED_MIN + deathPartRandom(blast.seed, partIndex, 7) * UP_SPEED_RANGE,
      vz:
        launchDirectionZ * launchSpeed +
        radialZ * RADIAL_SPEED +
        blast.inheritedZ,
      avx: Math.cos(spinAzimuth) * spinAxisHorizontal * spinSpeed,
      avy: spinAxisY * spinSpeed,
      avz: Math.sin(spinAzimuth) * spinAxisHorizontal * spinSpeed,
    };
  }
}

/** Stateless per-piece random channel. The entity id seeds the death event;
 *  piece index and channel keep every launch property independent without
 *  ambient Math.random() or call-order dependence. */
function deathPartRandom(seed: number, partIndex: number, channel: number): number {
  let value = seed >>> 0;
  value ^= Math.imul((partIndex + 1) >>> 0, 0x9e3779b1);
  value ^= Math.imul((channel + 1) >>> 0, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}
