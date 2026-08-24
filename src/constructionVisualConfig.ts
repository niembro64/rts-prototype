/** Shared construction visuals.
 *
 * These constants are for construction hardware, not shell bars:
 * These constants remain for legacy emitter geometry and construction-piece
 * hazard art. Live builders and factories emit work from host-authored points.
 */
import constructionVisualConfig from './constructionVisualConfig.json';
import { COLORS, readRgbTuple } from './colorsConfig';
import { BUILDING_BLUEPRINT_IDS } from './types/blueprintIds';

export type ConstructionHostMarkingAxis = 'up' | 'forward' | 'lateral';

/** Where a marking's coordinates live: 'chassis' profiles are in the
 *  host's body (radius-1) space and built by the chassis assemblers;
 *  'constructionArm' profiles are in the commander's construction-arm
 *  local space and built by the bot rig's tool assembler. */
export type ConstructionHostMarkingAttach = 'chassis' | 'constructionArm';

type ConstructionHostMarkingCenter = Readonly<{
  forward: number;
  up: number;
  lateral: number;
}>;

type ConstructionHostSleeveMarking = Readonly<{
  kind: 'sleeve';
  attach: ConstructionHostMarkingAttach;
  center: ConstructionHostMarkingCenter;
  axis: ConstructionHostMarkingAxis;
  radius: number;
  length: number;
  stripeCount: number;
}>;

type ConstructionHostPanelMarking = Readonly<{
  kind: 'panel';
  attach: ConstructionHostMarkingAttach;
  center: ConstructionHostMarkingCenter;
  axis: ConstructionHostMarkingAxis;
  width: number;
  height: number;
  stripeCount: number;
  mirrored: boolean;
}>;

type ConstructionHostRingBoxLod = Readonly<{
  chamferedHousing: boolean;
  topLatch: boolean;
  cornerFasteners: boolean;
}>;

type ConstructionHostRingBoxesMarking = Readonly<{
  kind: 'ringBoxes';
  attach: ConstructionHostMarkingAttach;
  center: ConstructionHostMarkingCenter;
  axis: ConstructionHostMarkingAxis;
  ringRadius: number;
  tubeRadius: number;
  boxCount: number;
  boxWidth: number;
  boxHeight: number;
  boxDepth: number;
  mountInset: number;
  cornerChamfer: number;
  faceWidth: number;
  faceHeight: number;
  faceLift: number;
  latchWidth: number;
  latchHeight: number;
  latchDepth: number;
  lod: Readonly<{
    high: ConstructionHostRingBoxLod;
    medium: ConstructionHostRingBoxLod;
    low: ConstructionHostRingBoxLod;
  }>;
  stripeCount: number;
}>;

export type ConstructionHostMarkingProfile =
  | ConstructionHostSleeveMarking
  | ConstructionHostPanelMarking
  | ConstructionHostRingBoxesMarking;

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function positiveEvenInteger(value: unknown, label: string): number {
  const number = positiveNumber(value, label);
  if (!Number.isInteger(number) || number < 4 || number % 2 !== 0) {
    throw new Error(`${label} must be an even integer of at least four`);
  }
  return number;
}

