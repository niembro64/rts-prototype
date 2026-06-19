// AudioManager — facade for all game audio (one-shot and continuous sounds)
// Delegates synth work to helper modules; owns AudioContext, master gain, and continuous sound state.

import { AUDIO, beamSoundFrequencyFromHarmonicIndex } from '../../audioConfig';
import { getTurretBlueprint, getShotBlueprint, getRayBlueprint, getUnitBlueprint } from '../sim/blueprints';
import type { AudioToolkit } from './audioHelpers';
import { FIRE_SYNTHS } from './fireSynths';
import { HIT_SYNTHS } from './hitSynths';
import { DEATH_SYNTHS } from './deathSynths';
import type { TurretAudioId } from '../../types/combat';
import type { SoundCategory } from '../../types/client';
import {
  type ContinuousSound,
  startContinuousSound,
  stopContinuousSound,
  setContinuousAudible,
  updateContinuousZoom,
  disposeContinuousSound,
  getBeamConfig,
  getShieldConfig,
} from './continuousSounds';

// Unified synth dispatch table
const SYNTH_DISPATCH: Record<string, (tk: AudioToolkit, speed: number, vol: number) => void> = {
  ...FIRE_SYNTHS,
  ...HIT_SYNTHS,
  ...DEATH_SYNTHS,
};

// Length of the one shared white-noise buffer. Long enough that looping
// continuous layers don't read as periodic and random-offset bursts stay
// uncorrelated; ~2s mono at 48kHz is ~384KB once, total.
const SHARED_NOISE_BUFFER_SECONDS = 2;

/** Subset of SoundCategory handled inside AudioManager — every value
 *  here gates one or more play methods below. `music` is excluded
 *  because musicPlayer owns music playback; the SOUNDS: button for
 *  music is wired directly to musicPlayer.start / stop in
 *  gameCanvasClientSettings. */
type AudioCategory = Exclude<SoundCategory, 'music'>;

