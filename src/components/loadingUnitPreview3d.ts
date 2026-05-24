import { COLORS, cssHex } from '@/colorsConfig';
import { SHELL_PALE_HEX } from '@/shellConfig';
import type { BuildableUnitId } from '@/game/sim/blueprints';
import {
  BUILDABLE_UNIT_IDS,
  getUnitBlueprint,
} from '@/game/sim/blueprints';
import { createUnitRuntimeTurrets } from '@/game/sim/runtimeTurrets';
import {
  getBarrelOrbitAngle,
  getConeBarrelBaseOrbitRadius,
  getConeBarrelTipOrbitRadius,
  getSimpleMultiBarrelOrbitRadius,
  getTurretBarrelCenterToTipLength,
  getTurretBarrelDiameter,
  getTurretHeadRadius,
} from '@/game/math';
import {
  TREAD_CHASSIS_LIFT_Y,
  getChassisLiftY,
  getSegmentMidYAt,
  getTurretRootY,
} from '@/game/math/BodyDimensions';
import { resolveMirroredLegConfigs } from '@/game/math/LegLayout';
import type {
  FlyingConfig,
  HoverConfig,
  UnitBlueprint,
  UnitBodyShape,
  UnitBodyShapePart,
} from '@/types/blueprints';
import type { Turret } from '@/game/sim/types';

export type LoadingUnitPreviewSelection = {
  id: BuildableUnitId;
  name: string;
};

export type LoadingUnitPreviewRuntime = {
  destroy: () => void;
};

export type LoadingUnitPreviewOptions = {
  fullBleed?: boolean;
};

type Vec3 = { x: number; y: number; z: number };

type Bounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type BuildContext = {
  root: HTMLElement;
  bounds: Bounds;
};

const SHELL_COLOR = cssHex(SHELL_PALE_HEX);
const SHELL_OPACITY = COLORS.construction.shell.pale.opacity;
const CYLINDER_SEGMENTS = 14;
const SPHERE_SLICES = 6;
const TREAD_CLEAT_HEIGHT = 1.1;
const TREAD_CLEAT_WIDTH_FRAC = 1.0;
const TREAD_CLEAT_LENGTH_FRAC = 0.36;

const EMPTY_BOUNDS: Bounds = {
  minX: Infinity,
  minY: Infinity,
  minZ: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
  maxZ: -Infinity,
};

export function pickRandomLoadingUnit(): LoadingUnitPreviewSelection {
  const unitIds = BUILDABLE_UNIT_IDS;
  const selected = unitIds[Math.floor(Math.random() * unitIds.length)] ?? unitIds[0];
  const blueprint = getUnitBlueprint(selected);
  return { id: selected, name: blueprint.name };
}

