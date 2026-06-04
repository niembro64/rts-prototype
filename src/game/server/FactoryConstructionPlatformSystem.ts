import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import { normalizeAngle } from '../math';
import { FACTORY_BASE_VISUAL_HEIGHT } from '../sim/blueprints';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { setUnitFacingYaw } from '../sim/unitOrientation';
import type { Entity, EntityId, Turret } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import type { Body3D, PhysicsEngine3D } from './PhysicsEngine3D';

type ActivePlatformShell = {
  shellId: EntityId;
  localX: number;
  localY: number;
  seated: boolean;
};

const FACTORY_PLATFORM_SPIN_RAD_PER_SEC = 0.42;
const FACTORY_PLATFORM_SEAT_EPSILON = 1.5;
const FACTORY_PLATFORM_EXIT_PADDING = 12;

/** Server-owned construction deck for fabricators.
 *
 * The normal building collider is a tall static cuboid used for blocking.
 * Factory construction wants a different authored surface: the visible
 * top deck. While a factory shell is being built, this system ignores the
 * factory's full blocker for that shell, supports the unit at the visible
 * deck height, and rotates the seated shell with the construction turret.
 */
export class FactoryConstructionPlatformSystem {
  private readonly world: WorldState;
  private readonly physics: PhysicsEngine3D;
  private readonly activeShells = new Map<EntityId, ActivePlatformShell>();
  private readonly releasedShellFactoryIds = new Map<EntityId, EntityId>();
  private readonly seenFactoryIds = new Set<EntityId>();

  constructor(world: WorldState, physics: PhysicsEngine3D) {
    this.world = world;
    this.physics = physics;
  }

  updateBeforePhysics(dtSec: number): void {
    const seenFactoryIds = this.seenFactoryIds;
    seenFactoryIds.clear();
    for (const factory of this.world.getFactoryBuildings()) {
      seenFactoryIds.add(factory.id);
      this.updateFactoryBeforePhysics(factory, dtSec);
    }
    this.releaseMissingActiveFactories(seenFactoryIds);
    seenFactoryIds.clear();
    this.updateReleasedSupports();
  }

  updateAfterPhysics(): void {
    for (const factory of this.world.getFactoryBuildings()) {
      this.updateFactoryAfterPhysics(factory);
    }
    this.updateReleasedSupports();
  }

  reset(): void {
    this.activeShells.clear();
    this.releasedShellFactoryIds.clear();
    this.seenFactoryIds.clear();
  }

  private updateFactoryBeforePhysics(factory: Entity, dtSec: number): void {
    const factoryComp = factory.factory;
    const shellId = factoryComp?.currentShellId ?? null;
    if (shellId === null) {
      this.stopConstructionTurret(factory);
      this.releaseActiveShell(factory);
      return;
    }

    const shell = this.world.getEntity(shellId);
    if (!this.isSupportedShell(shell)) {
      this.stopConstructionTurret(factory);
      this.releaseActiveShell(factory);
      return;
    }

    let state = this.activeShells.get(factory.id);
    if (state === undefined || state.shellId !== shell.id) {
      if (state !== undefined) this.addReleasedSupport(state.shellId, factory.id);
      state = {
        shellId: shell.id,
        localX: 0,
        localY: 0,
        seated: false,
      };
      this.activeShells.set(factory.id, state);
    }

    this.ignoreFactoryBody(shell, factory);

    const spinDelta = Number.isFinite(dtSec) && dtSec > 0
      ? FACTORY_PLATFORM_SPIN_RAD_PER_SEC * dtSec
      : 0;
    this.spinConstructionTurret(factory, spinDelta);

    const body = shell.body!.physicsBody;
    const platformTop = this.getPlatformTop(factory);
    if (!state.seated && this.isAtOrBelowPlatform(body, platformTop)) {
      this.captureShellLocalOffset(state, shell, factory);
      state.seated = true;
    }

    if (state.seated) {
      this.carrySeatedShell(factory, shell, state, spinDelta);
    }
  }

