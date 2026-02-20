import { AUDIO } from '../../audioConfig';
import { getWeaponBlueprint, getProjectileBlueprint, getUnitBlueprint } from '../sim/blueprints';

// Procedural audio generation using Web Audio API

// Weapon type IDs for audio
export type WeaponAudioId = string;

// Active continuous sound (for lasers)
interface ContinuousSound {
  oscillator: OscillatorNode;
  gainNode: GainNode;
  noiseSource?: AudioBufferSourceNode;
  noiseGain?: GainNode;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private initialized = false;

  // Track active continuous sounds by entity ID
  private activeLaserSounds: Map<number, ContinuousSound> = new Map();
  private activeForceFieldSounds: Map<number, ContinuousSound> = new Map();

  // Track pending fade-out timeouts for cleanup
  private pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

  // Volume controls
  public masterVolume = AUDIO.masterVolume;
  public sfxVolume = AUDIO.sfxVolume;
  public muted = true;  // Default to muted

  // Initialize audio context (must be called after user interaction)
  init(): void {
    if (this.initialized) return;

    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
    this.masterGain.connect(this.ctx.destination);
    this.initialized = true;
  }

  // Ensure context is running (browsers suspend until user interaction)
  private ensureContext(): AudioContext | null {
    if (!this.ctx) {
      this.init();
    }
    if (this.ctx?.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  // Create a gain node with volume.
  // autoDisconnectMs: ms after which the gain is disconnected from the audio graph
  // to prevent node accumulation. Default 1000ms covers all one-shot sounds (<0.6s).
  // Pass 0 for continuous sounds (lasers) that manage their own lifecycle.
  private createGain(volume: number = 1, autoDisconnectMs: number = 1000): GainNode | null {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return null;

    const gain = ctx.createGain();
    gain.gain.value = volume * this.sfxVolume;
    gain.connect(this.masterGain);

    if (autoDisconnectMs > 0) {
      setTimeout(() => {
        try { gain.disconnect(); } catch {}
      }, autoDisconnectMs);
    }

    return gain;
  }

  // Create noise buffer for explosions/impacts
  private createNoiseBuffer(duration: number): AudioBuffer | null {
    const ctx = this.ensureContext();
    if (!ctx) return null;

    const sampleRate = ctx.sampleRate;
    const length = sampleRate * duration;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    return buffer;
  }

  // ==================== WEAPON FIRE SOUNDS ====================

  // Start continuous laser sound (call when beam starts)
  startLaserSound(entityId: number, speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Don't start if already playing for this entity
    if (this.activeLaserSounds.has(entityId)) return;

    // Main oscillator - continuous tone (no auto-disconnect for continuous sounds)
    const osc = ctx.createOscillator();
    const gain = this.createGain(0.15 * volumeMultiplier, 0);
    if (!gain) return;

    osc.type = 'sawtooth';
    osc.frequency.value = 180 * speed;

    // Add slight wobble for more interesting sound
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 8 * speed; // 8 Hz wobble
    lfoGain.gain.value = 15 * speed; // ±15 Hz variation
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start();

    // Filter for warmth
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200 * speed;
    filter.Q.value = 2;

    // Smooth fade in from near-zero (no click)
    // Use linear ramp for smooth start from silence
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(
      0.2 * this.sfxVolume * volumeMultiplier,
      ctx.currentTime + 0.12
    );

    osc.connect(filter).connect(gain);
    osc.start();

    // Add high-frequency hiss/crackle layer
    const noiseBuffer = this.createNoiseBuffer(10); // Long buffer for looping
    let noiseSource: AudioBufferSourceNode | undefined;
    let noiseGain: GainNode | undefined;

    if (noiseBuffer) {
      noiseSource = ctx.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 4000 * speed;
      noiseFilter.Q.value = 1;

      // Create noise gain with fade-in (no click, no auto-disconnect for continuous)
      noiseGain = this.createGain(0, 0) ?? undefined;
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.0001, ctx.currentTime);
        noiseGain.gain.linearRampToValueAtTime(
          0.08 * this.sfxVolume * volumeMultiplier,
          ctx.currentTime + 0.12
        );
        noiseSource.connect(noiseFilter).connect(noiseGain);
        noiseSource.start();
      }
    }

    // Store reference to stop later
    this.activeLaserSounds.set(entityId, {
      oscillator: osc,
      gainNode: gain,
      noiseSource,
      noiseGain,
    });
  }