export function mountLoadingUnitPreview(
  host: HTMLElement,
  unitId: BuildableUnitId,
  options: LoadingUnitPreviewOptions = {},
): LoadingUnitPreviewRuntime {
  const fullBleed = options.fullBleed === true;
  const stage = document.createElement('div');
  stage.className = `loader-css-unit-stage${fullBleed ? ' full-bleed' : ''}`;
  stage.style.setProperty('--loader-shell-color', SHELL_COLOR);
  stage.style.setProperty('--loader-shell-opacity', String(SHELL_OPACITY));

  const camera = document.createElement('div');
  camera.className = 'loader-css-unit-camera';
  const spinRoot = document.createElement('div');
  spinRoot.className = 'loader-css-unit-spin';
  const modelRoot = document.createElement('div');
  modelRoot.className = 'loader-css-unit-model';

  spinRoot.appendChild(modelRoot);
  camera.appendChild(spinRoot);
  stage.appendChild(camera);
  host.appendChild(stage);

  const bounds = buildLoadingUnitModel(modelRoot, unitId);
  centerModel(modelRoot, bounds);

  let destroyed = false;
  const resize = (): void => {
    if (destroyed) return;
    fitCssCamera(camera, host, bounds, fullBleed);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  return {
    destroy: () => {
      destroyed = true;
      resizeObserver.disconnect();
      if (stage.parentElement === host) host.removeChild(stage);
    },
  };
}

function buildLoadingUnitModel(parent: HTMLElement, unitId: BuildableUnitId): Bounds {
  const blueprint = getUnitBlueprint(unitId);
  const ctx: BuildContext = {
    root: parent,
    bounds: { ...EMPTY_BOUNDS },
  };
  const radius = blueprint.radius.body;
  const chassisLift = getChassisLiftY(blueprint, radius);

  buildPreviewLocomotion(ctx, blueprint, radius);
  buildPreviewBody(ctx, blueprint.bodyShape, radius, chassisLift);
  buildPreviewTurrets(ctx, blueprint, unitId, radius, chassisLift);

  return normalizeBounds(ctx.bounds);
}

function buildPreviewBody(
  ctx: BuildContext,
  bodyShape: UnitBodyShape,
  radius: number,
  chassisLift: number,
): void {
  const addPart = (part: UnitBodyShapePart): void => {
    const x = part.offsetForward * radius;
    const z = (part.offsetLateral ?? 0) * radius;
    if (part.kind === 'circle') {
      const ry = (part.yFrac ?? part.radiusFrac) * radius;
      addSphere(ctx, {
        x,
        y: chassisLift + (part.centerYFrac ?? (part.yFrac ?? part.radiusFrac)) * radius,
        z,
      }, {
        x: part.radiusFrac * radius,
        y: ry,
        z: part.radiusFrac * radius,
      });
      return;
    }
    if (part.kind === 'oval') {
      addSphere(ctx, {
        x,
        y: chassisLift + part.yFrac * radius,
        z,
      }, {
        x: part.xFrac * radius,
        y: part.yFrac * radius,
        z: part.zFrac * radius,
      });
      return;
    }
    if (part.kind === 'cone') {
      addConeX(ctx, {
        x,
        y: chassisLift + (part.centerYFrac ?? part.radiusFrac) * radius,
        z,
      }, part.lengthFrac * radius, part.radiusFrac * radius);
      return;
    }
    addCylinderX(ctx, {
      x,
      y: chassisLift + (part.centerYFrac ?? part.radiusFrac) * radius,
      z,
    }, part.lengthFrac * radius, part.radiusFrac * radius, part.pitchRad ?? 0);
  };

  if (bodyShape.kind === 'composite') {
    for (const part of bodyShape.parts) addPart(part);
    return;
  }
  if (bodyShape.kind === 'circle') {
    const ry = (bodyShape.yFrac ?? bodyShape.radiusFrac) * radius;
    addSphere(ctx, {
      x: 0,
      y: chassisLift + ry,
      z: 0,
    }, {
      x: bodyShape.radiusFrac * radius,
      y: ry,
      z: bodyShape.radiusFrac * radius,
    });
    return;
  }
  if (bodyShape.kind === 'oval') {
    addSphere(ctx, {
      x: 0,
      y: chassisLift + bodyShape.yFrac * radius,
      z: 0,
    }, {
      x: bodyShape.xFrac * radius,
      y: bodyShape.yFrac * radius,
      z: bodyShape.zFrac * radius,
    });
    return;
  }
  if (bodyShape.kind === 'rect') {
    addBox(ctx, {
      x: 0,
      y: chassisLift + bodyShape.heightFrac * radius * 0.5,
      z: 0,
    }, {
      x: bodyShape.lengthFrac * radius * 2,
      y: bodyShape.heightFrac * radius,
      z: bodyShape.widthFrac * radius * 2,
    });
    return;
  }
  if (bodyShape.kind === 'rhombus') {
    addPrismFromVertices(ctx, [
      { x: bodyShape.lengthFrac * radius, z: 0 },
      { x: 0, z: bodyShape.widthFrac * radius },
      { x: -bodyShape.lengthFrac * radius, z: 0 },
      { x: 0, z: -bodyShape.widthFrac * radius },
    ], chassisLift, bodyShape.heightFrac * radius);
    return;
  }
  addRegularPrism(
    ctx,
    bodyShape.sides,
    bodyShape.radiusFrac * radius,
    bodyShape.radiusFrac * radius,
    chassisLift,
    bodyShape.heightFrac * radius,
    bodyShape.rotation,
  );
}

function buildPreviewTurrets(
  ctx: BuildContext,
  blueprint: UnitBlueprint,
  unitId: BuildableUnitId,
  radius: number,
  chassisLift: number,
): void {
  const turrets = createUnitRuntimeTurrets(unitId, radius);
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const mount = blueprint.turrets[i];
    const rootY = chassisLift + getTurretRootY(
      blueprint.bodyShape,
      radius,
      turret.mount.x,
      turret.mount.y,
      getTurretHeadRadius(turret.config),
      mount,
    );
    buildTurret(ctx, turret, {
      x: turret.mount.x,
      y: rootY,
      z: turret.mount.y,
    });
  }
}

function buildTurret(ctx: BuildContext, turret: Turret, root: Vec3): void {
  const barrel = turret.config.barrel;
  const isForceField = barrel?.type === 'complexSingleEmitter';
  const headRadius = getTurretHeadRadius(turret.config);

  if (turret.config.constructionEmitter) {
    buildConstructionEmitter(ctx, root, turret);
    return;
  }
  if (!isForceField) {
    addSphere(ctx, {
      x: root.x,
      y: root.y + headRadius,
      z: root.z,
    }, {
      x: headRadius,
      y: headRadius,
      z: headRadius,
    });
  }
  if (!barrel || isForceField || turret.config.headOnly) return;

  const length = getTurretBarrelCenterToTipLength(turret.config);
  if (length < 1e-4) return;
  const barrelRadius = getTurretBarrelDiameter(turret.config) * 0.5;
  const barrelY = root.y + headRadius;
  const addBarrel = (
    baseX: number,
    baseY: number,
    baseZ: number,
    tipX: number,
    tipY: number,
    tipZ: number,
  ): void => {
    addCylinderBetween(
      ctx,
      { x: root.x + baseX, y: barrelY + baseY, z: root.z + baseZ },
      { x: root.x + tipX, y: barrelY + tipY, z: root.z + tipZ },
      barrelRadius,
      barrel.type === 'singleConeBarrel',
    );
  };

  if (barrel.type === 'singleCylinderBarrel' || barrel.type === 'singleConeBarrel') {
    addBarrel(0, 0, 0, length, 0, 0);
  } else if (barrel.type === 'simpleMultiBarrel') {
    const orbitR = getSimpleMultiBarrelOrbitRadius(barrel, headRadius);
    for (let i = 0; i < barrel.barrelCount; i++) {
      const a = getBarrelOrbitAngle(i, barrel.barrelCount);
      const oy = Math.cos(a) * orbitR;
      const oz = Math.sin(a) * orbitR;
      addBarrel(0, oy, oz, length, oy, oz);
    }
  } else if (barrel.type === 'coneMultiBarrel') {
    const baseOrbitR = getConeBarrelBaseOrbitRadius(barrel, headRadius);
    const tipOrbitR = getConeBarrelTipOrbitRadius(
      barrel,
      headRadius,
      length,
      turret.config.spread?.angle,
    );
    for (let i = 0; i < barrel.barrelCount; i++) {
      const a = getBarrelOrbitAngle(i, barrel.barrelCount);
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      addBarrel(
        0, cosA * baseOrbitR, sinA * baseOrbitR,
        length, cosA * tipOrbitR, sinA * tipOrbitR,
      );
    }
  }
}

