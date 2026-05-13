/**
 * Unit Blueprints
 *
 * Single source of truth for all unit types, including commander.
 * Consolidates: UNIT_STATS, COMMANDER_STATS, UNIT_DEFINITIONS, UNIT_BUILD_CONFIGS,
 * CHASSIS_MOUNTS, LEG_CONFIG, TREAD_CONFIG, WHEEL_CONFIG, UNIT_SHORT_NAMES, death sounds.
 */

import { AUDIO } from '../../../audioConfig';
import { DEFAULT_UNIT_HUD_LAYOUT } from '../../../entityHudConfig';
import type { TurretId } from '../../../types/blueprintIds';
import type {
  UnitBlueprint,
  MountOffset,
  TurretMount,
  UnitBodyShape,
  ConstructionEmitterSize,
  UnitTurretMountZResolver,
} from './types';
import type { UnitLocomotion } from '../types';
import { createUnitLocomotion } from '../locomotion';
import { UNIT_LOCOMOTION_BLUEPRINTS } from './locomotion';
import {
  LEG_BODY_LIFT_FRAC,
  getExpectedUnitBodyCenterHeightY,
  getLegBodyCenterHeightY,
  getTreadBodyCenterHeightY,
  getWheelBodyCenterHeightY,
} from '../../math/BodyDimensions';
export { BUILDABLE_UNIT_IDS, type BuildableUnitId } from './unitRoster';
import { BUILDABLE_UNIT_IDS } from './unitRoster';

const WIDOW_BODY_RADIUS = 30;
const WIDOW_ABDOMEN_RADIUS_FRAC = 1.15;
const WIDOW_ABDOMEN_FORWARD_FRAC = -1.1;
const WIDOW_HEAD_RADIUS_FRAC = 0.55;
// Forward prosoma/head sphere location. The visible head belongs here;
// combat turrets that are meant to read as rear/back weapons should not
// reuse this mount.
const WIDOW_HEAD_FORWARD_FRAC = 0.3;
const WIDOW_ABDOMEN_TOP_Z_FRAC =
  LEG_BODY_LIFT_FRAC + WIDOW_ABDOMEN_RADIUS_FRAC * 2;
const WIDOW_HEAD_TOP_Z_FRAC = LEG_BODY_LIFT_FRAC + WIDOW_HEAD_RADIUS_FRAC * 2;

const BODY_SHAPES = {
  scout: {
    kind: 'polygon',
    sides: 4,
    radiusFrac: 0.55,
    heightFrac: 0.3,
    rotation: Math.PI / 4,
  },
  brawl: {
    kind: 'polygon',
    sides: 4,
    radiusFrac: 0.8,
    heightFrac: 0.3,
    rotation: 0,
  },
  tank: {
    kind: 'polygon',
    sides: 5,
    radiusFrac: 0.85,
    heightFrac: 0.3,
    rotation: 0,
  },
  burst: {
    kind: 'polygon',
    sides: 3,
    radiusFrac: 0.6,
    heightFrac: 0.3,
    rotation: Math.PI,
  },
  mortar: {
    kind: 'polygon',
    sides: 6,
    radiusFrac: 0.55,
    heightFrac: 0.3,
    rotation: 0,
  },
  hippo: {
    kind: 'rect',
    lengthFrac: 0.7,
    widthFrac: 1.6,
    heightFrac: 0.6,
  },
  beam: {
    kind: 'composite',
    // Tarantula keeps its forward head sphere; its beam turret mounts
    // on top of the rear abdomen segment.
    parts: [
      {
        kind: 'oval',
        offsetForward: -0.65,
        xFrac: 0.9,
        yFrac: (0.9 + 0.65) / 2,
        zFrac: 0.65,
      },
      { kind: 'circle', offsetForward: 0.3, radiusFrac: 0.55, yFrac: 0.55 },
    ],
  },
  arachnid: {
    kind: 'composite',
    // Widow keeps its forward prosoma/head sphere; the mega beam
    // turret mounts on top of the rear abdomen segment.
    parts: [
      {
        kind: 'circle',
        offsetForward: WIDOW_ABDOMEN_FORWARD_FRAC,
        radiusFrac: WIDOW_ABDOMEN_RADIUS_FRAC,
        yFrac: WIDOW_ABDOMEN_RADIUS_FRAC,
      },
      {
        kind: 'circle',
        offsetForward: WIDOW_HEAD_FORWARD_FRAC,
        radiusFrac: WIDOW_HEAD_RADIUS_FRAC,
        yFrac: WIDOW_HEAD_RADIUS_FRAC,
      },
    ],
  },
  formik: {
    kind: 'composite',
    // Formik keeps a small forward head sphere. Its combat turret
    // lives on the raised rear abdomen/back segment instead of
    // replacing the head silhouette.
    parts: [
      {
        kind: 'oval',
        offsetForward: -0.85,
        xFrac: 0.75,
        yFrac: 0.85,
        zFrac: 0.68,
      },
      {
        kind: 'oval',
        offsetForward: 0.05,
        xFrac: 0.7,
        yFrac: 0.72,
        zFrac: 0.55,
      },
      { kind: 'circle', offsetForward: 0.78, radiusFrac: 0.42, yFrac: 0.42 },
    ],
  },
  snipe: { kind: 'oval', xFrac: 0.5, yFrac: (0.5 + 0.35) / 2, zFrac: 0.35 },
  commander: {
    kind: 'composite',
    parts: [
      {
        kind: 'oval',
        offsetForward: -0.58,
        xFrac: 0.68,
        yFrac: 0.58,
        zFrac: 0.72,
      },
      {
        kind: 'oval',
        offsetForward: 0.04,
        xFrac: 0.78,
        yFrac: 0.62,
        zFrac: 0.76,
      },
      { kind: 'circle', offsetForward: 0.64, radiusFrac: 0.38, yFrac: 0.42 },
    ],
  },
  // Daddy uses a thin central platform under its force-field emitter.
  // Keeping the chassis low and broad gives the leg hips a sensible
  // attachment surface while leaving the emitter visually dominant.
  forceField: { kind: 'circle', radiusFrac: 0.55, yFrac: 0.12 },
  loris: { kind: 'circle', radiusFrac: 0.55, yFrac: 0.55 },
} satisfies Record<string, UnitBodyShape>;

