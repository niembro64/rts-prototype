// Simulation WASM presentation API surface.

export interface PresentationApi {
  clear: () => void;
  captureTick: (tick: number) => void;
  latestTick: () => number;
  hasHistory: () => boolean;
  slotInputScratchPtr: () => number;
  poseOutputScratchPtr: () => number;
  turretOutputScratchPtr: () => number;
  scratchEnsure: (count: number) => void;
  interpolate: (count: number, alpha: number) => number;
  poseOutputStride: number;
  turretOutputStride: number;
  maxTurretsPerEntity: number;
}

export interface RenderPoseApi {
  unitInputScratchPtr: () => number;
  unitOutputScratchPtr: () => number;
  unitScratchEnsure: (count: number) => void;
  unitCompute: (count: number) => void;
  unitInputStride: number;
  unitOutputStride: number;
  projectileAxisInputScratchPtr: () => number;
  projectileAxisOutputScratchPtr: () => number;
  projectileAxisScratchEnsure: (count: number) => void;
  projectileAxisCompute: (count: number) => void;
  projectileAxisInputStride: number;
  projectileAxisOutputStride: number;
  airborneEmitterInputScratchPtr: () => number;
  airborneEmitterOutputScratchPtr: () => number;
  airborneEmitterScratchEnsure: (count: number) => void;
  airborneEmitterCompute: (count: number) => void;
  airborneEmitterInputStride: number;
  airborneEmitterOutputStride: number;
  buildingInputScratchPtr: () => number;
  buildingOutputScratchPtr: () => number;
  buildingScratchEnsure: (count: number) => void;
  buildingCompute: (count: number) => void;
  buildingInputStride: number;
  buildingOutputStride: number;
  chassisPartInputScratchPtr: () => number;
  chassisPartOutputScratchPtr: () => number;
  chassisPartScratchEnsure: (count: number) => void;
  chassisPartCompute: (count: number) => void;
  chassisPartInputStride: number;
  chassisPartOutputStride: number;
  shieldPanelInputScratchPtr: () => number;
  shieldPanelOutputScratchPtr: () => number;
  shieldPanelScratchEnsure: (count: number) => void;
  shieldPanelCompute: (count: number) => void;
  shieldPanelInputStride: number;
  shieldPanelOutputStride: number;
  turretBarrelInputScratchPtr: () => number;
  turretBarrelOutputScratchPtr: () => number;
  turretBarrelScratchEnsure: (count: number) => void;
  turretBarrelCompute: (count: number) => void;
  turretBarrelInputStride: number;
  turretBarrelOutputStride: number;
  turretHeadInputScratchPtr: () => number;
  turretHeadOutputScratchPtr: () => number;
  turretHeadScratchEnsure: (count: number) => void;
  turretHeadCompute: (count: number) => void;
  turretHeadInputStride: number;
  turretHeadOutputStride: number;
  turretAimInputScratchPtr: () => number;
  turretAimOutputScratchPtr: () => number;
  turretAimScratchEnsure: (count: number) => void;
  turretAimCompute: (count: number) => void;
  turretAimInputStride: number;
  turretAimOutputStride: number;
}