function buildConstructionEmitter(ctx: BuildContext, root: Vec3, turret: Turret): void {
  const spec = turret.config.constructionEmitter;
  if (!spec) return;
  const dims = spec.sizes[turret.config.visualVariant ?? spec.defaultSize];
  if (!dims) return;
  const style = dims.towerSize === 'large'
    ? { baseRadiusMult: 2.85, baseHeightMult: 1.45, bandRadiusMult: 2.55, bandHeightMult: 0.95, capRadiusMult: 1.65 }
    : { baseRadiusMult: 2.55, baseHeightMult: 1.25, bandRadiusMult: 2.25, bandHeightMult: 0.78, capRadiusMult: 1.55 };

  for (let i = 0; i < 2; i++) {
    const a = (i / 2) * Math.PI * 2;
    const x = root.x + Math.cos(a) * dims.pylonOffset;
    const z = root.z + Math.sin(a) * dims.pylonOffset;
    const baseRadius = dims.innerPylonRadius * style.baseRadiusMult;
    const baseHeight = Math.max(1.2, dims.innerPylonRadius * style.baseHeightMult);
    const bandRadius = dims.innerPylonRadius * style.bandRadiusMult;
    const bandHeight = Math.max(1.0, dims.innerPylonRadius * style.bandHeightMult);
    const capRadius = Math.max(1.35, dims.innerPylonRadius * style.capRadiusMult);
    addCylinderY(ctx, { x, y: root.y + baseHeight * 0.5, z }, baseHeight, baseRadius, 6);
    addCylinderY(ctx, { x, y: root.y + baseHeight + bandHeight * 0.5, z }, bandHeight, bandRadius, 6);
    addCylinderY(ctx, { x, y: root.y + dims.pylonHeight * 0.5, z }, dims.pylonHeight, dims.innerPylonRadius);
    addSphere(ctx, {
      x,
      y: root.y + dims.pylonHeight + capRadius * 0.36,
      z,
    }, {
      x: capRadius,
      y: capRadius,
      z: capRadius,
    });
  }
}

function buildPreviewLocomotion(
  ctx: BuildContext,
  blueprint: UnitBlueprint,
  radius: number,
): void {
  const locomotion = blueprint.locomotion;
  switch (locomotion.type) {
    case 'wheels':
      buildCssWheels(ctx, radius, locomotion.config);
      return;
    case 'treads':
      buildCssTreads(ctx, radius, locomotion.config);
      return;
    case 'hover':
      buildCssHoverFans(ctx, radius, locomotion.config);
      return;
    case 'flying':
      buildCssFlyingRig(ctx, radius, locomotion.config);
      return;
    case 'legs':
      buildCssLegs(ctx, blueprint, radius);
      return;
  }
}

function buildCssWheels(
  ctx: BuildContext,
  radius: number,
  cfg: UnitBlueprint['locomotion'] extends infer L
    ? L extends { type: 'wheels'; config: infer C } ? C : never
    : never,
): void {
  const wheelR = Math.max(1, radius * cfg.wheelRadius);
  const tireWidth = Math.max(0.5, radius * cfg.treadWidth);
  const fx = radius * cfg.wheelDistX;
  const fz = radius * cfg.wheelDistY;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addCylinderZ(ctx, { x: sx * fx, y: wheelR, z: sz * fz }, tireWidth, wheelR);
    }
  }
}