  private updateFactoryAfterPhysics(factory: Entity): void {
    const state = this.activeShells.get(factory.id);
    if (state === undefined) return;
    const shell = this.world.getEntity(state.shellId);
    if (!this.isSupportedShell(shell)) {
      this.addReleasedSupport(state.shellId, factory.id);
      this.activeShells.delete(factory.id);
      return;
    }

    this.ignoreFactoryBody(shell, factory);
    const body = shell.body!.physicsBody;
    const platformTop = this.getPlatformTop(factory);
    if (!state.seated && this.isAtOrBelowPlatform(body, platformTop)) {
      this.captureShellLocalOffset(state, shell, factory);
      state.seated = true;
    }
    if (!state.seated) return;

    this.captureShellLocalOffset(state, shell, factory);
    this.supportBodyOnPlatform(shell, factory, true);
  }

  private releaseMissingActiveFactories(seenFactoryIds: Set<EntityId>): void {
    for (const [factoryId, state] of this.activeShells) {
      if (seenFactoryIds.has(factoryId)) continue;
      this.addReleasedSupport(state.shellId, factoryId);
      this.activeShells.delete(factoryId);
    }
  }

  private releaseActiveShell(factory: Entity): void {
    const state = this.activeShells.get(factory.id);
    if (state === undefined) return;
    this.addReleasedSupport(state.shellId, factory.id);
    this.activeShells.delete(factory.id);
  }

  private addReleasedSupport(shellId: EntityId, factoryId: EntityId): void {
    const shell = this.world.getEntity(shellId);
    if (shell === undefined || shell.unit === null || shell.body === null) return;
    this.releasedShellFactoryIds.set(shellId, factoryId);
  }

  private updateReleasedSupports(): void {
    for (const [shellId, factoryId] of this.releasedShellFactoryIds) {
      const shell = this.world.getEntity(shellId);
      const factory = this.world.getEntity(factoryId);
      if (shell === undefined || shell.unit === null || shell.body === null || factory === undefined) {
        this.releasedShellFactoryIds.delete(shellId);
        continue;
      }
      if (isBuildInProgress(shell.buildable)) continue;
      if (!this.isInsidePlatformFootprint(shell, factory)) {
        this.clearFactoryIgnore(shell, factory);
        this.releasedShellFactoryIds.delete(shellId);
        continue;
      }
      this.ignoreFactoryBody(shell, factory);
      this.supportBodyOnPlatform(shell, factory, false);
    }
  }

  private isSupportedShell(entity: Entity | undefined): entity is Entity {
    return entity !== undefined
      && entity.unit !== null
      && entity.body !== null
      && isBuildInProgress(entity.buildable);
  }

  private ignoreFactoryBody(shell: Entity, factory: Entity): void {
    const shellBody = shell.body?.physicsBody;
    const factoryBody = factory.body?.physicsBody;
    if (shellBody === undefined || factoryBody === undefined) return;
    this.physics.setIgnoreStatic(shellBody, factoryBody);
  }

  private clearFactoryIgnore(shell: Entity, factory: Entity): void {
    const shellBody = shell.body?.physicsBody;
    const factoryBody = factory.body?.physicsBody;
    if (shellBody === undefined || factoryBody === undefined) return;
    this.physics.clearIgnoreStatic(shellBody, factoryBody);
  }

  private getPlatformTop(factory: Entity): number {
    const building = factory.building;
    if (building === null) return factory.transform.z;
    return factory.transform.z - building.depth * 0.5 + FACTORY_BASE_VISUAL_HEIGHT;
  }

  private isAtOrBelowPlatform(body: Body3D, platformTop: number): boolean {
    return body.z - body.groundOffset <= platformTop + FACTORY_PLATFORM_SEAT_EPSILON;
  }

  private captureShellLocalOffset(state: ActivePlatformShell, shell: Entity, factory: Entity): void {
    const body = shell.body!.physicsBody;
    const dx = body.x - factory.transform.x;
    const dy = body.y - factory.transform.y;
    const rotation = this.getConstructionPlatformRotation(factory);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    state.localX = cos * dx + sin * dy;
    state.localY = -sin * dx + cos * dy;
    this.clampLocalOffset(state, shell, factory);
  }

  private clampLocalOffset(state: ActivePlatformShell, shell: Entity, factory: Entity): void {
    const building = factory.building;
    const unit = shell.unit;
    if (building === null || unit === null) {
      state.localX = 0;
      state.localY = 0;
      return;
    }
    const maxX = Math.max(0, building.width * 0.5 - unit.radius.collision);
    const maxY = Math.max(0, building.height * 0.5 - unit.radius.collision);
    state.localX = Math.max(-maxX, Math.min(maxX, state.localX));
    state.localY = Math.max(-maxY, Math.min(maxY, state.localY));
  }