const TARANTULA_ABDOMEN_FORWARD_FRAC = -0.65;
const FORMIK_BACK_SEGMENT_FORWARD_FRAC = -0.85;
const TICK_BODY_CENTER_HEIGHT = 8;
const TICK_TURRET_Z_FRAC = TICK_BODY_CENTER_HEIGHT / 10;
const DADDY_VISUAL_RADIUS = 13;
const DADDY_PUSH_RADIUS = 15;
const DADDY_BODY_CENTER_HEIGHT = 60;
const DADDY_BEAM_TURRET_Z_FRAC =
  DADDY_BODY_CENTER_HEIGHT / DADDY_VISUAL_RADIUS;
// Daddy's main body is authored high above the ground; this force-field
// mount intentionally uses a >1 radius fraction to sit on its underside.
const DADDY_FORCE_FIELD_TURRET_Z_FRAC = 49 / DADDY_VISUAL_RADIUS;
const DADDY_LEG_ATTACH_HEIGHT_FRAC = DADDY_FORCE_FIELD_TURRET_Z_FRAC;
const LORIS_BODY_CENTER_HEIGHT = 24;
const LORIS_MIRROR_TURRET_Z_FRAC = LORIS_BODY_CENTER_HEIGHT / 10;
// Commander construction turret is the small version of the shared
// construction emitter. Its mount is authored as a normal turret pivot:
// z is the turret head center in body-radius fractions. The renderer
// subtracts the turret body radius to place the emitter base at the
// same raised deck where the previous bespoke commander emitter lived.
const COMMANDER_CONSTRUCTION_TURRET_Z_FRAC = 2.28;

function turretMount(
  turretId: TurretId,
  mount: MountOffset,
  visualVariant?: ConstructionEmitterSize,
  zResolver?: UnitTurretMountZResolver,
): TurretMount {
  return {
    turretId,
    mount,
    ...(visualVariant ? { visualVariant } : {}),
    ...(zResolver ? { zResolver } : {}),
  };
}

function mountPoint(x: number, y: number, z: number): MountOffset {
  return { x, y, z };
}

function topMountedTurretMount(
  turretId: TurretId,
  x: number,
  y: number,
  bodyTopZFrac: number,
): TurretMount {
  return turretMount(turretId, mountPoint(x, y, bodyTopZFrac), undefined, {
    kind: 'topMounted',
    bodyTopZFrac,
  });
}

