import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { TerrainMapShape } from '../types/terrain';
import type { BattlePreset } from './battlePresets';
import type {
  AudioScope,
  CameraFollowMode,
  CameraFovDegrees,
  CameraSmoothMode,
  CameraViewMode,
  DriftChannelMode,
  DriftMode,
  EntityHudElement,
  EntityHudToggles,
  EntityHudType,
  MasterVolumePercent,
  PositionDriftChannelMode,
  PredictionMode,
  ProjRangeType,
  RangeType,
  SelectionHudMode,
  SoundCategory,
  UnitRadiusType,
  WaypointDetail,
} from '../types/client';
import type { KeyframeRatio, SnapshotRate, TickRate } from '../types/server';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import type { RenderMode } from '../types/graphics';
import type { CommandHotkeyPresetId } from '../game/input/commandHotkeys';

export type ControlBarStyle = Record<string, string>;

export type GameCanvasBattleControlBarModel = {
  readonly isReadonly: boolean;
  readonly barStyle: ControlBarStyle;
  readonly battleLabel: string;
  readonly battleElapsed: string;
  readonly allDemoUnitsActive: boolean;
  readonly demoUnitBlueprintIds: readonly string[];
  readonly currentAllowedUnits: readonly string[];
  readonly currentAllowedUnitsSet: ReadonlySet<string>;
  readonly displayUnitCap: number;
  readonly gameStarted: boolean;
  readonly mapWidthLandCells: number;
  readonly mapLengthLandCells: number;
  readonly centerMagnitude: number;
  readonly dividersMagnitude: number;
  readonly terrainMapShape: TerrainMapShape;
  readonly terrainDTerrain: number;
  readonly metalDepositStep: number;
  readonly terrainDetail: number;
  readonly displayUnitCount: number;
  readonly currentShieldsObstructSight: boolean;
  readonly currentFogOfWarEnabled: boolean;
  readonly currentConverterTax: number;
  readonly presets: readonly BattlePreset[];
  readonly activePresetName: string | null;
  applyPreset(preset: BattlePreset): void;
  resetDemoDefaults(): void;
  toggleAllDemoUnits(): void;
  toggleDemoUnitBlueprintId(unitBlueprintId: string): void;
  changeMaxTotalUnits(cap: number): void;
  applyMapLandDimensions(dimensions: MapLandCellDimensions): void;
  applyCenterMagnitude(value: number): void;
  applyDividersMagnitude(value: number): void;
  applyTerrainMapShape(shape: TerrainMapShape): void;
  applyTerrainDTerrain(value: number): void;
  applyMetalDepositStep(value: number): void;
  applyTerrainDetail(value: number): void;
  setShieldsObstructSight(enabled: boolean): void;
  setFogOfWarEnabled(enabled: boolean): void;
  setConverterTax(tax: number): void;
};

export type GameCanvasServerControlBarModel = {
  readonly isReadonly: boolean;
  readonly barStyle: ControlBarStyle;
  readonly serverLabel: string;
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
  readonly clientLabel: string;
  readonly playerClientEnabled: boolean;
  readonly displayedClientTime: string;
  readonly displayedClientIp: string;
  readonly waypointDetail: WaypointDetail;
  readonly entityHud: Readonly<EntityHudToggles>;
  readonly selectionHudMode: SelectionHudMode;
  readonly commandHotkeyPreset: CommandHotkeyPresetId;
  readonly entityHudTypes: readonly EntityHudType[];
  readonly entityHudElements: readonly EntityHudElement[];
  readonly logicMsAvg: number;
  readonly logicMsHi: number;
  readonly renderMsAvg: number;
  readonly renderMsHi: number;
  readonly displayGpuMs: number;
  readonly gpuSourceLabel: string;
  readonly gpuTimerSupported: boolean;
  readonly rendererContextMainCount: number;
  readonly rendererContextAuxiliaryCount: number;
  readonly rendererContextAuxiliaryBudget: number;
  readonly rendererContextDeniedAuxiliaryCount: number;
  readonly hudSpriteActiveCount: number;
  readonly hudSpriteRetainedCount: number;
  readonly hudSpritePeakCount: number;
  readonly hudSpriteDisposedCount: number;
  readonly hudSpriteBudgetCount: number;
  readonly scopedRetainedUnitMeshes: number;
  readonly scopedRetainedBuildingMeshes: number;
  readonly scopedMeshHiddenPerSec: number;
  readonly scopedMeshReactivatedPerSec: number;
  readonly scopedMeshDestroyPerSec: number;
  readonly scopedMeshRebuildPerSec: number;
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
  readonly diffSnapSizeAvgBytes: number;
  readonly diffSnapSizeHiBytes: number;
  readonly fullSnapSizeAvgBytes: number;
  readonly fullSnapSizeHiBytes: number;
  readonly snapshotMbpsPerClient: number;
  readonly snapshotMbpsHostTotal: number;
  readonly remoteSnapshotClientCount: number;
  readonly audioSmoothing: boolean;
  readonly burnMarks: boolean;
  readonly locomotionMarks: boolean;
  readonly smokeTrails: boolean;
  readonly smokeSoftEdges: boolean;
  readonly beamSnapToTurret: boolean;
  readonly resourceBallDensity: number;
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
  readonly metalMap: boolean;
  readonly elevationMap: boolean;
  readonly sightBoundary: boolean;
  readonly radarBoundary: boolean;
  readonly renderMode: RenderMode;
  readonly audioScope: AudioScope;
  readonly masterVolume: MasterVolumePercent;
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
  readonly cameraFollowMode: CameraFollowMode;
  readonly fullscreenActive: boolean;
  readonly uiChromeVisible: boolean;
  readonly mapDetailsVisible: boolean;
  resetClientDefaults(): void;
  togglePlayerClientEnabled(): void;
  changeWaypointDetail(mode: WaypointDetail): void;
  toggleEntityHud(type: EntityHudType, element: EntityHudElement): void;
  changeSelectionHudMode(mode: SelectionHudMode): void;
  changeCommandHotkeyPreset(presetId: CommandHotkeyPresetId): void;
  toggleAudioSmoothing(): void;
  toggleBurnMarks(): void;
  toggleLocomotionMarks(): void;
  toggleSmokeTrails(): void;
  toggleSmokeSoftEdges(): void;
  toggleBeamSnapToTurret(): void;
  changeResourceBallDensity(value: number): void;
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
  toggleMetalMap(): void;
  toggleElevationMap(): void;
  toggleSightBoundary(): void;
  toggleRadarBoundary(): void;
  changeRenderMode(mode: RenderMode): void;
  changeAudioScope(scope: AudioScope): void;
  changeMasterVolume(volume: MasterVolumePercent): void;
  changeGameSpeed(rate: TickRate): void;
  setGamePaused(paused: boolean): void;
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
  setCameraViewMode(mode: CameraViewMode): void;
  setCameraFollowMode(mode: CameraFollowMode): void;
  showMapOverview(): void;
  flipCameraYaw(): void;
  setCameraAnchor(index: number): void;
  focusCameraAnchor(index: number): void;
  toggleFullscreen(): void;
  captureScreenshot(): void;
  goToLastPing(): void;
  toggleUiChrome(): void;
  toggleMapDetails(): void;
};
