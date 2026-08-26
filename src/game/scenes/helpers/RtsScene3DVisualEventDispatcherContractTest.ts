import * as THREE from 'three';
import {
  getClientConfig,
  getMaterialExplosions,
  setMaterialExplosions,
} from '@/clientBarConfig';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';
import {
  beamEndpointFlashRadius,
  DamageImpact3D,
  type DamageImpactRequest,
  explosionBaseChunkGroupCount,
  explosionChunkLifetimeScale,
  explosionChunkPatternForDetail,
  explosionFlashRadius,
} from '../../render3d/BeamImpact3D';
import {
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_MID,
  detailLevelForRung,
} from '../../render3d/EntityDetailLevel3D';
import type { BeamRenderer3D } from '../../render3d/BeamRenderer3D';
import type { Render3DEntities } from '../../render3d/Render3DEntities';
import type { ShieldImpactRenderer3D } from '../../render3d/ShieldImpactRenderer3D';
import type { WaterSplash3D } from '../../render3d/WaterSplash3D';
import type { ClientViewState } from '../../network/ClientViewState';
import type { ViewportFootprint } from '../../ViewportFootprint';
import { dispatchSimEvent3DVisual } from './RtsScene3DVisualEventDispatcher';
import { presentSnapshotEventsImmediatelyAndScheduleAudio } from './RtsScene3DSnapshotIntake';
import { DEATH_EXPLOSION_HITBOX_RADIUS_MULT } from '../../sim/blueprints/entityBaseLedger';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[damage impact routing contract] ${message}`);
}

function chunkClassCount(
  pattern: ReturnType<typeof explosionChunkPatternForDetail>,
  motionClass: 0 | 1 | 2,
  renderSizeClass: 0 | 1 | 2,
): number {
  let count = 0;
  for (let i = 0; i < pattern.length; i++) {
    const chunk = pattern[i];
    if (
      chunk.motionClass === motionClass &&
      chunk.renderSizeClass === renderSizeClass
    ) count++;
  }
  return count;
}

type ExplosionLodProbe = {
  birthCount: number;
  firstLifetime: number;
  flashRadius: number;
  firstBandMotion: Float32Array;
  firstBandScale: readonly [number, number, number];
};

function probeExplosionLod(
  detailLevel: number,
  damageRadius: number = 18,
  damage: number = 60,
): ExplosionLodProbe {
  const parent = new THREE.Group();
  const renderer = new DamageImpact3D(
    parent,
    { inScope: () => true } as unknown as ViewportFootprint,
    { getTerrainZ: () => 0, waterLevel: 0 },
  );
  const internals = renderer as unknown as {
    particleMesh: THREE.InstancedMesh;
    particleMotion: Float32Array;
    particleBirthLifeKindSeed: Float32Array;
    siteRadius: Float32Array;
    spawnSerial: number;
  };
  try {
    renderer.spawnDamageImpact({
      x: 24,
      y: 24,
      z: 20,
      damageRadius,
      damage,
      surface: 'blast',
      detailLevel,
    });
    renderer.update([], 16);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const firstBandScale: [number, number, number] = [0, 0, 0];
    for (let slot = 0; slot < 3; slot++) {
      internals.particleMesh.getMatrixAt(slot, matrix);
      matrix.decompose(position, rotation, scale);
      firstBandScale[slot] = scale.length();
    }
    return {
      birthCount: internals.spawnSerial,
      firstLifetime: internals.particleBirthLifeKindSeed[1],
      flashRadius: internals.siteRadius[0],
      firstBandMotion: internals.particleMotion.slice(0, 12),
      firstBandScale,
    };
  } finally {
    renderer.destroy();
  }
}

function event(
  type: 'hit' | 'projectileExpire' | 'death',
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
    deathContext: type === 'death' ? {
      unitVel: { x: 8, y: -4 },
      hitDir: { x: 0.5, y: -0.25 },
      projectileVel: { x: 20, y: -10 },
      attackMagnitude: 30,
      radius: 18,
      color: 0xffffff,
    } : null,
    impactContext: type === 'death' ? null : {
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
  const highPattern = explosionChunkPatternForDetail(DETAIL_LEVEL_FULL);
  const mediumPattern = explosionChunkPatternForDetail(
    detailLevelForRung(DETAIL_RUNG_MID),
  );
  const lowPattern = explosionChunkPatternForDetail(
    detailLevelForRung(DETAIL_RUNG_FAR),
  );
  assertContract(
    highPattern.length === 13 &&
      chunkClassCount(highPattern, 2, 2) === 1 &&
      chunkClassCount(highPattern, 1, 1) === 3 &&
      chunkClassCount(highPattern, 0, 0) === 9,
    'HIGH explosions must resolve each N to 1 large-slow, 3 medium, and 9 small-fast chunks',
  );
  assertContract(
    mediumPattern.length === 7 &&
      chunkClassCount(mediumPattern, 2, 2) === 1 &&
      chunkClassCount(mediumPattern, 1, 1) === 3 &&
      chunkClassCount(mediumPattern, 0, 1) === 3,
    'MED explosions must collapse small-fast chunks 3:1 into medium-fast chunks',
  );
  assertContract(
    lowPattern.length === 3 &&
      chunkClassCount(lowPattern, 2, 2) === 1 &&
      chunkClassCount(lowPattern, 1, 2) === 1 &&
      chunkClassCount(lowPattern, 0, 2) === 1,
    'LOW explosions must render one large representative from each motion band',
  );
  assertContract(
    explosionChunkPatternForDetail(DETAIL_LEVEL_GLYPH).length === 3 &&
      chunkClassCount(
        explosionChunkPatternForDetail(DETAIL_LEVEL_GLYPH),
        2,
        2,
      ) === 1 &&
      chunkClassCount(
        explosionChunkPatternForDetail(DETAIL_LEVEL_GLYPH),
        1,
        2,
      ) === 1 &&
      chunkClassCount(
        explosionChunkPatternForDetail(DETAIL_LEVEL_GLYPH),
        0,
        2,
      ) === 1,
    'MIN/GLYPH explosions must retain the LOW three-representative pattern',
  );
  assertContract(
    explosionBaseChunkGroupCount(18, 60) === 1 &&
      explosionBaseChunkGroupCount(18, 200) === 2 &&
      explosionBaseChunkGroupCount(18, 10000) === 13 &&
      explosionBaseChunkGroupCount(190, 9000) === 20 &&
      explosionBaseChunkGroupCount(240, 420) === 15 &&
      explosionBaseChunkGroupCount(1_000_000, 1_000_000_000) === 24,
    'explosion damage and radius must jointly grow and cap the base N group count',
  );
  assertContract(
    Math.abs(explosionFlashRadius(18, 60) - 12.96) < 1e-6 &&
      explosionFlashRadius(190, 9000) > 184 &&
      explosionFlashRadius(1_000_000, 1_000_000_000) === 240 &&
      Math.abs(beamEndpointFlashRadius(2, 24) - 17.28) < 1e-6 &&
      beamEndpointFlashRadius(1_000, 1_000) === 160,
    'explosion and beam endpoint flashes must scale visibly from their authored radii',
  );
  assertContract(
    explosionChunkLifetimeScale(1) === 1 &&
      explosionChunkLifetimeScale(20) === 2.5 &&
      explosionChunkLifetimeScale(1_000) === 2.5,
    'large explosion chunk lifetimes must grow from the small baseline to a hard 2.5x cap',
  );

  const highProbe = probeExplosionLod(DETAIL_LEVEL_FULL);
  const mediumProbe = probeExplosionLod(detailLevelForRung(DETAIL_RUNG_MID));
  const lowProbe = probeExplosionLod(detailLevelForRung(DETAIL_RUNG_FAR));
  const minimumProbe = probeExplosionLod(DETAIL_LEVEL_GLYPH);
  const largeProbe = probeExplosionLod(DETAIL_LEVEL_FULL, 190, 9000);
  assertContract(
    highProbe.birthCount === 13 &&
      mediumProbe.birthCount === 7 &&
      lowProbe.birthCount === 3 &&
      minimumProbe.birthCount === 3,
    'the renderer must emit the exact HIGH/MED/LOW/MIN chunk totals for N=1',
  );
  assertContract(
    largeProbe.birthCount === 260 &&
      largeProbe.firstLifetime > highProbe.firstLifetime * 2.49 &&
      largeProbe.flashRadius > highProbe.flashRadius * 14,
    'a large powerful blast must render many more, longer-lived chunks and a much larger flash',
  );
  for (let i = 0; i < highProbe.firstBandMotion.length; i++) {
    assertContract(
      highProbe.firstBandMotion[i] === mediumProbe.firstBandMotion[i] &&
        highProbe.firstBandMotion[i] === lowProbe.firstBandMotion[i],
      'LOD collapse must retain the deterministic velocity of each source motion band',
    );
  }
  assertContract(
    Math.abs(highProbe.firstBandScale[0] - mediumProbe.firstBandScale[0]) < 1e-6 &&
      Math.abs(highProbe.firstBandScale[0] - lowProbe.firstBandScale[0]) < 1e-6 &&
      highProbe.firstBandScale[1] < lowProbe.firstBandScale[1] &&
      highProbe.firstBandScale[2] < mediumProbe.firstBandScale[2] &&
      mediumProbe.firstBandScale[2] < lowProbe.firstBandScale[2],
    'LOD collapse must promote rendered size independently of retained motion',
  );

  const impacts: DamageImpactRequest[] = [];
  const killed: Array<{ id: number; blast: unknown }> = [];
  const plasmaCollapses: Array<{ id: number; x: number; y: number; z: number }> = [];
  const context = {
    clientViewState: {
      getEntity: () => undefined,
    } as unknown as ClientViewState,
    entityRenderer: {
      markEntityKilled: (id: number, blast: unknown) => { killed.push({ id, blast }); },
      startPlasmaImpactCollapse: (id: number, x: number, y: number, z: number) => {
        plasmaCollapses.push({ id, x, y, z });
        return true;
      },
    } as unknown as Render3DEntities,
    beamRenderer: {
      spawnDamageImpact: (request: DamageImpactRequest) => { impacts.push(request); },
    } as unknown as BeamRenderer3D,
    shieldImpactRenderer: {} as ShieldImpactRenderer3D,
    waterSplashRenderer: {} as WaterSplash3D,
    isPositionMinimumLod: () => false,
    positionVisualDetailLevel: () => DETAIL_LEVEL_FULL,
  };

  const previousMaterialExplosions = getMaterialExplosions();
  setMaterialExplosions(true);
  dispatchSimEvent3DVisual(event('hit', 71), context);
  assertContract(impacts.length === 1, 'a shot hit must enter the shared damage-impact pipeline');
  assertContract(impacts[0].damageRadius === 24, 'hit presentation must use the actual splash radius');
  assertContract(impacts[0].hitEntity === true, 'a confirmed body hit must retain body-impact response');
  assertContract(
    impacts[0].detailLevel === DETAIL_LEVEL_FULL,
    'impact requests must carry the exact shared LOD level into the chunk renderer',
  );
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
    plasmaCollapses.length === 2 &&
      plasmaCollapses[0].id === 71 &&
      plasmaCollapses[1].id === 72 &&
      plasmaCollapses.every(({ x, y, z }) => x === 120 && y === 160 && z === 42),
    'hit and expiry events must pin plasma collapse to their exact authoritative event point',
  );

  const eventTiming: string[] = [];
  let playScheduledAudio: (() => void) | null = null;
  presentSnapshotEventsImmediatelyAndScheduleAudio(
    [event('hit', 75)],
    100,
    {
      smoothingEnabled: true,
      presentVisual: () => { eventTiming.push('visual'); },
      playAudio: () => { eventTiming.push('audio'); },
      scheduler: {
        recordSnapshot: () => -1,
        schedule: (events, _now, smoothingEnabled, play) => {
          assertContract(
            smoothingEnabled && events.length === 1,
            'the timing probe must exercise the delayed-audio path',
          );
          eventTiming.push('audio-scheduled');
          playScheduledAudio = () => { play(events[0]); };
        },
      },
    },
  );
  assertContract(
    eventTiming.join(',') === 'visual,audio-scheduled',
    'snapshot visuals must present immediately before smoothed audio is scheduled',
  );
  assertContract(playScheduledAudio !== null, 'smoothed audio must remain queued for later playback');
  (playScheduledAudio as () => void)();
  assertContract(
    eventTiming.join(',') === 'visual,audio-scheduled,audio',
    'audio smoothing must delay only sound, never the terminal projectile visual',
  );

  dispatchSimEvent3DVisual(event('death', 73), context);
  assertContract(
    Number(impacts.length) === 3 && impacts[2].surface === 'blast',
    'entity death must enter the consolidated fire-blast pipeline explicitly',
  );
  assertContract(
    impacts[2].damageRadius === 18 * DEATH_EXPLOSION_HITBOX_RADIUS_MULT &&
      impacts[2].incomingX === 40 &&
      impacts[2].incomingY === -20,
    'death fire must burn at the derived death-blast sphere (hitbox × the shared multiple) with killing-blow momentum',
  );
  assertContract(
    killed.length === 1 && killed[0].id === 73 && killed[0].blast !== undefined,
    'death must arm material disassembly before the render-removal queue runs',
  );

  impacts.length = 0;
  killed.length = 0;
  setMaterialExplosions(false);
  dispatchSimEvent3DVisual(event('death', 74), context);
  assertContract(
    impacts.length === 1 && impacts[0].surface === 'blast',
    'turning material breakup off must never suppress the mandatory death explosion',
  );
  assertContract(
    killed.length === 1 && Number(killed[0].id) === 74 && killed[0].blast === undefined,
    'MATEXP off must disable only detailed part disassembly',
  );
  setMaterialExplosions(true);

  impacts.length = 0;
  killed.length = 0;
  const minimumContext = {
    ...context,
    isPositionMinimumLod: () => true,
    positionVisualDetailLevel: () => DETAIL_LEVEL_GLYPH,
  };
  dispatchSimEvent3DVisual(event('hit', 81), minimumContext);
  dispatchSimEvent3DVisual(event('projectileExpire', 82), minimumContext);
  dispatchSimEvent3DVisual(event('death', 83), minimumContext);
  assertContract(
    impacts.length === 3 &&
      impacts.every((impact) => impact.detailLevel === DETAIL_LEVEL_GLYPH),
    'hit, expiry, and death explosions must all reach the renderer at MIN',
  );
  assertContract(
    killed.length === 1 && Number(killed[0].id) === 83,
    'MIN must retain entity death disassembly routing as well as its fire blast',
  );
  setMaterialExplosions(previousMaterialExplosions);

  assertContract(
    getClientConfig('demo').volumeToggles.default === false &&
      getClientConfig('real').volumeToggles.default === false,
    'authoritative damage-volume debug rendering must default off in demo and real battles',
  );

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
    particleMesh: THREE.InstancedMesh;
    siteKind: Float32Array;
  };
  const particleFragmentShader = (
    internals.particleMesh.material as THREE.ShaderMaterial
  ).fragmentShader;
  const particleMaterial = internals.particleMesh.material as THREE.ShaderMaterial;
  assertContract(
    particleFragmentShader.includes('blastBirthColor = vec3(1.0, 0.82, 0.06)') &&
      particleFragmentShader.includes('smoothstep(0.06, 0.20, vAge01)'),
    'fire-blast tetrahedra must begin yellow-hot before rejoining their established red fade',
  );
  assertContract(
    particleMaterial.toneMapped === false &&
      particleMaterial.uniforms.uBrightness === undefined &&
      particleMaterial.userData.renderLighting === 'self-lit',
    'explosion tetrahedra must remain self-luminous at low scene exposure',
  );
  try {
    renderer.spawnDamageImpact({
      x: 24,
      y: 24,
      z: 0,
      damageRadius: 18,
      surface: 'blast',
    });
    renderer.spawnDamageImpact({ x: 32, y: 32, z: 0, damageRadius: 18 });
    renderer.update([], 16);
    assertContract(groundScorchDeposits === 1, 'terrain damage must feed consolidated scorch');
    assertContract(
      internals.particleMesh.count > 0,
      'one-shot damage events must emit bounded shared ejecta chunks',
    );
    assertContract(
      internals.siteKind[0] === 4,
      'an entity-death fire blast must stay radial even at terrain height',
    );
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
      !('debugDamageVolumeMesh' in internals),
      'terminal impacts must not create global VOLUMES geometry because no selected entity owns it',
    );
  } finally {
    renderer.destroy();
  }
}
