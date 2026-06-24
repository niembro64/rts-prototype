import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { LAND_CELL_SIZE } from '../../config';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, EntityId, ProjectileShot, Turret } from '../sim/types';
import { isProjectileShot, isRocketLikeShot } from '../sim/types';
import { getSurfaceHeight } from '../sim/Terrain';
import { getProjectileLaunchSpeed } from '../sim/combat/combatUtils';
import { isBuildBlockingActivation } from '../sim/buildableHelpers';
import type { OverlayLineSystem } from './OverlayLineSystem';
import type { GroundLineBatch3D } from './GroundLineBatch3D';
import { hexToRgb01 } from './colorUtils';
import {
  findProjectileShotReachDistance,
  resolveProjectileWeaponMount,
} from './ProjectileBallisticPreview';

const ENVELOPE_SLICES = 64;
const RECOMPUTE_FRAMES = 6;

type EnvelopeRing = {
  // World-space [x,y,z, …] of the draped reach outline; cached between
  // recomputes so the (expensive) per-direction ballistic solve only reruns
  // every RECOMPUTE_FRAMES, while the batch re-pushes the cached points each
  // frame.
  points: Float32Array;
  cacheKey: string;
  framesUntilRecompute: number;
};

export class ProjectileRangeEnvelope3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly batch: GroundLineBatch3D;
  private readonly widthPx: number;
  private readonly groundLift: number;
  private readonly color: { r: number; g: number; b: number };
  private readonly alpha: number;
  private readonly rings: EnvelopeRing[] = [];
  private activeEntityId: EntityId | null = null;

  constructor(world: THREE.Group, clientViewState: ClientViewState, overlayLines: OverlayLineSystem) {
    this.world = world;
    this.clientViewState = clientViewState;
    const style = overlayLines.style('projectileEnvelope');
    this.widthPx = style.widthPx;
    this.groundLift = style.groundLift;
    this.color = hexToRgb01(COLORS.effects.projectile.rangeEnvelope.colorHex);
    this.alpha = COLORS.effects.projectile.rangeEnvelope.opacity;
    this.batch = overlayLines.createBatch('projectileEnvelope', ENVELOPE_SLICES * 4);
    this.world.add(this.batch.mesh);
  }

  update(): void {
    this.batch.begin();
    const selectedIds = this.clientViewState.getSelectedIds();
    if (selectedIds.size !== 1) {
      this.clear();
      return;
    }

    let selectedId: EntityId | null = null;
    for (const id of selectedIds) {
      selectedId = id;
      break;
    }
    if (selectedId === null) {
      this.clear();
      return;
    }

    const entity = this.clientViewState.getEntity(selectedId);
    if (!this.canShowForEntity(entity)) {
      this.clear();
      return;
    }
    if (this.activeEntityId !== selectedId) {
      this.activeEntityId = selectedId;
      this.invalidateAll();
    }

    const mapWidth = this.clientViewState.getMapWidth();
    const mapHeight = this.clientViewState.getMapHeight();
    const turrets = entity.combat?.turrets ?? [];
    const { r, g, b } = this.color;
    let ringIndex = 0;
    for (let turretIndex = 0; turretIndex < turrets.length; turretIndex++) {
      const weapon = turrets[turretIndex];
      if (!this.shouldDrawWeapon(weapon)) continue;
      const shot = weapon.config.shot;
      if (!shot || !isProjectileShot(shot)) continue;

      const speed = getProjectileLaunchSpeed(shot);
      if (speed <= 1e-6) continue;

      const mount = resolveProjectileWeaponMount(entity, weapon, mapWidth, mapHeight);
      const ring = this.ensureRing(ringIndex);

      const key = `${entity.id}:${turretIndex}:${shot.shotBlueprintId}:${shot.launchForce}:${shot.mass}:`
        + `${isRocketLikeShot(shot) ? 1 : 0}:`
        + `${mapWidth}:${mapHeight}`;
      if (ring.cacheKey !== key || ring.framesUntilRecompute <= 0) {
        this.computeEnvelopePoints(ring, mount.x, mount.y, mount.z, shot, speed, mapWidth, mapHeight);
        ring.cacheKey = key;
        ring.framesUntilRecompute = RECOMPUTE_FRAMES;
      } else {
        ring.framesUntilRecompute--;
      }

      this.batch.pushPolyline(ring.points, ENVELOPE_SLICES, r, g, b, this.alpha, this.widthPx, true);
      ringIndex++;
    }

    this.batch.finishFrame();
    if (ringIndex === 0) this.activeEntityId = null;
  }

  destroy(): void {
    this.world.remove(this.batch.mesh);
    this.batch.dispose();
    this.rings.length = 0;
    this.activeEntityId = null;
  }

  private clear(): void {
    this.batch.finishFrame();
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
    ring = {
      points: new Float32Array(ENVELOPE_SLICES * 3),
      cacheKey: '',
      framesUntilRecompute: 0,
    };
    this.rings[index] = ring;
    return ring;
  }

  private computeEnvelopePoints(
    ring: EnvelopeRing,
    originX: number,
    originY: number,
    launchZ: number,
    shot: ProjectileShot,
    speed: number,
    mapWidth: number,
    mapHeight: number,
  ): void {
    const points = ring.points;
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
      const groundY = getSurfaceHeight(x, y, mapWidth, mapHeight, LAND_CELL_SIZE) + this.groundLift;
      const o = i * 3;
      points[o] = x;
      points[o + 1] = groundY;
      points[o + 2] = y;
    }
  }

  private invalidateAll(): void {
    for (const ring of this.rings) {
      ring.cacheKey = '';
      ring.framesUntilRecompute = 0;
    }
  }
}