class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private initialized = false;

  // Continuous sound tracking
  private activeLaserSounds: Map<number, ContinuousSound> = new Map();
  private activeShieldSounds: Map<number, ContinuousSound> = new Map();
  private pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private gainCleanupTimeouts = new Set<ReturnType<typeof setTimeout>>();

  // One shared white-noise buffer serves every burst and continuous noise
  // layer (sources start at random offsets) instead of filling a fresh
  // Math.random() AudioBuffer per sound — at battle scale that was hundreds
  // of buffer allocations per second.
  private sharedNoiseBuffer: AudioBuffer | null = null;

  // One-shot voice budget (AUDIO.voiceBudget): rolling-window counters.
  private voiceWindowStartMs = 0;
  private voiceStartsThisWindow = 0;
  private readonly voiceStartsBySynth = new Map<string, number>();

  // Volume controls
  public masterVolume = AUDIO.masterVolume;
  public sfxVolume = AUDIO.sfxVolume;
  public muted = true;

  /** Per-category mute gate (OTHER-1). Each category maps
   *  1:1 to one of the SOUNDS: buttons in the client control bar; when
   *  the button is OFF the matching play method short-circuits before
   *  building any audio nodes. The 'music' category never plays through
   *  AudioManager (musicPlayer owns it) and is intentionally absent.
   *  Defaults to "everything on" so a fresh AudioManager before the
   *  client settings have been applied still produces audio. */
  private categoryEnabled: Record<AudioCategory, boolean> = {
    fire: true,
    hit: true,
    dead: true,
    beam: true,
    field: true,
  };

  // Initialize audio context (must be called after user interaction)
  init(): void {
    if (this.initialized) return;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
    this.masterGain.connect(this.ctx.destination);
    this.initialized = true;
  }

  private ensureContext(): AudioContext | null {
    if (!this.ctx) this.init();
    if (this.ctx?.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // AudioToolkit — passed to synth functions so they can create nodes
  private getToolkit(): AudioToolkit | null {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return null;
    const mgain = this.masterGain;
    const sfx = this.sfxVolume;
    return {
      ctx,
      createGain: (volume: number = 1, autoDisconnectMs: number = 1000): GainNode | null => {
        const gain = ctx.createGain();
        gain.gain.value = volume * sfx;
        gain.connect(mgain);
        if (autoDisconnectMs > 0) {
          const timeoutId = setTimeout(() => {
            this.gainCleanupTimeouts.delete(timeoutId);
            try { gain.disconnect(); } catch {}
          }, autoDisconnectMs);
          this.gainCleanupTimeouts.add(timeoutId);
        }
        return gain;
      },
      createNoiseBuffer: (): AudioBuffer | null => {
        // Shared buffer: white noise is statistically identical everywhere,
        // so every consumer reads from one buffer (looping or starting at a
        // random offset) and schedules its own stop. The requested duration
        // is ignored — bursts are bounded by their explicit stop time and
        // loops wrap the shared buffer.
        if (this.sharedNoiseBuffer === null) {
          const length = Math.ceil(ctx.sampleRate * SHARED_NOISE_BUFFER_SECONDS);
          const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
          this.sharedNoiseBuffer = buffer;
        }
        return this.sharedNoiseBuffer;
      },
    };
  }

  // ==================== ONE-SHOT SOUNDS ====================

  /** One-shot voice budget: allow at most N synth starts per rolling
   *  window (and M per synth id) so hundred-event battle frames don't
   *  build hundreds of Web Audio node graphs the mix can't resolve
   *  anyway. Returns false when the budget is spent and the one-shot
   *  should simply be dropped. */
  private tryAcquireVoice(synthId: string): boolean {
    const budget = AUDIO.voiceBudget;
    const now = performance.now();
    if (now - this.voiceWindowStartMs >= budget.windowMs) {
      this.voiceWindowStartMs = now;
      this.voiceStartsThisWindow = 0;
      this.voiceStartsBySynth.clear();
    }
    if (this.voiceStartsThisWindow >= budget.maxStartsPerWindow) return false;
    const perSynth = this.voiceStartsBySynth.get(synthId) ?? 0;
    if (perSynth >= budget.maxStartsPerSynthPerWindow) return false;
    this.voiceStartsThisWindow++;
    this.voiceStartsBySynth.set(synthId, perSynth + 1);
    return true;
  }

  // Generic weapon fire by blueprint ID
  playWeaponFire(turretBlueprintId: TurretAudioId, _pitch: number = 1, volumeMultiplier: number = 1): void {
    if (!this.categoryEnabled.fire) return;
    if (!AUDIO.fireGain) return;
    let entry;
    try { entry = getTurretBlueprint(turretBlueprintId).audio?.fireSound; } catch { return; }
    if (!entry || !entry.volume) return;

    const fn = SYNTH_DISPATCH[entry.synth];
    if (!fn) return;
    if (!this.tryAcquireVoice(entry.synth)) return;

    const tk = this.getToolkit();
    if (!tk) return;

    const variation = 0.9 + Math.random() * 0.2;
    fn(tk, entry.playSpeed * variation, volumeMultiplier * entry.volume * AUDIO.fireGain);
  }

  // Generic hit by shot ID.
  playWeaponHit(shotBlueprintId: string, volumeMultiplier: number = 1): void {
    if (!this.categoryEnabled.hit) return;
    if (!AUDIO.hitGain) return;
    let entry;
    try { entry = getShotBlueprint(shotBlueprintId).hitSound; }
    catch {
      try { entry = getRayBlueprint(shotBlueprintId).hitSound; } catch { return; }
    }
    if (!entry || !entry.volume) return;

    const fn = SYNTH_DISPATCH[entry.synth];
    if (!fn) return;
    if (!this.tryAcquireVoice(entry.synth)) return;

    const tk = this.getToolkit();
    if (!tk) return;

    fn(tk, entry.playSpeed, volumeMultiplier * entry.volume * AUDIO.hitGain);
  }

  // Death sound based on dying unit blueprint
  playUnitDeath(unitBlueprintId: string, volumeMultiplier: number = 1): void {
    if (!this.categoryEnabled.dead) return;
    if (!AUDIO.deadGain) return;
    let entry;
    try { entry = getUnitBlueprint(unitBlueprintId).deathSound; } catch { return; }
    if (!entry || !entry.volume) return;

    const fn = SYNTH_DISPATCH[entry.synth];
    if (!fn) return;
    if (!this.tryAcquireVoice(entry.synth)) return;

    const tk = this.getToolkit();
    if (!tk) return;

    fn(tk, entry.playSpeed, volumeMultiplier * entry.volume * AUDIO.deadGain);
  }

  // ==================== CONTINUOUS SOUNDS ====================

  private getBeamFrequencyForTurret(turretBlueprintId: TurretAudioId | null | undefined): number | undefined {
    if (!turretBlueprintId) return undefined;
    try {
      const turret = getTurretBlueprint(turretBlueprintId);
      if (turret.emissionKind !== 'ray' || turret.emissionBlueprintId === null) return undefined;
      const ray = getRayBlueprint(turret.emissionBlueprintId);
      if (ray.type !== 'beam') return undefined;
      return beamSoundFrequencyFromHarmonicIndex(ray.continuousSound.harmonicSeriesIndex);
    } catch {
      return undefined;
    }
  }

  startLaserSoundForTurret(
    entityId: number,
    turretBlueprintId: TurretAudioId | null | undefined,
    volumeMultiplier: number = 1,
    zoomVolume: number = 1,
  ): void {
    this.startLaserSound(
      entityId,
      this.getBeamFrequencyForTurret(turretBlueprintId),
      volumeMultiplier,
      zoomVolume,
    );
  }

  startLaserSound(entityId: number, freqOverride: number | undefined, volumeMultiplier: number = 1, zoomVolume: number = 1): void {
    if (!this.categoryEnabled.beam) return;
    if (this.activeLaserSounds.has(entityId)) return;
    // Hard cap: at battle scale hundreds of beams can be live at once;
    // past the cap extra loops add node-graph cost but no audible
    // information, so they simply don't start.
    if (this.activeLaserSounds.size >= AUDIO.continuousVoiceCap.beam) return;
    const tk = this.getToolkit();
    if (!tk) return;
    // Attach sfxVolume so continuousSounds helper can read it
    (tk as unknown as { sfxVolume: number }).sfxVolume = this.sfxVolume;
    const config = getBeamConfig();
    if (freqOverride !== undefined) config.freq = freqOverride;
    const sound = startContinuousSound(tk, config, 1, volumeMultiplier, zoomVolume);
    if (sound) this.activeLaserSounds.set(entityId, sound);
  }

  stopLaserSound(entityId: number): void {
    const sound = this.activeLaserSounds.get(entityId);
    if (!sound || !this.ctx) return;
    stopContinuousSound(this.ctx, sound, 0.1, this.pendingTimeouts);
    this.activeLaserSounds.delete(entityId);
  }

  stopAllLaserSounds(): void {
    for (const entityId of this.activeLaserSounds.keys()) this.stopLaserSound(entityId);
  }

  startShieldSound(entityId: number, speed: number = 1, volumeMultiplier: number = 1, zoomVolume: number = 1): void {
    if (!this.categoryEnabled.field) return;
    if (this.activeShieldSounds.has(entityId)) return;
    if (this.activeShieldSounds.size >= AUDIO.continuousVoiceCap.field) return;
    const tk = this.getToolkit();
    if (!tk) return;
    (tk as unknown as { sfxVolume: number }).sfxVolume = this.sfxVolume;
    const sound = startContinuousSound(tk, getShieldConfig(), speed, volumeMultiplier, zoomVolume);
    if (sound) this.activeShieldSounds.set(entityId, sound);
  }

  stopShieldSound(entityId: number): void {
    const sound = this.activeShieldSounds.get(entityId);
    if (!sound || !this.ctx) return;
    stopContinuousSound(this.ctx, sound, 0.15, this.pendingTimeouts);
    this.activeShieldSounds.delete(entityId);
  }

  stopAllShieldSounds(): void {
    for (const entityId of this.activeShieldSounds.keys()) this.stopShieldSound(entityId);
  }

  stopAllContinuousSounds(): void {
    this.stopAllLaserSounds();
    this.stopAllShieldSounds();
  }

  stopAllContinuousSoundsNow(): void {
    for (const sound of this.activeLaserSounds.values()) {
      disposeContinuousSound(sound);
    }
    for (const sound of this.activeShieldSounds.values()) {
      disposeContinuousSound(sound);
    }
    this.activeLaserSounds.clear();
    this.activeShieldSounds.clear();
  }

  // Mute or unmute a continuous sound by ID
  setContinuousSoundAudible(entityId: number, audible: boolean): void {
    if (!this.ctx) return;
    const sound = this.activeLaserSounds.get(entityId) ?? this.activeShieldSounds.get(entityId);
    if (!sound) return;
    setContinuousAudible(this.ctx, sound, audible);
  }

  // Update zoom-based volume for a continuous sound
  updateContinuousSoundZoom(soundId: number, zoomVolume: number): void {
    if (!this.ctx) return;
    const sound = this.activeLaserSounds.get(soundId) ?? this.activeShieldSounds.get(soundId);
    if (!sound) return;
    updateContinuousZoom(this.ctx, sound, zoomVolume);
  }

  // ==================== DIRECT SYNTH ACCESS ====================

  // Play a raw synth by name (for sound test UI)
  playSynth(synthName: string, speed: number = 1, volume: number = 1): void {
    const fn = SYNTH_DISPATCH[synthName];
    if (!fn) return;
    const tk = this.getToolkit();
    if (!tk) return;
    fn(tk, speed, volume * this.sfxVolume);
  }

  // Get all available synth names
  getSynthNames(): string[] {
    return Object.keys(SYNTH_DISPATCH);
  }

  // ==================== VOLUME CONTROLS ====================

  getContext(): AudioContext | null { return this.ctx; }
  getMasterGain(): GainNode | null { return this.masterGain; }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
  }

  setSfxVolume(volume: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, volume));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) this.masterGain.gain.value = muted ? 0 : this.masterVolume;
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Enable / disable a SOUNDS: category from the client control bar
   *  (OTHER-1). Disabling 'beam' or 'field' also stops any
   *  continuous sound currently playing in that category — without this
   *  a beam that started before the user clicked OFF would keep
   *  looping until its laserStop event eventually arrived. The 'music'
   *  category is owned by musicPlayer; calls naming it here are a
   *  no-op so the toggle wiring in gameCanvasClientSettings can stay
   *  uniform across categories. */
  setCategoryEnabled(category: SoundCategory, enabled: boolean): void {
    if (category === 'music') return;
    this.categoryEnabled[category] = enabled;
    if (enabled) return;
    if (category === 'beam') this.stopAllLaserSounds();
    else if (category === 'field') this.stopAllShieldSounds();
  }

  destroy(): void {
    this.stopAllContinuousSoundsNow();
    for (const timeout of this.pendingTimeouts) clearTimeout(timeout);
    this.pendingTimeouts.clear();
    for (const timeout of this.gainCleanupTimeouts) clearTimeout(timeout);
    this.gainCleanupTimeouts.clear();
    try { this.masterGain?.disconnect(); } catch {}
    const ctx = this.ctx;
    if (ctx !== null && ctx.state !== 'closed') {
      void ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.masterGain = null;
    this.sharedNoiseBuffer = null;
    this.voiceWindowStartMs = 0;
    this.voiceStartsThisWindow = 0;
    this.voiceStartsBySynth.clear();
    this.initialized = false;
  }
}

// Singleton instance
export const audioManager = new AudioManager();
