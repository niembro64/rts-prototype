import * as THREE from 'three';
import {
  getClientConfig,
  getVolumeToggle,
  setVolumeToggle,
} from '@/clientBarConfig';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import {
  DamageImpact3D,
  type DamageImpactRequest,
} from '../../render3d/BeamImpact3D';
import type { BeamRenderer3D } from '../../render3d/BeamRenderer3D';
import type { Explosion3D } from '../../render3d/Explosion3D';
import type { Render3DEntities } from '../../render3d/Render3DEntities';
import type { ShieldImpactRenderer3D } from '../../render3d/ShieldImpactRenderer3D';
import type { WaterSplash3D } from '../../render3d/WaterSplash3D';
import type { ClientViewState } from '../../network/ClientViewState';
import type { ViewportFootprint } from '../../ViewportFootprint';
import { dispatchSimEvent3DVisual } from './RtsScene3DVisualEventDispatcher';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[damage impact routing contract] ${message}`);
}

function event(
  type: 'hit' | 'projectileExpire',
  entityId: number,
): NetworkServerSnapshotSimEvent {
  return {
    type,
    turretBlueprintId: '',
    sourceType: 'system',
    sourceKey: 'damage-impact-contract',
    pos: { x: 120, y: 160, z: 42 },
    playerId: 1,
    entityId,
    deathContext: null,
    impactContext: {
      radiusCollision: 5,
      deathExplosionRadius: 24,
      projectile: { pos: { x: 120, y: 160 }, vel: { x: 30, y: -12 } },
      entity: { vel: { x: 0, y: 0 }, radiusCollision: type === 'hit' ? 8 : 0 },
      penetrationDir: { x: 1, y: 0 },
    },
    waterSplash: null,
    shieldImpact: null,
    killerPlayerId: null,
    victimPlayerId: null,
    audioOnly: false,
  };
}

export function runRtsScene3DVisualEventDispatcherContractTest(): void {
  const impacts: DamageImpactRequest[] = [];
  let deathSphereSpawns = 0;
  const context = {
    clientViewState: {} as ClientViewState,
    entityRenderer: {} as Render3DEntities,
    beamRenderer: {
      spawnDamageImpact: (request: DamageImpactRequest) => { impacts.push(request); },
    } as unknown as BeamRenderer3D,
    explosionRenderer: {
      spawnDeath: () => { deathSphereSpawns++; },
    } as unknown as Explosion3D,
    shieldImpactRenderer: {} as ShieldImpactRenderer3D,
    waterSplashRenderer: {} as WaterSplash3D,
    isPositionLowLod: () => false,
    positionVisualDetailLevel: () => 0,
  };

  dispatchSimEvent3DVisual(event('hit', 71), context);
  assertContract(impacts.length === 1, 'a shot hit must enter the shared damage-impact pipeline');
  assertContract(impacts[0].damageRadius === 24, 'hit presentation must use the actual splash radius');
  assertContract(impacts[0].hitEntity === true, 'a confirmed body hit must retain body-impact response');
  assertContract(
    impacts[0].incomingX === 129 &&
      Math.abs((impacts[0].incomingY ?? 0) + 3.6) < 1e-9,
    'hit presentation must retain penetration and projectile momentum',
  );

  dispatchSimEvent3DVisual(event('projectileExpire', 72), context);
  assertContract(Number(impacts.length) === 2, 'a shot expiry must use the same shared impact pipeline');
  assertContract(impacts[1].damageRadius === 24, 'expiry presentation must retain authored damage radius');
  assertContract(impacts[1].hitEntity !== true, 'a free expiry must remain a free-space blast');
  assertContract(
    deathSphereSpawns === 0,
    'shot hits and expiries must never route through the expanding death-sphere renderer',
  );

  assertContract(
    getClientConfig('demo').volumeToggles.default === false &&
      getClientConfig('real').volumeToggles.default === false,
    'authoritative damage-volume debug rendering must default off in demo and real battles',
  );

  const previousExplosionVolume = getVolumeToggle('explosion');
  const parent = new THREE.Group();
  let groundScorchDeposits = 0;
  const renderer = new DamageImpact3D(
    parent,
    { inScope: () => true } as unknown as ViewportFootprint,
    {
      getTerrainZ: () => 0,
      getTerrainNormal: () => ({ nx: 0, ny: 0, nz: 1 }),
      waterLevel: 0,
      depositGroundBurn: () => { groundScorchDeposits++; },
    },
  );
  const internals = renderer as unknown as {
    debugDamageVolumeMesh: THREE.InstancedMesh;
    particleMesh: THREE.InstancedMesh;
  };
  try {
    setVolumeToggle('explosion', false);
    renderer.spawnDamageImpact({ x: 32, y: 32, z: 0, damageRadius: 18 });
    renderer.update([], 16);
    assertContract(groundScorchDeposits === 1, 'terrain damage must feed consolidated scorch');
    assertContract(
      internals.particleMesh.count > 0,
      'one-shot damage events must emit bounded shared ejecta chunks',
    );
    assertContract(
      internals.debugDamageVolumeMesh.count === 0,
      'damage spheres must remain hidden while CLIENT EXP is disabled',
    );

    setVolumeToggle('explosion', true);
    renderer.spawnDamageImpact({
      x: 80,
      y: 80,
      z: 40,
      damageRadius: 24,
      incomingX: 1,
      incomingY: 0,
      incomingZ: 0.25,
    });
    renderer.update([], 16);
    assertContract(
      internals.debugDamageVolumeMesh.count > 0,
      'CLIENT EXP must reveal active authoritative terminal damage spheres',
    );
  } finally {
    renderer.destroy();
    setVolumeToggle('explosion', previousExplosionVolume);
  }
}
