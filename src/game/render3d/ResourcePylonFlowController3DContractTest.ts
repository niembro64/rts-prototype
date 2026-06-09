import * as THREE from 'three';
import type { ResourcePylonRig } from './ConstructionEmitterMesh3D';
import { ResourcePylonFlowController3D } from './ResourcePylonFlowController3D';
import type { EntityId, PlayerId } from '../sim/types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[resource pylon flow contract] ${message}`);
  }
}

function makePylon(resource: 'energy' | 'metal', x: number, channel: number): ResourcePylonRig {
  const rootLocal = new THREE.Vector3(x, 0, 0);
  const topLocal = new THREE.Vector3(x, 10, 0);
  return {
    resource,
    direction: 'outbound',
    rootLocal,
    rootBaseLocal: rootLocal.clone(),
    topLocal,
    topBaseLocal: topLocal.clone(),
    sprayTravelSpeed: 100,
    sprayParticleRadius: 1,
    tubeBeadRadius: 0.8,
    flowRadius: 24,
    coneAngle: Math.PI / 8,
    channel,
    smoothedRate: 0,
    displaySmoothedRate: 0,
  };
}

export function runResourcePylonFlowController3DContractTest(): void {
  const hostId = 10 as EntityId;
  const targetId = 11 as EntityId;
  const playerId = 1 as PlayerId;
  const group = new THREE.Group();
  group.updateWorldMatrix(true, false);

  const controller = new ResourcePylonFlowController3D();
  const energyPylon = makePylon('energy', -5, 0);
  controller.beginFrame();
  controller.emitResourcePylonFlow({
    pylon: energyPylon,
    group,
    hostId,
    playerId,
    targetId,
    worldEndpoint: new THREE.Vector3(20, 12, 0),
    endpointRadius: 8,
    direction: 'outbound',
    rate: 1,
    absRate: 20,
    channel: 0,
  });
  assertContract(controller.getSprayTargets().length === 0, 'outbound pylon flow must not create a free-leg spray until a tube bead reaches the tip');
  const outboundFlows = controller.getTubeFlows();
  assertContract(outboundFlows.length === 1, 'outbound pylon flow must create one tube flow');
  assertContract(outboundFlows[0].up === true, 'outbound pylon tube beads must move root to tip');
  assertContract(outboundFlows[0].birthMode === 'rate', 'outbound pylon tube must be rate-born at the root');
  assertContract(outboundFlows[0].freeLeg?.flow === 'randomOutbound', 'outbound pylon tube must hand off to an outward free leg');
  assertContract(outboundFlows[0].ballSpawnRate !== undefined && outboundFlows[0].ballSpawnRate > 0, 'outbound pylon density must come from absolute resource rate');

  controller.beginFrame();
  const metalPylon = makePylon('metal', 5, 1);
  controller.emitResourcePylonFlow({
    pylon: metalPylon,
    group,
    hostId,
    playerId,
    targetId,
    worldEndpoint: new THREE.Vector3(20, 12, 0),
    endpointRadius: 8,
    direction: 'inbound',
    rate: 1,
    absRate: 12,
    channel: 1,
  });
  const inboundFlows = controller.getTubeFlows();
  const inboundSprays = controller.getSprayTargets();
  assertContract(inboundFlows.length === 1, 'inbound pylon flow must create one tube flow');
  assertContract(inboundFlows[0].up === false, 'inbound pylon tube beads must move tip to root');
  assertContract(inboundFlows[0].birthMode === 'handoff', 'inbound pylon tube must be born from free-leg handoff at the tip');
  assertContract(inboundSprays.length === 1, 'inbound pylon flow must create one incoming free-leg spray');
  assertContract(inboundSprays[0].flow === 'randomInbound', 'inbound free leg must come in to the pylon tip');
  assertContract(inboundSprays[0].pylonTubeHandoffKey === inboundFlows[0].key, 'inbound free leg must hand off into the matching tube');

  controller.beginFrame();
  controller.emitTaxedArc({
    hostId,
    playerId,
    sourcePylon: energyPylon,
    sinkPylon: metalPylon,
    group,
    sourceRate: 1,
    sinkRate: 0.5,
    sourceAbsRate: 20,
    sinkAbsRate: 10,
  });
  const arcFlows = controller.getTubeFlows();
  assertContract(arcFlows.length === 3, 'taxed arc must create source crossing, source leak, and sink receiving tube flows');
  assertContract(
    arcFlows.some((flow) => flow.up === false && flow.birthMode === 'handoff'),
    'taxed arc must include an inbound receiving pylon tube',
  );
  assertContract(
    arcFlows.filter((flow) => flow.up === true && flow.birthMode === 'rate').length === 2,
    'taxed arc must split the consumed pylon into crossing and leaked outbound flows',
  );
  assertContract(
    arcFlows.some((flow) => flow.freeLeg?.pylonTubeHandoffKey !== undefined && flow.freeLeg.endColorRGB !== undefined),
    'crossing arc balls must recolor and hand off into the receiving pylon',
  );
  assertContract(
    arcFlows.some((flow) => flow.freeLeg?.flow === 'randomOutbound' && flow.freeLeg.pylonTubeHandoffKey === undefined),
    'taxed leaked balls must leave the source pylon without entering another pylon',
  );
  controller.destroy();
}