function buildCssTreads(
  ctx: BuildContext,
  radius: number,
  cfg: UnitBlueprint['locomotion'] extends infer L
    ? L extends { type: 'treads'; config: infer C } ? C : never
    : never,
): void {
  const length = radius * cfg.treadLength;
  const width = radius * cfg.treadWidth;
  const offset = radius * cfg.treadOffset;
  const treadRadius = Math.min(TREAD_CHASSIS_LIFT_Y / 2, Math.max(1, length / 2));
  const straightLength = Math.max(1, length - 2 * treadRadius);
  const halfStraight = straightLength / 2;
  const treadY = TREAD_CHASSIS_LIFT_Y / 2;
  const wheelCount = Math.max(2, Math.round(cfg.treadLength * 2));
  const wheelR = Math.max(1, radius * cfg.wheelRadius);
  const arcLength = Math.PI * treadRadius;
  const cleatLoopLength = 2 * straightLength + 2 * arcLength;
  const cleatCount = Math.max(8, Math.round(cleatLoopLength / Math.max(1, radius * 0.26)));
  const cleatSpacing = cleatLoopLength / cleatCount;
  const cleatLen = cleatSpacing * TREAD_CLEAT_LENGTH_FRAC;
  const cleatWidth = width * TREAD_CLEAT_WIDTH_FRAC;

  for (const side of [-1, 1]) {
    const sideZ = side * offset;
    addBox(ctx, { x: 0, y: treadY, z: sideZ }, {
      x: straightLength,
      y: TREAD_CHASSIS_LIFT_Y,
      z: width,
    });
    for (const end of [-1, 1]) {
      addCylinderZ(ctx, {
        x: end * halfStraight,
        y: treadY,
        z: sideZ,
      }, width, treadRadius);
    }
    for (let i = 0; i < wheelCount; i++) {
      const t = (i + 0.5) / wheelCount;
      const x = -length / 2 + t * length;
      addCylinderZ(ctx, { x, y: treadY, z: sideZ }, width * 1.05, wheelR);
    }
    for (let i = 0; i <= cleatCount; i++) {
      const cleat = layoutTreadCleat(i * cleatSpacing, straightLength, treadRadius);
      addBox(ctx, {
        x: cleat.x,
        y: cleat.y,
        z: sideZ,
      }, {
        x: cleatLen,
        y: TREAD_CLEAT_HEIGHT,
        z: cleatWidth,
      }, { z: cleat.angle });
    }
  }
}

function buildCssHoverFans(ctx: BuildContext, radius: number, cfg: HoverConfig): void {
  const mainFanRadius = Math.max(1, radius * cfg.fanRadius);
  const mainRingTubeRadius = Math.max(0.35, radius * cfg.fanRingTubeRadius);
  const useDragonflyLayout = cfg.tailFanOffsetX !== undefined;
  const hasTailFan = useDragonflyLayout && cfg.tailFanRadius !== undefined && cfg.tailFanRadius > 0;
  const positions: Array<{ x: number; z: number; fanRadius: number; tubeRadius: number }> = [];

  if (useDragonflyLayout) {
    const lateral = radius * cfg.fanDistY;
    positions.push(
      { x: 0, z: -lateral, fanRadius: mainFanRadius, tubeRadius: mainRingTubeRadius },
      { x: 0, z: lateral, fanRadius: mainFanRadius, tubeRadius: mainRingTubeRadius },
    );
    if (hasTailFan) {
      positions.push({
        x: radius * (cfg.tailFanOffsetX ?? 0),
        z: 0,
        fanRadius: Math.max(0.6, radius * cfg.tailFanRadius!),
        tubeRadius: Math.max(0.18, radius * (cfg.tailFanRingTubeRadius ?? cfg.fanRingTubeRadius)),
      });
    }
  } else if (cfg.fanLayout === 'triFront') {
    const fanDist = radius * Math.hypot(cfg.fanDistX, cfg.fanDistY);
    for (const angle of [-Math.PI / 3, Math.PI / 3, Math.PI]) {
      positions.push({
        x: Math.cos(angle) * fanDist,
        z: Math.sin(angle) * fanDist,
        fanRadius: mainFanRadius,
        tubeRadius: mainRingTubeRadius,
      });
    }
  } else {
    const fx = radius * cfg.fanDistX;
    const fz = radius * cfg.fanDistY;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        positions.push({
          x: sx * fx,
          z: sz * fz,
          fanRadius: mainFanRadius,
          tubeRadius: mainRingTubeRadius,
        });
      }
    }
  }

  for (const pos of positions) {
    addRing(ctx, { x: pos.x, y: -Math.max(0.4, pos.tubeRadius * 0.9), z: pos.z }, pos.fanRadius, pos.tubeRadius);
    addSphere(ctx, { x: pos.x, y: -Math.max(0.4, pos.tubeRadius * 0.9), z: pos.z }, {
      x: pos.fanRadius * 0.22,
      y: pos.fanRadius * 0.22,
      z: pos.fanRadius * 0.22,
    });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      addBox(ctx, {
        x: pos.x + Math.cos(a) * pos.fanRadius * 0.44,
        y: -Math.max(0.4, pos.tubeRadius * 0.9),
        z: pos.z + Math.sin(a) * pos.fanRadius * 0.44,
      }, {
        x: pos.fanRadius * 0.7,
        y: Math.max(0.14, pos.tubeRadius * 0.32),
        z: Math.max(0.55, pos.fanRadius * 0.2),
      }, { y: -a });
    }
  }
}

