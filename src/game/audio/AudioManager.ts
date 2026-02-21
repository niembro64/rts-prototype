// AudioManager — facade for all game audio (one-shot and continuous sounds)
// Delegates synth work to helper modules; owns AudioContext, master gain, and continuous sound state.

import { AUDIO } from '../../audioConfig';
import { getTurretBlueprint, getShotBlueprint, getUnitBlueprint } from '../sim/blueprints';
import type { AudioToolkit } from './audioHelpers';
import { FIRE_SYNTHS } from './fireSynths';
import { HIT_SYNTHS } from './hitSynths';
import { DEATH_SYNTHS } from './deathSynths';
import {
  type ContinuousSound,
  startContinuousSound,
  stopContinuousSound,
  setContinuousAudible,
  updateContinuousZoom,
  getBeamConfig,
  getForceFieldConfig,
} from './continuousSounds';

export type WeaponAudioId = string;

// Unified synth dispatch table
const SYNTH_DISPATCH: Record<string, (tk: AudioToolkit, speed: number, vol: number) => void> = {
  ...FIRE_SYNTHS,
  ...HIT_SYNTHS,
  ...DEATH_SYNTHS,
};

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private initialized = false;

  // Continuous sound tracking
  private activeLaserSounds: Map<number, ContinuousSound> = new Map();
  private activeForceFieldSounds: Map<number, ContinuousSound> = new Map();
  private pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

  // Volume controls
  public masterVolume = AUDIO.masterVolume;
  public sfxVolume = AUDIO.sfxVolume;
  public muted = true;

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
          setTimeout(() => { try { gain.disconnect(); } catch {} }, autoDisconnectMs);
        }
        return gain;
      },
      createNoiseBuffer: (duration: number): AudioBuffer | null => {
        const length = ctx.sampleRate * duration;
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        return buffer;
      },
    };
  }

  // ==================== ONE-SHOT SOUNDS ====================

  // Generic weapon fire by blueprint ID
  playWeaponFire(weaponId: WeaponAudioId, _pitch: number = 1, volumeMultiplier: number = 1): void {
    if (!AUDIO.fireGain) return;
    let entry;
    try { entry = getTurretBlueprint(weaponId).fireSound; } catch { return; }
    if (!entry || !entry.volume) return;

    const fn = SYNTH_DISPATCH[entry.synth];
    if (!fn) return;

    const tk = this.getToolkit();
    if (!tk) return;

    const variation = 0.9 + Math.random() * 0.2;
    fn(tk, entry.playSpeed * variation, volumeMultiplier * entry.volume * AUDIO.fireGain);
  }

  // Generic hit by projectile type ID
  playWeaponHit(projectileId: string, volumeMultiplier: number = 1): void {
    if (!AUDIO.hitGain) return;
    let entry;
    try { entry = getShotBlueprint(projectileId).hitSound; } catch { return; }
    if (!entry || !entry.volume) return;

    const fn = SYNTH_DISPATCH[entry.synth];
    if (!fn) return;

    const tk = this.getToolkit();
    if (!tk) return;

    fn(tk, entry.playSpeed, volumeMultiplier * entry.volume * AUDIO.hitGain);
  }

  // Death sound based on dying unit type
  playUnitDeath(unitType: string, volumeMultiplier: number = 1): void {
    if (!AUDIO.deadGain) return;
    let entry;
    try { entry = getUnitBlueprint(unitType).deathSound; } catch { return; }
    if (!entry || !entry.volume) return;

    const fn = SYNTH_DISPATCH[entry.synth];
    if (!fn) return;

    const tk = this.getToolkit();
    if (!tk) return;

    fn(tk, entry.playSpeed, volumeMultiplier * entry.volume * AUDIO.deadGain);
  }

  // ==================== CONTINUOUS SOUNDS ====================

  startLaserSound(entityId: number, freqOverride: number | undefined, volumeMultiplier: number = 1, zoomVolume: number = 1): void {
    if (this.activeLaserSounds.has(entityId)) return;
    const tk = this.getToolkit();
    if (!tk) return;
    // Attach sfxVolume so continuousSounds helper can read it
    (tk as unknown as { sfxVolume: number }).sfxVolume = this.sfxVolume;
    const config = getBeamConfig();
    if (freqOverride !== undefined) config.freq = freqOverride;
    const sound = startContinuousSound(tk, config, entityId, 1, volumeMultiplier, zoomVolume);
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
    for (const id of this.pendingTimeouts) clearTimeout(id);
    this.pendingTimeouts.clear();
  }

  startForceFieldSound(entityId: number, speed: number = 1, volumeMultiplier: number = 1, zoomVolume: number = 1): void {
    if (this.activeForceFieldSounds.has(entityId)) return;
    const tk = this.getToolkit();
    if (!tk) return;
    (tk as unknown as { sfxVolume: number }).sfxVolume = this.sfxVolume;
    const sound = startContinuousSound(tk, getForceFieldConfig(), entityId, speed, volumeMultiplier, zoomVolume);
    if (sound) this.activeForceFieldSounds.set(entityId, sound);
  }

  stopForceFieldSound(entityId: number): void {
    const sound = this.activeForceFieldSounds.get(entityId);
    if (!sound || !this.ctx) return;
    stopContinuousSound(this.ctx, sound, 0.15, this.pendingTimeouts);
    this.activeForceFieldSounds.delete(entityId);
  }

  stopAllForceFieldSounds(): void {
    for (const entityId of this.activeForceFieldSounds.keys()) this.stopForceFieldSound(entityId);
  }

  // Get active continuous sounds as [soundId, sourceEntityId] pairs
  getActiveContinuousSounds(): [number, number][] {
    const pairs: [number, number][] = [];
    for (const [soundId, sound] of this.activeLaserSounds) pairs.push([soundId, sound.sourceEntityId]);
    for (const [soundId, sound] of this.activeForceFieldSounds) pairs.push([soundId, sound.sourceEntityId]);
    return pairs;
  }

  // Mute or unmute a continuous sound by ID
  setContinuousSoundAudible(entityId: number, audible: boolean): void {
    if (!this.ctx) return;
    const sound = this.activeLaserSounds.get(entityId) ?? this.activeForceFieldSounds.get(entityId);
    if (!sound) return;
    setContinuousAudible(this.ctx, sound, audible);
  }

  // Update zoom-based volume for a continuous sound
  updateContinuousSoundZoom(soundId: number, zoomVolume: number): void {
    if (!this.ctx) return;
    const sound = this.activeLaserSounds.get(soundId) ?? this.activeForceFieldSounds.get(soundId);
    if (!sound) return;
    updateContinuousZoom(this.ctx, sound, zoomVolume);
  }

  // ==================== VOLUME CONTROLS ====================

  getContext(): AudioContext | null { return this.ctx; }
  getMasterGain(): GainNode | null { return this.masterGain; }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) this.masterGain.gain.value = this.masterVolume;
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
}

// Singleton instance
export const audioManager = new AudioManager();