function markingAxis(value: unknown, label: string): ConstructionHostMarkingAxis {
  if (value !== 'up' && value !== 'forward' && value !== 'lateral') {
    throw new Error(`${label} must be "up", "forward", or "lateral"`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be boolean`);
  }
  return value;
}

function markingCenter(value: unknown, label: string): ConstructionHostMarkingCenter {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    forward: finiteNumber(raw.forward, `${label}.forward`),
    up: finiteNumber(raw.up, `${label}.up`),
    lateral: finiteNumber(raw.lateral, `${label}.lateral`),
  });
}

function ringBoxLod(value: unknown, label: string): ConstructionHostRingBoxLod {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    chamferedHousing: booleanValue(
      raw.chamferedHousing,
      `${label}.chamferedHousing`,
    ),
    topLatch: booleanValue(raw.topLatch, `${label}.topLatch`),
    cornerFasteners: booleanValue(
      raw.cornerFasteners,
      `${label}.cornerFasteners`,
    ),
  });
}

function markingAttach(
  value: unknown,
  label: string,
): ConstructionHostMarkingAttach {
  if (value === undefined) return 'chassis';
  if (value !== 'chassis' && value !== 'constructionArm') {
    throw new Error(`${label} must be "chassis" or "constructionArm"`);
  }
  return value;
}

function markingProfile(
  entityId: string,
  value: unknown,
  index: number,
): ConstructionHostMarkingProfile {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`constructionVisualConfig.hostMarkings.${entityId}[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const label = `constructionVisualConfig.hostMarkings.${entityId}[${index}]`;
  const attach = markingAttach(raw.attach, `${label}.attach`);
  const center = markingCenter(raw.center, `${label}.center`);
  const axis = markingAxis(raw.axis, `${label}.axis`);
  const stripeCount = positiveEvenInteger(raw.stripeCount, `${label}.stripeCount`);
  if (raw.kind === 'sleeve') {
    return Object.freeze({
      kind: 'sleeve',
      attach,
      center,
      axis,
      radius: positiveNumber(raw.radius, `${label}.radius`),
      length: positiveNumber(raw.length, `${label}.length`),
      stripeCount,
    });
  }
  if (raw.kind === 'panel') {
    const mirrored = booleanValue(raw.mirrored, `${label}.mirrored`);
    const normalOffset = axis === 'forward'
      ? center.forward
      : axis === 'up' ? center.up : center.lateral;
    if (mirrored && normalOffset === 0) {
      throw new Error(`${label}.mirrored requires a non-zero center offset on its normal axis`);
    }
    return Object.freeze({
      kind: 'panel',
      attach,
      center,
      axis,
      width: positiveNumber(raw.width, `${label}.width`),
      height: positiveNumber(raw.height, `${label}.height`),
      stripeCount,
      mirrored,
    });
  }
  if (raw.kind === 'ringBoxes') {
    const boxCount = positiveNumber(raw.boxCount, `${label}.boxCount`);
    if (!Number.isInteger(boxCount)) {
      throw new Error(`${label}.boxCount must be an integer`);
    }
    const tubeRadius = positiveNumber(raw.tubeRadius, `${label}.tubeRadius`);
    const boxWidth = positiveNumber(raw.boxWidth, `${label}.boxWidth`);
    const boxHeight = positiveNumber(raw.boxHeight, `${label}.boxHeight`);
    const boxDepth = positiveNumber(raw.boxDepth, `${label}.boxDepth`);
    const mountInset = positiveNumber(raw.mountInset, `${label}.mountInset`);
    const cornerChamfer = positiveNumber(raw.cornerChamfer, `${label}.cornerChamfer`);
    const faceWidth = positiveNumber(raw.faceWidth, `${label}.faceWidth`);
    const faceHeight = positiveNumber(raw.faceHeight, `${label}.faceHeight`);
    const latchWidth = positiveNumber(raw.latchWidth, `${label}.latchWidth`);
    const latchHeight = positiveNumber(raw.latchHeight, `${label}.latchHeight`);
    const latchDepth = positiveNumber(raw.latchDepth, `${label}.latchDepth`);
    if (typeof raw.lod !== 'object' || raw.lod === null) {
      throw new Error(`${label}.lod must be an object`);
    }
    const rawLod = raw.lod as Record<string, unknown>;
    const lod = Object.freeze({
      high: ringBoxLod(rawLod.high, `${label}.lod.high`),
      medium: ringBoxLod(rawLod.medium, `${label}.lod.medium`),
      low: ringBoxLod(rawLod.low, `${label}.lod.low`),
    });
    if (
      !lod.high.chamferedHousing ||
      !lod.high.topLatch ||
      !lod.high.cornerFasteners ||
      lod.medium.chamferedHousing ||
      !lod.medium.topLatch ||
      lod.medium.cornerFasteners ||
      lod.low.chamferedHousing ||
      lod.low.topLatch ||
      lod.low.cornerFasteners
    ) {
      throw new Error(
        `${label}.lod must strictly reduce high(chamfers+latch+fasteners) ` +
        'to medium(latch) to low(housing only)',
      );
    }
    if (boxHeight > tubeRadius * 2) {
      throw new Error(`${label}.boxHeight must fit on the host ring tube`);
    }
    if (mountInset >= boxDepth) {
      throw new Error(`${label}.mountInset must be smaller than boxDepth`);
    }
    if (cornerChamfer * 2 >= Math.min(boxWidth, boxHeight)) {
      throw new Error(`${label}.cornerChamfer must leave flat housing edges`);
    }
    if (
      faceWidth > boxWidth - cornerChamfer * 2 ||
      faceHeight > boxHeight - cornerChamfer * 2
    ) {
      throw new Error(`${label} striped face must fit inside the chamfered housing`);
    }
    if (
      latchWidth > boxWidth ||
      latchHeight >= boxHeight ||
      latchDepth > boxDepth
    ) {
      throw new Error(`${label} top latch must fit the housing`);
    }
    return Object.freeze({
      kind: 'ringBoxes',
      attach,
      center,
      axis,
      ringRadius: positiveNumber(raw.ringRadius, `${label}.ringRadius`),
      tubeRadius,
      boxCount,
      boxWidth,
      boxHeight,
      boxDepth,
      mountInset,
      cornerChamfer,
      faceWidth,
      faceHeight,
      faceLift: positiveNumber(raw.faceLift, `${label}.faceLift`),
      latchWidth,
      latchHeight,
      latchDepth,
      lod,
      stripeCount,
    });
  }
  throw new Error(`${label}.kind must be "sleeve", "panel", or "ringBoxes"`);
}

const rawHostMarkings = constructionVisualConfig.hostMarkings as Record<string, unknown>;

const stripeAngleDeg = finiteNumber(
  constructionVisualConfig.hostMarkingStyle.stripeAngleDeg,
  'constructionVisualConfig.hostMarkingStyle.stripeAngleDeg',
);
if (stripeAngleDeg !== 45) {
  throw new Error(
    `constructionVisualConfig.hostMarkingStyle.stripeAngleDeg must be exactly 45, got ${stripeAngleDeg}`,
  );
}

/** One construction-hazard grammar for both renderers. Stripe boundaries are
 * generated in physical surface coordinates at exactly 45 degrees. Cylinders
 * remain open-ended and circular hardware receives perimeter-mounted boxes
 * with striped tangent faces, so the colors can never form radial wedges or a
 * sunburst. */
export const CONSTRUCTION_HAZARD_MARKING_STYLE = Object.freeze({
  stripeAngleDeg: 45 as const,
  pylonStripeCount: positiveEvenInteger(
    constructionVisualConfig.hostMarkingStyle.pylonStripeCount,
    'constructionVisualConfig.hostMarkingStyle.pylonStripeCount',
  ),
});

/** Permanent yellow/black identity markings for every host that owns build
 * power — each host authors an ARRAY of markings so stripes can sit in
 * several interesting spots at once. Unit dimensions are in body-radius
 * units ('chassis' attach) or arm-local units ('constructionArm'). The
 * Fabricator torus uses its live ring radius as the unit scale, so the
 * same authored clamp-box profile drives the browser and native renderer
 * without restating placement numbers. */
function buildConstructionHostMarkingProfiles(): Readonly<
  Record<string, readonly ConstructionHostMarkingProfile[]>
> {
  const profiles = Object.fromEntries(
    Object.entries(rawHostMarkings).map(([entityId, value]) => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(
        `constructionVisualConfig.hostMarkings.${entityId} must be a non-empty array of markings`,
      );
    }
    return [
      entityId,
      Object.freeze(value.map((entry, index) => markingProfile(entityId, entry, index))),
    ];
    }),
  ) as Record<string, readonly ConstructionHostMarkingProfile[]>;
  const inherit = (targetId: string, sourceId: string): void => {
    const source = profiles[sourceId];
    if (source === undefined) {
      throw new Error(`construction marking source ${sourceId} is missing`);
    }
    profiles[targetId] = source;
  };
  for (const buildingBlueprintId of BUILDING_BLUEPRINT_IDS) {
    if (buildingBlueprintId.endsWith('Fabricator')) {
      inherit(
        buildingBlueprintId,
        buildingBlueprintId === 'towerFabricator' ||
        buildingBlueprintId === 'buildingAdvancedUniversalFabricator' ||
        buildingBlueprintId === 'buildingExperimentalUniversalFabricator'
          ? 'towerFabricator'
          : 'directionalFabricator',
      );
    }
  }
  // The directional profile is a shared authoring template, not a runtime
  // host. Its arrays have already been assigned to every specialist factory;
  // keep the exported registry an exact capability-derived host map.
  delete profiles.directionalFabricator;
  inherit('unitConstructionBot', 'unitCommander');
  inherit('unitConstructionRover', 'unitConstructionDrone');
  inherit('unitAdvancedConstructionBot', 'unitConstructionBot');
  inherit('unitAdvancedConstructionRover', 'unitConstructionRover');
  inherit('unitAdvancedConstructionDrone', 'unitConstructionDrone');
  inherit('unitAdvancedConstructionSubmarine', 'unitConstructionSubmarine');
  return Object.freeze(profiles);
}

export const CONSTRUCTION_HOST_MARKING_PROFILES = buildConstructionHostMarkingProfiles();

export function getConstructionHostMarkingProfiles(
  entityId: string,
): readonly ConstructionHostMarkingProfile[] {
  const authored = CONSTRUCTION_HOST_MARKING_PROFILES[entityId];
  return authored ?? [];
}

/** Standard construction hazard stripe palette. These are the same
 * yellow/black colors originally used by the commander's construction
 * turret material. Keep RGB and hex forms together so shader materials
 * and regular Three materials read from one documented source. */
export const CONSTRUCTION_HAZARD_COLORS = {
  yellowHex: COLORS.construction.hazardStripe.yellow.colorHex,
  blackHex: COLORS.construction.hazardStripe.black.colorHex,
  yellowRgb: readRgbTuple(
    COLORS.construction.hazardStripe.yellow.rgb01,
    'colorsConfig.construction.hazardStripe.yellow.rgb01',
  ),
  blackRgb: readRgbTuple(
    COLORS.construction.hazardStripe.black.rgb01,
    'colorsConfig.construction.hazardStripe.black.rgb01',
  ),
} as const;

/** BAR-faithful nanoframe/build-flow visual constants.
 *
 * Sourced from Beyond All Reason's construction rendering so the build
 * flow reads the same here:
 *  - ghostAlpha 0.24: a queued-but-unstarted build renders as the full
 *    team-tinted model at 24% alpha (BAR gfx_showbuilderqueue
 *    `shapeOpacity`).
 *  - bandExponents [3, 1.5, 0.7, 0.35]: the four rising height
 *    thresholds `pow(buildProgress, e)` of BAR's CUS GL4 nanoframe —
 *    finished material below the lowest band, team-pulse tint between
 *    bands, flat translucent team color above the highest.
 *  - topAlphaFloor 0.4: alpha floor of the not-yet-built top portion.
 *  - pulseRadPerSec 4.5 / pulseMaxGain 1.78: BAR's
 *    `sin(simFrame * 0.15)` at 30 sim-Hz pulsing team color 1.0x-1.78x.
 *  - scanLineHalfWidth: white glow band half-width (fraction of model
 *    height) around each threshold — BAR's climbing "scan lines".
 *  - worldGridCell: world-space construction lattice (this game's
 *    20-unit build grid stands in for BAR's 8-elmo lattice) and
 *    modelGridCellMax→Min: the model-space grid that shrinks 12→2 as
 *    progress rises; both fade out over the final `gridLastFraction`.
 */
function readBandExponents(raw: number[]): readonly [number, number, number, number] {
  if (raw.length !== 4) {
    throw new Error(
      `constructionVisualConfig.nanoframe.bandExponents must have exactly 4 entries, got ${raw.length}`,
    );
  }
  return [raw[0], raw[1], raw[2], raw[3]];
}

export const NANOFRAME_VISUAL_CONFIG = {
  ghostAlpha: constructionVisualConfig.nanoframe.ghostAlpha,
  ghostTeamMix: constructionVisualConfig.nanoframe.ghostTeamMix,
  topAlphaFloor: constructionVisualConfig.nanoframe.topAlphaFloor,
  bandExponents: readBandExponents(constructionVisualConfig.nanoframe.bandExponents),
  pulseRadPerSec: constructionVisualConfig.nanoframe.pulseRadPerSec,
  pulseMaxGain: constructionVisualConfig.nanoframe.pulseMaxGain,
  scanLineHalfWidth: constructionVisualConfig.nanoframe.scanLineHalfWidth,
  worldGridCell: constructionVisualConfig.nanoframe.worldGridCell,
  modelGridCellMax: constructionVisualConfig.nanoframe.modelGridCellMax,
  modelGridCellMin: constructionVisualConfig.nanoframe.modelGridCellMin,
  gridLastFraction: constructionVisualConfig.nanoframe.gridLastFraction,
  gridIntensity: constructionVisualConfig.nanoframe.gridIntensity,
  tintMix: constructionVisualConfig.nanoframe.tintMix,
} as const;