function computeWidowTurrets(): TurretMount[] {
  const abdomenEdgeMounts: TurretMount[] = [];
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    abdomenEdgeMounts.push(
      topMountedTurretMount(
        'pulseTurret',
        Math.cos(angle) * WIDOW_ABDOMEN_RADIUS_FRAC +
          WIDOW_ABDOMEN_FORWARD_FRAC,
        Math.sin(angle) * WIDOW_ABDOMEN_RADIUS_FRAC,
        WIDOW_ABDOMEN_TOP_Z_FRAC,
      ),
    );
  }
  return [
    abdomenEdgeMounts[0], // front-left abdomen edge
    abdomenEdgeMounts[1], // back-left abdomen edge
    abdomenEdgeMounts[2], // back-right abdomen edge
    abdomenEdgeMounts[3], // front-right abdomen edge
    topMountedTurretMount(
      'megaBeamTurret',
      WIDOW_ABDOMEN_FORWARD_FRAC,
      0,
      WIDOW_ABDOMEN_TOP_Z_FRAC,
    ), // abdomen center
    topMountedTurretMount(
      'forceTurret',
      WIDOW_HEAD_FORWARD_FRAC,
      0,
      WIDOW_HEAD_TOP_Z_FRAC,
    ), // head center
  ];
}