  // Stop continuous laser sound (call when beam ends)
  stopLaserSound(entityId: number): void {
    const sound = this.activeLaserSounds.get(entityId);
    if (!sound) return;

    const ctx = this.ctx;
    if (!ctx) return;

    // Smooth fade out to near-zero (no click)
    const fadeTime = 0.1;
    sound.gainNode.gain.linearRampToValueAtTime(
      0.0001,
      ctx.currentTime + fadeTime
    );
    if (sound.noiseGain) {
      sound.noiseGain.gain.linearRampToValueAtTime(
        0.0001,
        ctx.currentTime + fadeTime
      );
    }

    // Stop after fade completes
    const timeoutId = setTimeout(() => {
      this.pendingTimeouts.delete(timeoutId);
      try {
        sound.oscillator.stop();
        sound.noiseSource?.stop();
      } catch {
        // Ignore if already stopped
      }
    }, fadeTime * 1000 + 20);
    this.pendingTimeouts.add(timeoutId);

    this.activeLaserSounds.delete(entityId);
  }

  // Stop all laser sounds (cleanup)
  stopAllLaserSounds(): void {
    for (const entityId of this.activeLaserSounds.keys()) {
      this.stopLaserSound(entityId);
    }
    // Clear any remaining pending timeouts
    for (const id of this.pendingTimeouts) {
      clearTimeout(id);
    }
    this.pendingTimeouts.clear();
  }

