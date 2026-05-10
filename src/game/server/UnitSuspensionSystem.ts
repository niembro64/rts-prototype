import { ENTITY_CHANGED_SUSPENSION } from '../../types/network';
import { isUnitGroundPointAtOrBelowTerrain } from '../sim/unitGroundPhysics';
import { advanceUnitSuspension, isUnitSuspensionNearRest } from '../sim/unitSuspension';
import type { EntityId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import type { UnitSuspensionState } from '@/types/locomotionTypes';
import type { PhysicsEngine3D } from './PhysicsEngine3D';

export class UnitSuspensionSystem {
  private readonly world: WorldState;
  private readonly physics: PhysicsEngine3D;
  private readonly activeSuspensionUnitIds = new Set<EntityId>();
  private readonly awakeEntityIdsBuf: EntityId[] = [];
  private suspensionUnitSetVersion = -1;

  constructor(world: WorldState, physics: PhysicsEngine3D) {
    this.world = world;
    this.physics = physics;
  }

  update(dtMs: number): void {
    if (dtMs <= 0) return;

    this.refreshSuspensionUnits();
    this.collectAwakeSuspensionUnits();

    for (const id of this.activeSuspensionUnitIds) {
      const entity = this.world.getEntity(id);
      const unit = entity?.unit;
      const suspension = unit?.suspension;
      if (!entity || !unit || !suspension) {
        this.activeSuspensionUnitIds.delete(id);
        continue;
      }

      const body = entity.body?.physicsBody;
      const changed = advanceUnitSuspension(unit, entity.transform.rotation, dtMs, {
        legContact: body
          ? isUnitGroundPointAtOrBelowTerrain(unit, body.z, this.world.getGroundZ(body.x, body.y))
          : suspension.legContact,
      });
      if (changed) {
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_SUSPENSION);
      }
      if (!this.shouldKeepSuspensionActive(suspension, body?.sleeping ?? true)) {
        this.activeSuspensionUnitIds.delete(id);
      }
    }
  }

  private refreshSuspensionUnits(): void {
    const version = this.world.getUnitSetVersion();
    if (version === this.suspensionUnitSetVersion) return;
    this.suspensionUnitSetVersion = version;

    const units = this.world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (entity.unit?.suspension) {
        this.activeSuspensionUnitIds.add(entity.id);
      }
    }
  }

  private collectAwakeSuspensionUnits(): void {
    const awakeIds = this.awakeEntityIdsBuf;
    awakeIds.length = 0;
    this.physics.collectAwakeEntityIds(awakeIds);
    for (let i = 0; i < awakeIds.length; i++) {
      const entity = this.world.getEntity(awakeIds[i]);
      if (entity?.unit?.suspension) {
        this.activeSuspensionUnitIds.add(entity.id);
      }
    }
    awakeIds.length = 0;
  }

  private shouldKeepSuspensionActive(suspension: UnitSuspensionState, bodySleeping: boolean): boolean {
    if (!bodySleeping) return true;
    if (!suspension.anchorVelocityInitialized) return true;
    return !isUnitSuspensionNearRest(suspension);
  }
}