export const UNIT_BLUEPRINTS: Record<string, UnitBlueprint> = {
  jackal: {
    id: 'jackal',
    name: 'Jackal',
    shortName: 'JKL',
    hp: 55,
    radius: { body: 8, shot: 6, push: 8 * 1.2 },
    bodyCenterHeight: getWheelBodyCenterHeightY(BODY_SHAPES.scout, 8, 0.28),
    mass: 30,
    cost: { energy: 50, mana: 50, metal: 50 },
    turrets: [turretMount('lightTurret', mountPoint(0, 0, 1.2))],
    bodyShape: BODY_SHAPES.scout,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.jackal,
    detector: { radius: 900 },
    deathSound: AUDIO.event.death.jackal,
  },
  lynx: {
    id: 'lynx',
    name: 'Lynx',
    shortName: 'LNX',
    hp: 60,
    radius: { body: 10, shot: 7, push: 10 * 1.3 },
    bodyCenterHeight: getTreadBodyCenterHeightY(BODY_SHAPES.burst, 10),
    mass: 40,
    cost: { energy: 90, mana: 90, metal: 90 },
    turrets: [turretMount('pulseTurret', mountPoint(0, 0, 1.3))],
    bodyShape: BODY_SHAPES.burst,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.lynx,
    deathSound: AUDIO.event.death.lynx,
  },
  daddy: {
    id: 'daddy',
    name: 'Daddy',
    shortName: 'DDY',
    hp: 200,
    radius: {
      body: DADDY_VISUAL_RADIUS,
      shot: 9,
      push: DADDY_PUSH_RADIUS,
    },
    bodyCenterHeight: DADDY_BODY_CENTER_HEIGHT,
    mass: 30,
    cost: { energy: 350, mana: 350, metal: 350 },
    turrets: [
      turretMount('beamTurret', mountPoint(0, 0, DADDY_BEAM_TURRET_Z_FRAC)),
      turretMount(
        'forceTurret',
        mountPoint(0, 0, DADDY_FORCE_FIELD_TURRET_Z_FRAC),
      ),
    ],
    bodyShape: BODY_SHAPES.forceField,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    hideChassis: true,
    legAttachHeightFrac: DADDY_LEG_ATTACH_HEIGHT_FRAC,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.daddy,
    deathSound: AUDIO.event.death.daddy,
  },
  badger: {
    id: 'badger',
    name: 'Badger',
    shortName: 'BDG',
    hp: 300,
    radius: { body: 16, shot: 13, push: 16 * 1.4 },
    bodyCenterHeight: getTreadBodyCenterHeightY(BODY_SHAPES.brawl, 16),
    mass: 300,
    cost: { energy: 300, mana: 300, metal: 300 },
    turrets: [turretMount('salvoRocketTurret', mountPoint(0, 0, 1.4))],
    bodyShape: BODY_SHAPES.brawl,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.badger,
    deathSound: AUDIO.event.death.badger,
  },
  mongoose: {
    id: 'mongoose',
    name: 'Mongoose',
    shortName: 'MGS',
    hp: 200,
    radius: { body: 20, shot: 12, push: 20 * 1.2 },
    bodyCenterHeight: getWheelBodyCenterHeightY(BODY_SHAPES.mortar, 20, 0.22),
    mass: 200,
    cost: { energy: 220, mana: 220, metal: 220 },
    turrets: [turretMount('mortarTurret', mountPoint(0, 0, 1.2))],
    bodyShape: BODY_SHAPES.mortar,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.mongoose,
    deathSound: AUDIO.event.death.mongoose,
  },
  tick: {
    id: 'tick',
    name: 'Tick',
    shortName: 'TCK',
    hp: 55,
    radius: { body: 10, shot: 8, push: 11 * 1.1 },
    bodyCenterHeight: TICK_BODY_CENTER_HEIGHT,
    mass: 20,
    cost: { energy: 35, mana: 35, metal: 35 },
    turrets: [turretMount('miniBeam', mountPoint(0, 0, TICK_TURRET_Z_FRAC))],
    bodyShape: BODY_SHAPES.snipe,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    hideChassis: true,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.tick,
    suspension: {
      stiffness: 260_000,
      dampingRatio: 0.55,
      maxOffset: { x: 3, y: 3, z: 10 },
    },
    cloak: { enabled: true },
    deathSound: AUDIO.event.death.tick,
  },
  mammoth: {
    id: 'mammoth',
    name: 'Mammoth',
    shortName: 'MMT',
    hp: 900,
    radius: { body: 24, shot: 24, push: 24 * 1.5 },
    bodyCenterHeight: getTreadBodyCenterHeightY(BODY_SHAPES.tank, 24),
    mass: 1000,
    cost: { energy: 1200, mana: 1200, metal: 1200 },
    turrets: [turretMount('cannonTurret', mountPoint(0, 0, 1.5))],
    bodyShape: BODY_SHAPES.tank,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.mammoth,
    deathSound: AUDIO.event.death.mammoth,
  },
  formik: {
    id: 'formik',
    name: 'Formik',
    shortName: 'FMK',
    // Larger than Widow (scale 30 → 40) and tougher to match.
    hp: 3200,
    radius: { body: 40, shot: 50, push: 50 * 1.3 },
    bodyCenterHeight: getLegBodyCenterHeightY(BODY_SHAPES.formik, 40),
    mass: 2500,
    cost: { energy: 4000, mana: 4000, metal: 4000 },
    turrets: [
      turretMount(
        'gatlingMortarTurret',
        mountPoint(FORMIK_BACK_SEGMENT_FORWARD_FRAC, 0, 3.3),
      ),
    ],
    // Mount on the top of the rear abdomen/back segment. The forward
    // head sphere remains a body part, not a turret replacement.
    bodyShape: BODY_SHAPES.formik,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.formik,
    deathSound: AUDIO.event.death.formik,
  },
  widow: {
    id: 'widow',
    name: 'Widow',
    shortName: 'WDW',
    hp: 2400,
    radius: { body: WIDOW_BODY_RADIUS, shot: 40, push: 40 * 1.3 },
    bodyCenterHeight: getLegBodyCenterHeightY(
      BODY_SHAPES.arachnid,
      WIDOW_BODY_RADIUS,
    ),
    mass: 1000,
    cost: { energy: 3000, mana: 3000, metal: 3000 },
    turrets: computeWidowTurrets(),
    bodyShape: BODY_SHAPES.arachnid,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.widow,
    deathSound: AUDIO.event.death.widow,
  },
  hippo: {
    id: 'hippo',
    name: 'Hippo',
    shortName: 'HPO',
    hp: 1500,
    radius: { body: 30, shot: 27, push: 45 * 1.2 },
    bodyCenterHeight: getTreadBodyCenterHeightY(BODY_SHAPES.hippo, 30),
    mass: 1500,
    cost: { energy: 2500, mana: 2500, metal: 2500 },
    turrets: [turretMount('hippoGatlingTurret', mountPoint(0.2, 0, 1.8))],
    bodyShape: BODY_SHAPES.hippo,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.hippo,
    deathSound: AUDIO.event.death.hippo,
  },
  tarantula: {
    id: 'tarantula',
    name: 'Tarantula',
    shortName: 'TRN',
    hp: 100,
    radius: { body: 11, shot: 13, push: 11 * 1.8 },
    bodyCenterHeight: getLegBodyCenterHeightY(BODY_SHAPES.beam, 11),
    mass: 30,
    cost: { energy: 300, mana: 300, metal: 300 },
    turrets: [
      turretMount(
        'beamTurret',
        mountPoint(TARANTULA_ABDOMEN_FORWARD_FRAC, 0, 2.5),
      ),
    ],
    // Mount the beam turret on the rear abdomen segment; the forward
    // head body sphere stays in place.
    bodyShape: BODY_SHAPES.beam,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.tarantula,
    deathSound: AUDIO.event.death.tarantula,
  },
  loris: {
    id: 'loris',
    name: 'Loris',
    shortName: 'LRS',
    hp: 200,
    radius: { body: 10, shot: 8, push: 24 },
    bodyCenterHeight: LORIS_BODY_CENTER_HEIGHT,
    mass: 90,
    cost: { energy: 190, mana: 190, metal: 190 },
    turrets: [
      turretMount('mirrorTurret', mountPoint(0, 0, LORIS_MIRROR_TURRET_Z_FRAC)),
    ],
    bodyShape: BODY_SHAPES.loris,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    hideChassis: true,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.loris,
    deathSound: AUDIO.event.death.loris,
  },
  commander: {
    id: 'commander',
    name: 'Commander',
    shortName: 'CMD',
    hp: 500,
    radius: { body: 20, shot: 20, push: 20 },
    bodyCenterHeight: getLegBodyCenterHeightY(BODY_SHAPES.commander, 20),
    mass: 300,
    cost: { energy: 400, mana: 400, metal: 400 },
    turrets: [
      turretMount('beamTurret', mountPoint(0.36, -0.42, 1)),
      turretMount('dgunTurret', mountPoint(0.36, 0.42, 1)),
      turretMount(
        'constructionTurret',
        mountPoint(-0.42, 0, COMMANDER_CONSTRUCTION_TURRET_Z_FRAC),
        'small',
      ),
    ],
    bodyShape: BODY_SHAPES.commander,
    hud: DEFAULT_UNIT_HUD_LAYOUT,
    locomotion: UNIT_LOCOMOTION_BLUEPRINTS.commander,
    builder: { buildRange: 150, constructionRate: 50 },
    dgun: { turretId: 'dgunTurret', energyCost: 200 },
    detector: { radius: 1100 },
    deathSound: AUDIO.event.death.commander,
  },
};