function buildCssFlyingRig(ctx: BuildContext, radius: number, cfg: FlyingConfig): void {
  const addWingPanels = (opts: {
    spanFrac: number;
    chordFrac: number;
    offsetXFrac: number;
    heightFrac: number;
    thicknessFrac: number;
    dihedralDeg: number;
    mirrorX: boolean;
  }): void => {
    const chord = radius * opts.chordFrac;
    const thickness = radius * opts.thicknessFrac;
    const sideSpan = radius * opts.spanFrac;
    const x = radius * opts.offsetXFrac;
    const y = radius * opts.heightFrac;
    const dihedral = opts.dihedralDeg * Math.PI / 180;
    for (const side of [-1, 1]) {
      addBox(ctx, {
        x: x + (opts.mirrorX ? -chord * 0.12 : chord * 0.12),
        y,
        z: side * sideSpan * 0.5,
      }, {
        x: chord,
        y: thickness,
        z: sideSpan,
      }, { x: side * dihedral, y: opts.mirrorX ? Math.PI : 0 });
    }
  };

  if (
    cfg.wingEnabled !== false &&
    cfg.wingSpan !== undefined &&
    cfg.wingChord !== undefined &&
    cfg.wingOffsetX !== undefined &&
    cfg.wingHeight !== undefined
  ) {
    addWingPanels({
      spanFrac: cfg.wingSpan,
      chordFrac: cfg.wingChord,
      offsetXFrac: cfg.wingOffsetX,
      heightFrac: cfg.wingHeight,
      thicknessFrac: cfg.wingThickness ?? 0.04,
      dihedralDeg: cfg.wingDihedralDeg ?? 0,
      mirrorX: false,
    });
  }
  if (
    cfg.tailWingSpan !== undefined &&
    cfg.tailWingChord !== undefined &&
    cfg.tailWingOffsetX !== undefined &&
    cfg.tailWingHeight !== undefined
  ) {
    addWingPanels({
      spanFrac: cfg.tailWingSpan,
      chordFrac: cfg.tailWingChord,
      offsetXFrac: cfg.tailWingOffsetX,
      heightFrac: cfg.tailWingHeight,
      thicknessFrac: cfg.tailWingThickness ?? cfg.wingThickness ?? 0.04,
      dihedralDeg: cfg.tailWingDihedralDeg ?? 0,
      mirrorX: cfg.tailWingMirrorX ?? false,
    });
  }

  const jetRadius = Math.max(0.4, radius * cfg.jetRadius);
  const jetLength = Math.max(1, radius * cfg.jetLength);
  const jetX = radius * cfg.jetOffsetX;
  const jetY = radius * cfg.jetOffsetZ;
  const jetZ = radius * cfg.jetOffsetY;
  const jetLateralOffsets = cfg.jetCount === 1 ? [0] : [-jetZ, jetZ];
  for (const lateralOffset of jetLateralOffsets) {
    addCylinderX(ctx, { x: jetX, y: jetY, z: lateralOffset }, jetLength, jetRadius);
  }
}

function buildCssLegs(ctx: BuildContext, blueprint: UnitBlueprint, radius: number): void {
  if (blueprint.locomotion.type !== 'legs') return;
  const chassisLift = getChassisLiftY(blueprint, radius);
  const { all: legs } = resolveMirroredLegConfigs(blueprint.locomotion.config, radius);
  const upperThickness = Math.max(blueprint.locomotion.config.upperThickness, 1) * 0.6;
  const lowerThickness = Math.max(blueprint.locomotion.config.lowerThickness, 1) * 0.6;

  for (const leg of legs) {
    const hipY = blueprint.legAttachHeightFrac !== null
      ? blueprint.legAttachHeightFrac * radius
      : chassisLift + getSegmentMidYAt(blueprint.bodyShape, radius, leg.attachOffsetX);
    const totalLength = leg.upperLegLength + leg.lowerLegLength;
    const restDistance = totalLength * leg.snapDistanceMultiplier;
    const hip = { x: leg.attachOffsetX, y: hipY, z: leg.attachOffsetY };
    const foot = {
      x: leg.attachOffsetX + Math.cos(leg.snapTargetAngle) * restDistance,
      y: 0.8,
      z: leg.attachOffsetY + Math.sin(leg.snapTargetAngle) * restDistance,
    };
    const knee = kneeFromIK(
      hip.x, hip.y, hip.z,
      foot.x, foot.y, foot.z,
      leg.upperLegLength,
      leg.lowerLegLength,
      0, 1, 0,
    );
    addCylinderBetween(ctx, hip, knee, upperThickness);
    addCylinderBetween(ctx, knee, foot, lowerThickness);
    addSphere(ctx, hip, {
      x: Math.max(1, blueprint.locomotion.config.hipRadius),
      y: Math.max(1, blueprint.locomotion.config.hipRadius),
      z: Math.max(1, blueprint.locomotion.config.hipRadius),
    });
    addSphere(ctx, knee, {
      x: Math.max(1, blueprint.locomotion.config.kneeRadius),
      y: Math.max(1, blueprint.locomotion.config.kneeRadius),
      z: Math.max(1, blueprint.locomotion.config.kneeRadius),
    });
    addSphere(ctx, foot, {
      x: Math.max(1.1, lowerThickness * 1.2),
      y: Math.max(1.1, lowerThickness * 1.2),
      z: Math.max(1.1, lowerThickness * 1.2),
    });
  }
}

function addBox(
  ctx: BuildContext,
  center: Vec3,
  size: Vec3,
  rotation: Partial<Vec3> = {},
): HTMLElement {
  const piece = createPiece('loader-css-unit-box', center, rotation);
  addFace(piece, size.x, size.y, `translateZ(${size.z / 2}px)`);
  addFace(piece, size.x, size.y, `rotateY(180deg) translateZ(${size.z / 2}px)`);
  addFace(piece, size.z, size.y, `rotateY(90deg) translateZ(${size.x / 2}px)`);
  addFace(piece, size.z, size.y, `rotateY(-90deg) translateZ(${size.x / 2}px)`);
  addFace(piece, size.x, size.z, `rotateX(90deg) translateZ(${size.y / 2}px)`);
  addFace(piece, size.x, size.z, `rotateX(-90deg) translateZ(${size.y / 2}px)`);
  ctx.root.appendChild(piece);
  includeBoxBounds(ctx.bounds, center, size, rotation);
  return piece;
}

