import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { LAND_CELL_SIZE } from '../../config';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, EntityId, ProjectileShot, Turret } from '../sim/types';
import { isProjectileShot, isRocketLikeShot } from '../sim/types';
import { getSurfaceHeight } from '../sim/Terrain';
import { getProjectileLaunchSpeed } from '../sim/combat/combatUtils';
import { isBuildBlockingActivation } from '../sim/buildableHelpers';
import {
  createClosedRibbonGeometry,
  writeClosedRibbonGeometry,
  type ClosedRibbonGeometry,
} from './GroundCircleLine3D';
import {
  findProjectileShotReachDistance,
  resolveProjectileWeaponMount,
} from './ProjectileBallisticPreview';

const ENVELOPE_SLICES = 64;
const RECOMPUTE_FRAMES = 6;
const GROUND_LIFT = 9;
const RENDER_ORDER = 22;

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
    color: COLORS.effects.projectile.rangeEnvelope.colorHex,
    transparent: true,
    opacity: COLORS.effects.projectile.rangeEnvelope.opacity,
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

      const mount = resolveProjectileWeaponMount(entity, weapon, mapWidth, mapHeight);
      const baseY = getSurfaceHeight(mount.x, mount.y, mapWidth, mapHeight, LAND_CELL_SIZE)
        + GROUND_LIFT;
      const ring = this.ensureRing(ringIndex);
      ring.mesh.visible = true;
      ring.mesh.position.set(mount.x, baseY, mount.y);

      const key = `${entity.id}:${turretIndex}:${shot.shotBlueprintId}:${shot.launchForce}:${shot.mass}:`
        + `${isRocketLikeShot(shot) ? 1 : 0}:`
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
    if (isBuildBlockingActivation(entity.buildable)) return false;
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
      const dist = findProjectileShotReachDistance(
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
