import type { EntityId } from './types';
import type { WorldState } from './WorldState';
import { isConstructionBodyMaterialized } from './buildableHelpers';
import { getSimWasm } from '../sim-wasm/init';

const DEATH_CLEANUP_KIND_UNIT = 1;
const DEATH_CLEANUP_KIND_BUILDING = 2;

export class SimulationDeathCleanupClassifier {
  private deathEnabledBuf = new Uint8Array(0);
  private deathEntityIdBuf = new Int32Array(0);
  private deathKindBuf = new Uint8Array(0);
  private deathHpBuf = new Float64Array(0);
  private deathUnitMaterializedBuf = new Uint8Array(0);
  private deathDiffEntityIdsBuf = new Int32Array(0);
  private deathDiffKindBuf = new Uint8Array(0);
  private deathDiffCountBuf = new Uint32Array(1);

  constructor(private readonly world: WorldState) {}

  classify(
    deathCheckIds: readonly EntityId[],
    deadUnitIds: EntityId[],
    deadBuildingIds: EntityId[],
  ): void {
    const count = deathCheckIds.length;
    this.ensureCapacity(count);
    const enabled = this.deathEnabledBuf;
    const entityIds = this.deathEntityIdBuf;
    const kind = this.deathKindBuf;
    const hp = this.deathHpBuf;
    const unitMaterialized = this.deathUnitMaterializedBuf;
    const diffEntityIds = this.deathDiffEntityIdsBuf;
    const diffKind = this.deathDiffKindBuf;
    const diffCount = this.deathDiffCountBuf;
    enabled.fill(0, 0, count);
    kind.fill(0, 0, count);
    unitMaterialized.fill(0, 0, count);
    diffCount[0] = 0;

    // Pack only entities whose HP changed since the last drain. Rust owns
    // the unit/building dead-alive classification and compact removal diff
    // generation; TypeScript keeps JS graph lookup and removal side effects
    // until the ECS migration.
    let expectedCleanupRows = 0;
    for (let i = 0; i < count; i++) {
      const entityId = deathCheckIds[i];
      entityIds[i] = entityId;
      const entity = this.world.getEntity(entityId);
      hp[i] = 0;
      if (!entity) continue;
      if (entity.unit !== null) {
        enabled[i] = 1;
        kind[i] = DEATH_CLEANUP_KIND_UNIT;
        hp[i] = entity.unit.hp;
        unitMaterialized[i] = isConstructionBodyMaterialized(entity) ? 1 : 0;
        expectedCleanupRows++;
      } else if (entity.building !== null) {
        enabled[i] = 1;
        kind[i] = DEATH_CLEANUP_KIND_BUILDING;
        hp[i] = entity.building.hp;
        expectedCleanupRows++;
      }
    }

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationDeathCleanupClassifier.classify: sim-wasm is not initialized');
    }
    const processed = sim.deathCleanupDiffBatch(
      count,
      enabled.subarray(0, count),
      entityIds.subarray(0, count),
      kind.subarray(0, count),
      hp.subarray(0, count),
      unitMaterialized.subarray(0, count),
      diffEntityIds.subarray(0, count),
      diffKind.subarray(0, count),
      diffCount,
    );
    if (processed !== expectedCleanupRows) {
      throw new Error(`SimulationDeathCleanupClassifier.classify: death cleanup batch failed: ${processed}/${expectedCleanupRows}`);
    }

    const deadDiffCount = diffCount[0];
    if (deadDiffCount > count) {
      throw new Error(`SimulationDeathCleanupClassifier.classify: invalid death cleanup diff count: ${deadDiffCount}/${count}`);
    }
    for (let i = 0; i < deadDiffCount; i++) {
      const entityId = diffEntityIds[i];
      if (diffKind[i] === DEATH_CLEANUP_KIND_UNIT) {
        deadUnitIds.push(entityId);
      } else if (diffKind[i] === DEATH_CLEANUP_KIND_BUILDING) {
        deadBuildingIds.push(entityId);
      }
    }
  }

  private ensureCapacity(required: number): void {
    if (required <= this.deathEnabledBuf.length) return;
    let next = Math.max(16, this.deathEnabledBuf.length);
    while (next < required) next *= 2;
    this.deathEnabledBuf = new Uint8Array(next);
    this.deathEntityIdBuf = new Int32Array(next);
    this.deathKindBuf = new Uint8Array(next);
    this.deathHpBuf = new Float64Array(next);
    this.deathUnitMaterializedBuf = new Uint8Array(next);
    this.deathDiffEntityIdsBuf = new Int32Array(next);
    this.deathDiffKindBuf = new Uint8Array(next);
  }
}
