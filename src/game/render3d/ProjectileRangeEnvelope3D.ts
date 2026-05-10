import * as THREE from 'three';
import { GRAVITY, LAND_CELL_SIZE } from '../../config';
import {
  getTransformCosSin,
  getTurretWorldMount,
  solveKinematicIntercept,
  type KinematicInterceptSolution,
  type KinematicState3,
  type KinematicVec3,
} from '../math';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, EntityId, ProjectileShot, Turret } from '../sim/types';
import { getShotMaxLifespan, isProjectileShot } from '../sim/types';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import { getRuntimeTurretMount } from '../sim/turretMounts';
import { getUnitGroundZ } from '../sim/unitGeometry';
import { getProjectileLaunchSpeed } from '../sim/combat/combatUtils';
import {
  createClosedRibbonGeometry,
  writeClosedRibbonGeometry,
  type ClosedRibbonGeometry,
} from './GroundCircleLine3D';

const ENVELOPE_SLICES = 64;
const RECOMPUTE_FRAMES = 6;
const SEARCH_ITERATIONS = 14;
const GROUND_LIFT = 9;
const RENDER_ORDER = 22;
const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };
const _rangeOriginState: KinematicState3 = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
};
const _rangeTargetState: KinematicState3 = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
};
const _rangeProjectileAcceleration: KinematicVec3 = { x: 0, y: 0, z: -GRAVITY };
const _rangeIntercept: KinematicInterceptSolution = {
  time: 0,
  aimPoint: { x: 0, y: 0, z: 0 },
  launchVelocity: { x: 0, y: 0, z: 0 },
};

type EnvelopeRing = {
  mesh: THREE.Mesh;
  ribbon: ClosedRibbonGeometry;
  cacheKey: string;
  framesUntilRecompute: number;
};