function addSphere(ctx: BuildContext, center: Vec3, radius: Vec3): HTMLElement {
  const piece = createPiece('loader-css-unit-sphere', center);
  piece.style.transform += ` scale3d(${radius.x}, ${radius.y}, ${radius.z})`;
  for (let i = 0; i < SPHERE_SLICES; i++) {
    const angle = (i / SPHERE_SLICES) * 180;
    addFace(piece, 2, 2, `rotateY(${angle}deg)`, 'loader-css-unit-sphere-slice');
  }
  addFace(piece, 2, 2, 'rotateX(90deg)', 'loader-css-unit-sphere-slice');
  addFace(piece, 2, 2, 'rotateX(-90deg)', 'loader-css-unit-sphere-slice');
  ctx.root.appendChild(piece);
  includeAabb(ctx.bounds, {
    minX: center.x - radius.x,
    maxX: center.x + radius.x,
    minY: center.y - radius.y,
    maxY: center.y + radius.y,
    minZ: center.z - radius.z,
    maxZ: center.z + radius.z,
  });
  return piece;
}

function addCylinderX(
  ctx: BuildContext,
  center: Vec3,
  length: number,
  radius: number,
  pitchRad = 0,
  segments = CYLINDER_SEGMENTS,
): HTMLElement {
  return addCylinderPrimitive(ctx, center, length, radius, {
    x: 0,
    y: 0,
    z: pitchRad,
  }, false, segments);
}

function addConeX(ctx: BuildContext, center: Vec3, length: number, radius: number): HTMLElement {
  return addCylinderPrimitive(ctx, center, length, radius, {}, true, CYLINDER_SEGMENTS);
}

function addCylinderY(
  ctx: BuildContext,
  center: Vec3,
  length: number,
  radius: number,
  segments = CYLINDER_SEGMENTS,
): HTMLElement {
  return addCylinderBetween(
    ctx,
    { x: center.x, y: center.y - length / 2, z: center.z },
    { x: center.x, y: center.y + length / 2, z: center.z },
    radius,
    false,
    segments,
  );
}

function addCylinderZ(
  ctx: BuildContext,
  center: Vec3,
  length: number,
  radius: number,
  segments = CYLINDER_SEGMENTS,
): HTMLElement {
  return addCylinderBetween(
    ctx,
    { x: center.x, y: center.y, z: center.z - length / 2 },
    { x: center.x, y: center.y, z: center.z + length / 2 },
    radius,
    false,
    segments,
  );
}

function addCylinderBetween(
  ctx: BuildContext,
  start: Vec3,
  end: Vec3,
  radius: number,
  cone = false,
  segments = CYLINDER_SEGMENTS,
): HTMLElement {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-4) return document.createElement('div');
  const center = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
    z: (start.z + end.z) / 2,
  };
  const cssDir = normalize({ x: dx, y: -dy, z: dz });
  const rotation = rotationFromCssXAxis(cssDir);
  const piece = addCylinderPrimitive(ctx, center, length, radius, {}, cone, segments, rotation, false);
  includeAabb(ctx.bounds, {
    minX: Math.min(start.x, end.x) - radius,
    maxX: Math.max(start.x, end.x) + radius,
    minY: Math.min(start.y, end.y) - radius,
    maxY: Math.max(start.y, end.y) + radius,
    minZ: Math.min(start.z, end.z) - radius,
    maxZ: Math.max(start.z, end.z) + radius,
  });
  return piece;
}

function addCylinderPrimitive(
  ctx: BuildContext,
  center: Vec3,
  length: number,
  radius: number,
  rotation: Partial<Vec3> = {},
  cone = false,
  segments = CYLINDER_SEGMENTS,
  rotate3d = '',
  includePrimitiveBounds = true,
): HTMLElement {
  const piece = createPiece(
    cone ? 'loader-css-unit-cylinder loader-css-unit-cone' : 'loader-css-unit-cylinder',
    center,
    rotation,
    rotate3d,
  );
  const sideWidth = Math.max(0.1, 2 * radius * Math.tan(Math.PI / segments));
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * 360;
    addFace(
      piece,
      length,
      sideWidth,
      `rotateX(${angle}deg) translateZ(${radius}px)`,
      cone ? 'loader-css-unit-cone-side' : 'loader-css-unit-cylinder-side',
    );
  }
  addFace(
    piece,
    radius * 2,
    radius * 2,
    `translateX(${length / 2}px) rotateY(90deg)`,
    'loader-css-unit-cylinder-cap',
  );
  if (!cone) {
    addFace(
      piece,
      radius * 2,
      radius * 2,
      `translateX(${-length / 2}px) rotateY(-90deg)`,
      'loader-css-unit-cylinder-cap',
    );
  }
  ctx.root.appendChild(piece);
  if (includePrimitiveBounds) {
    includeBoxBounds(ctx.bounds, center, { x: length, y: radius * 2, z: radius * 2 }, rotation);
  }
  return piece;
}

