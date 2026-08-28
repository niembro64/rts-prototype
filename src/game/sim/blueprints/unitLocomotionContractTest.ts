import type { UnitLocomotionBlueprint } from './types';
import {
  cloneUnitLocomotion,
  createUnitLocomotion,
  getUnitLocomotionTraversalCapabilities,
} from '../unitLocomotion';
import {
  UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS,
  getUnitLocomotionPreset,
} from '../unitLocomotionPresetConfig';
import { getUnitBlueprint, getUnitLocomotion } from './index';
import { getAllUnitBlueprints } from './units';
import { getBodyHalfWidthFrac } from '../../math/BodyDimensions';
import type { LocomotionMount } from '@/types/blueprintSchema.generated';
import { UNIT_BLUEPRINT_IDS } from '@/types/blueprintIds';
import rawLocomotionConfig from '../unitLocomotionConfig.json';
import {
  forEachSurfaceProbePoint,
  getSurfaceProbeSpacing,
} from '../surfaceProbeSets';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[locomotion contract] ${message}`);
}

function cloneBlueprint(value: UnitLocomotionBlueprint): UnitLocomotionBlueprint {
  return JSON.parse(JSON.stringify(value)) as UnitLocomotionBlueprint;
}

function expectLocomotionError(blueprint: UnitLocomotionBlueprint, message: string): void {
  try {
    createUnitLocomotion(blueprint);
  } catch {
    return;
  }
  throw new Error(`[locomotion contract] expected invalid locomotion: ${message}`);
}

type ExpectedLocomotionDomain = Readonly<{
  type: UnitLocomotionBlueprint['type'];
  allowOnGround: boolean;
  allowInAir: boolean;
  allowInWater: boolean;
  waterFatal: boolean;
  landFatal: boolean;
}>;

/**
 * This is an explicit roster policy rather than a visual-type inference.
 * The same leg rig may be a land-only bot or the Commander's seabed-walking
 * chassis; navigation and survival stay deliberate data decisions.
 */
const EXPECTED_ROSTER_LOCOMOTION: Readonly<Record<string, ExpectedLocomotionDomain>> = {
  unitHuman: { type: 'bot', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitJackal: { type: 'rover', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitLynx: { type: 'tank', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitDaddy: { type: 'crawler', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitBadger: { type: 'tank', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitHedgehog: { type: 'tank', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitMongoose: { type: 'rover', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitTick: { type: 'crawler', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitMammoth: { type: 'tank', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitFormik: { type: 'crawler', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitWidow: { type: 'crawler', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitHippo: { type: 'amphibious-tank', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: false },
  unitSeaTurtle: { type: 'amphibian', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: false },
  unitOrca: { type: 'submarine', allowOnGround: false, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: true },
  unitTarantula: { type: 'crawler', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitLoris: { type: 'tank', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitBee: { type: 'drone', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitDragonfly: { type: 'drone', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitConstructionDrone: { type: 'drone', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitConstructionSubmarine: { type: 'submarine', allowOnGround: false, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: true },
  unitEagle: { type: 'plane', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitDuck: { type: 'aerosub', allowOnGround: false, allowInAir: true, allowInWater: true, waterFatal: false, landFatal: false },
  unitAlbatros: { type: 'plane', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitQueenBee: { type: 'drone', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitQueenTick: { type: 'crawler', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitTransport: { type: 'drone', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitCommander: { type: 'bot', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: false },
  unitRex: { type: 'bot', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: false },
  unitRadarScout: { type: 'drone', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitConstructionBot: { type: 'bot', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitConstructionRover: { type: 'rover', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitStealthScout: { type: 'amphibian', allowOnGround: false, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: true },
  unitDetector: { type: 'drone', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitRadarJammer: { type: 'amphibian', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: false },
  unitMissileRover: { type: 'rover', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitClusterArtillery: { type: 'rover', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitWaterStrider: { type: 'crawler', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: false },
  unitPatrolCorvette: { type: 'amphibian', allowOnGround: false, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: true },
  unitPetrel: { type: 'aerosub', allowOnGround: false, allowInAir: true, allowInWater: true, waterFatal: false, landFatal: false },
  unitAdvancedConstructionBot: { type: 'bot', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitAdvancedConstructionRover: { type: 'rover', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true, landFatal: false },
  unitAdvancedConstructionDrone: { type: 'drone', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true, landFatal: false },
  unitAdvancedConstructionSubmarine: { type: 'submarine', allowOnGround: false, allowInAir: false, allowInWater: true, waterFatal: false, landFatal: true },
};


/**
 * A LEG ATTACHMENT IS A FULL {x, y, z} IN THE UNIT'S OWN FRAME.
 *
 * The height used to be derived — the lifted mid-point of whichever body
 * segment the leg sat under, with a unit-wide `legAttachHeightFrac` override
 * for hulls whose visible body is a turret. Three separate files re-derived
 * it and had to agree, a bodyless hull could not have legs at all, and no leg
 * could sit at a different height from its neighbours on the same unit.
 *
 * Now it is authored per leg, which means it can also be authored WRONG in a
 * way nothing else notices: a missing axis reads as 0 and drops the hip to
 * the unit's origin. Pin all three.
 */
function checkLegAttachmentPoints(): void {
  const footlessUnitIds = new Set(['unitDaddy', 'unitTick']);
  for (const blueprint of getAllUnitBlueprints()) {
    const unitBlueprintId = blueprint.unitBlueprintId;
    const locomotion = blueprint.unitLocomotion;
    if (locomotion.type !== 'crawler') continue;
    assertContract(
      locomotion.config.hasFeet === !footlessUnitIds.has(unitBlueprintId),
      `${unitBlueprintId} must explicitly match the authored arachnid-foot roster`,
    );
    const legs = locomotion.config.leftSide;
    assertContract(
      legs.length > 0,
      `${unitBlueprintId} walks, so it must author at least one leg`,
    );
    for (let i = 0; i < legs.length; i++) {
      const point = legs[i].attachmentPoint;
      for (const axis of ['xUnitRadiusRatio', 'yUnitRadiusRatio', 'zUnitRadiusRatio'] as const) {
        assertContract(
          Number.isFinite(point[axis]),
          `${unitBlueprintId} leg ${i} must author a finite ${axis} — a missing `
            + 'axis reads as 0, which silently drops the hip to the unit origin',
        );
      }
      // The lateral axis is the MIRROR axis: resolveMirroredLegConfigs negates
      // it and nothing else, so a leg authored on the centreline produces two
      // legs in the same place rather than a pair.
      assertContract(
        Math.abs(point.yUnitRadiusRatio) > 1e-6,
        `${unitBlueprintId} leg ${i} sits on the centreline, so its mirror `
          + 'lands on top of it',
      );
      // Height is up from the unit's own origin, so a hip at or below zero is
      // a leg attached underneath the body rather than to it.
      assertContract(
        point.zUnitRadiusRatio > 0,
        `${unitBlueprintId} leg ${i} attaches at or below the unit origin `
          + `(z = ${point.zUnitRadiusRatio})`,
      );
    }
  }
}



/**
 * SIDE-MOUNTED pieces must clear the hull laterally.
 *
 * A wheel or a track IS at its mount and hangs off the side, so its inner
 * face is what has to clear the body. This is the check the roster actually
 * failed: nothing related a mount to where the hull ends, so every tracked
 * unit shipped with its belts inside its own body — Mammoth's inner face sat
 * at 0.60 against a body reaching 0.85.
 *
 * It deliberately does NOT cover every locomotion type. A hover duct hangs
 * BELOW the hull and a tri-layout puts one fan directly astern; both clear on
 * an axis this test does not measure, and asserting the lateral one against
 * them would only teach people to weaken the rule. Legs and flipper shoulders
 * are attachments by design — the limb hanging off them is what reads as
 * separated, not the root. What every type does share is checked below.
 */
const LOCOMOTION_PIECE_CLEARANCE = 0.1;

function sideMountedPieces(
  blueprint: ReturnType<typeof getAllUnitBlueprints>[number],
): { mounts: readonly LocomotionMount[]; halfWidth: number } | null {
  const locomotion = blueprint.unitLocomotion;
  switch (locomotion.type) {
    case 'rover':
    case 'tank':
    case 'amphibious-tank':
      return { mounts: locomotion.config.mounts, halfWidth: locomotion.config.treadWidth / 2 };
    default:
      return null;
  }
}

function checkLocomotionMountClearance(): void {
  for (const blueprint of getAllUnitBlueprints()) {
    const sideMounted = sideMountedPieces(blueprint);
    if (sideMounted === null) continue;
    const unitBlueprintId = blueprint.unitBlueprintId;
    const bodyHalfWidth = getBodyHalfWidthFrac(blueprint.bodyShape);
    for (let i = 0; i < sideMounted.mounts.length; i++) {
      // The piece hangs off the side, so its INNER FACE is what has to clear.
      // A mount that merely puts the centre outside the body still buries
      // half the track.
      const inner = Math.abs(sideMounted.mounts[i].yUnitRadiusRatio) - sideMounted.halfWidth;
      assertContract(
        inner >= bodyHalfWidth + LOCOMOTION_PIECE_CLEARANCE - 1e-6,
        `${unitBlueprintId} mount ${i} sits ${inner.toFixed(3)} out but the body `
          + `reaches ${bodyHalfWidth.toFixed(3)} — the piece needs to clear it by `
          + `${LOCOMOTION_PIECE_CLEARANCE} unit-radius, or it renders buried in `
          + 'the hull it is supposed to be carrying',
      );
    }
  }
}

/**
 * EVERY locomotion piece, of every type, is placed by a finite {x, y, z} —
 * and no two pieces of one unit share a point.
 *
 * The second half is not hypothetical. Jets were authored as a `jetCount`
 * plus one lateral scalar, and every twin-jet unit in the roster authored
 * that scalar as 0, so the pair rendered exactly coincident: one nozzle
 * wearing another, at twice the draw cost and no visual difference. Two
 * pieces at one point is always a mistake, and it only becomes visible once
 * the offsets are written down.
 */
function allLocomotionMounts(
  blueprint: ReturnType<typeof getAllUnitBlueprints>[number],
): readonly LocomotionMount[] {
  const locomotion = blueprint.unitLocomotion;
  switch (locomotion.type) {
    case 'rover':
    case 'tank':
    case 'amphibious-tank':
      return locomotion.config.mounts;
    case 'drone':
    case 'amphibian':
      return locomotion.config.mounts.map((mount) => mount.offset);
    case 'submarine':
      return [
        ...locomotion.config.pectorals.map((mount) => mount.offset),
        locomotion.config.rearFan.offset,
      ];
    case 'plane':
    case 'aerosub':
      return locomotion.config.jets.map((jet) => jet.offset);
    case 'crawler':
      return locomotion.config.leftSide.map((leg) => leg.attachmentPoint);
    case 'bot':
      // A biped authors one hip and one shoulder; both are mirrored.
      return [locomotion.config.legs.hip, locomotion.config.arms.shoulder];
    default:
      return [];
  }
}

function checkLocomotionMountsAuthored(): void {
  for (const blueprint of getAllUnitBlueprints()) {
    const unitBlueprintId = blueprint.unitBlueprintId;
    const mounts = allLocomotionMounts(blueprint);
    assertContract(
      mounts.length > 0,
      `${unitBlueprintId} moves, so it must author at least one locomotion mount`,
    );
    const seen = new Set<string>();
    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i];
      for (const axis of ['xUnitRadiusRatio', 'yUnitRadiusRatio', 'zUnitRadiusRatio'] as const) {
        assertContract(
          Number.isFinite(mount[axis]),
          `${unitBlueprintId} mount ${i} must author a finite ${axis} — a missing `
            + 'axis reads as 0, which silently drops the piece to the unit origin',
        );
      }
      const key = [
        mount.xUnitRadiusRatio, mount.yUnitRadiusRatio, mount.zUnitRadiusRatio,
      ].join(',');
      assertContract(
        !seen.has(key),
        `${unitBlueprintId} mounts two locomotion pieces at (${key}) — one piece `
          + 'wearing another, at twice the cost and no visual difference',
      );
      seen.add(key);
    }
  }
}

function checkBotTurretHostAttachments(): void {
  for (const blueprint of getAllUnitBlueprints()) {
    const bot = blueprint.unitLocomotion.type === 'bot';
    for (const turret of blueprint.turrets) {
      if (!bot) {
        assertContract(
          turret.hostAttachment === undefined,
          `${blueprint.unitBlueprintId}/${turret.mountId} cannot name a bot attachment on a non-bot host`,
        );
        continue;
      }
      const attachment = turret.hostAttachment;
      assertContract(
        (attachment?.kind === 'botPiece' &&
            (attachment.piece === 'head' ||
              attachment.piece === 'leftShoulder' ||
              attachment.piece === 'rightShoulder' ||
              attachment.piece === 'backpackLeft' ||
              attachment.piece === 'backpackRight')) ||
          (attachment?.kind === 'botArm' &&
            (attachment.arm === 'leftArm' || attachment.arm === 'rightArm' ||
              ((attachment.arm === 'leftUpperArm' || attachment.arm === 'rightUpperArm') &&
                blueprint.unitLocomotion.type === 'bot' &&
                blueprint.unitLocomotion.config.upperArms !== undefined))),
        `${blueprint.unitBlueprintId}/${turret.mountId} must identify its bot host attachment`,
      );
    }
  }

  const human = getUnitBlueprint('unitHuman');
  assertContract(
    human.turrets[0]?.hostAttachment?.kind === 'botArm' &&
      human.turrets[0].hostAttachment.arm === 'rightArm',
    'Human mounts its gun on the authored right arm',
  );

  const commander = getUnitBlueprint('unitCommander');
  const beam = commander.turrets.find((turret) => turret.mountId === 'beam');
  const dgun = commander.turrets.find((turret) => turret.mountId === 'disruptor');
  assertContract(
    beam?.hostAttachment?.kind === 'botArm' &&
      beam.hostAttachment.arm === 'leftArm',
    'Commander mounts its beam on the left arm',
  );
  assertContract(
    dgun?.hostAttachment?.kind === 'botPiece' && dgun.hostAttachment.piece === 'head',
    'Commander mounts its D-gun on the head',
  );

  const rex = getUnitBlueprint('unitRex');
  const rightFastRocket = rex.turrets.find((turret) => turret.mountId === 'antiAirRight');
  const leftFastRocket = rex.turrets.find((turret) => turret.mountId === 'antiAirLeft');
  const rightSilo = rex.turrets.find((turret) => turret.mountId === 'siloRight');
  const leftSilo = rex.turrets.find((turret) => turret.mountId === 'siloLeft');
  assertContract(
    rightFastRocket?.hostAttachment?.kind === 'botArm' &&
      rightFastRocket.hostAttachment.arm === 'rightUpperArm' &&
      leftFastRocket?.hostAttachment?.kind === 'botArm' &&
      leftFastRocket.hostAttachment.arm === 'leftUpperArm' &&
      rex.unitLocomotion.type === 'bot' &&
      rex.unitLocomotion.config.upperArms?.elbowBendDirection === 'downward',
    'Rex fast-rocket launchers mount to the downward-bending optional upper arms',
  );
  assertContract(
    rightSilo?.hostAttachment?.kind === 'botPiece' &&
      rightSilo.hostAttachment.piece === 'backpackRight' &&
      leftSilo?.hostAttachment?.kind === 'botPiece' &&
      leftSilo.hostAttachment.piece === 'backpackLeft',
    'Rex vertical rockets mount to their respective moving backpack sockets',
  );
}

export function runUnitLocomotionContractTest(): void {
  checkLegAttachmentPoints();
  checkLocomotionMountsAuthored();
  checkLocomotionMountClearance();
  checkBotTurretHostAttachments();
  const probeSpacing = getSurfaceProbeSpacing().world;
  const fewSamples: Array<{ x: number; y: number }> = [];
  const manySamples: Array<{ x: number; y: number }> = [];
  forEachSurfaceProbePoint('few', 0, 0, 1, 0, (x, y) => {
    fewSamples.push({ x, y });
  });
  forEachSurfaceProbePoint('many', 0, 0, 1, 0, (x, y) => {
    manySamples.push({ x, y });
  });
  // The rule is that every probe set is laid out on ONE shared spacing lattice,
  // not that a set uses particular multiples of it -- `many` is authored at
  // even multiples so it spreads wider than `few` over the same lattice.
  // Assert the lattice, so re-authoring a set's reach stays a data change.
  const offLattice = [...fewSamples, ...manySamples].filter((sample) => {
    const fx = sample.x / probeSpacing;
    const fy = sample.y / probeSpacing;
    return Math.abs(fx - Math.round(fx)) > 1e-9 || Math.abs(fy - Math.round(fy)) > 1e-9;
  });
  assertContract(
    probeSpacing > 0 &&
      offLattice.length === 0 &&
      fewSamples.length > 1 &&
      manySamples.length > fewSamples.length - 1 &&
      // Both sets must actually leave the origin, or the "lattice" is vacuous.
      fewSamples.some((sample) => sample.x !== 0 || sample.y !== 0) &&
      manySamples.some((sample) => sample.x !== 0 || sample.y !== 0),
    'all multi-point surface-probe layouts use the one shared spacing lattice: ' +
      `off-lattice=${JSON.stringify(offLattice)}`,
  );
  assertContract(
    Math.max(...manySamples.map((sample) => Math.abs(sample.x))) >
      Math.max(...fewSamples.map((sample) => Math.abs(sample.x))),
    'the many-probe set must reach further along the lattice than the few-probe set',
  );

  for (const [presetId, rawPreset] of Object.entries(rawLocomotionConfig.presets)) {
    const preset = getUnitLocomotionPreset(presetId);
    const ground = preset.actuator.ground;
    assertContract(
      ground.staticFrictionCoefficient >= 0 &&
        ground.tangentialDampingRate >= 0 &&
        ground.angularDampingRate >= 0,
      `${presetId}.ground owns contact physics`,
    );
    assertContract(
      !Object.prototype.hasOwnProperty.call(rawPreset.actuator.ground, 'maxPropulsiveForce'),
      `${presetId}.ground does not own unit propulsion`,
    );
    for (const medium of ['air', 'water'] as const) {
      const runtime = preset.actuator[medium];
      assertContract(
        runtime.linearDampingRate >= 0 &&
          runtime.angularDampingRate >= 0,
        `${presetId}.${medium} owns linear and angular damping`,
      );
      assertContract(
        !Object.prototype.hasOwnProperty.call(rawPreset.actuator[medium], 'maxPropulsiveForce'),
        `${presetId}.${medium} does not own unit propulsion`,
      );
      for (const field of UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS) {
        assertContract(
          Object.prototype.hasOwnProperty.call(runtime.surfaceLiftResponse, field),
          `${presetId}.${medium}.surfaceLiftResponse explicitly owns ${field}`,
        );
      }
      assertContract(
        runtime.surfaceLiftResponse.randomizationAmount === 0 &&
          runtime.surfaceLiftResponse.ema === 0,
        `${presetId}.${medium} surface following is deterministic and unfiltered`,
      );
    }
  }

  for (const blueprint of getAllUnitBlueprints()) {
    const runtime = getUnitLocomotion(blueprint.unitBlueprintId);
    const clone = cloneUnitLocomotion(runtime);
    assertContract(
      clone.physics.ground.maxPropulsiveForce === runtime.physics.ground.maxPropulsiveForce &&
        clone.physics.air.maxPropulsiveForce === runtime.physics.air.maxPropulsiveForce &&
        clone.physics.water.maxPropulsiveForce === runtime.physics.water.maxPropulsiveForce &&
        clone.actuator.propulsionAxis === runtime.actuator.propulsionAxis &&
        clone.navigation.waypoint.allowOnGround === runtime.navigation.waypoint.allowOnGround &&
        clone.navigation.move.allowInWater === runtime.navigation.move.allowInWater,
      `${blueprint.unitBlueprintId} locomotion cloning preserves per-medium propulsion and navigation`,
    );
    assertContract(
      runtime.physics.ground.maxPropulsiveForce ===
        blueprint.unitLocomotion.physics.ground.maxPropulsiveForce &&
        runtime.physics.air.maxPropulsiveForce ===
          blueprint.unitLocomotion.physics.air.maxPropulsiveForce &&
        runtime.physics.water.maxPropulsiveForce ===
          blueprint.unitLocomotion.physics.water.maxPropulsiveForce &&
        runtime.physics.air.lift.surfaceFollowingInverseForceFromGround ===
        blueprint.unitLocomotion.physics.air.lift.surfaceFollowingInverseForceFromGround &&
        runtime.physics.air.lift.surfaceFollowingInverseForceFromWater ===
          blueprint.unitLocomotion.physics.air.lift.surfaceFollowingInverseForceFromWater &&
        runtime.physics.water.lift.surfaceFollowingInverseForceFromGround ===
          blueprint.unitLocomotion.physics.water.lift.surfaceFollowingInverseForceFromGround &&
        runtime.physics.water.lift.surfaceFollowingProportionalForceFromWater ===
          blueprint.unitLocomotion.physics.water.lift.surfaceFollowingProportionalForceFromWater,
      `${blueprint.unitBlueprintId} owns per-medium propulsion and explicit surface-following forces`,
    );
    assertContract(
      getUnitLocomotionTraversalCapabilities(runtime).waypoint.allowInAir ===
        runtime.navigation.waypoint.allowInAir,
      `${blueprint.unitBlueprintId} route permissions come from navigation, not visual type`,
    );
  }

  assertContract(
    Object.keys(EXPECTED_ROSTER_LOCOMOTION).length === UNIT_BLUEPRINT_IDS.length,
    'every unit has an explicit locomotion-domain policy',
  );
  for (const unitBlueprintId of UNIT_BLUEPRINT_IDS) {
    const expected = EXPECTED_ROSTER_LOCOMOTION[unitBlueprintId];
    const runtime = getUnitLocomotion(unitBlueprintId);
    assertContract(expected !== undefined, `${unitBlueprintId} has a locomotion-domain policy`);
    assertContract(
      runtime.type === expected.type &&
        runtime.navigation.waypoint.allowOnGround === expected.allowOnGround &&
        runtime.navigation.waypoint.allowInAir === expected.allowInAir &&
        runtime.navigation.waypoint.allowInWater === expected.allowInWater &&
        (runtime.environmentalHazards.waterDamagePerSecond > 0) === expected.waterFatal &&
        (runtime.environmentalHazards.landDamagePerSecond > 0) === expected.landFatal,
      `${unitBlueprintId} matches its intended ground, air, and water locomotion`,
    );
    assertContract(
      runtime.navigation.move.allowInWater && runtime.physics.water.maxPropulsiveForce > 0,
      `${unitBlueprintId} has positive emergency water propulsion and move-valid water cells`,
    );
    const blueprint = getUnitBlueprint(unitBlueprintId);
    assertContract(
      runtime.environmentalHazards.waterDamagePerSecond ===
        (expected.waterFatal ? blueprint.hp / 2 : 0),
      `${unitBlueprintId} authors universal numeric water damage; intended water units use zero`,
    );
    assertContract(
      runtime.environmentalHazards.landDamagePerSecond ===
        (expected.landFatal ? blueprint.hp / 2 : 0),
      `${unitBlueprintId} authors universal numeric land damage; only water-only hulls burn ashore`,
    );
    assertContract(
      runtime.environmentalHazards.lavaDamageMultiplier ===
        (unitBlueprintId === 'unitRex' ? 0 : 1),
      `${unitBlueprintId} resolves its explicit lava-survival policy`,
    );
  }

  // The bot rig is shared by two presets: `bot` is a land bot that drowns
  // like a tank, `amphibious-bot` walks the seabed. Only the Commander and
  // the Rex are amphibious.
  for (const unitBlueprintId of ['unitHuman', 'unitConstructionBot', 'unitAdvancedConstructionBot'] as const) {
    const landBot = getUnitLocomotion(unitBlueprintId);
    assertContract(
      landBot.physicsPresetId === 'bot' &&
        !landBot.navigation.waypoint.allowInWater &&
        landBot.environmentalHazards.waterDamagePerSecond > 0,
      `${unitBlueprintId} is a land bot: no water waypoints and it drowns`,
    );
  }
  assertContract(
    getUnitLocomotion('unitRex').physicsPresetId === 'amphibious-bot',
    'Rex is an amphibious bot',
  );
  const commander = getUnitLocomotion('unitCommander');
  assertContract(
    commander.physicsPresetId === 'amphibious-bot' &&
      commander.actuator.propulsionAxis === 'waypointForwardOnly' &&
      commander.navigation.waypoint.allowOnGround &&
      commander.navigation.waypoint.allowInWater &&
      !commander.navigation.waypoint.allowInAir &&
      commander.environmentalHazards.waterDamagePerSecond === 0 &&
      commander.physics.water.lift.surfaceFollowingProportionalForceFromWater === 0,
    'Commander turns before advancing and walks the seabed without a water-surface controller',
  );
  for (const unitBlueprintId of ['unitHuman', 'unitCommander', 'unitRex'] as const) {
    assertContract(
      getUnitLocomotion(unitBlueprintId).actuator.propulsionAxis === 'waypointForwardOnly',
      `${unitBlueprintId} bot locomotion cannot apply powered reverse thrust`,
    );
  }

  const eagle = getUnitLocomotion('unitEagle');
  assertContract(
    eagle.navigation.waypoint.allowInAir && eagle.physics.air.maxPropulsiveForce > 0,
    'Eagle has explicit air navigation and air propulsion',
  );
  const eagleMass = getUnitBlueprint('unitEagle').base.mass;
  const bee = getUnitLocomotion('unitBee');
  const beeMass = getUnitBlueprint('unitBee').base.mass;
  // The Albatros is the lumbering heavy: half Eagle-class acceleration (so
  // half the cruise speed under the same air damping) and an authored yaw slew
  // far below the plane preset's, so its turning circle is much wider.
  const albatros = getUnitLocomotion('unitAlbatros');
  const albatrosMass = getUnitBlueprint('unitAlbatros').base.mass;
  const eagleAirAccel = eagle.physics.air.maxPropulsiveForce / eagleMass;
  const albatrosAirAccel = albatros.physics.air.maxPropulsiveForce / albatrosMass;
  assertContract(
    Math.abs(albatrosAirAccel - eagleAirAccel * 0.5) < eagleAirAccel * 0.05,
    'Albatros authors half Eagle-class air acceleration',
  );
  assertContract(
    typeof albatros.actuator.turnRateDegreesPerSecond === 'number' &&
      typeof eagle.actuator.turnRateDegreesPerSecond === 'number' &&
      albatros.actuator.turnRateDegreesPerSecond <= eagle.actuator.turnRateDegreesPerSecond * 0.35,
    'Albatros overrides the preset yaw slew to a fraction of the Eagle rate for a much wider turning circle',
  );
  const queenTick = getUnitLocomotion('unitQueenTick');
  assertContract(
    queenTick.physicsPresetId === 'crawler' &&
      queenTick.physics.ground.maxPropulsiveForce > 0 &&
      queenTick.physics.air.maxPropulsiveForce === 0 &&
      queenTick.navigation.waypoint.allowOnGround &&
      !queenTick.navigation.waypoint.allowInAir,
    'Queen Tick walks on legs with ground propulsion and no flight capability',
  );
  const queenBee = getUnitLocomotion('unitQueenBee');
  const queenBeeMass = getUnitBlueprint('unitQueenBee').base.mass;
  assertContract(
    queenBee.physics.air.maxPropulsiveForce / queenBeeMass >=
      bee.physics.air.maxPropulsiveForce / beeMass &&
      queenBee.physics.water.maxPropulsiveForce === queenBee.physics.air.maxPropulsiveForce,
    'Queen Bee authors Bee-class air acceleration and matching emergency water propulsion',
  );
  const orca = getUnitLocomotion('unitOrca');
  assertContract(
      !orca.navigation.waypoint.allowOnGround &&
      orca.navigation.waypoint.allowInWater &&
      orca.physics.ground.maxPropulsiveForce === 0 &&
      orca.physics.water.maxPropulsiveForce > 0 &&
      !orca.motionControl.maintainFullThrustAtWaypoints &&
      !orca.motionControl.cruiseWhenUncommanded,
    'Orca is water-navigable and brakes to stop at a waypoint',
  );
  for (const unitBlueprintId of [
    'unitDuck',
    'unitOrca',
    'unitConstructionSubmarine',
    'unitAdvancedConstructionSubmarine',
  ] as const) {
    const locomotion = getUnitLocomotion(unitBlueprintId);
    assertContract(
      locomotion.actuator.propulsionAxis !== 'worldPlanar' &&
        locomotion.motionControl.waypointDeadzone !== undefined,
      `${unitBlueprintId} must use the generalized body-forward waypoint-orbit interlock`,
    );
  }

  // Final-approach classes: hover always brakes (the anchor hold is the
  // chassis identity), forward flight never brakes (the loiter circle is the
  // hold), and no preset may author both policies at once.
  for (const blueprint of getAllUnitBlueprints()) {
    const locomotion = getUnitLocomotion(blueprint.unitBlueprintId);
    const { maintainFullThrustAtWaypoints, alwaysBrakeAtFinalWaypoint, cruiseWhenUncommanded } =
      locomotion.motionControl;
    assertContract(
      !(maintainFullThrustAtWaypoints && alwaysBrakeAtFinalWaypoint),
      `${blueprint.unitBlueprintId} authors both full-thrust and always-brake final approach`,
    );
    const bodyForward = locomotion.actuator.propulsionAxis !== 'worldPlanar';
    const deadzone = locomotion.motionControl.waypointDeadzone;
    assertContract(
      bodyForward === (deadzone !== undefined),
      `${blueprint.unitBlueprintId} must use the shared waypoint-orbit interlock exactly when its actuator is body-forward`,
    );
    if (deadzone !== undefined) {
      assertContract(
        Number.isFinite(deadzone.turnRadiusMultiplier) &&
          deadzone.turnRadiusMultiplier >= 1 &&
          deadzone.frontSliceDegrees > 0 &&
          deadzone.frontSliceDegrees < 90,
        `${blueprint.unitBlueprintId} has a valid waypoint no-turn deadzone`,
      );
    }
    if (locomotion.type === 'drone') {
      assertContract(
        alwaysBrakeAtFinalWaypoint && !cruiseWhenUncommanded,
        `${blueprint.unitBlueprintId} is a drone: hover braking at the final waypoint is its chassis identity`,
      );
    }
    if (locomotion.type === 'plane' || locomotion.type === 'aerosub') {
      assertContract(
        maintainFullThrustAtWaypoints && cruiseWhenUncommanded && !alwaysBrakeAtFinalWaypoint,
        `${blueprint.unitBlueprintId} is forward-flight: full thrust plus cruise loiter, never the final brake`,
      );
      assertContract(
        locomotion.actuator.propulsionAxis === 'alwaysForward',
        `${blueprint.unitBlueprintId} is forward-flight: the gas is always on along the nose (alwaysForward)`,
      );
      const turnRate = locomotion.actuator.turnRateDegreesPerSecond;
      assertContract(
        typeof turnRate === 'number' && Number.isFinite(turnRate) && turnRate > 0 && turnRate <= 720,
        `${blueprint.unitBlueprintId} is forward-flight: it must author the constant-rate circle turn (turnRateDegreesPerSecond)`,
      );
      assertContract(deadzone !== undefined, `${blueprint.unitBlueprintId} is forward-flight and orbit-proof`);
    }
  }

  const incompleteAirLift = cloneBlueprint(getUnitBlueprint('unitEagle').unitLocomotion);
  delete (incompleteAirLift.physics.air.lift as {
    surfaceFollowingInverseForceFromWater?: number;
  }).surfaceFollowingInverseForceFromWater;
  expectLocomotionError(incompleteAirLift, 'air lift requires both inverse surface sources');

  const missingGroundPropulsion = cloneBlueprint(getUnitBlueprint('unitEagle').unitLocomotion);
  delete (missingGroundPropulsion.physics.ground as {
    maxPropulsiveForce?: number;
  }).maxPropulsiveForce;
  expectLocomotionError(missingGroundPropulsion, 'ground requires maxPropulsiveForce');

  const missingAirPropulsion = cloneBlueprint(getUnitBlueprint('unitEagle').unitLocomotion);
  delete (missingAirPropulsion.physics.air as {
    maxPropulsiveForce?: number;
  }).maxPropulsiveForce;
  expectLocomotionError(missingAirPropulsion, 'air requires maxPropulsiveForce');

  const invalidWaterLift = cloneBlueprint(getUnitBlueprint('unitOrca').unitLocomotion);
  const waterLift = invalidWaterLift.physics.water.lift as {
    surfaceFollowingProportionalForceFromWater?: number;
  };
  delete waterLift.surfaceFollowingProportionalForceFromWater;
  expectLocomotionError(invalidWaterLift, 'water lift requires its proportional water-surface force');

  const invalidLavaMultiplier = cloneBlueprint(getUnitBlueprint('unitRex').unitLocomotion);
  invalidLavaMultiplier.environmentalHazards.lavaDamageMultiplier = -1;
  expectLocomotionError(invalidLavaMultiplier, 'lava damage multiplier must be non-negative');
}