export class ProjectileRangeEnvelope3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xff3333,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  private readonly rings: EnvelopeRing[] = [];
  private activeEntityId: EntityId | null = null;

  constructor(world: THREE.Group, clientViewState: ClientViewState) {
    this.world = world;
    this.clientViewState = clientViewState;
  }

  update(): void {
    const selectedIds = this.clientViewState.getSelectedIds();
    if (selectedIds.size !== 1) {
      this.hideAll();
      return;
    }

    let selectedId: EntityId | null = null;
    for (const id of selectedIds) {
      selectedId = id;
      break;
    }
    if (selectedId === null) {
      this.hideAll();
      return;
    }

    const entity = this.clientViewState.getEntity(selectedId);
    if (!this.canShowForEntity(entity)) {
      this.hideAll();
      return;
    }
    if (this.activeEntityId !== selectedId) {
      this.activeEntityId = selectedId;
      this.invalidateAll();
    }

    const mapWidth = this.clientViewState.getMapWidth();
    const mapHeight = this.clientViewState.getMapHeight();
    const turrets = entity.combat?.turrets ?? [];
    let ringIndex = 0;
    for (let turretIndex = 0; turretIndex < turrets.length; turretIndex++) {
      const weapon = turrets[turretIndex];
      if (!this.shouldDrawWeapon(weapon)) continue;
      const shot = weapon.config.shot;
      if (!shot || !isProjectileShot(shot)) continue;

      const speed = getProjectileLaunchSpeed(shot);
      if (speed <= 1e-6) continue;

      const mount = this.resolveTurretMount(entity, weapon, mapWidth, mapHeight);
      const baseY = getSurfaceHeight(mount.x, mount.y, mapWidth, mapHeight, LAND_CELL_SIZE)
        + GROUND_LIFT;
      const ring = this.ensureRing(ringIndex);
      ring.mesh.visible = true;
      ring.mesh.position.set(mount.x, baseY, mount.y);

      const key = `${entity.id}:${turretIndex}:${shot.id}:${shot.launchForce}:${shot.mass}:`
        + `${shot.lifespan ?? 0}:${shot.ignoresGravity === true ? 1 : 0}:`
        + `${mapWidth}:${mapHeight}`;
      if (ring.cacheKey !== key || ring.framesUntilRecompute <= 0) {
        this.writeEnvelopeGeometry(ring, mount.x, mount.y, mount.z, shot, speed, mapWidth, mapHeight, baseY);
        ring.cacheKey = key;
        ring.framesUntilRecompute = RECOMPUTE_FRAMES;
      } else {
        ring.framesUntilRecompute--;
      }

      ringIndex++;
    }

    for (let i = ringIndex; i < this.rings.length; i++) {
      this.rings[i].mesh.visible = false;
    }
    if (ringIndex === 0) this.activeEntityId = null;
  }

  destroy(): void {
    for (const ring of this.rings) {
      this.world.remove(ring.mesh);
      ring.mesh.geometry.dispose();
    }
    this.rings.length = 0;
    this.material.dispose();
    this.activeEntityId = null;
  }

  private canShowForEntity(entity: Entity | undefined): entity is Entity {
    if (!entity || (!entity.unit && !entity.building) || !entity.combat) return false;
    if (entity.selectable?.selected !== true) return false;
    const hp = entity.unit?.hp ?? entity.building?.hp ?? 0;
    if (hp <= 0) return false;
    if (entity.buildable && !entity.buildable.isComplete) return false;
    return true;
  }

  private shouldDrawWeapon(weapon: Turret): boolean {
    const shot = weapon.config.shot;
    return !!shot
      && isProjectileShot(shot)
      && !weapon.config.visualOnly
      && !weapon.config.passive
      && !weapon.config.verticalLauncher;
  }

  private resolveTurretMount(
    entity: Entity,
    weapon: Turret,
    mapWidth: number,
    mapHeight: number,
  ): { x: number; y: number; z: number } {
    if (entity.unit && weapon.config.mountMode === 'unitBodyCenter') {
      return {
        x: entity.transform.x,
        y: entity.transform.y,
        z: entity.transform.z,
      };
    }

    const { cos, sin } = getTransformCosSin(entity.transform);
    const surfaceN = entity.unit
      ? entity.unit.surfaceNormal ?? getSurfaceNormal(
          entity.transform.x,
          entity.transform.y,
          mapWidth,
          mapHeight,
          LAND_CELL_SIZE,
        )
      : FLAT_SURFACE_NORMAL;
    const mount = getRuntimeTurretMount(weapon);
    return getTurretWorldMount(
      entity.transform.x,
      entity.transform.y,
      getUnitGroundZ(entity),
      cos,
      sin,
      mount.x,
      mount.y,
      mount.z,
      surfaceN,
    );
  }

  private ensureRing(index: number): EnvelopeRing {
    let ring = this.rings[index];
    if (ring) return ring;

    const ribbon = createClosedRibbonGeometry(ENVELOPE_SLICES);
    const mesh = new THREE.Mesh(ribbon.geometry, this.material);
    mesh.renderOrder = RENDER_ORDER;
    mesh.frustumCulled = false;
    this.world.add(mesh);
    ring = {
      mesh,
      ribbon,
      cacheKey: '',
      framesUntilRecompute: 0,
    };
    this.rings[index] = ring;
    return ring;
  }

  private writeEnvelopeGeometry(
    ring: EnvelopeRing,
    originX: number,
    originY: number,
    launchZ: number,
    shot: ProjectileShot,
    speed: number,
    mapWidth: number,
    mapHeight: number,
    baseY: number,
  ): void {
    const centers = ring.ribbon.centers;
    for (let i = 0; i < ENVELOPE_SLICES; i++) {
      const a = (i / ENVELOPE_SLICES) * Math.PI * 2;
      const dirX = Math.cos(a);
      const dirY = Math.sin(a);
      const dist = this.findReachDistance(
        originX,
        originY,
        launchZ,
        dirX,
        dirY,
        shot,
        speed,
        mapWidth,
        mapHeight,
      );
      const x = originX + dirX * dist;
      const y = originY + dirY * dist;
      const groundY = getSurfaceHeight(x, y, mapWidth, mapHeight, LAND_CELL_SIZE) + GROUND_LIFT;
      const o = i * 3;
      centers[o] = dirX * dist;
      centers[o + 1] = groundY - baseY;
      centers[o + 2] = dirY * dist;
    }
    writeClosedRibbonGeometry(ring.ribbon);
  }

  private findReachDistance(
    originX: number,
    originY: number,
    launchZ: number,
    dirX: number,
    dirY: number,
    shot: ProjectileShot,
    speed: number,
    mapWidth: number,
    mapHeight: number,
  ): number {
    const mapLimit = this.rayDistanceToMapEdge(originX, originY, dirX, dirY, mapWidth, mapHeight);
    if (mapLimit <= 0) return 0;

    if (shot.ignoresGravity === true) {
      const lifeMs = getShotMaxLifespan(shot);
      if (!Number.isFinite(lifeMs)) return mapLimit;
      return Math.min(mapLimit, speed * lifeMs / 1000);
    }

    if (this.canReachAtDistance(originX, originY, launchZ, dirX, dirY, mapLimit, shot, speed, mapWidth, mapHeight)) {
      return mapLimit;
    }

    let lo = 0;
    let hi = mapLimit;
    for (let i = 0; i < SEARCH_ITERATIONS; i++) {
      const mid = (lo + hi) * 0.5;
      if (this.canReachAtDistance(originX, originY, launchZ, dirX, dirY, mid, shot, speed, mapWidth, mapHeight)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private canReachAtDistance(
    originX: number,
    originY: number,
    launchZ: number,
    dirX: number,
    dirY: number,
    dist: number,
    shot: ProjectileShot,
    speed: number,
    mapWidth: number,
    mapHeight: number,
  ): boolean {
    if (dist <= 1e-3) return true;
    const x = originX + dirX * dist;
    const y = originY + dirY * dist;
    const lifeMs = getShotMaxLifespan(shot);
    _rangeOriginState.position.x = originX;
    _rangeOriginState.position.y = originY;
    _rangeOriginState.position.z = launchZ;
    _rangeOriginState.velocity.x = 0;
    _rangeOriginState.velocity.y = 0;
    _rangeOriginState.velocity.z = 0;
    _rangeOriginState.acceleration.x = 0;
    _rangeOriginState.acceleration.y = 0;
    _rangeOriginState.acceleration.z = 0;
    _rangeTargetState.position.x = x;
    _rangeTargetState.position.y = y;
    _rangeTargetState.position.z = getSurfaceHeight(x, y, mapWidth, mapHeight, LAND_CELL_SIZE);
    _rangeTargetState.velocity.x = 0;
    _rangeTargetState.velocity.y = 0;
    _rangeTargetState.velocity.z = 0;
    _rangeTargetState.acceleration.x = 0;
    _rangeTargetState.acceleration.y = 0;
    _rangeTargetState.acceleration.z = 0;
    const intercept = solveKinematicIntercept({
      origin: _rangeOriginState,
      target: _rangeTargetState,
      projectileSpeed: speed,
      projectileAcceleration: _rangeProjectileAcceleration,
      maxTimeSec: Number.isFinite(lifeMs) ? lifeMs / 1000 : undefined,
    }, _rangeIntercept);
    return intercept !== null;
  }

  private rayDistanceToMapEdge(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    mapWidth: number,
    mapHeight: number,
  ): number {
    let t = Infinity;
    if (dirX > 1e-6) t = Math.min(t, (mapWidth - x) / dirX);
    else if (dirX < -1e-6) t = Math.min(t, -x / dirX);

    if (dirY > 1e-6) t = Math.min(t, (mapHeight - y) / dirY);
    else if (dirY < -1e-6) t = Math.min(t, -y / dirY);

    return Number.isFinite(t) ? Math.max(0, t) : 0;
  }

  private hideAll(): void {
    for (const ring of this.rings) ring.mesh.visible = false;
    this.activeEntityId = null;
  }

  private invalidateAll(): void {
    for (const ring of this.rings) {
      ring.cacheKey = '';
      ring.framesUntilRecompute = 0;
    }
  }
}