function addRing(ctx: BuildContext, center: Vec3, radius: number, tubeRadius: number): HTMLElement {
  const piece = createPiece('loader-css-unit-ring', center, { x: Math.PI / 2 });
  piece.style.width = `${radius * 2}px`;
  piece.style.height = `${radius * 2}px`;
  piece.style.marginLeft = `${-radius}px`;
  piece.style.marginTop = `${-radius}px`;
  piece.style.borderWidth = `${Math.max(1, tubeRadius)}px`;
  ctx.root.appendChild(piece);
  includeAabb(ctx.bounds, {
    minX: center.x - radius - tubeRadius,
    maxX: center.x + radius + tubeRadius,
    minY: center.y - tubeRadius,
    maxY: center.y + tubeRadius,
    minZ: center.z - radius - tubeRadius,
    maxZ: center.z + radius + tubeRadius,
  });
  return piece;
}

function addRegularPrism(
  ctx: BuildContext,
  sides: number,
  radiusX: number,
  radiusZ: number,
  baseY: number,
  height: number,
  rotation = 0,
): void {
  const verts: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    verts.push({ x: Math.cos(a) * radiusX, z: Math.sin(a) * radiusZ });
  }
  addPrismFromVertices(ctx, verts, baseY, height);
}

function addPrismFromVertices(
  ctx: BuildContext,
  verts: Array<{ x: number; z: number }>,
  baseY: number,
  height: number,
): void {
  const group = document.createElement('div');
  group.className = 'loader-css-unit-piece loader-css-unit-prism';
  group.style.transform = cssTranslate({ x: 0, y: baseY + height / 2, z: 0 });
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const edgeLength = Math.hypot(b.x - a.x, b.z - a.z);
    const edgeAngle = Math.atan2(b.z - a.z, b.x - a.x);
    const normalAngle = edgeAngle - Math.PI / 2;
    const face = document.createElement('div');
    face.className = 'loader-css-unit-face loader-css-unit-prism-side';
    face.style.width = `${edgeLength}px`;
    face.style.height = `${height}px`;
    face.style.marginLeft = `${-edgeLength / 2}px`;
    face.style.marginTop = `${-height / 2}px`;
    face.style.transform = `${cssTranslate({ x: mid.x, y: 0, z: mid.z })} rotateY(${-normalAngle}rad)`;
    group.appendChild(face);
  }
  ctx.root.appendChild(group);
  const xs = verts.map((v) => v.x);
  const zs = verts.map((v) => v.z);
  includeAabb(ctx.bounds, {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: baseY,
    maxY: baseY + height,
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  });
}

function createPiece(
  className: string,
  center: Vec3,
  rotation: Partial<Vec3> = {},
  rotate3d = '',
): HTMLElement {
  const piece = document.createElement('div');
  piece.className = `loader-css-unit-piece ${className}`;
  const transforms = [cssTranslate(center)];
  if (rotate3d) transforms.push(rotate3d);
  if (rotation.x) transforms.push(`rotateX(${-rotation.x}rad)`);
  if (rotation.y) transforms.push(`rotateY(${-rotation.y}rad)`);
  if (rotation.z) transforms.push(`rotateZ(${-rotation.z}rad)`);
  piece.style.transform = transforms.join(' ');
  return piece;
}

function addFace(
  parent: HTMLElement,
  width: number,
  height: number,
  transform: string,
  extraClass = '',
): HTMLElement {
  const face = document.createElement('div');
  face.className = `loader-css-unit-face${extraClass ? ` ${extraClass}` : ''}`;
  face.style.width = `${width}px`;
  face.style.height = `${height}px`;
  face.style.marginLeft = `${-width / 2}px`;
  face.style.marginTop = `${-height / 2}px`;
  face.style.transform = transform;
  parent.appendChild(face);
  return face;
}

function fitCssCamera(
  camera: HTMLElement,
  host: HTMLElement,
  bounds: Bounds,
  fullBleed: boolean,
): void {
  const rect = host.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const aspect = width / height;
  const sizeX = bounds.maxX - bounds.minX;
  const sizeY = bounds.maxY - bounds.minY;
  const sizeZ = bounds.maxZ - bounds.minZ;
  const yawSafeWidth = Math.max(1, Math.hypot(sizeX, sizeZ));
  const projectedHeight = Math.max(1, sizeY + yawSafeWidth * (aspect < 0.75 ? 0.28 : 0.14));
  const usableWidth = width * (fullBleed ? 0.94 : 0.84);
  const usableHeight = height * (fullBleed ? (aspect < 0.75 ? 0.5 : 0.68) : 0.78);
  const scale = Math.max(
    0.2,
    Math.min(usableWidth / yawSafeWidth, usableHeight / projectedHeight),
  );
  const anchorY = fullBleed
    ? (aspect < 0.75 ? 0.48 : 0.39)
    : 0.47;
  camera.style.setProperty('--loader-css-unit-scale', scale.toFixed(4));
  camera.style.setProperty('--loader-css-anchor-y', `${(anchorY * 100).toFixed(2)}%`);
}

