import { ENTITY_CHANGED_TURRETS } from '../../types/network';
import { normalizeAngle } from '../math';
import type { Entity, Turret } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { resolveFactoryProductionLaunchPlan } from '../sim/factoryProductionLaunch';

/** Server-authored construction turret motion for fabricators.
 *
 * Shell placement is owned by factoryProductionHold + EntityHold. This system
 * only animates the construction emitter turret while the factory is actively
 * funding a shell; it does not carry, seat, rotate, or otherwise couple the
 * shell to the fabricator.
 */
export class FactoryConstructionTurretSystem {
  private readonly world: WorldState;

  constructor(world: WorldState) {
    this.world = world;
  }

  update(_dtSec: number): void {
    const factories = this.world.getFactoryBuildings().concat(this.world.getFactoryUnits());
    for (const factory of factories) {
      const factoryComp = factory.factory;
      const active = factoryComp !== null
        && factoryComp.isProducing
        && factoryComp.currentShellId !== null;
      if (!active) {
        this.stopProductionTurrets(factory);
        continue;
      }

      const shell = factoryComp.currentShellId !== null
        ? this.world.getEntity(factoryComp.currentShellId)
        : undefined;
      if (shell === undefined) {
        this.stopProductionTurrets(factory);
        continue;
      }
      const plan = resolveFactoryProductionLaunchPlan(this.world, factory, shell);
      if (plan === null) {
        this.stopProductionTurrets(factory);
        continue;
      }
      this.aimProductionTurrets(factory, plan.yaw);
    }
  }

  reset(): void {
    const factories = this.world.getFactoryBuildings().concat(this.world.getFactoryUnits());
    for (const factory of factories) {
      this.stopProductionTurrets(factory);
    }
  }

  private isProductionTurret(turret: Turret): boolean {
    // Only the spawn turret tracks the launch heading. Construction
    // resource pylons keep a fixed authoritative yaw: their rigs orbit
    // the factory's ring center client-side with the resource-rate spin
    // (ConstructionVisualController3D), so a sim-side launch aim would
    // only fight that presentation.
    return turret.config.turretBlueprintId === 'turretSpawnUnits';
  }

  private aimProductionTurrets(factory: Entity, yaw: number): void {
    const turrets = factory.combat?.turrets;
    if (turrets === undefined) return;
    let changed = false;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (!this.isProductionTurret(turret)) continue;
      const nextYaw = normalizeAngle(yaw);
      if (
        turret.rotation !== nextYaw ||
        turret.angularVelocity !== 0 ||
        turret.angularAcceleration !== 0 ||
        turret.pitch !== 0 ||
        turret.pitchVelocity !== 0 ||
        turret.pitchAcceleration !== 0
      ) {
        changed = true;
      }
      turret.rotation = nextYaw;
      turret.angularVelocity = 0;
      turret.angularAcceleration = 0;
      turret.pitch = 0;
      turret.pitchVelocity = 0;
      turret.pitchAcceleration = 0;
      turret.aimTargetYaw = nextYaw;
      turret.aimTargetPitch = 0;
      turret.aimErrorYaw = 0;
      turret.aimErrorPitch = 0;
    }
    if (changed) this.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_TURRETS);
  }

  private stopProductionTurrets(factory: Entity): void {
    const turrets = factory.combat?.turrets;
    if (turrets === undefined) return;
    let changed = false;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (!this.isProductionTurret(turret)) continue;
      if (
        turret.angularVelocity !== 0 ||
        turret.angularAcceleration !== 0 ||
        turret.pitchVelocity !== 0 ||
        turret.pitchAcceleration !== 0
      ) {
        changed = true;
      }
      turret.angularVelocity = 0;
      turret.angularAcceleration = 0;
      turret.pitchVelocity = 0;
      turret.pitchAcceleration = 0;
    }
    if (changed) this.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_TURRETS);
  }
}
