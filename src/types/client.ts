import type {
  DefaultSetting,
  BooleanSetting,
  LabeledOptionsConfig,
  PlatformBooleanDefaults,
} from './bars';
import type { RenderMode } from './graphics';

export type AudioScope = 'off' | 'window' | 'padded' | 'all';
/** Legacy four-mode smoothing space (snap / fast / mid / slow) still
 *  used by the chassis-tilt EMA and the camera-smoothing knob. Per-
 *  channel snapshot drift uses DriftChannelMode below (adds 'ignore'
 *  and renames 'mid' → 'medium'). */
export type DriftMode = 'snap' | 'fast' | 'mid' | 'slow';
/** Per-channel drift smoothing mode. Each of the four prediction
 *  channels (movement position, movement velocity, rotation position,
 *  rotation velocity) selects independently:
 *    ignore — never apply the stored snapshot value for this channel
 *             to the rendered entity. Prediction (if any) keeps
 *             running from the last applied value forever.
 *    snap   — every client tick, replace the rendered value with the
 *             latest stored snapshot value for this channel. No EMA.
 *    fast/medium/slow — every client tick, EMA the rendered value
 *             toward the latest stored snapshot value using a
 *             frame-rate-independent half-life (smaller = snappier,
 *             larger = softer).
 *  The most recent server snapshot for each channel is always stored;
 *  the per-channel mode controls only what to do with it per tick. */
export type DriftChannelMode = 'ignore' | 'snap' | 'fast' | 'medium' | 'slow';
/** Client-side prediction physics order. Selected on the PLAYER
 *  CLIENT bar; the prediction integrator reads it before stepping
 *  position each frame.
 *    pos — snap straight to the snapshot position; do not integrate
 *          velocity. Lowest cpu, most jittery.
 *    vel — integrate position from velocity each frame. Smoothest
 *          inter-snapshot motion. The wire never carries acceleration
 *          (the server owns force inputs and only ships their
 *          integrated velocity), so there is no ACC mode. */
export type PredictionMode = 'pos' | 'vel';
export type CameraSmoothMode = 'snap' | 'fast' | 'mid' | 'slow';
export type CameraFovDegrees = 10 | 20 | 30 | 60 | 120;
/** Waypoint visualization detail. SIMPLE shows only the user-issued
 *  click points and shortcut lines between them — the convention in
 *  most RTS games. DETAILED shows every intermediate waypoint that
 *  the pathfinder inserted along the route, so the player can see
 *  how units route around obstacles. */
export type WaypointDetail = 'simple' | 'detailed';
export type SoundCategory =
  | 'fire'
  | 'hit'
  | 'dead'
  | 'beam'
  | 'field'
  | 'music';

export type RangeType =
  | 'trackAcquire'
  | 'trackRelease'
  | 'engageAcquire'
  | 'engageRelease'
  | 'engageMinAcquire'
  | 'engageMinRelease'
  | 'build';
export type ProjRangeType = 'collision' | 'explosion';
export type UnitRadiusType = 'visual' | 'shot' | 'push';

export type SoundDefaults = Record<SoundCategory, boolean>;

export type ClientBarConfig = {
  readonly render: LabeledOptionsConfig<RenderMode>;
  readonly audio: LabeledOptionsConfig<Exclude<AudioScope, 'off'>>;
  readonly audioSmoothing: BooleanSetting;
  /** Beam, laser, and dgun scorch trails drawn by BurnMark3D.
   *  Default off — scorches accumulate fast in long fights and the
   *  player typically wants the live battlefield, not its history. */
  readonly burnMarks: BooleanSetting;
  /** Wheel, tread, and footstep prints drawn by GroundPrint3D from
   *  unit movement. Default on — these decay quickly and read as
   *  part of the unit silhouettes' motion. */
  readonly locomotionMarks: BooleanSetting;
  readonly beamSnapToTurret: BooleanSetting;
  readonly triangleDebug: BooleanSetting;
  readonly buildGridDebug: BooleanSetting;
  /** Per-channel client-side drift EMAs. Each channel selects from the
   *  same five modes (ignore / snap / fast / medium / slow). The
   *  rendered entity always stores the most recent snapshot value for
   *  the channel; the mode decides per tick whether to skip, snap, or
   *  blend toward it. */
  readonly movementPosEma: LabeledOptionsConfig<DriftChannelMode>;
  readonly movementVelEma: LabeledOptionsConfig<DriftChannelMode>;
  readonly rotationPosEma: LabeledOptionsConfig<DriftChannelMode>;
  readonly rotationVelEma: LabeledOptionsConfig<DriftChannelMode>;
  /** Prediction physics order — POS / VEL. See PredictionMode for
   *  semantics. Default 'vel' integrates position from the last-seen
   *  velocity. There is no ACC mode (the wire does not carry
   *  acceleration). */
  readonly predictionMode: LabeledOptionsConfig<PredictionMode>;
  /** Per-frame chassis-tilt EMA on the client. Layered on top of the
   *  HOST SERVER tilt EMA. Uses DriftMode (snap / fast / mid / slow)
   *  — tilt is always applied; there's no 'ignore' equivalent. */
  readonly tiltEma: LabeledOptionsConfig<DriftMode>;
  readonly legsRadius: BooleanSetting;
  readonly cameraSmooth: LabeledOptionsConfig<CameraSmoothMode>;
  readonly cameraFov: LabeledOptionsConfig<CameraFovDegrees>;
  readonly edgeScroll: BooleanSetting;
  readonly dragPan: BooleanSetting;
  readonly sounds: DefaultSetting<SoundDefaults>;
  readonly rangeToggles: BooleanSetting;
  readonly projRangeToggles: BooleanSetting;
  readonly unitRadiusToggles: BooleanSetting;
  readonly lobbyVisible: DefaultSetting<PlatformBooleanDefaults>;
  readonly waypointDetail: LabeledOptionsConfig<WaypointDetail>;
};