function centerModel(modelRoot: HTMLElement, bounds: Bounds): void {
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
  modelRoot.style.transform = `translate3d(${-center.x}px, ${center.y}px, ${-center.z}px)`;
}

function layoutTreadCleat(
  distance: number,
  straightLength: number,
  treadRadius: number,
): { x: number; y: number; angle: number } {
  const halfStraight = straightLength / 2;
  const arcLength = Math.PI * treadRadius;
  const loopLength = 2 * straightLength + 2 * arcLength;
  let d = ((distance % loopLength) + loopLength) % loopLength;
  const outerRadius = treadRadius + TREAD_CLEAT_HEIGHT / 2;
  const treadY = TREAD_CHASSIS_LIFT_Y / 2;

  if (d < straightLength) {
    return { x: -halfStraight + d, y: treadY + outerRadius, angle: 0 };
  }
  d -= straightLength;
  if (d < arcLength) {
    const theta = Math.PI / 2 - d / treadRadius;
    return {
      x: halfStraight + Math.cos(theta) * outerRadius,
      y: treadY + Math.sin(theta) * outerRadius,
      angle: Math.atan2(-Math.cos(theta), Math.sin(theta)),
    };
  }
  d -= arcLength;
  if (d < straightLength) {
    return { x: halfStraight - d, y: treadY - outerRadius, angle: Math.PI };
  }
  d -= straightLength;
  const theta = -Math.PI / 2 - d / treadRadius;
  return {
    x: -halfStraight + Math.cos(theta) * outerRadius,
    y: treadY + Math.sin(theta) * outerRadius,
    angle: Math.atan2(-Math.cos(theta), Math.sin(theta)),
  };
}

function kneeFromIK(
  hipX: number, hipY: number, hipZ: number,
  footX: number, footY: number, footZ: number,
  upperLen: number, lowerLen: number,
  upX: number, upY: number, upZ: number,
): Vec3 {
  const dx = footX - hipX;
  const dy = footY - hipY;
  const dz = footZ - hipZ;
  const dist = Math.max(1e-3, Math.hypot(dx, dy, dz));
  const clampedDist = Math.min(dist, upperLen + lowerLen * 0.98);
  let cosB = (upperLen * upperLen + clampedDist * clampedDist - lowerLen * lowerLen) /
    (2 * upperLen * clampedDist);
  cosB = Math.max(-1, Math.min(1, cosB));
  const sinB = Math.sqrt(Math.max(0, 1 - cosB * cosB));
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  const dotUpN = upX * nx + upY * ny + upZ * nz;
  let ux = upX - dotUpN * nx;
  let uy = upY - dotUpN * ny;
  let uz = upZ - dotUpN * nz;
  const uLen = Math.hypot(ux, uy, uz);
  if (uLen > 1e-6) {
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;
  } else {
    ux = upX; uy = upY; uz = upZ;
  }
  return {
    x: hipX + upperLen * (cosB * nx + sinB * ux),
    y: hipY + upperLen * (cosB * ny + sinB * uy),
    z: hipZ + upperLen * (cosB * nz + sinB * uz),
  };
}

function cssTranslate(point: Vec3): string {
  return `translate3d(${point.x}px, ${-point.y}px, ${point.z}px)`;
}

function rotationFromCssXAxis(direction: Vec3): string {
  const from = { x: 1, y: 0, z: 0 };
  const axis = cross(from, direction);
  const axisLength = Math.hypot(axis.x, axis.y, axis.z);
  const dot = Math.max(-1, Math.min(1, direction.x));
  const angle = Math.acos(dot);
  if (axisLength < 1e-6 || angle < 1e-6) return '';
  return `rotate3d(${axis.x / axisLength}, ${axis.y / axisLength}, ${axis.z / axisLength}, ${angle}rad)`;
}

function normalize(v: Vec3): Vec3 {
  const length = Math.max(1e-6, Math.hypot(v.x, v.y, v.z));
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function includeBoxBounds(
  bounds: Bounds,
  center: Vec3,
  size: Vec3,
  rotation: Partial<Vec3> = {},
): void {
  const radius = Math.hypot(size.x, size.y, size.z) / 2;
  const halfX = rotation.x || rotation.y || rotation.z ? radius : size.x / 2;
  const halfY = rotation.x || rotation.y || rotation.z ? radius : size.y / 2;
  const halfZ = rotation.x || rotation.y || rotation.z ? radius : size.z / 2;
  includeAabb(bounds, {
    minX: center.x - halfX,
    maxX: center.x + halfX,
    minY: center.y - halfY,
    maxY: center.y + halfY,
    minZ: center.z - halfZ,
    maxZ: center.z + halfZ,
  });
}

function includeAabb(bounds: Bounds, box: Bounds): void {
  bounds.minX = Math.min(bounds.minX, box.minX);
  bounds.minY = Math.min(bounds.minY, box.minY);
  bounds.minZ = Math.min(bounds.minZ, box.minZ);
  bounds.maxX = Math.max(bounds.maxX, box.maxX);
  bounds.maxY = Math.max(bounds.maxY, box.maxY);
  bounds.maxZ = Math.max(bounds.maxZ, box.maxZ);
}

function normalizeBounds(bounds: Bounds): Bounds {
  if (Number.isFinite(bounds.minX)) return bounds;
  return { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 };
}
