import type * as THREE from 'three';
import {
  getLodMode,
  setLodMode,
} from '../../clientBarConfig';
import type { Entity } from '../sim/types';
import {
  ENTITY_LOD_PROXY_GLYPH_CIRCLE,
  ENTITY_LOD_PROXY_GLYPH_CROSS,
  ENTITY_LOD_PROXY_GLYPH_DIAMOND,
  ENTITY_LOD_PROXY_GLYPH_SQUARE,
  ENTITY_LOD_PROXY_GLYPH_TRIANGLE,
  EntityLodHysteresis3D,
  entityEmissionUsesLowLodDistance3D,
  entityLodProxyGlyph3D,
  simPositionUsesLowEmissionLod3D,
} from './EntityLod3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[entity lod 3d contract] ${message}`);
  }
}

function cameraAt(x: number, y: number, z: number): THREE.Camera {
  return { position: { x, y, z } } as unknown as THREE.Camera;
}

function entityAt(id: number, x: number, y: number, z: number): Entity {
  return {
    id,
    type: 'unit',
    entitySlotId: -1,
    transform: { x, y, z, rotation: 0, rotCos: null, rotSin: null },
    unit: null,
    building: null,
    projectile: null,
    builder: null,
    commander: null,
    factory: null,
    transport: null,
  } as Entity;
}

function assertEmissionParity(
  lod: EntityLodHysteresis3D,
  camera: THREE.Camera,
  entity: Entity,
  highToLowDistance: number | null,
  label: string,
): void {
  const direct = entityEmissionUsesLowLodDistance3D(camera, entity, highToLowDistance);
  const cached = lod.entityEmissionUsesLowLodDistance(camera, entity, highToLowDistance);
  assertContract(cached === direct, `${label} cached emission LOD matches direct distance`);
}

export function runEntityLod3DContractTest(): void {
  const lod = new EntityLodHysteresis3D();
  const camera = cameraAt(0, 0, 0);
  const entity = entityAt(101, 3, 4, 0);
  const previousLodMode = getLodMode();

  try {
    lod.beginFrame();
    assertEmissionParity(lod, camera, entity, null, 'null threshold');
    assertEmissionParity(lod, camera, entity, Number.NaN, 'nan threshold');
    assertEmissionParity(lod, camera, entity, -1, 'negative threshold');
    assertEmissionParity(lod, camera, entity, 4.99, 'outside threshold');
    assertEmissionParity(lod, camera, entity, 5, 'on threshold');
    assertEmissionParity(lod, camera, entity, 5.01, 'inside threshold');

    entity.transform.y = 100;
    lod.beginFrame();
    assertEmissionParity(lod, camera, entity, 50, 'new frame refreshes cached distance');
    assertContract(
      lod.entityEmissionUsesLowLodDistance(camera, entity, 50) ===
        simPositionUsesLowEmissionLod3D(
          camera,
          entity.transform.x,
          entity.transform.y,
          entity.transform.z,
          50,
        ),
      'cached emission LOD matches explicit sim-position calculation',
    );

    const bodyLod = new EntityLodHysteresis3D();
    const body = entityAt(202, 0, 0, 0);
    setLodMode('low');
    bodyLod.beginFrame();
    assertContract(
      bodyLod.entityUsesLodProxy(camera, body),
      'LOW mode always forces entity LOD proxies',
    );
    setLodMode('high');
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxy(camera, body),
      'HIGH mode never allows entity LOD proxies',
    );
    setLodMode('auto');
    body.transform.x = 0;
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxy(camera, body),
      'AUTO mode keeps nearby entities in full detail',
    );
    body.transform.x = 10000;
    bodyLod.beginFrame();
    assertContract(
      bodyLod.entityUsesLodProxy(camera, body),
      'AUTO mode keeps existing distance-based proxy selection',
    );

    const groundUnit = entityAt(301, 0, 0, 0);
    groundUnit.unit = { locomotion: { type: 'wheels' } } as NonNullable<Entity['unit']>;
    assertContract(
      entityLodProxyGlyph3D(groundUnit) === ENTITY_LOD_PROXY_GLYPH_CIRCLE,
      'ground combat units use the default circular proxy glyph',
    );

    const airUnit = entityAt(302, 0, 0, 0);
    airUnit.unit = { locomotion: { type: 'flying' } } as NonNullable<Entity['unit']>;
    assertContract(
      entityLodProxyGlyph3D(airUnit) === ENTITY_LOD_PROXY_GLYPH_TRIANGLE,
      'flying units use the triangular proxy glyph',
    );

    const builderUnit = entityAt(303, 0, 0, 0);
    builderUnit.unit = { locomotion: { type: 'hover' } } as NonNullable<Entity['unit']>;
    builderUnit.builder = {} as NonNullable<Entity['builder']>;
    assertContract(
      entityLodProxyGlyph3D(builderUnit) === ENTITY_LOD_PROXY_GLYPH_DIAMOND,
      'builder units use the diamond proxy glyph',
    );

    const transportUnit = entityAt(304, 0, 0, 0);
    transportUnit.unit = { locomotion: { type: 'wheels' } } as NonNullable<Entity['unit']>;
    transportUnit.transport = { capacity: 1, loadedUnits: [] } as NonNullable<Entity['transport']>;
    assertContract(
      entityLodProxyGlyph3D(transportUnit) === ENTITY_LOD_PROXY_GLYPH_SQUARE,
      'transport units use the square proxy glyph',
    );

    const commanderUnit = entityAt(305, 0, 0, 0);
    commanderUnit.unit = { locomotion: { type: 'wheels' } } as NonNullable<Entity['unit']>;
    commanderUnit.builder = {} as NonNullable<Entity['builder']>;
    commanderUnit.commander = { isDGunActive: false, dgunEnergyCost: 0 };
    assertContract(
      entityLodProxyGlyph3D(commanderUnit) === ENTITY_LOD_PROXY_GLYPH_CROSS,
      'commander units take precedence over builder proxy glyphs',
    );

    const structure = entityAt(306, 0, 0, 0);
    structure.type = 'building';
    structure.building = {} as NonNullable<Entity['building']>;
    assertContract(
      entityLodProxyGlyph3D(structure) === ENTITY_LOD_PROXY_GLYPH_SQUARE,
      'structures use the square proxy glyph',
    );
  } finally {
    setLodMode(previousLodMode);
  }
}
