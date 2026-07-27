import * as THREE from 'three';
import type {
  PylonTubeBirthMode,
  PylonTubeFlow,
  PylonTubeFreeLeg,
  SprayTarget,
} from '@/types/ui';
import { SHELL_BAR_COLORS } from '@/shellConfig';
import { ballSpawnRateForResourceRate } from '@/resourceConfig';
import type { EntityId, PlayerId } from '../sim/types';
import type {
  ConstructionTowerResource,
  ResourcePylonDirection,
  ResourcePylonRig,
} from './ConstructionEmitterMesh3D';
import { hexStringToRgb } from './colorUtils';

const RESOURCE_SPRAY_COLORS = [
  hexStringToRgb(SHELL_BAR_COLORS.energy),
  hexStringToRgb(SHELL_BAR_COLORS.metal),
] as const;

const RESOURCE_SPRAY_COLOR_BY_RESOURCE: Record<ConstructionTowerResource, { r: number; g: number; b: number }> = {
  energy: RESOURCE_SPRAY_COLORS[0],
  metal: RESOURCE_SPRAY_COLORS[1],
};

export type ResourcePylonFlowDescriptor = {
  pylon: ResourcePylonRig;
  group: THREE.Group;
  hostId: EntityId;
  playerId: PlayerId;
  targetId: EntityId;
  worldEndpoint: THREE.Vector3 | null;
  endpointRadius: number;
  direction: ResourcePylonDirection;
  rate: number;
  absRate: number;
  channel: number;
};

export type ResourcePylonTaxedArcDescriptor = {
  hostId: EntityId;
  playerId: PlayerId;
  sourcePylon: ResourcePylonRig;
  sinkPylon: ResourcePylonRig;
  group: THREE.Group;
  sourceRate: number;
  sinkRate: number;
  sourceAbsRate: number;
  sinkAbsRate: number;
};

function pylonTubeFlowKey(
  sourceId: EntityId,
  targetId: EntityId,
  channel: number,
  direction: ResourcePylonDirection,
): string {
  return `${sourceId}:${targetId}:${channel}:${direction}`;
}

/** One reusable free-leg scratch per emit-site literal shape. Safe because
 *  pushTubeFlow copies every field into its pooled destination (colorRGB
 *  field-by-field; endColorRGB is the stable module-constant reference)
 *  and never retains the passed object. */