for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  const expectedBodyCenterHeight = getExpectedUnitBodyCenterHeightY(
    bp,
    bp.radius.body,
  );
  if (
    !Number.isFinite(bp.bodyCenterHeight) ||
    Math.abs(bp.bodyCenterHeight - expectedBodyCenterHeight) > 1e-6
  ) {
    throw new Error(
      `Invalid bodyCenterHeight for ${bp.id}: expected ${expectedBodyCenterHeight}, got ${bp.bodyCenterHeight}`,
    );
  }

  if (!bp.hud || !Number.isFinite(bp.hud.barsOffsetAboveTop)) {
    throw new Error(
      `Invalid HUD layout for ${bp.id}: barsOffsetAboveTop must be finite`,
    );
  }

  if (bp.detector && (!Number.isFinite(bp.detector.radius) || bp.detector.radius <= 0)) {
    throw new Error(
      `Invalid detector for ${bp.id}: detector radius must be positive`,
    );
  }

  if (bp.locomotion.type === 'legs') {
    const legs = bp.locomotion.config.leftSide;
    if (!Array.isArray(legs) || legs.length === 0) {
      throw new Error(
        `Invalid leg layout for ${bp.id}: leftSide must define at least one leg`,
      );
    }
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const values = [
        ['attachOffsetXFrac', leg.attachOffsetXFrac],
        ['attachOffsetYFrac', leg.attachOffsetYFrac],
        ['upperLegLengthFrac', leg.upperLegLengthFrac],
        ['lowerLegLengthFrac', leg.lowerLegLengthFrac],
        ['snapTriggerAngle', leg.snapTriggerAngle],
        ['snapTargetAngle', leg.snapTargetAngle],
        ['snapDistanceMultiplier', leg.snapDistanceMultiplier],
        ['extensionThreshold', leg.extensionThreshold],
      ] as const;
      for (const [name, value] of values) {
        if (!Number.isFinite(value)) {
          throw new Error(
            `Invalid leg layout for ${bp.id}[${i}]: ${name} must be finite`,
          );
        }
      }
      if (leg.upperLegLengthFrac <= 0 || leg.lowerLegLengthFrac <= 0) {
        throw new Error(
          `Invalid leg layout for ${bp.id}[${i}]: leg lengths must be positive`,
        );
      }
      if (leg.snapDistanceMultiplier <= 0 || leg.extensionThreshold <= 0) {
        throw new Error(
          `Invalid leg layout for ${bp.id}[${i}]: snapDistanceMultiplier and extensionThreshold must be positive`,
        );
      }
    }
  }

  // Mount-finiteness only — cross-blueprint turret-ID validation runs
  // in blueprints/index.ts where both UNIT_BLUEPRINTS and
  // TURRET_BLUEPRINTS are visible.
  for (let i = 0; i < bp.turrets.length; i++) {
    const turret = bp.turrets[i];
    const mount = turret.mount;
    if (
      !Number.isFinite(mount.x) ||
      !Number.isFinite(mount.y) ||
      !Number.isFinite(mount.z)
    ) {
      throw new Error(
        `Invalid turret mount for ${bp.id}[${i}] ${turret.turretId}: mount x/y/z must be finite`,
      );
    }
  }

  if (bp.dgun) {
    if (!bp.turrets.some((turret) => turret.turretId === bp.dgun!.turretId)) {
      throw new Error(
        `Invalid dgun turret for ${bp.id}: ${bp.dgun.turretId} is not mounted on the unit`,
      );
    }
  }
}