  // Start continuous force field sound (call when force field becomes active)
  startForceFieldSound(entityId: number, speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Don't start if already playing for this entity
    if (this.activeForceFieldSounds.has(entityId)) return;

    // Deep resonant hum (no auto-disconnect for continuous sounds)
    const osc = ctx.createOscillator();
    const gain = this.createGain(0, 0);
    if (!gain) return;

    osc.type = 'triangle';
    osc.frequency.value = 60 * speed;

    // Slow wobble for pulsing effect
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 3 * speed;
    lfoGain.gain.value = 8 * speed;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start();

    // Lowpass for warmth
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400 * speed;
    filter.Q.value = 3;

    // Smooth fade in
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(
      0.12 * this.sfxVolume * volumeMultiplier,
      ctx.currentTime + 0.2
    );

    osc.connect(filter).connect(gain);
    osc.start();

    // Add filtered noise layer for texture
    const noiseBuffer = this.createNoiseBuffer(10);
    let noiseSource: AudioBufferSourceNode | undefined;
    let noiseGain: GainNode | undefined;

    if (noiseBuffer) {
      noiseSource = ctx.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 200 * speed;
      noiseFilter.Q.value = 2;

      noiseGain = this.createGain(0, 0) ?? undefined;
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.0001, ctx.currentTime);
        noiseGain.gain.linearRampToValueAtTime(
          0.04 * this.sfxVolume * volumeMultiplier,
          ctx.currentTime + 0.2
        );
        noiseSource.connect(noiseFilter).connect(noiseGain);
        noiseSource.start();
      }
    }

    this.activeForceFieldSounds.set(entityId, {
      oscillator: osc,
      gainNode: gain,
      noiseSource,
      noiseGain,
    });
  }

  // Stop continuous force field sound (call when force field deactivates)
  stopForceFieldSound(entityId: number): void {
    const sound = this.activeForceFieldSounds.get(entityId);
    if (!sound) return;

    const ctx = this.ctx;
    if (!ctx) return;

    const fadeTime = 0.15;
    sound.gainNode.gain.linearRampToValueAtTime(
      0.0001,
      ctx.currentTime + fadeTime
    );
    if (sound.noiseGain) {
      sound.noiseGain.gain.linearRampToValueAtTime(
        0.0001,
        ctx.currentTime + fadeTime
      );
    }

    const timeoutId = setTimeout(() => {
      this.pendingTimeouts.delete(timeoutId);
      try {
        sound.oscillator.stop();
        sound.noiseSource?.stop();
      } catch {
        // Ignore if already stopped
      }
    }, fadeTime * 1000 + 20);
    this.pendingTimeouts.add(timeoutId);

    this.activeForceFieldSounds.delete(entityId);
  }

  // Stop all force field sounds (cleanup)
  stopAllForceFieldSounds(): void {
    for (const entityId of this.activeForceFieldSounds.keys()) {
      this.stopForceFieldSound(entityId);
    }
  }

  // Legacy method for compatibility - now starts continuous sound briefly
  playLaserFire(speed: number = 1, volumeMultiplier: number = 1): void {
    // For single-shot laser effects (like railgun), use a short burst
    const ctx = this.ensureContext();
    if (!ctx) return;

    const gain = this.createGain(0.2 * volumeMultiplier);
    if (!gain) return;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300 * speed, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      150 * speed,
      ctx.currentTime + 0.12 / speed
    );

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1500;

    gain.gain.setValueAtTime(0.25 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12 / speed);

    osc.connect(filter).connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.12 / speed);
  }

  // Minigun fire - short punchy noise burst
  playMinigunFire(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const gain = this.createGain(0.15 * volumeMultiplier);
    if (!gain) return;

    // Noise component
    const noiseBuffer = this.createNoiseBuffer(0.05 / speed);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500 * speed;
    filter.Q.value = 2;

    gain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.04 / speed);

    noise.connect(filter).connect(gain);
    noise.start();

    // Add a tiny click/pop
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.1 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'square';
      osc.frequency.value = 150 * speed;
      oscGain.gain.setValueAtTime(0.2 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.02 / speed);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.02 / speed);
    }
  }

  // Cannon fire - deep boom
  playCannonFire(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Low frequency boom
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.35 * volumeMultiplier);
    if (!oscGain) return;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 * speed, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      40 * speed,
      ctx.currentTime + 0.3 / speed
    );

    oscGain.gain.setValueAtTime(0.5 * volumeMultiplier, ctx.currentTime);
    oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3 / speed);

    osc.connect(oscGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.3 / speed);

    // Noise burst for texture
    const noiseBuffer = this.createNoiseBuffer(0.2 / speed);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const noiseGain = this.createGain(0.2 * volumeMultiplier);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.2 / speed);

    if (noiseGain) {
      noiseGain.gain.setValueAtTime(0.3 * volumeMultiplier, ctx.currentTime);
      noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2 / speed);
      noise.connect(filter).connect(noiseGain);
      noise.start();
    }
  }

  // Shotgun fire - chunky blast
  playShotgunFire(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Multiple layered noise bursts
    for (let i = 0; i < 3; i++) {
      const delay = i * 0.008 / speed;
      const noiseBuffer = this.createNoiseBuffer(0.1 / speed);
      if (!noiseBuffer) continue;

      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = (800 + i * 400) * speed;
      filter.Q.value = 1;

      const gain = this.createGain(0.2 * volumeMultiplier);
      if (!gain) continue;

      gain.gain.setValueAtTime(
        0.35 * volumeMultiplier,
        ctx.currentTime + delay
      );
      gain.gain.exponentialRampToValueAtTime(
        0.01,
        ctx.currentTime + delay + 0.08 / speed
      );

      noise.connect(filter).connect(gain);
      noise.start(ctx.currentTime + delay);
    }

    // Add a bass thump
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.25 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(100 * speed, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(
        50 * speed,
        ctx.currentTime + 0.1 / speed
      );
      oscGain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1 / speed);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.1 / speed);
    }
  }

  // Grenade launcher - thunk sound
  playGrenadeFire(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = this.createGain(0.3 * volumeMultiplier);
    if (!gain) return;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200 * speed, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      80 * speed,
      ctx.currentTime + 0.12 / speed
    );

    gain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12 / speed);

    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.12 / speed);
  }

  // Railgun - electric zap
  playRailgunFire(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // High frequency zap
    const osc1 = ctx.createOscillator();
    const gain1 = this.createGain(0.2 * volumeMultiplier);
    if (gain1) {
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(2000 * speed, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(
        500 * speed,
        ctx.currentTime + 0.1 / speed
      );
      gain1.gain.setValueAtTime(0.25 * volumeMultiplier, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1 / speed);
      osc1.connect(gain1);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.1 / speed);
    }

    // Electric crackle
    const noiseBuffer = this.createNoiseBuffer(0.15 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 3000;

      const noiseGain = this.createGain(0.15 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.2 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.15 / speed
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Burst rifle - quick triple tap
  playBurstRifleFire(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Single shot sound (will be called multiple times by burst logic)
    const noiseBuffer = this.createNoiseBuffer(0.04 / speed);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2000 * speed;
    filter.Q.value = 1.5;

    const gain = this.createGain(0.2 * volumeMultiplier);
    if (!gain) return;

    gain.gain.setValueAtTime(0.3 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.04 / speed);

    noise.connect(filter).connect(gain);
    noise.start();
  }

  // Insect fire - rapid chittery clicks
  playInsectFire(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const gain = this.createGain(0.15 * volumeMultiplier);
    if (!gain) return;

    // High-frequency click/chirp
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(800 * speed, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      400 * speed,
      ctx.currentTime + 0.03 / speed
    );

    // Bandpass filter for that insect-like quality
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200 * speed;
    filter.Q.value = 3;

    gain.gain.setValueAtTime(0.25 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.03 / speed);

    osc.connect(filter).connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.03 / speed);

    // Add tiny noise burst for texture
    const noiseBuffer = this.createNoiseBuffer(0.02 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'highpass';
      noiseFilter.frequency.value = 3000;

      const noiseGain = this.createGain(0.08 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.1 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.02 / speed
        );
        noise.connect(noiseFilter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Force field - deep resonant pulse
  playForceFieldFire(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Deep bass pulse
    const osc1 = ctx.createOscillator();
    const gain1 = this.createGain(0.35 * volumeMultiplier);
    if (gain1) {
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(80 * speed, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(
        40 * speed,
        ctx.currentTime + 0.25 / speed
      );
      gain1.gain.setValueAtTime(0.5 * volumeMultiplier, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25 / speed);
      osc1.connect(gain1);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.25 / speed);
    }

    // Mid-range resonant tone
    const osc2 = ctx.createOscillator();
    const gain2 = this.createGain(0.25 * volumeMultiplier);
    if (gain2) {
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(200 * speed, ctx.currentTime);
      osc2.frequency.exponentialRampToValueAtTime(
        100 * speed,
        ctx.currentTime + 0.2 / speed
      );
      gain2.gain.setValueAtTime(0.35 * volumeMultiplier, ctx.currentTime);
      gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2 / speed);
      osc2.connect(gain2);
      osc2.start();
      osc2.stop(ctx.currentTime + 0.2 / speed);
    }

    // High frequency shimmer
    const noiseBuffer = this.createNoiseBuffer(0.15 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 2500;
      filter.Q.value = 2;

      const noiseGain = this.createGain(0.15 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.2 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.15 / speed
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Unified synth dispatch table — any synth can be used for any sound slot
  private static SYNTH_DISPATCH: Record<string, (this: AudioManager, speed: number, vol: number) => void> = {
    // One-shot percussive / tonal
    'laser-zap':        AudioManager.prototype.playLaserFire,
    'minigun':          AudioManager.prototype.playMinigunFire,
    'cannon':           AudioManager.prototype.playCannonFire,
    'shotgun':          AudioManager.prototype.playShotgunFire,
    'grenade':          AudioManager.prototype.playGrenadeFire,
    'railgun':          AudioManager.prototype.playRailgunFire,
    'burst-rifle':      AudioManager.prototype.playBurstRifleFire,
    'force-field':      AudioManager.prototype.playForceFieldFire,
    'insect':           AudioManager.prototype.playInsectFire,
    'sizzle':           AudioManager.prototype.playLaserHit,
    'bullet':           AudioManager.prototype.playBulletHit,
    'heavy':            AudioManager.prototype.playHeavyHit,
    'explosion':        AudioManager.prototype.playExplosionHit,
    'small-explosion':  AudioManager.prototype.playSmallDeath,
    'medium-explosion': AudioManager.prototype.playMediumDeath,
    'large-explosion':  AudioManager.prototype.playLargeDeath,
  };

  // Generic weapon fire by ID
  playWeaponFire(
    weaponId: WeaponAudioId,
    _pitch: number = 1,
    volumeMultiplier: number = 1
  ): void {
    if (!AUDIO.turrets.fireGain) return;
    let entry;
    try { entry = getWeaponBlueprint(weaponId).fireSound; } catch { return; }
    if (!entry || !entry.volume) return;

    const fn = AudioManager.SYNTH_DISPATCH[entry.synth];
    if (!fn) return;

    const variation = 0.9 + Math.random() * 0.2;
    fn.call(this, entry.playSpeed * variation, volumeMultiplier * entry.volume * AUDIO.turrets.fireGain);
  }

  // ==================== HIT SOUNDS ====================

  // Laser hit - sizzle
  playLaserHit(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const noiseBuffer = this.createNoiseBuffer(0.08 / speed);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 4000;

    const gain = this.createGain(0.15 * volumeMultiplier);
    if (!gain) return;

    gain.gain.setValueAtTime(0.2 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08 / speed);

    noise.connect(filter).connect(gain);
    noise.start();
  }

  // Bullet hit - short metallic tick/ping
  playBulletHit(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    // U-shaped: lows + highs, scooped mids

    // Layer 1: Low sub-thump (sine, fast decay)
    const lowOsc = ctx.createOscillator();
    const lowGain = this.createGain(0.18 * volumeMultiplier);
    if (!lowGain) return;

    lowOsc.type = 'sine';
    lowOsc.frequency.setValueAtTime(100 * speed, t);
    lowOsc.frequency.exponentialRampToValueAtTime(50 * speed, t + 0.03 / speed);

    lowGain.gain.setValueAtTime(0.18 * volumeMultiplier, t);
    lowGain.gain.exponentialRampToValueAtTime(0.01, t + 0.04 / speed);

    lowOsc.connect(lowGain);
    lowOsc.start(t);
    lowOsc.stop(t + 0.04 / speed);

    // Layer 2: High-frequency crack (square, very short)
    const hiOsc = ctx.createOscillator();
    const hiGain = this.createGain(0.12 * volumeMultiplier);
    if (!hiGain) return;

    hiOsc.type = 'square';
    hiOsc.frequency.setValueAtTime(4000 * speed, t);
    hiOsc.frequency.exponentialRampToValueAtTime(2000 * speed, t + 0.008 / speed);

    hiGain.gain.setValueAtTime(0.12 * volumeMultiplier, t);
    hiGain.gain.exponentialRampToValueAtTime(0.01, t + 0.012 / speed);

    // Highpass to keep only the sizzle
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500 * speed;

    hiOsc.connect(hp).connect(hiGain);
    hiOsc.start(t);
    hiOsc.stop(t + 0.012 / speed);

    // Layer 3: Noise burst through notch (scoop 800-2000Hz mids)
    const noiseBuffer = this.createNoiseBuffer(0.02 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const notch = ctx.createBiquadFilter();
      notch.type = 'notch';
      notch.frequency.value = 1200 * speed;
      notch.Q.value = 1.0;

      const noiseGain = this.createGain(0.08 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.08 * volumeMultiplier, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.02 / speed);
        noise.connect(notch).connect(noiseGain);
        noise.start(t);
      }
    }
  }

  // Heavy hit (cannon)
  playHeavyHit(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = this.createGain(0.3 * volumeMultiplier);
    if (!gain) return;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(150 * speed, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(50 * speed, ctx.currentTime + 0.15 / speed);

    gain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15 / speed);

    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.15 / speed);

    // Impact noise
    const noiseBuffer = this.createNoiseBuffer(0.1 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 800;

      const noiseGain = this.createGain(0.2 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.25 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.1 / speed
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Explosion hit (grenade splash)
  playExplosionHit(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Low boom
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.35 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80 * speed, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(20 * speed, ctx.currentTime + 0.4 / speed);
      oscGain.gain.setValueAtTime(0.5 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4 / speed);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.4 / speed);
    }

    // Explosion noise
    const noiseBuffer = this.createNoiseBuffer(0.4 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2000, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.4 / speed);

      const noiseGain = this.createGain(0.3 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.4 / speed
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Generic hit by projectile type ID
  playWeaponHit(projectileId: string, volumeMultiplier: number = 1): void {
    if (!AUDIO.projectiles.hitGain) return;
    let entry;
    try { entry = getProjectileBlueprint(projectileId).hitSound; } catch { return; }
    if (!entry || !entry.volume) return;
    const fn = AudioManager.SYNTH_DISPATCH[entry.synth];
    if (fn) fn.call(this, entry.playSpeed, volumeMultiplier * entry.volume * AUDIO.projectiles.hitGain);
  }

  // ==================== DEATH SOUNDS ====================

  // Small unit death - quick punchy explosion
  playSmallDeath(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Sharp attack thump
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.3 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(200 * speed, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40 * speed, ctx.currentTime + 0.12 / speed);
      oscGain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12 / speed);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.12 / speed);
    }

    // Explosion burst noise
    const noiseBuffer = this.createNoiseBuffer(0.18 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2500, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(
        400,
        ctx.currentTime + 0.18 / speed
      );

      const noiseGain = this.createGain(0.25 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.35 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.18 / speed
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Medium unit death - solid explosion with debris
  playMediumDeath(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Main explosion thump
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.35 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120 * speed, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(25 * speed, ctx.currentTime + 0.25 / speed);
      oscGain.gain.setValueAtTime(0.45 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25 / speed);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.25 / speed);
    }

    // Secondary mid-freq punch
    const osc2 = ctx.createOscillator();
    const osc2Gain = this.createGain(0.2 * volumeMultiplier);
    if (osc2Gain) {
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(180 * speed, ctx.currentTime);
      osc2.frequency.exponentialRampToValueAtTime(50 * speed, ctx.currentTime + 0.2 / speed);
      osc2Gain.gain.setValueAtTime(0.3 * volumeMultiplier, ctx.currentTime);
      osc2Gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2 / speed);
      osc2.connect(osc2Gain);
      osc2.start();
      osc2.stop(ctx.currentTime + 0.2 / speed);
    }

    // Explosion noise burst
    const noiseBuffer = this.createNoiseBuffer(0.3 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(3500, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.3 / speed);

      const noiseGain = this.createGain(0.3 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.3 / speed
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Large unit death - massive explosion with rumble
  playLargeDeath(speed: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Deep powerful boom
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.45 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80 * speed, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(15 * speed, ctx.currentTime + 0.5 / speed);
      oscGain.gain.setValueAtTime(0.55 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5 / speed);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.5 / speed);
    }

    // Secondary rumble layer
    const osc2 = ctx.createOscillator();
    const osc2Gain = this.createGain(0.35 * volumeMultiplier);
    if (osc2Gain) {
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(100 * speed, ctx.currentTime + 0.02 / speed);
      osc2.frequency.exponentialRampToValueAtTime(20 * speed, ctx.currentTime + 0.45 / speed);
      osc2Gain.gain.setValueAtTime(
        0.4 * volumeMultiplier,
        ctx.currentTime + 0.02 / speed
      );
      osc2Gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45 / speed);
      osc2.connect(osc2Gain);
      osc2.start(ctx.currentTime + 0.02 / speed);
      osc2.stop(ctx.currentTime + 0.45 / speed);
    }

    // Third sub-bass layer for weight
    const osc3 = ctx.createOscillator();
    const osc3Gain = this.createGain(0.3 * volumeMultiplier);
    if (osc3Gain) {
      osc3.type = 'sine';
      osc3.frequency.setValueAtTime(40 * speed, ctx.currentTime);
      osc3.frequency.exponentialRampToValueAtTime(12 * speed, ctx.currentTime + 0.6 / speed);
      osc3Gain.gain.setValueAtTime(0.35 * volumeMultiplier, ctx.currentTime);
      osc3Gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6 / speed);
      osc3.connect(osc3Gain);
      osc3.start();
      osc3.stop(ctx.currentTime + 0.6 / speed);
    }

    // Heavy explosion noise
    const noiseBuffer = this.createNoiseBuffer(0.55 / speed);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(4000, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.55 / speed);

      const noiseGain = this.createGain(0.4 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.5 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.55 / speed
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Death sound based on dying unit type
  playUnitDeath(unitType: string, volumeMultiplier: number = 1): void {
    if (!AUDIO.units.deathGain) return;
    let entry;
    try { entry = getUnitBlueprint(unitType).deathSound; } catch { return; }
    if (!entry || !entry.volume) return;
    const fn = AudioManager.SYNTH_DISPATCH[entry.synth];
    if (fn) fn.call(this, entry.playSpeed, volumeMultiplier * entry.volume * AUDIO.units.deathGain);
  }

  // Set master volume (0-1)
  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) {
      this.masterGain.gain.value = this.masterVolume;
    }
  }

  // Set SFX volume (0-1)
  setSfxVolume(volume: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, volume));
  }

  // Toggle mute
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.value = muted ? 0 : this.masterVolume;
    }
  }

  // Toggle mute and return new state
  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }
}

// Singleton instance
export const audioManager = new AudioManager();
