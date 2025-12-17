// Procedural audio generation using Web Audio API

// Weapon type IDs for audio
export type WeaponAudioId =
  | 'beam'
  | 'minigun'
  | 'cannon'
  | 'shotgun'
  | 'grenade'
  | 'railgun'
  | 'burst-rifle'
  | 'sonic-wave';

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

  // Volume controls
  public masterVolume = 0.3;
  public sfxVolume = 0.5;
  public muted = true;  // Default to muted

  // Initialize audio context (must be called after user interaction)
  init(): void {
    if (this.initialized) return;

    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.masterVolume;
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

  // Create a gain node with volume
  private createGain(volume: number = 1): GainNode | null {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return null;

    const gain = ctx.createGain();
    gain.gain.value = volume * this.sfxVolume;
    gain.connect(this.masterGain);
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
  startLaserSound(entityId: number, pitch: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Don't start if already playing for this entity
    if (this.activeLaserSounds.has(entityId)) return;

    // Main oscillator - continuous tone
    const osc = ctx.createOscillator();
    const gain = this.createGain(0.15);
    if (!gain) return;

    osc.type = 'sawtooth';
    osc.frequency.value = 180 * pitch;

    // Add slight wobble for more interesting sound
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 8; // 8 Hz wobble
    lfoGain.gain.value = 15; // ±15 Hz variation
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start();

    // Filter for warmth
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.Q.value = 2;

    // Smooth fade in from near-zero (no click)
    // Use linear ramp for smooth start from silence
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(
      0.2 * this.sfxVolume,
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
      noiseFilter.frequency.value = 4000;
      noiseFilter.Q.value = 1;

      // Create noise gain with fade-in (no click)
      noiseGain = this.createGain(0) ?? undefined;
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.0001, ctx.currentTime);
        noiseGain.gain.linearRampToValueAtTime(
          0.08 * this.sfxVolume,
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
    setTimeout(() => {
      try {
        sound.oscillator.stop();
        sound.noiseSource?.stop();
      } catch {
        // Ignore if already stopped
      }
    }, fadeTime * 1000 + 20);

    this.activeLaserSounds.delete(entityId);
  }

  // Stop all laser sounds (cleanup)
  stopAllLaserSounds(): void {
    for (const entityId of this.activeLaserSounds.keys()) {
      this.stopLaserSound(entityId);
    }
  }

  // Legacy method for compatibility - now starts continuous sound briefly
  playLaserFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    // For single-shot laser effects (like railgun), use a short burst
    const ctx = this.ensureContext();
    if (!ctx) return;

    const gain = this.createGain(0.2 * volumeMultiplier);
    if (!gain) return;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300 * pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      150 * pitch,
      ctx.currentTime + 0.12
    );

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1500;

    gain.gain.setValueAtTime(0.25 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);

    osc.connect(filter).connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  }

  // Minigun fire - short punchy noise burst
  playMinigunFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const gain = this.createGain(0.15 * volumeMultiplier);
    if (!gain) return;

    // Noise component
    const noiseBuffer = this.createNoiseBuffer(0.05);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500 * pitch;
    filter.Q.value = 2;

    gain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.04);

    noise.connect(filter).connect(gain);
    noise.start();

    // Add a tiny click/pop
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.1 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'square';
      osc.frequency.value = 150 * pitch;
      oscGain.gain.setValueAtTime(0.2 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.02);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
    }
  }

  // Cannon fire - deep boom
  playCannonFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Low frequency boom
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.35 * volumeMultiplier);
    if (!oscGain) return;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 * pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      40 * pitch,
      ctx.currentTime + 0.3
    );

    oscGain.gain.setValueAtTime(0.5 * volumeMultiplier, ctx.currentTime);
    oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    osc.connect(oscGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);

    // Noise burst for texture
    const noiseBuffer = this.createNoiseBuffer(0.2);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const noiseGain = this.createGain(0.2 * volumeMultiplier);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.2);

    if (noiseGain) {
      noiseGain.gain.setValueAtTime(0.3 * volumeMultiplier, ctx.currentTime);
      noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      noise.connect(filter).connect(noiseGain);
      noise.start();
    }
  }

  // Shotgun fire - chunky blast
  playShotgunFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Multiple layered noise bursts
    for (let i = 0; i < 3; i++) {
      const delay = i * 0.008;
      const noiseBuffer = this.createNoiseBuffer(0.1);
      if (!noiseBuffer) continue;

      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = (800 + i * 400) * pitch;
      filter.Q.value = 1;

      const gain = this.createGain(0.2 * volumeMultiplier);
      if (!gain) continue;

      gain.gain.setValueAtTime(
        0.35 * volumeMultiplier,
        ctx.currentTime + delay
      );
      gain.gain.exponentialRampToValueAtTime(
        0.01,
        ctx.currentTime + delay + 0.08
      );

      noise.connect(filter).connect(gain);
      noise.start(ctx.currentTime + delay);
    }

    // Add a bass thump
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.25 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(100 * pitch, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(
        50 * pitch,
        ctx.currentTime + 0.1
      );
      oscGain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    }
  }

  // Grenade launcher - thunk sound
  playGrenadeFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = this.createGain(0.3 * volumeMultiplier);
    if (!gain) return;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200 * pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      80 * pitch,
      ctx.currentTime + 0.12
    );

    gain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);

    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  }

  // Railgun - electric zap
  playRailgunFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // High frequency zap
    const osc1 = ctx.createOscillator();
    const gain1 = this.createGain(0.2 * volumeMultiplier);
    if (gain1) {
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(2000 * pitch, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(
        500 * pitch,
        ctx.currentTime + 0.1
      );
      gain1.gain.setValueAtTime(0.25 * volumeMultiplier, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc1.connect(gain1);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.1);
    }

    // Electric crackle
    const noiseBuffer = this.createNoiseBuffer(0.15);
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
          ctx.currentTime + 0.15
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Burst rifle - quick triple tap
  playBurstRifleFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Single shot sound (will be called multiple times by burst logic)
    const noiseBuffer = this.createNoiseBuffer(0.04);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2000 * pitch;
    filter.Q.value = 1.5;

    const gain = this.createGain(0.2 * volumeMultiplier);
    if (!gain) return;

    gain.gain.setValueAtTime(0.3 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.04);

    noise.connect(filter).connect(gain);
    noise.start();
  }

  // Insect fire - rapid chittery clicks
  playInsectFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const gain = this.createGain(0.15 * volumeMultiplier);
    if (!gain) return;

    // High-frequency click/chirp
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(800 * pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      400 * pitch,
      ctx.currentTime + 0.03
    );

    // Bandpass filter for that insect-like quality
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200 * pitch;
    filter.Q.value = 3;

    gain.gain.setValueAtTime(0.25 * volumeMultiplier, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.03);

    osc.connect(filter).connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.03);

    // Add tiny noise burst for texture
    const noiseBuffer = this.createNoiseBuffer(0.02);
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
          ctx.currentTime + 0.02
        );
        noise.connect(noiseFilter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Widow sonic - deep resonant pulse
  playSonicWaveFire(pitch: number = 1, volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Deep bass pulse
    const osc1 = ctx.createOscillator();
    const gain1 = this.createGain(0.35 * volumeMultiplier);
    if (gain1) {
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(80 * pitch, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(
        40 * pitch,
        ctx.currentTime + 0.25
      );
      gain1.gain.setValueAtTime(0.5 * volumeMultiplier, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      osc1.connect(gain1);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.25);
    }

    // Mid-range resonant tone
    const osc2 = ctx.createOscillator();
    const gain2 = this.createGain(0.25 * volumeMultiplier);
    if (gain2) {
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(200 * pitch, ctx.currentTime);
      osc2.frequency.exponentialRampToValueAtTime(
        100 * pitch,
        ctx.currentTime + 0.2
      );
      gain2.gain.setValueAtTime(0.35 * volumeMultiplier, ctx.currentTime);
      gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      osc2.connect(gain2);
      osc2.start();
      osc2.stop(ctx.currentTime + 0.2);
    }

    // High frequency shimmer
    const noiseBuffer = this.createNoiseBuffer(0.15);
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
          ctx.currentTime + 0.15
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Generic weapon fire by ID
  playWeaponFire(
    weaponId: WeaponAudioId,
    pitch: number = 1,
    volumeMultiplier: number = 1
  ): void {
    // Add slight random variation
    const variation = 0.9 + Math.random() * 0.2;
    const finalPitch = pitch * variation;

    switch (weaponId) {
      case 'beam':
        this.playLaserFire(finalPitch, volumeMultiplier);
        break;
      case 'minigun':
        this.playMinigunFire(finalPitch, volumeMultiplier * 0.2);
        break;
      case 'cannon':
        this.playCannonFire(finalPitch, volumeMultiplier);
        break;
      case 'shotgun':
        this.playShotgunFire(finalPitch, volumeMultiplier);
        break;
      case 'grenade':
        this.playGrenadeFire(finalPitch, volumeMultiplier);
        break;
      case 'railgun':
        this.playRailgunFire(finalPitch, volumeMultiplier * 0.3);
        break;
      case 'burst-rifle':
        this.playBurstRifleFire(finalPitch, volumeMultiplier);
        break;
      case 'sonic-wave':
        this.playSonicWaveFire(finalPitch, volumeMultiplier * 0.01);
        break;
      default:
        // throw error
        throw new Error(`Unknown weapon ID: ${weaponId}`);
    }
  }

  // ==================== HIT SOUNDS ====================

  // Laser hit - sizzle
  playLaserHit(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const noiseBuffer = this.createNoiseBuffer(0.08);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 4000;

    const gain = this.createGain(0.15);
    if (!gain) return;

    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);

    noise.connect(filter).connect(gain);
    noise.start();
  }

  // Bullet hit - thud/impact
  playBulletHit(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = this.createGain(0.2);
    if (!gain) return;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.05);

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);

    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);

    // Small noise burst
    const noiseBuffer = this.createNoiseBuffer(0.03);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1500;

      const noiseGain = this.createGain(0.1);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.15, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.03
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Heavy hit (cannon)
  playHeavyHit(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = this.createGain(0.3);
    if (!gain) return;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);

    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);

    // Impact noise
    const noiseBuffer = this.createNoiseBuffer(0.1);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 800;

      const noiseGain = this.createGain(0.2);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.25, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.1
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Explosion hit (grenade splash)
  playExplosionHit(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Low boom
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.35);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 0.4);
      oscGain.gain.setValueAtTime(0.5, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    }

    // Explosion noise
    const noiseBuffer = this.createNoiseBuffer(0.4);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2000, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.4);

      const noiseGain = this.createGain(0.3);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.4, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.4
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Generic hit by weapon ID
  playWeaponHit(weaponId: WeaponAudioId): void {
    switch (weaponId) {
      case 'beam':
      case 'railgun':
        this.playLaserHit();
        break;
      case 'cannon':
        this.playHeavyHit();
        break;
      case 'grenade':
        this.playExplosionHit();
        break;
      default:
        this.playBulletHit();
    }
  }

  // ==================== DEATH SOUNDS ====================

  // Small unit death - quick punchy explosion
  playSmallDeath(volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Sharp attack thump
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.3 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.12);
      oscGain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    }

    // Explosion burst noise
    const noiseBuffer = this.createNoiseBuffer(0.18);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2500, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(
        400,
        ctx.currentTime + 0.18
      );

      const noiseGain = this.createGain(0.25 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.35 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.18
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Medium unit death - solid explosion with debris
  playMediumDeath(volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Main explosion thump
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.35 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(25, ctx.currentTime + 0.25);
      oscGain.gain.setValueAtTime(0.45 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    }

    // Secondary mid-freq punch
    const osc2 = ctx.createOscillator();
    const osc2Gain = this.createGain(0.2 * volumeMultiplier);
    if (osc2Gain) {
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(180, ctx.currentTime);
      osc2.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.2);
      osc2Gain.gain.setValueAtTime(0.3 * volumeMultiplier, ctx.currentTime);
      osc2Gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      osc2.connect(osc2Gain);
      osc2.start();
      osc2.stop(ctx.currentTime + 0.2);
    }

    // Explosion noise burst
    const noiseBuffer = this.createNoiseBuffer(0.3);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(3500, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.3);

      const noiseGain = this.createGain(0.3 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.4 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.3
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Large unit death - massive explosion with rumble
  playLargeDeath(volumeMultiplier: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Deep powerful boom
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.45 * volumeMultiplier);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(15, ctx.currentTime + 0.5);
      oscGain.gain.setValueAtTime(0.55 * volumeMultiplier, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    }

    // Secondary rumble layer
    const osc2 = ctx.createOscillator();
    const osc2Gain = this.createGain(0.35 * volumeMultiplier);
    if (osc2Gain) {
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(100, ctx.currentTime + 0.02);
      osc2.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 0.45);
      osc2Gain.gain.setValueAtTime(
        0.4 * volumeMultiplier,
        ctx.currentTime + 0.02
      );
      osc2Gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
      osc2.connect(osc2Gain);
      osc2.start(ctx.currentTime + 0.02);
      osc2.stop(ctx.currentTime + 0.45);
    }

    // Third sub-bass layer for weight
    const osc3 = ctx.createOscillator();
    const osc3Gain = this.createGain(0.3 * volumeMultiplier);
    if (osc3Gain) {
      osc3.type = 'sine';
      osc3.frequency.setValueAtTime(40, ctx.currentTime);
      osc3.frequency.exponentialRampToValueAtTime(12, ctx.currentTime + 0.6);
      osc3Gain.gain.setValueAtTime(0.35 * volumeMultiplier, ctx.currentTime);
      osc3Gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
      osc3.connect(osc3Gain);
      osc3.start();
      osc3.stop(ctx.currentTime + 0.6);
    }

    // Heavy explosion noise
    const noiseBuffer = this.createNoiseBuffer(0.55);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(4000, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.55);

      const noiseGain = this.createGain(0.4 * volumeMultiplier);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.5 * volumeMultiplier, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + 0.55
        );
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Death sound based on weapon audio type (determines unit "class")
  playUnitDeath(weaponId: WeaponAudioId, volumeMultiplier: number = 1): void {
    switch (weaponId) {
      case 'minigun':
      case 'burst-rifle':
      case 'sonic-wave':
        this.playSmallDeath(volumeMultiplier);
        break;
      case 'beam':
      case 'shotgun':
      case 'railgun':
        this.playMediumDeath(volumeMultiplier);
        break;
      case 'cannon':
      case 'grenade':
        this.playLargeDeath(volumeMultiplier);
        break;
      default:
        this.playSmallDeath(volumeMultiplier);
    }
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