function createScratchFreeLeg(): PylonTubeFreeLeg {
  return {
    sourceId: 0,
    sourcePlayerId: 1 as PlayerId,
    target: { id: 0, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
    flow: 'direct',
    flowRadius: 0,
    channel: 0,
    speed: 0,
    particleRadius: 0,
    colorRGB: RESOURCE_SPRAY_COLORS[0],
  };
}

export class ResourcePylonFlowController3D {
  private sprayTargets: SprayTarget[] = [];
  private sprayTargetPool: SprayTarget[] = [];
  private tubeFlows: PylonTubeFlow[] = [];
  private tubeFlowPool: PylonTubeFlow[] = [];
  private _tipWorld = new THREE.Vector3();
  private _rootWorld = new THREE.Vector3();
  private _arcSourceRootWorld = new THREE.Vector3();
  private _arcSourceTipWorld = new THREE.Vector3();
  private _arcSinkRootWorld = new THREE.Vector3();
  private _arcSinkTipWorld = new THREE.Vector3();
  private readonly _outboundFreeLeg = createScratchFreeLeg();
  private readonly _crossingFreeLeg = createScratchFreeLeg();
  private readonly _taxFreeLeg = createScratchFreeLeg();

  beginFrame(): void {
    for (let i = 0; i < this.sprayTargets.length; i++) {
      this.sprayTargetPool.push(this.sprayTargets[i]);
    }
    this.sprayTargets.length = 0;
    for (let i = 0; i < this.tubeFlows.length; i++) {
      this.tubeFlowPool.push(this.tubeFlows[i]);
    }
    this.tubeFlows.length = 0;
  }

  getSprayTargets(): readonly SprayTarget[] {
    return this.sprayTargets;
  }

  getTubeFlows(): readonly PylonTubeFlow[] {
    return this.tubeFlows;
  }

  destroy(): void {
    this.sprayTargets.length = 0;
    this.sprayTargetPool.length = 0;
    this.tubeFlows.length = 0;
    this.tubeFlowPool.length = 0;
  }

  emitResourcePylonFlow(desc: ResourcePylonFlowDescriptor): void {
    const {
      pylon,
      group,
      hostId,
      playerId,
      targetId,
      worldEndpoint,
      endpointRadius,
      direction,
      rate,
      absRate,
      channel,
    } = desc;
    const ballSpawnRate = ballSpawnRateForResourceRate(absRate);
    pylon.direction = direction;

    const tip = this._tipWorld
      .copy(pylon.topLocal)
      .applyMatrix4(group.matrixWorld);
    const root = this._rootWorld
      .copy(pylon.rootLocal)
      .applyMatrix4(group.matrixWorld);

    const flowKey = pylonTubeFlowKey(hostId, targetId, channel, direction);
    const color = RESOURCE_SPRAY_COLOR_BY_RESOURCE[pylon.resource];

    let outboundFreeLeg: PylonTubeFreeLeg | undefined;
    if (direction === 'outbound') {
      outboundFreeLeg = this._outboundFreeLeg;
      outboundFreeLeg.sourceId = hostId;
      outboundFreeLeg.sourcePlayerId = playerId;
      outboundFreeLeg.target.id = targetId;
      outboundFreeLeg.target.pos.x = worldEndpoint ? worldEndpoint.x : tip.x;
      outboundFreeLeg.target.pos.y = worldEndpoint ? worldEndpoint.z : tip.z;
      outboundFreeLeg.target.z = worldEndpoint ? worldEndpoint.y : tip.y;
      outboundFreeLeg.target.radius = worldEndpoint ? endpointRadius : pylon.flowRadius;
      outboundFreeLeg.flow = 'randomOutbound';
      outboundFreeLeg.flowRadius = pylon.flowRadius;
      outboundFreeLeg.coneAngle = worldEndpoint ? pylon.coneAngle : undefined;
      outboundFreeLeg.channel = channel;
      outboundFreeLeg.speed = pylon.sprayTravelSpeed;
      outboundFreeLeg.particleRadius = pylon.sprayParticleRadius;
      outboundFreeLeg.colorRGB = color;
      outboundFreeLeg.endColorRGB = undefined;
      outboundFreeLeg.endpointFade = undefined;
      outboundFreeLeg.pylonTubeHandoffKey = undefined;
    }

    this.pushTubeFlow(
      flowKey,
      pylon,
      root,
      tip,
      direction === 'outbound',
      direction === 'outbound' ? 'rate' : 'handoff',
      rate,
      direction === 'outbound' ? ballSpawnRate : undefined,
      outboundFreeLeg,
    );

    if (direction === 'outbound') return;

    const spray = this.acquireSprayTarget();
    spray.source.id = hostId;
    spray.source.playerId = playerId;
    spray.target.id = targetId;
    spray.target.dim = undefined;
    spray.source.pos.x = tip.x;
    spray.source.pos.y = tip.z;
    spray.source.z = tip.y;
    spray.flow = 'randomInbound';
    spray.flowRadius = pylon.flowRadius;
    spray.target.pos.x = tip.x;
    spray.target.pos.y = tip.z;
    spray.target.z = tip.y;
    spray.target.radius = 0;
    if (worldEndpoint) {
      this.setSprayCone(spray, tip, worldEndpoint, pylon.coneAngle);
    }
    spray.type = 'build';
    spray.intensity = Math.min(1, rate);
    spray.channel = channel;
    spray.speed = pylon.sprayTravelSpeed;
    spray.particleRadius = pylon.sprayParticleRadius;
    spray.colorRGB = color;
    spray.endpointFade = 'start';
    spray.pylonTubeHandoffKey = flowKey;
    spray.ballSpawnRate = ballSpawnRate;
  }

  emitTaxedArc(desc: ResourcePylonTaxedArcDescriptor): void {
    const sourceRate = Math.max(0, desc.sourceRate);
    const sourceAbs = Math.max(0, desc.sourceAbsRate);
    const sinkAbs = Math.max(0, desc.sinkAbsRate);
    const crossingAbs = Math.min(sourceAbs, sinkAbs);
    const taxAbs = Math.max(0, sourceAbs - crossingAbs);
    const crossingRate = sourceAbs > 0 ? sourceRate * (crossingAbs / sourceAbs) : Math.max(0, desc.sinkRate);
    const taxRate = sourceAbs > 0 ? sourceRate * (taxAbs / sourceAbs) : 0;

    desc.group.updateWorldMatrix(true, false);
    this.writePylonWorldEndpoints(
      desc.sourcePylon,
      desc.group,
      this._arcSourceRootWorld,
      this._arcSourceTipWorld,
    );
    this.writePylonWorldEndpoints(
      desc.sinkPylon,
      desc.group,
      this._arcSinkRootWorld,
      this._arcSinkTipWorld,
    );

    const sourceColor = RESOURCE_SPRAY_COLOR_BY_RESOURCE[desc.sourcePylon.resource];
    const sinkColor = RESOURCE_SPRAY_COLOR_BY_RESOURCE[desc.sinkPylon.resource];
    const sinkFlowKey = pylonTubeFlowKey(desc.hostId, desc.hostId, 40 + desc.sinkPylon.channel, 'inbound');
    const crossingChannel = 50 + desc.sourcePylon.channel * 2 + desc.sinkPylon.channel;
    const taxChannel = 60 + desc.sourcePylon.channel;

    if (crossingAbs > 0 || crossingRate > 0.001) {
      this.pushTubeFlow(
        sinkFlowKey,
        desc.sinkPylon,
        this._arcSinkRootWorld,
        this._arcSinkTipWorld,
        false,
        'handoff',
        crossingRate,
        undefined,
        undefined,
      );
      const crossingLeg = this._crossingFreeLeg;
      crossingLeg.sourceId = desc.hostId;
      crossingLeg.sourcePlayerId = desc.playerId;
      crossingLeg.target.id = desc.hostId;
      crossingLeg.target.pos.x = this._arcSinkTipWorld.x;
      crossingLeg.target.pos.y = this._arcSinkTipWorld.z;
      crossingLeg.target.z = this._arcSinkTipWorld.y;
      crossingLeg.target.radius = 0;
      crossingLeg.flow = 'direct';
      crossingLeg.flowRadius = 1;
      crossingLeg.coneAngle = undefined;
      crossingLeg.channel = crossingChannel;
      crossingLeg.speed = Math.max(desc.sourcePylon.sprayTravelSpeed, desc.sinkPylon.sprayTravelSpeed);
      crossingLeg.particleRadius = Math.max(desc.sourcePylon.sprayParticleRadius, desc.sinkPylon.sprayParticleRadius);
      crossingLeg.colorRGB = sourceColor;
      crossingLeg.endColorRGB = sinkColor;
      crossingLeg.endpointFade = 'none';
      crossingLeg.pylonTubeHandoffKey = sinkFlowKey;
      this.pushTubeFlow(
        pylonTubeFlowKey(desc.hostId, desc.hostId, crossingChannel, 'outbound'),
        desc.sourcePylon,
        this._arcSourceRootWorld,
        this._arcSourceTipWorld,
        true,
        'rate',
        crossingRate,
        ballSpawnRateForResourceRate(crossingAbs),
        crossingLeg,
      );
    }

    if (taxAbs > 0 || taxRate > 0.001) {
      const taxLeg = this._taxFreeLeg;
      taxLeg.sourceId = desc.hostId;
      taxLeg.sourcePlayerId = desc.playerId;
      taxLeg.target.id = desc.hostId;
      taxLeg.target.pos.x = this._arcSinkTipWorld.x;
      taxLeg.target.pos.y = this._arcSinkTipWorld.z;
      taxLeg.target.z = this._arcSinkTipWorld.y;
      taxLeg.target.radius = desc.sourcePylon.flowRadius;
      taxLeg.flow = 'randomOutbound';
      taxLeg.flowRadius = desc.sourcePylon.flowRadius;
      taxLeg.coneAngle = desc.sourcePylon.coneAngle;
      taxLeg.channel = taxChannel;
      taxLeg.speed = desc.sourcePylon.sprayTravelSpeed;
      taxLeg.particleRadius = desc.sourcePylon.sprayParticleRadius;
      taxLeg.colorRGB = sourceColor;
      taxLeg.endColorRGB = undefined;
      taxLeg.endpointFade = undefined;
      taxLeg.pylonTubeHandoffKey = undefined;
      this.pushTubeFlow(
        pylonTubeFlowKey(desc.hostId, desc.hostId, taxChannel, 'outbound'),
        desc.sourcePylon,
        this._arcSourceRootWorld,
        this._arcSourceTipWorld,
        true,
        'rate',
        taxRate,
        ballSpawnRateForResourceRate(taxAbs),
        taxLeg,
      );
    }
  }

  private pushTubeFlow(
    key: string,
    pylon: ResourcePylonRig,
    root: THREE.Vector3,
    tip: THREE.Vector3,
    up: boolean,
    birthMode: PylonTubeBirthMode,
    intensity: number,
    ballSpawnRate: number | undefined,
    freeLeg: PylonTubeFreeLeg | undefined,
  ): void {
    let flow = this.tubeFlowPool.pop();
    if (!flow) {
      flow = {
        key: '',
        root: { x: 0, y: 0, z: 0 },
        tip: { x: 0, y: 0, z: 0 },
        up: true,
        birthMode: 'rate',
        intensity: 0,
        speed: 0,
        beadRadius: 0,
        colorRGB: { r: 0, g: 0, b: 0 },
      };
    }
    flow.key = key;
    flow.root.x = root.x; flow.root.y = root.y; flow.root.z = root.z;
    flow.tip.x = tip.x; flow.tip.y = tip.y; flow.tip.z = tip.z;
    flow.up = up;
    flow.birthMode = birthMode;
    flow.intensity = Math.min(1, intensity);
    flow.ballSpawnRate = ballSpawnRate;
    flow.speed = pylon.sprayTravelSpeed;
    flow.beadRadius = pylon.tubeBeadRadius;
    const color = RESOURCE_SPRAY_COLOR_BY_RESOURCE[pylon.resource];
    flow.colorRGB.r = color.r; flow.colorRGB.g = color.g; flow.colorRGB.b = color.b;
    if (freeLeg) {
      const out = flow.freeLeg ?? {
        sourceId: freeLeg.sourceId,
        sourcePlayerId: freeLeg.sourcePlayerId,
        target: { id: freeLeg.target.id, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
        flow: freeLeg.flow,
        flowRadius: 0,
        channel: 0,
        speed: 0,
        particleRadius: 0,
        colorRGB: { r: 0, g: 0, b: 0 },
      };
      out.sourceId = freeLeg.sourceId;
      out.sourcePlayerId = freeLeg.sourcePlayerId;
      out.target.id = freeLeg.target.id;
      out.target.pos.x = freeLeg.target.pos.x;
      out.target.pos.y = freeLeg.target.pos.y;
      out.target.z = freeLeg.target.z;
      out.target.radius = freeLeg.target.radius;
      out.flow = freeLeg.flow;
      out.flowRadius = freeLeg.flowRadius;
      out.coneAngle = freeLeg.coneAngle;
      out.channel = freeLeg.channel;
      out.speed = freeLeg.speed;
      out.particleRadius = freeLeg.particleRadius;
      out.colorRGB.r = freeLeg.colorRGB.r;
      out.colorRGB.g = freeLeg.colorRGB.g;
      out.colorRGB.b = freeLeg.colorRGB.b;
      out.endColorRGB = freeLeg.endColorRGB;
      out.endpointFade = freeLeg.endpointFade;
      out.pylonTubeHandoffKey = freeLeg.pylonTubeHandoffKey;
      flow.freeLeg = out;
    } else {
      flow.freeLeg = undefined;
    }
    this.tubeFlows.push(flow);
  }

  private acquireSprayTarget(): SprayTarget {
    let target = this.sprayTargetPool.pop();
    if (!target) {
      target = {
        source: { id: 0, pos: { x: 0, y: 0 }, z: 0, playerId: 1 as PlayerId },
        target: { id: 0, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
        type: 'build',
        intensity: 0,
        channel: 0,
        flow: 'direct',
        flowRadius: 0,
      };
    }
    target.colorRGB = undefined;
    target.endColorRGB = undefined;
    target.endpointFade = undefined;
    target.pylonTubeHandoffKey = undefined;
    target.ballSpawnRate = undefined;
    target.waypoint = undefined;
    target.waypoint2 = undefined;
    target.speed = undefined;
    target.particleRadius = undefined;
    target.channel = 0;
    target.flow = 'direct';
    target.flowRadius = 0;
    target.coneAngle = undefined;
    this.sprayTargets.push(target);
    return target;
  }

  private writePylonWorldEndpoints(
    pylon: ResourcePylonRig,
    group: THREE.Group,
    rootOut: THREE.Vector3,
    tipOut: THREE.Vector3,
  ): void {
    rootOut.copy(pylon.rootLocal).applyMatrix4(group.matrixWorld);
    tipOut.copy(pylon.topLocal).applyMatrix4(group.matrixWorld);
  }

  private setSprayCone(
    spray: SprayTarget,
    tip: THREE.Vector3,
    lockOn: THREE.Vector3,
    coneAngle: number,
  ): void {
    const dx = lockOn.x - tip.x;
    const dy = lockOn.y - tip.y;
    const dz = lockOn.z - tip.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) {
      spray.coneAngle = undefined;
      return;
    }
    const axis = spray.coneAxis ?? { x: 0, y: 0, z: 0 };
    axis.x = dx / len;
    axis.y = dy / len;
    axis.z = dz / len;
    spray.coneAxis = axis;
    spray.coneAngle = coneAngle;
    spray.flowRadius = len;
  }
}
