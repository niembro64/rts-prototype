import * as THREE from 'three';
import { UNIT_DEATH_FADE_MS, VISION_FADE_IN_MS, VISION_FADE_OUT_MS } from '@/visionConfig';
import type { EntityMesh } from './EntityMesh3D';
import type { EntityDeathRenderablePart3D } from './EntityDeathDisassembly3D';
import { DyingMeshFade } from './EntityFade3D';
import {
  VanishingProxyGhosts3D,
  VanishingUnitMotion3D,
  VisionFadeInClock3D,
} from './EntityVisionFade3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[entity vision fade contract] ${message}`);
}

/** Read a live `size` through a plain number so successive assertions on
 *  it are not narrowed to the literal the previous one established. */
function sizeOf(collection: { readonly size: number }): number {
  return collection.size;
}

function assertNear(actual: number, expected: number, message: string): void {
  assertContract(
    Math.abs(actual - expected) <= 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

function testConfiguredDurations(): void {
  assertContract(
    VISION_FADE_IN_MS > 0 && VISION_FADE_OUT_MS > 0,
    'vision fades must have a positive duration or the tiers pop',
  );
  assertContract(
    VISION_FADE_IN_MS === VISION_FADE_OUT_MS,
    'in and out must share one duration: a contact blip\'s fall is the model\'s rise, and unequal clocks reopen the overlap/gap at every sight boundary',
  );
  assertContract(
    UNIT_DEATH_FADE_MS > VISION_FADE_OUT_MS,
    'a confirmed death lingers longer than a quiet vision loss',
  );
}

function testFadeInClock(): void {
  const clock = new VisionFadeInClock3D(400);
  assertNear(clock.alphaOf(7), 1, 'an id the clock never sighted has nothing to fade');

  // Units: advance per row per frame, seeding at zero on first sight.
  assertNear(clock.advance(1, 100), 0.25, 'first sighting seeds at zero and rises with dt');
  assertNear(clock.advance(1, 100), 0.5, 'the rise accumulates across frames');
  assertNear(clock.advance(1, 1000), 1, 'the rise clamps at one');
  assertNear(clock.advance(1, 100), 1, 'a finished rise stays at one');

  // A later LOD promotion finds the clock already at one: the rise is keyed
  // on the sighting, never on which representation happened to build.
  clock.ensure(1);
  assertNear(clock.alphaOf(1), 1, 'ensure() never restarts a tracked id');

  // Buildings: ensure on sight, advance the whole set outside the row loop.
  clock.ensure(2);
  clock.ensure(3);
  assertNear(clock.alphaOf(2), 0, 'ensure() seeds an unseen id at zero');
  const rose: Array<[number, number]> = [];
  clock.advanceAll(200, (id, alpha) => rose.push([id, alpha]));
  assertContract(
    rose.length === 2 && rose.every(([, alpha]) => alpha === 0.5),
    'advanceAll() reports every id still rising with its new alpha',
  );
  rose.length = 0;
  clock.advanceAll(1000, (id, alpha) => rose.push([id, alpha]));
  assertContract(
    rose.length === 2 && rose.every(([, alpha]) => alpha === 1),
    'advanceAll() reports the frame a rise completes',
  );
  rose.length = 0;
  clock.advanceAll(100, (id, alpha) => rose.push([id, alpha]));
  assertContract(rose.length === 0, 'finished rises are skipped, not re-reported');

  // Re-sighted mid fade-out: the rise resumes from where the fall reached.
  clock.seedFromAlpha(4, 0.3);
  assertNear(clock.alphaOf(4), 0.3, 'seedFromAlpha() resumes the rise from the given alpha');
  assertNear(clock.advance(4, 40), 0.4, 'a resumed rise keeps climbing from its seed');

  // Leaving the live set resets the id so re-entry fades in afresh.
  clock.forget(1);
  assertNear(clock.alphaOf(1), 1, 'a forgotten id reads as untracked');
  assertNear(clock.advance(1, 0), 0, 'a forgotten id re-seeds at zero on its next sighting');

  const instant = new VisionFadeInClock3D(0);
  assertNear(instant.advance(9, 0), 1, 'a zero duration disables the rise');
  instant.ensure(10);
  assertNear(instant.alphaOf(10), 1, 'a zero duration reads fully visible for tracked ids');
}

function testVanishingMotion(): void {
  const group = new THREE.Group();
  group.position.set(12, 3, -7);
  const mesh = {
    group,
    chassis: new THREE.Group(),
    chassisMeshes: [],
    bodyShapeKey: '',
    turrets: [],
    geometryKey: 'vision-fade-contract',
  } as unknown as EntityMesh;

  const rendererPosition = new THREE.Vector3(12, 4, -7);
  const rendererPart: EntityDeathRenderablePart3D = {
    worldPosition: rendererPosition.clone(),
    applyDelta: (delta): void => {
      rendererPosition.x += delta.dx;
      rendererPosition.y += delta.dy;
      rendererPosition.z += delta.dz;
      assertContract(
        delta.drx === 0 && delta.dry === 0 && delta.drz === 0,
        'quiet vision loss must not add death-style tumble',
      );
    },
  };

  const motion = new VanishingUnitMotion3D();
  motion.prepare(mesh, { x: 10, y: 5, z: -4 }, [rendererPart]);
  motion.advance(mesh, 100);
  motion.advance(mesh, 400);

  assertNear(group.position.x, 17, 'the retained scene-graph root coasts at constant X speed');
  assertNear(group.position.y, 5.5, 'the retained scene-graph root coasts at constant Y speed');
  assertNear(group.position.z, -9, 'the retained scene-graph root coasts at constant Z speed');
  assertNear(rendererPosition.x, 17, 'world-parented instances receive the same X travel');
  assertNear(rendererPosition.y, 6.5, 'world-parented instances receive the same Y travel');
  assertNear(rendererPosition.z, -9, 'world-parented instances receive the same Z travel');

  motion.forget(mesh);
  motion.advance(mesh, 500);
  assertNear(group.position.x, 17, 'teardown stops retained visual motion');
  assertNear(rendererPosition.x, 17, 'teardown stops renderer-owned instance motion');
}

function testDyingMeshFadeResume(): void {
  const applied: number[] = [];
  let tornDown = 0;
  const fade = new DyingMeshFade<{ tag: string }>(
    400,
    (_mesh, alpha) => applied.push(alpha),
    () => { tornDown += 1; },
  );
  assertNear(fade.fadeOf(5), 1, 'an id that is not dying reads as fully opaque');
  fade.markDying(5, { tag: 'a' }, 0.8);
  fade.update(100);
  assertNear(fade.fadeOf(5), 0.55, 'fadeOf() reports the fade the fall has reached');
  assertContract(applied.length === 1 && Math.abs(applied[0] - 0.55) <= 1e-9, 'the fall is applied each frame');
  fade.finalize(5);
  assertContract(tornDown === 1 && !fade.has(5), 'finalize() tears the retained mesh down at once');
  assertNear(fade.fadeOf(5), 1, 'a finalized id no longer reports a fade');
}

function testProxyGhosts(): void {
  const ghosts = new VanishingProxyGhosts3D(500);
  assertContract(!ghosts.begin(1), 'an id with no noted glyph has nothing to ghost');

  ghosts.noteRow(1, 100, 200, 5, 9, 3, 2, 40, -20, 0);
  ghosts.noteRow(1, 110, 195, 5, 9, 3, 2, 40, -20, 0);
  ghosts.noteRow(2, 500, 500, 0, 12, 1, 7, 0, 0, 0);
  assertContract(ghosts.begin(1), 'the last noted glyph row becomes the ghost');
  assertContract(sizeOf(ghosts) === 1, 'begin() moves exactly one id into the ghost set');

  const pushed: number[][] = [];
  ghosts.update(250, (x, y, z, radius, glyph, ownerId, alpha) =>
    pushed.push([x, y, z, radius, glyph, ownerId ?? -1, alpha]));
  assertContract(pushed.length === 1, 'a live ghost pushes one glyph per frame');
  const [x, y, z, radius, glyph, ownerId, alpha] = pushed[0];
  assertNear(x, 120, 'the ghost coasts on the noted sim-X velocity');
  assertNear(y, 190, 'the ghost coasts on the noted sim-Y velocity');
  assertNear(z, 5, 'a zero vertical velocity keeps the ghost at its altitude');
  assertContract(radius === 9 && glyph === 3 && ownerId === 2, 'the ghost keeps its glyph shape and owner colour');
  assertNear(alpha, 0.5, 'the ghost falls linearly over the fade-out duration');

  assertNear(ghosts.recall(1), 0.5, 'recall() hands the reached alpha back so the rise can resume there');
  assertContract(sizeOf(ghosts) === 0, 'recall() drops the ghost');
  assertNear(ghosts.recall(1), -1, 'a second recall finds nothing');

  ghosts.forget(2);
  assertContract(!ghosts.begin(2), 'forget() drops the noted row as well as any ghost');

  ghosts.noteRow(3, 0, 0, 0, 4, 1, 0, 0, 0, 0);
  ghosts.begin(3);
  pushed.length = 0;
  ghosts.update(500, (...args) => pushed.push(args as number[]));
  assertContract(pushed.length === 0 && sizeOf(ghosts) === 0, 'a ghost whose fall reaches zero is dropped without a push');

  const disabled = new VanishingProxyGhosts3D(0);
  disabled.noteRow(4, 0, 0, 0, 4, 1, 0, 0, 0, 0);
  assertContract(!disabled.begin(4), 'a zero duration never retains a ghost');
}

export function runEntityVisionFade3DContractTest(): void {
  testConfiguredDurations();
  testFadeInClock();
  testVanishingMotion();
  testDyingMeshFadeResume();
  testProxyGhosts();
}
