import { ENTITY_CHANGED_TURRETS } from '../../types/network';
import { normalizeAngle } from '../math';
import type { Entity, Turret } from '../sim/types';
import type { WorldState } from '../sim/WorldState';

const FACTORY_CONSTRUCTION_TURRET_SPIN_RAD_PER_SEC = 0.42;

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

  update(dtSec: number): void {
    for (const factory of this.world.getFactoryBuildings()) {
      const factoryComp = factory.factory;
      const active = factoryComp !== null
        && factoryComp.isProducing
        && factoryComp.currentShellId !== null;
      if (!active) {
        this.stopConstructionTurret(factory);
        continue;
      }

      const spinDelta = Number.isFinite(dtSec) && dtSec > 0
        ? FACTORY_CONSTRUCTION_TURRET_SPIN_RAD_PER_SEC * dtSec
        : 0;
      this.spinConstructionTurret(factory, spinDelta);
    }
  }

  reset(): void {
    for (const factory of this.world.getFactoryBuildings()) {
      this.stopConstructionTurret(factory);
    }
  }

  private getConstructionTurret(factory: Entity): Turret | null {
    const turrets = factory.combat?.turrets;
    if (turrets === undefined) return null;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (turret.config.constructionEmitter !== null) return turret;
    }
    return null;
  }

  private spinConstructionTurret(factory: Entity, spinDelta: number): void {
    const turret = this.getConstructionTurret(factory);
    if (turret === null) return;
    if (spinDelta !== 0) {
      turret.rotation = normalizeAngle(turret.rotation + spinDelta);
    }
    turret.angularVelocity = FACTORY_CONSTRUCTION_TURRET_SPIN_RAD_PER_SEC;
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
