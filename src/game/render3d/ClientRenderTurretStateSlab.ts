import type { Entity, Turret } from '../sim/types';
import { getChassisLiftY } from '../math/BodyDimensions';
import { getTurretHeadRadius } from '../math';
import { getUnitBlueprint } from '../sim/blueprints';
import { turretStateToCode } from '../../types/network';
import {
  SHIELD_FIELD_SHAPE_AIMED_CYLINDER,
  SHIELD_FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER,
  SHIELD_FIELD_SHAPE_SPHERE,
} from './ShieldFieldShape3D';

const INITIAL_RENDER_TURRET_HOST_CAP = 4096;
export const CLIENT_RENDER_TURRET_MAX_PER_HOST = 16;
export const CLIENT_RENDER_TURRET_STATE_ENGAGED = turretStateToCode('engaged');

export const CLIENT_RENDER_TURRET_FLAG_ACTIVE = 1;
export const CLIENT_RENDER_TURRET_FLAG_HEAD_ONLY = 1 << 1;
export const CLIENT_RENDER_TURRET_FLAG_CONSTRUCTION_EMITTER = 1 << 2;
export const CLIENT_RENDER_TURRET_FLAG_VISUAL_ONLY = 1 << 3;
export const CLIENT_RENDER_TURRET_FLAG_MULTI_BARREL_SPIN = 1 << 4;
export const CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD = 1 << 5;

export type ClientRenderTurretStateViews = {
  readonly hostEntityIds: Float64Array;
  readonly turretEntityIds: Float64Array;
  readonly flags: Uint16Array;
  readonly stateCode: Uint8Array;
  readonly rotation: Float32Array;
  readonly pitch: Float32Array;
  readonly mountX: Float32Array;
  readonly mountY: Float32Array;
  readonly mountZ: Float32Array;
  readonly headRadius: Float32Array;
  readonly range: Float32Array;
  readonly shieldRange: Float32Array;
  readonly barrierOuterRange: Float32Array;
  readonly barrierOriginOffsetZ: Float32Array;
  readonly barrierAlpha: Float32Array;
  readonly barrierShape: Uint8Array;
  readonly mountLiftY: Float32Array;
  readonly spinIdle: Float32Array;
  readonly spinAccel: Float32Array;
  readonly spinDecel: Float32Array;
  readonly spinMax: Float32Array;
  readonly hostCounts: Uint16Array;
};

export type ClientRenderTurretHostRows = {
  readonly hostSlot: number;
  readonly start: number;
  readonly count: number;
  readonly views: ClientRenderTurretStateViews;
};

function growFloat32(source: Float32Array, nextCapacity: number): Float32Array {
  const next = new Float32Array(nextCapacity);
  next.set(source);
  return next;
}

