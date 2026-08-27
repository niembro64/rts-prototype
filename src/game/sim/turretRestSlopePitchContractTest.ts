// Contract: once its restore delay has elapsed with nothing to shoot at, a
// unit turret returns to its rest yaw, and on a GROUND chassis its rest pitch
// follows the smoothed ground slope along that heading — a stowed barrel lies
// along the hill the body stands on. Air (and water-only) hosts rest flat.
//
// See budget_design_philosophy.html — "A building turret has no rest angle"
// (the unit paragraph that follows it).

import { normalizeAngle } from '../math/MathHelpers';
import { updateTurretRotation } from './combat/turretSystem';
import { surfaceSlopePitchAlongHeading } from './terrain/terrainSurface';
import type { UnitBlueprintId } from '../../types/blueprintIds';
import type { Entity, PlayerId, Turret } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[turret rest slope pitch] ${message}`);
}

function assertNear(actual: number, expected: number, message: string, epsilon = 1e-3): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > epsilon) {
    throw new Error(`[turret rest slope pitch] ${message}: expected ${expected}, got ${actual}`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const HOST_YAW = 0.6;
const SLOPE_RAD = (12 * Math.PI) / 180;
const STEP_MS = 100;

type Fixture = { world: WorldState; host: Entity; turret: Turret; restWorldYaw: number };

function spawnHost(seed: number, blueprintId: UnitBlueprintId): Fixture {
  const world = new WorldState(seed, 1024, 1024);
  const host = world.createUnitFromBlueprint(300, 300, 1 as PlayerId, blueprintId);
  host.transform.rotation = HOST_YAW;
  world.addEntity(host);
  assertContract(host.unit !== null && host.combat !== null, `${blueprintId} is an armed unit`);
  const turret = host.combat.turrets[0];
  assertContract(turret !== undefined && !turret.config.verticalLauncher, `${blueprintId} has an aimed station`);
  turret.localPitch = 0;
  turret.localPitchVelocity = 0;
  turret.pitch = 0;
  turret.articulationIdleMs = 0;
  return {
    world,
    host,
    turret,
    restWorldYaw: normalizeAngle(HOST_YAW + turret.config.articulation.restYaw),
  };
}

/** Unit normal of a plane rising by `slope` radians along heading `yaw`. */
function slopedNormal(slope: number, yaw: number): { nx: number; ny: number; nz: number } {
  return {
    nx: -Math.sin(slope) * Math.cos(yaw),
    ny: -Math.sin(slope) * Math.sin(yaw),
    nz: Math.cos(slope),
  };
}

function setNormal(fixture: Fixture, n: { nx: number; ny: number; nz: number }): void {
  // A bare fixture has no physics body, so `surfaceNormal` is the plain
  // spawn-time object rather than the BodyPool view; write it directly and
  // never run the ground-normal EMA, which would resample the flat test map.
  const normal = fixture.host.unit!.surfaceNormal;
  normal.nx = n.nx;
  normal.ny = n.ny;
  normal.nz = n.nz;
}

function driveIdle(fixture: Fixture): void {
  const restoreDelayMs = fixture.turret.config.articulation.restoreDelayMs;
  for (let elapsed = 0; elapsed <= restoreDelayMs * 3; elapsed += STEP_MS) {
    updateTurretRotation(fixture.world, STEP_MS, [fixture.host]);
  }
}

function expectedRestPitch(turret: Turret, slopePitch: number): number {
  const articulation = turret.config.articulation;
  return clamp(
    articulation.restPitch + slopePitch,
    articulation.pitch.minAngle,
    articulation.pitch.maxAngle,
  );
}

export function runTurretRestSlopePitchContractTest(): void {
  // The helper itself: rising ground ahead is positive, a plane rising across
  // the heading contributes nothing, and the water plane is flat.
  assertNear(
    surfaceSlopePitchAlongHeading(slopedNormal(SLOPE_RAD, HOST_YAW), HOST_YAW),
    SLOPE_RAD,
    'slope pitch along the rise equals the plane angle',
    1e-9,
  );
  assertNear(
    surfaceSlopePitchAlongHeading(slopedNormal(SLOPE_RAD, HOST_YAW), HOST_YAW + Math.PI),
    -SLOPE_RAD,
    'facing down the same plane reads the negative angle',
    1e-9,
  );
  assertNear(
    surfaceSlopePitchAlongHeading(slopedNormal(SLOPE_RAD, HOST_YAW + Math.PI / 2), HOST_YAW),
    0,
    'a plane rising across the heading has no pitch along it',
    1e-9,
  );
  assertNear(
    surfaceSlopePitchAlongHeading({ nx: 0, ny: 0, nz: 1 }, HOST_YAW),
    0,
    'the flat/water normal gives zero pitch',
    1e-12,
  );

  // 1) Ground unit on a rise along its rest heading: yaw restores to forward
  //    and pitch settles on the slope.
  {
    const fixture = spawnHost(70401, 'unitJackal');
    assertContract(
      fixture.host.unit!.locomotion.navigation.waypoint.allowOnGround,
      'the rover fixture is a ground chassis',
    );
    setNormal(fixture, slopedNormal(SLOPE_RAD, fixture.restWorldYaw));
    fixture.turret.localYaw = 0.9;
    driveIdle(fixture);
    assertNear(
      normalizeAngle(fixture.turret.localYaw - fixture.turret.config.articulation.restYaw),
      0,
      'an idle ground turret restores to its rest yaw',
    );
    assertNear(
      normalizeAngle(fixture.turret.rotation - fixture.restWorldYaw),
      0,
      'the restored world yaw is the chassis nose plus the rest yaw',
    );
    const expected = expectedRestPitch(fixture.turret, SLOPE_RAD);
    assertContract(expected > 0, 'the rover traverse admits an uphill rest pitch');
    assertNear(fixture.turret.pitch, expected, 'uphill rest pitch follows the ground slope');
    assertNear(fixture.turret.aimTargetPitch, expected, 'the joint target is the slope rest pitch');
  }

  // 2) Facing down the same plane the barrel stows downhill.
  {
    const fixture = spawnHost(70402, 'unitJackal');
    setNormal(fixture, slopedNormal(SLOPE_RAD, fixture.restWorldYaw + Math.PI));
    driveIdle(fixture);
    assertNear(
      fixture.turret.pitch,
      expectedRestPitch(fixture.turret, -SLOPE_RAD),
      'downhill rest pitch follows the ground slope',
    );
  }

  // 3) Flat ground keeps the authored rest pitch.
  {
    const fixture = spawnHost(70403, 'unitJackal');
    setNormal(fixture, { nx: 0, ny: 0, nz: 1 });
    fixture.turret.localPitch = 0.4;
    driveIdle(fixture);
    assertNear(
      fixture.turret.pitch,
      fixture.turret.config.articulation.restPitch,
      'flat ground rests at the authored pitch',
    );
  }

  // 4) A slope across the heading does not pitch the stowed barrel.
  {
    const fixture = spawnHost(70404, 'unitJackal');
    setNormal(fixture, slopedNormal(SLOPE_RAD, fixture.restWorldYaw + Math.PI / 2));
    driveIdle(fixture);
    assertNear(
      fixture.turret.pitch,
      fixture.turret.config.articulation.restPitch,
      'a cross slope leaves the rest pitch alone',
    );
  }

  // 5) An air host on the same rise rests flat: no hill under it.
  {
    const fixture = spawnHost(70405, 'unitBee');
    assertContract(
      !fixture.host.unit!.locomotion.navigation.waypoint.allowOnGround,
      'the drone fixture is not a ground chassis',
    );
    setNormal(fixture, slopedNormal(SLOPE_RAD, fixture.restWorldYaw));
    driveIdle(fixture);
    assertNear(
      fixture.turret.pitch,
      fixture.turret.config.articulation.restPitch,
      'an air host ignores the ground slope at rest',
    );
  }
}