let unitTurretMountsResolved = false;

export function resolveUnitTurretMounts(
  getTurretBodyRadius: (turretId: TurretId) => number,
): void {
  if (unitTurretMountsResolved) return;

  for (const bp of Object.values(UNIT_BLUEPRINTS)) {
    for (let i = 0; i < bp.turrets.length; i++) {
      const turret = bp.turrets[i];
      const resolver = turret.zResolver;
      if (!resolver) continue;
      if (resolver.kind !== 'topMounted') {
        throw new Error(
          `Invalid turret mount resolver for ${bp.id}[${i}] ${turret.turretId}: unsupported kind`,
        );
      }
      const turretRadius = getTurretBodyRadius(turret.turretId);
      if (!Number.isFinite(turretRadius) || turretRadius <= 0) {
        throw new Error(
          `Invalid top-mounted turret for ${bp.id}[${i}] ${turret.turretId}: turret radius.body must be positive`,
        );
      }
      turret.mount.z = resolver.bodyTopZFrac + turretRadius / bp.radius.body;
    }
  }

  unitTurretMountsResolved = true;
}

function assertUnitTurretMountsResolved(): void {
  if (!unitTurretMountsResolved) {
    throw new Error(
      'Unit turret mounts must be resolved by the blueprint builder before use',
    );
  }
}

export function getUnitBlueprint(id: string): UnitBlueprint {
  assertUnitTurretMountsResolved();
  const unitBlueprint = UNIT_BLUEPRINTS[id];
  if (!unitBlueprint) throw new Error(`Unknown unit blueprint: ${id}`);
  return unitBlueprint;
}

export function getUnitLocomotion(id: string): UnitLocomotion {
  return createUnitLocomotion(getUnitBlueprint(id).locomotion);
}

export function getAllUnitBlueprints(): UnitBlueprint[] {
  assertUnitTurretMountsResolved();
  return Object.values(UNIT_BLUEPRINTS);
}

// Normalized cost: total per-build cost / max total across buildables.
// "Total" is the sum across the three resource axes — gives a single
// scalar for UI rank/scale display while honouring per-resource costs.
let _costNormCache: { max: number } | null = null;

function totalCost(c: { energy: number; mana: number; metal: number }): number {
  return c.energy + c.mana + c.metal;
}

function getCostNorm(): { max: number } {
  if (_costNormCache) return _costNormCache;
  let max = 0;
  for (const id of BUILDABLE_UNIT_IDS) {
    const unitBlueprint = UNIT_BLUEPRINTS[id];
    if (!unitBlueprint) continue;
    const t = totalCost(unitBlueprint.cost);
    if (t > max) max = t;
  }
  _costNormCache = { max };
  return _costNormCache;
}

export function getNormalizedUnitCost(unitBlueprint: {
  cost: { energy: number; mana: number; metal: number };
}): number {
  const { max } = getCostNorm();
  return max > 0 ? totalCost(unitBlueprint.cost) / max : 0;
}