function growFloat64(source: Float64Array, nextCapacity: number): Float64Array {
  const next = new Float64Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint8(source: Uint8Array, nextCapacity: number): Uint8Array {
  const next = new Uint8Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint16(source: Uint16Array, nextCapacity: number): Uint16Array {
  const next = new Uint16Array(nextCapacity);
  next.set(source);
  return next;
}

function assertNear(label: string, actual: number, expected: number, tolerance = 1e-3): void {
  if (Math.abs(actual - expected) <= tolerance) return;
  throw new Error(
    `[client render turret state] ${label} mismatch: slab=${actual}, entity=${expected}`,
  );
}

function barrierShapeCode(shape: string | undefined): number {
  if (shape === 'infiniteVerticalCylinder') return SHIELD_FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER;
  if (shape === 'aimedCylinder') return SHIELD_FIELD_SHAPE_AIMED_CYLINDER;
  return SHIELD_FIELD_SHAPE_SPHERE;
}

function turretFlags(turret: Turret): number {
  let flags = CLIENT_RENDER_TURRET_FLAG_ACTIVE;
  if (turret.config.headOnly) flags |= CLIENT_RENDER_TURRET_FLAG_HEAD_ONLY;
  if (turret.config.constructionEmitter !== null) {
    flags |= CLIENT_RENDER_TURRET_FLAG_CONSTRUCTION_EMITTER;
  }
  if (turret.config.visualOnly) flags |= CLIENT_RENDER_TURRET_FLAG_VISUAL_ONLY;
  const barrel = turret.config.barrel;
  if (
    barrel !== undefined &&
    (barrel.type === 'simpleMultiBarrel' || barrel.type === 'coneMultiBarrel')
  ) {
    flags |= CLIENT_RENDER_TURRET_FLAG_MULTI_BARREL_SPIN;
  }
  const shot = turret.config.shot;
  if (shot?.type === 'shield' && shot.barrier !== undefined && shot.barrier !== null) {
    flags |= CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD;
  }
  return flags;
}

function unitMountLiftY(entity: Entity): number {
  const unit = entity.unit;
  if (unit === null) return 0;
  let blueprint;
  try { blueprint = getUnitBlueprint(unit.unitBlueprintId); }
  catch { /* use fallback */ }
  return getChassisLiftY(blueprint, unit.radius.other);
}

export class ClientRenderTurretStateSlab {
  private dirtyHostMarks: Uint8Array = new Uint8Array(INITIAL_RENDER_TURRET_HOST_CAP);
  private readonly dirtyHostSlots: number[] = [];
  private readonly hostRowsScratch: ClientRenderTurretHostRows = {
    hostSlot: -1,
    start: 0,
    count: 0,
    views: undefined as unknown as ClientRenderTurretStateViews,
  };
  private views: ClientRenderTurretStateViews = {
    hostEntityIds: new Float64Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    turretEntityIds: new Float64Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    flags: new Uint16Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    stateCode: new Uint8Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    rotation: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    pitch: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    mountX: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    mountY: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    mountZ: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    headRadius: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    range: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    shieldRange: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    barrierOuterRange: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    barrierOriginOffsetZ: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    barrierAlpha: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    barrierShape: new Uint8Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    mountLiftY: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    spinIdle: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    spinAccel: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    spinDecel: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    spinMax: new Float32Array(INITIAL_RENDER_TURRET_HOST_CAP * CLIENT_RENDER_TURRET_MAX_PER_HOST),
    hostCounts: new Uint16Array(INITIAL_RENDER_TURRET_HOST_CAP),
  };

  getViews(): ClientRenderTurretStateViews {
    return this.views;
  }

  hostRows(hostSlot: number): ClientRenderTurretHostRows | undefined {
    if (hostSlot < 0 || hostSlot >= this.views.hostCounts.length) return undefined;
    const count = this.views.hostCounts[hostSlot];
    if (count <= 0) return undefined;
    const rows = this.hostRowsScratch;
    (rows as { hostSlot: number }).hostSlot = hostSlot;
    (rows as { start: number }).start = hostSlot * CLIENT_RENDER_TURRET_MAX_PER_HOST;
    (rows as { count: number }).count = count;
    (rows as { views: ClientRenderTurretStateViews }).views = this.views;
    return rows;
  }

  refreshHost(entity: Entity, hostSlot: number): ClientRenderTurretHostRows | undefined {
    const turrets = entity.combat?.turrets;
    const count = turrets?.length ?? 0;
    this.ensureHostCapacity(hostSlot + 1);
    if (count > CLIENT_RENDER_TURRET_MAX_PER_HOST) {
      throw new Error(
        `[client render turret state] entity ${entity.id} has ${count} turrets; ` +
        `increase CLIENT_RENDER_TURRET_MAX_PER_HOST (${CLIENT_RENDER_TURRET_MAX_PER_HOST})`,
      );
    }

    const previousCount = this.views.hostCounts[hostSlot];
    const clearCount = Math.max(previousCount, count);
    const start = hostSlot * CLIENT_RENDER_TURRET_MAX_PER_HOST;
    for (let i = 0; i < clearCount; i++) this.clearRow(start + i);

    this.views.hostCounts[hostSlot] = count;
    if (turrets === undefined || count === 0) {
      this.markHostDirty(hostSlot);
      return undefined;
    }

    const mountLiftY = unitMountLiftY(entity);
    for (let i = 0; i < count; i++) {
      this.writeRow(entity, turrets[i], start + i, mountLiftY);
    }
    this.markHostDirty(hostSlot);
    return this.hostRows(hostSlot);
  }

  unsetHostSlot(hostSlot: number): void {
    if (hostSlot < 0 || hostSlot >= this.views.hostCounts.length) return;
    const count = this.views.hostCounts[hostSlot];
    if (count <= 0) return;
    const start = hostSlot * CLIENT_RENDER_TURRET_MAX_PER_HOST;
    for (let i = 0; i < count; i++) this.clearRow(start + i);
    this.views.hostCounts[hostSlot] = 0;
    this.markHostDirty(hostSlot);
  }

  consumeDirtyHostSlots(out: number[] = []): number[] {
    out.length = 0;
    for (let i = 0; i < this.dirtyHostSlots.length; i++) {
      const slot = this.dirtyHostSlots[i];
      out.push(slot);
      this.dirtyHostMarks[slot] = 0;
    }
    this.dirtyHostSlots.length = 0;
    return out;
  }

  clear(): void {
    this.dirtyHostMarks.fill(0);
    this.dirtyHostSlots.length = 0;
    this.views.hostCounts.fill(0);
    this.views.flags.fill(0);
    this.views.hostEntityIds.fill(0);
    this.views.turretEntityIds.fill(0);
  }

  assertParity(entity: Entity, hostSlot: number): void {
    const turrets = entity.combat?.turrets ?? [];
    const count = this.views.hostCounts[hostSlot];
    if (count !== turrets.length) {
      throw new Error(
        `[client render turret state] turret count mismatch for ${entity.id}: ` +
        `slab=${count}, entity=${turrets.length}`,
      );
    }
    const start = hostSlot * CLIENT_RENDER_TURRET_MAX_PER_HOST;
    const mountLiftY = unitMountLiftY(entity);
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      const row = start + i;
      assertNear(`host id ${i}`, this.views.hostEntityIds[row], entity.id, 0);
      assertNear(`turret id ${i}`, this.views.turretEntityIds[row], turret.id, 0);
      assertNear(`rotation ${i}`, this.views.rotation[row], turret.rotation);
      assertNear(`pitch ${i}`, this.views.pitch[row], turret.pitch);
      assertNear(`mountX ${i}`, this.views.mountX[row], turret.mount.x);
      assertNear(`mountY ${i}`, this.views.mountY[row], turret.mount.y);
      assertNear(`mountZ ${i}`, this.views.mountZ[row], turret.mount.z);
      assertNear(`headRadius ${i}`, this.views.headRadius[row], getTurretHeadRadius(turret.config));
      assertNear(`range ${i}`, this.views.range[row], turret.config.range);
      assertNear(`shieldRange ${i}`, this.views.shieldRange[row], turret.shield?.range ?? 0);
      assertNear(`mountLiftY ${i}`, this.views.mountLiftY[row], mountLiftY);
      if (this.views.stateCode[row] !== turretStateToCode(turret.state)) {
        throw new Error(`[client render turret state] state code mismatch for ${entity.id}/${i}`);
      }
      if ((this.views.flags[row] & turretFlags(turret)) !== turretFlags(turret)) {
        throw new Error(`[client render turret state] flags mismatch for ${entity.id}/${i}`);
      }
    }
  }

  private writeRow(
    entity: Entity,
    turret: Turret,
    row: number,
    mountLiftY: number,
  ): void {
    const views = this.views;
    const flags = turretFlags(turret);
    const barrier = turret.config.shot?.type === 'shield'
      ? turret.config.shot.barrier
      : undefined;
    const spin = turret.config.barrel !== undefined &&
      (turret.config.barrel.type === 'simpleMultiBarrel' ||
        turret.config.barrel.type === 'coneMultiBarrel')
      ? turret.config.barrel.spin
      : undefined;

    views.hostEntityIds[row] = entity.id;
    views.turretEntityIds[row] = turret.id;
    views.flags[row] = flags;
    views.stateCode[row] = turretStateToCode(turret.state);
    views.rotation[row] = turret.rotation;
    views.pitch[row] = turret.pitch;
    views.mountX[row] = turret.mount.x;
    views.mountY[row] = turret.mount.y;
    views.mountZ[row] = turret.mount.z;
    views.headRadius[row] = getTurretHeadRadius(turret.config);
    views.range[row] = turret.config.range;
    views.shieldRange[row] = turret.shield?.range ?? 0;
    views.barrierOuterRange[row] = barrier?.outerRange ?? 0;
    views.barrierOriginOffsetZ[row] = barrier?.originOffsetZ ?? 0;
    views.barrierAlpha[row] = barrier?.alpha ?? 0;
    views.barrierShape[row] = barrierShapeCode(barrier?.shape);
    views.mountLiftY[row] = mountLiftY;
    views.spinIdle[row] = spin?.idle ?? 0;
    views.spinAccel[row] = spin?.accel ?? 0;
    views.spinDecel[row] = spin?.decel ?? 0;
    views.spinMax[row] = spin?.max ?? 0;
  }

  private clearRow(row: number): void {
    const views = this.views;
    views.hostEntityIds[row] = 0;
    views.turretEntityIds[row] = 0;
    views.flags[row] = 0;
    views.stateCode[row] = 0;
    views.rotation[row] = 0;
    views.pitch[row] = 0;
    views.mountX[row] = 0;
    views.mountY[row] = 0;
    views.mountZ[row] = 0;
    views.headRadius[row] = 0;
    views.range[row] = 0;
    views.shieldRange[row] = 0;
    views.barrierOuterRange[row] = 0;
    views.barrierOriginOffsetZ[row] = 0;
    views.barrierAlpha[row] = 0;
    views.barrierShape[row] = 0;
    views.mountLiftY[row] = 0;
    views.spinIdle[row] = 0;
    views.spinAccel[row] = 0;
    views.spinDecel[row] = 0;
    views.spinMax[row] = 0;
  }

  private ensureHostCapacity(requiredHostCount: number): void {
    if (requiredHostCount <= this.views.hostCounts.length) return;
    let nextHostCapacity = this.views.hostCounts.length;
    while (nextHostCapacity < requiredHostCount) nextHostCapacity *= 2;
    const nextRowCapacity = nextHostCapacity * CLIENT_RENDER_TURRET_MAX_PER_HOST;
    const views = this.views;
    this.views = {
      hostEntityIds: growFloat64(views.hostEntityIds, nextRowCapacity),
      turretEntityIds: growFloat64(views.turretEntityIds, nextRowCapacity),
      flags: growUint16(views.flags, nextRowCapacity),
      stateCode: growUint8(views.stateCode, nextRowCapacity),
      rotation: growFloat32(views.rotation, nextRowCapacity),
      pitch: growFloat32(views.pitch, nextRowCapacity),
      mountX: growFloat32(views.mountX, nextRowCapacity),
      mountY: growFloat32(views.mountY, nextRowCapacity),
      mountZ: growFloat32(views.mountZ, nextRowCapacity),
      headRadius: growFloat32(views.headRadius, nextRowCapacity),
      range: growFloat32(views.range, nextRowCapacity),
      shieldRange: growFloat32(views.shieldRange, nextRowCapacity),
      barrierOuterRange: growFloat32(views.barrierOuterRange, nextRowCapacity),
      barrierOriginOffsetZ: growFloat32(views.barrierOriginOffsetZ, nextRowCapacity),
      barrierAlpha: growFloat32(views.barrierAlpha, nextRowCapacity),
      barrierShape: growUint8(views.barrierShape, nextRowCapacity),
      mountLiftY: growFloat32(views.mountLiftY, nextRowCapacity),
      spinIdle: growFloat32(views.spinIdle, nextRowCapacity),
      spinAccel: growFloat32(views.spinAccel, nextRowCapacity),
      spinDecel: growFloat32(views.spinDecel, nextRowCapacity),
      spinMax: growFloat32(views.spinMax, nextRowCapacity),
      hostCounts: growUint16(views.hostCounts, nextHostCapacity),
    };
    this.dirtyHostMarks = growUint8(this.dirtyHostMarks, nextHostCapacity);
  }

  private markHostDirty(hostSlot: number): void {
    if (this.dirtyHostMarks[hostSlot] !== 0) return;
    this.dirtyHostMarks[hostSlot] = 1;
    this.dirtyHostSlots.push(hostSlot);
  }
}