  private carrySeatedShell(
    factory: Entity,
    shell: Entity,
    state: ActivePlatformShell,
    spinDelta: number,
  ): void {
    const body = shell.body!.physicsBody;
    const rotation = this.getConstructionPlatformRotation(factory);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const targetX = factory.transform.x + cos * state.localX - sin * state.localY;
    const targetY = factory.transform.y + sin * state.localX + cos * state.localY;
    const relX = targetX - factory.transform.x;
    const relY = targetY - factory.transform.y;
    const platformTop = this.getPlatformTop(factory);

    body.x = targetX;
    body.y = targetY;
    body.z = platformTop + body.groundOffset;
    body.vx = -FACTORY_PLATFORM_SPIN_RAD_PER_SEC * relY;
    body.vy = FACTORY_PLATFORM_SPIN_RAD_PER_SEC * relX;
    body.vz = 0;
    body.upwardSurfaceContact = true;
    this.physics.wakeBody(body);

    shell.transform.x = body.x;
    shell.transform.y = body.y;
    shell.transform.z = body.z;
    if (spinDelta !== 0) {
      setUnitFacingYaw(shell, normalizeAngle(shell.transform.rotation + spinDelta));
    }
    this.world.markSnapshotDirty(shell.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL | ENTITY_CHANGED_ROT);
  }

  private supportBodyOnPlatform(shell: Entity, factory: Entity, updateLocalContact: boolean): void {
    const body = shell.body!.physicsBody;
    const platformTop = this.getPlatformTop(factory);
    body.z = platformTop + body.groundOffset;
    if (body.vz < 0) body.vz = 0;
    body.upwardSurfaceContact = true;
    this.physics.wakeBody(body);
    shell.transform.x = body.x;
    shell.transform.y = body.y;
    shell.transform.z = body.z;
    if (updateLocalContact) {
      const state = this.activeShells.get(factory.id);
      if (state !== undefined) this.captureShellLocalOffset(state, shell, factory);
    }
    this.world.markSnapshotDirty(shell.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
  }

  private isInsidePlatformFootprint(shell: Entity, factory: Entity): boolean {
    const building = factory.building;
    const unit = shell.unit;
    if (building === null || unit === null) return false;
    const dx = shell.transform.x - factory.transform.x;
    const dy = shell.transform.y - factory.transform.y;
    const cos = Math.cos(factory.transform.rotation);
    const sin = Math.sin(factory.transform.rotation);
    const localX = cos * dx + sin * dy;
    const localY = -sin * dx + cos * dy;
    const pad = unit.radius.collision + FACTORY_PLATFORM_EXIT_PADDING;
    return Math.abs(localX) <= building.width * 0.5 + pad
      && Math.abs(localY) <= building.height * 0.5 + pad;
  }

  private getConstructionTurret(factory: Entity): Turret | null {
    const turrets = factory.combat?.turrets;
    if (turrets === undefined) return null;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (turret.config.constructionEmitter !== undefined) return turret;
    }
    return null;
  }

  private getConstructionPlatformRotation(factory: Entity): number {
    return this.getConstructionTurret(factory)?.rotation ?? factory.transform.rotation;
  }

  private spinConstructionTurret(factory: Entity, spinDelta: number): void {
    const turret = this.getConstructionTurret(factory);
    if (turret === null) return;
    if (spinDelta !== 0) {
      turret.rotation = normalizeAngle(turret.rotation + spinDelta);
    }
    turret.angularVelocity = FACTORY_PLATFORM_SPIN_RAD_PER_SEC;
    turret.angularAcceleration = 0;
    turret.pitch = 0;
    turret.pitchVelocity = 0;
    turret.pitchAcceleration = 0;
    this.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_TURRETS);
  }

  private stopConstructionTurret(factory: Entity): void {
    const turret = this.getConstructionTurret(factory);
    if (turret === null) return;
    if (
      turret.angularVelocity === 0 &&
      turret.angularAcceleration === 0 &&
      turret.pitchVelocity === 0 &&
      turret.pitchAcceleration === 0
    ) {
      return;
    }
    turret.angularVelocity = 0;
    turret.angularAcceleration = 0;
    turret.pitchVelocity = 0;
    turret.pitchAcceleration = 0;
    this.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_TURRETS);
  }
}
