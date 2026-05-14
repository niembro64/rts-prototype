import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { ForceFieldReflectionMode } from '../types/shotTypes';
import type { TerrainMapShape, TerrainShape } from '../types/terrain';
import type {
  AudioScope,
  CameraFovDegrees,
  CameraSmoothMode,
  DriftMode,
  PredictionMode,
  GridOverlay,
  ProjRangeType,
  RangeType,
  SoundCategory,
  UnitRadiusType,
  WaypointDetail,
} from '../types/client';
import type { KeyframeRatio, SnapshotRate, TickRate } from '../types/server';
import type { LodSignalStates } from '../types/lod';
import type { ServerSimQuality, ServerSimSignalStates } from '../types/serverSimLod';
import type { TiltEmaMode } from '../shellConfig';
import type {
  ConcreteGraphicsQuality,
  GraphicsQuality,
  RenderMode,
} from '../types/graphics';

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
  readonly currentMirrorsEnabled: boolean;
  readonly currentForceFieldsEnabled: boolean;
  readonly currentForceFieldsBlockTargeting: boolean;
  readonly currentForceFieldReflectionMode: ForceFieldReflectionMode;
  readonly currentFogOfWarEnabled: boolean;
  resetDemoDefaults(): void;
  toggleAllDemoUnits(): void;
  toggleDemoUnitType(unitType: string): void;
  changeMaxTotalUnits(cap: number): void;
  applyMapLandDimensions(dimensions: MapLandCellDimensions): void;
  applyTerrainShape(kind: 'center' | 'dividers', shape: TerrainShape): void;
  applyTerrainMapShape(shape: TerrainMapShape): void;
  setMirrorsEnabled(enabled: boolean): void;
  setForceFieldsEnabled(enabled: boolean): void;
  setForceFieldsBlockTargeting(enabled: boolean): void;
  setForceFieldReflectionMode(mode: ForceFieldReflectionMode): void;
  setFogOfWarEnabled(enabled: boolean): void;
};

export type GameCanvasServerControlBarModel = {
  readonly isReadonly: boolean;
  readonly barStyle: ControlBarStyle;
  readonly displayServerTime: string;
  readonly displayServerIp: string;
  readonly displayTargetTickRate: TickRate;
  readonly displayTickRate: TickRate;
  readonly serverTiltEmaMode: TiltEmaMode;
  readonly displayServerTpsAvg: number;
  readonly displayServerTpsWorst: number;
  readonly displayServerCpuAvg: number;
  readonly displayServerCpuHi: number;
  readonly displaySnapshotRate: SnapshotRate;
  readonly displayKeyframeRatio: KeyframeRatio;
  readonly serverSimQuality: ServerSimQuality;
  readonly serverAnySolo: boolean;
  readonly serverSignalStates: ServerSimSignalStates;
  readonly effectiveSimQuality: ConcreteGraphicsQuality | '';
  resetServerDefaults(): void;
  setTickRateValue(rate: TickRate): void;
  setTiltEmaModeValue(mode: TiltEmaMode): void;
  setNetworkUpdateRate(rate: SnapshotRate): void;
  setKeyframeRatioValue(ratio: KeyframeRatio): void;
  setSimQualityValue(quality: ServerSimQuality): void;
  cycleServerSignal(signal: keyof ServerSimSignalStates): void;
};

export type GameCanvasClientControlBarModel = {
  readonly barStyle: ControlBarStyle;
  readonly playerClientEnabled: boolean;
  readonly displayedClientTime: string;
  readonly displayedClientIp: string;
  readonly gridOverlay: GridOverlay;
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
  readonly displaySnapshotRate: SnapshotRate;
  readonly fullSnapAvgRate: number;
  readonly fullSnapWorstRate: number;
  readonly fullSnapBarTarget: number;
  readonly audioSmoothing: boolean;
  readonly burnMarks: boolean;
  readonly locomotionMarks: boolean;
  readonly beamSnapToTurret: boolean;
  readonly driftMode: DriftMode;
  readonly predictionMode: PredictionMode;
  readonly clientTiltEmaMode: DriftMode;
  readonly allPanActive: boolean;
  readonly dragPanEnabled: boolean;
  readonly edgeScrollEnabled: boolean;
  readonly graphicsQuality: GraphicsQuality;
  readonly effectiveQuality: ConcreteGraphicsQuality;
  readonly clientAnySolo: boolean;
  readonly clientSignalStates: LodSignalStates;
  readonly showServerControls: boolean;
  readonly baseLodMode: boolean;
  readonly lodShellRings: boolean;
  readonly lodGridBorders: boolean;
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
  changeGridOverlay(mode: GridOverlay): void;
  changeWaypointDetail(mode: WaypointDetail): void;
  toggleAudioSmoothing(): void;
  toggleBurnMarks(): void;
  toggleLocomotionMarks(): void;
  toggleBeamSnapToTurret(): void;
  changeDriftMode(mode: DriftMode): void;
  changePredictionMode(mode: PredictionMode): void;
  changeClientTiltEmaMode(mode: DriftMode): void;
  toggleAllPan(): void;
  toggleDragPan(): void;
  toggleEdgeScroll(): void;
  changeGraphicsQuality(quality: GraphicsQuality): void;
  cycleClientSignal(signal: keyof LodSignalStates): void;
  toggleBaseLodMode(): void;
  toggleLodShellRings(): void;
  toggleLodGridBorders(): void;
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
