import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { TerrainMapShape, TerrainShape } from '../types/terrain';
import type {
  AudioScope,
  CameraFovDegrees,
  CameraSmoothMode,
  DriftChannelMode,
  DriftMode,
  PositionDriftChannelMode,
  PredictionMode,
  ProjRangeType,
  RangeType,
  SoundCategory,
  UnitRadiusType,
  WaypointDetail,
} from '../types/client';
import type { KeyframeRatio, SnapshotRate, TickRate } from '../types/server';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import type { RenderMode } from '../types/graphics';

export type ControlBarStyle = Record<string, string>;

export type GameCanvasBattleControlBarModel = {
  readonly isReadonly: boolean;
  readonly barStyle: ControlBarStyle;
  readonly battleLabel: string;
  readonly battleElapsed: string;
  readonly allDemoUnitsActive: boolean;
  readonly demoUnitTypes: readonly string[];
  readonly currentAllowedUnits: readonly string[];
  readonly currentAllowedUnitsSet: ReadonlySet<string>;
  readonly displayUnitCap: number;
  readonly gameStarted: boolean;
  readonly mapWidthLandCells: number;
  readonly mapLengthLandCells: number;
  readonly terrainCenter: TerrainShape;
  readonly terrainDividers: TerrainShape;
  readonly terrainMapShape: TerrainMapShape;
  readonly displayUnitCount: number;
  readonly currentForceFieldsObstructSight: boolean;
  readonly currentFogOfWarEnabled: boolean;
  resetDemoDefaults(): void;
  toggleAllDemoUnits(): void;
  toggleDemoUnitType(unitType: string): void;
  changeMaxTotalUnits(cap: number): void;
  applyMapLandDimensions(dimensions: MapLandCellDimensions): void;
  applyTerrainShape(kind: 'center' | 'dividers', shape: TerrainShape): void;
  applyTerrainMapShape(shape: TerrainMapShape): void;
  setForceFieldsObstructSight(enabled: boolean): void;
  setFogOfWarEnabled(enabled: boolean): void;
};

export type GameCanvasServerControlBarModel = {
  readonly isReadonly: boolean;
  readonly barStyle: ControlBarStyle;
  readonly displayServerTime: string;
  readonly displayServerIp: string;
  readonly displayTickRate: TickRate;
  readonly serverUnitGroundNormalEmaMode: UnitGroundNormalEmaMode;
  readonly displayServerTpsAvg: number;
  readonly displayServerTpsWorst: number;
  readonly displayServerCpuAvg: number;
  readonly displayServerCpuHi: number;
  readonly displaySnapshotRate: SnapshotRate;
  readonly displayKeyframeRatio: KeyframeRatio;
  resetServerDefaults(): void;
  setTickRateValue(rate: TickRate): void;
  setUnitGroundNormalEmaModeValue(mode: UnitGroundNormalEmaMode): void;
  setNetworkUpdateRate(rate: SnapshotRate): void;
  setKeyframeRatioValue(ratio: KeyframeRatio): void;
};

export type GameCanvasClientControlBarModel = {
  readonly barStyle: ControlBarStyle;
  readonly playerClientEnabled: boolean;
  readonly displayedClientTime: string;
  readonly displayedClientIp: string;
  readonly waypointDetail: WaypointDetail;
  readonly logicMsAvg: number;
  readonly logicMsHi: number;
  readonly renderMsAvg: number;
  readonly renderMsHi: number;
  readonly displayGpuMs: number;
  readonly gpuSourceLabel: string;
  readonly gpuTimerSupported: boolean;
  readonly frameMsAvg: number;
  readonly frameMsHi: number;
  readonly longtaskSupported: boolean;
  readonly longtaskMsPerSec: number;
  readonly renderTpsAvg: number;
  readonly renderTpsWorst: number;
  readonly currentZoom: number;
  readonly snapAvgRate: number;
  readonly snapWorstRate: number;
  readonly displayTickRate: TickRate;
  readonly displaySnapshotRate: SnapshotRate;
  readonly fullSnapAvgRate: number;
  readonly fullSnapWorstRate: number;
  readonly fullSnapBarTarget: number;
  readonly audioSmoothing: boolean;
  readonly burnMarks: boolean;
  readonly locomotionMarks: boolean;
  readonly beamSnapToTurret: boolean;
  readonly movementPosEma: PositionDriftChannelMode;
  readonly movementVelEma: DriftChannelMode;
  readonly rotationPosEma: PositionDriftChannelMode;
  readonly rotationVelEma: DriftChannelMode;
  readonly predictionMode: PredictionMode;
  readonly clientUnitGroundNormalEmaMode: DriftMode;
  readonly allPanActive: boolean;
  readonly dragPanEnabled: boolean;
  readonly edgeScrollEnabled: boolean;
  readonly showServerControls: boolean;
  readonly triangleDebug: boolean;
  readonly buildGridDebug: boolean;
  readonly renderMode: RenderMode;
  readonly audioScope: AudioScope;
  readonly allSoundsActive: boolean;
  readonly soundToggles: Readonly<Record<SoundCategory, boolean>>;
  readonly sfxCategories: readonly SoundCategory[];
  readonly soundLabels: Readonly<Record<SoundCategory, string>>;
  readonly soundTooltips: Readonly<Record<SoundCategory, string>>;
  readonly allRangesActive: boolean;
  readonly rangeToggles: Readonly<Record<RangeType, boolean>>;
  readonly allProjRangesActive: boolean;
  readonly projRangeToggles: Readonly<Record<ProjRangeType, boolean>>;
  readonly allUnitRadiiActive: boolean;
  readonly unitRadiusToggles: Readonly<Record<UnitRadiusType, boolean>>;
  readonly legsRadiusToggle: boolean;
  readonly cameraFovDegrees: CameraFovDegrees;
  readonly cameraSmoothMode: CameraSmoothMode;
  resetClientDefaults(): void;
  togglePlayerClientEnabled(): void;
  changeWaypointDetail(mode: WaypointDetail): void;
  toggleAudioSmoothing(): void;
  toggleBurnMarks(): void;
  toggleLocomotionMarks(): void;
  toggleBeamSnapToTurret(): void;
  changeMovementPosEma(mode: PositionDriftChannelMode): void;
  changeMovementVelEma(mode: DriftChannelMode): void;
  changeRotationPosEma(mode: PositionDriftChannelMode): void;
  changeRotationVelEma(mode: DriftChannelMode): void;
  changePredictionMode(mode: PredictionMode): void;
  changeClientUnitGroundNormalEmaMode(mode: DriftMode): void;
  toggleAllPan(): void;
  toggleDragPan(): void;
  toggleEdgeScroll(): void;
  toggleTriangleDebug(): void;
  toggleBuildGridDebug(): void;
  changeRenderMode(mode: RenderMode): void;
  changeAudioScope(scope: AudioScope): void;
  toggleAllSounds(): void;
  toggleSoundCategory(category: SoundCategory): void;
  toggleAllRanges(): void;
  toggleRange(type: RangeType): void;
  toggleAllProjRanges(): void;
  toggleProjRange(type: ProjRangeType): void;
  toggleAllUnitRadii(): void;
  toggleUnitRadius(type: UnitRadiusType): void;
  toggleLegsRadius(): void;
  changeCameraFovDegrees(fov: CameraFovDegrees): void;
  setCameraMode(mode: CameraSmoothMode): void;
};
