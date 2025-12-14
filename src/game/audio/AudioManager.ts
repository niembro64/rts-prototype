// Procedural audio generation using Web Audio API

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private initialized = false;

  // Volume controls
  public masterVolume = 0.3;
  public sfxVolume = 0.5;

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

  // Laser fire - sine wave frequency sweep
  playLaserFire(pitch: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const gain = this.createGain(0.25);
    if (!gain) return;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200 * pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300 * pitch, ctx.currentTime + 0.15);

    filter.type = 'lowpass';
    filter.frequency.value = 2000;

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);

    osc.connect(filter).connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  }

  // Minigun fire - short punchy noise burst
  playMinigunFire(pitch: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const gain = this.createGain(0.15);
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

    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.04);

    noise.connect(filter).connect(gain);
    noise.start();

    // Add a tiny click/pop
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.1);
    if (oscGain) {
      osc.type = 'square';
      osc.frequency.value = 150 * pitch;
      oscGain.gain.setValueAtTime(0.2, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.02);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
    }
  }

  // Cannon fire - deep boom
  playCannonFire(pitch: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Low frequency boom
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.35);
    if (!oscGain) return;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 * pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40 * pitch, ctx.currentTime + 0.3);

    oscGain.gain.setValueAtTime(0.5, ctx.currentTime);
    oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    osc.connect(oscGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);

    // Noise burst for texture
    const noiseBuffer = this.createNoiseBuffer(0.2);
    if (!noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const noiseGain = this.createGain(0.2);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.2);

    if (noiseGain) {
      noiseGain.gain.setValueAtTime(0.3, ctx.currentTime);
      noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      noise.connect(filter).connect(noiseGain);
      noise.start();
    }
  }

  // Shotgun fire - chunky blast
  playShotgunFire(pitch: number = 1): void {
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

      const gain = this.createGain(0.2);
      if (!gain) continue;

      gain.gain.setValueAtTime(0.35, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + delay + 0.08);

      noise.connect(filter).connect(gain);
      noise.start(ctx.currentTime + delay);
    }

    // Add a bass thump
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.25);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(100 * pitch, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(50 * pitch, ctx.currentTime + 0.1);
      oscGain.gain.setValueAtTime(0.4, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    }
  }

  // Grenade launcher - thunk sound
  playGrenadeFire(pitch: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = this.createGain(0.3);
    if (!gain) return;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200 * pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80 * pitch, ctx.currentTime + 0.12);

    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);

    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  }

  // Railgun - electric zap
  playRailgunFire(pitch: number = 1): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // High frequency zap
    const osc1 = ctx.createOscillator();
    const gain1 = this.createGain(0.2);
    if (gain1) {
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(2000 * pitch, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(500 * pitch, ctx.currentTime + 0.1);
      gain1.gain.setValueAtTime(0.25, ctx.currentTime);
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

      const noiseGain = this.createGain(0.15);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.2, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Burst rifle - quick triple tap
  playBurstRifleFire(pitch: number = 1): void {
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

    const gain = this.createGain(0.2);
    if (!gain) return;

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.04);

    noise.connect(filter).connect(gain);
    noise.start();
  }

  // Generic weapon fire by ID
  playWeaponFire(weaponId: string, pitch: number = 1): void {
    // Add slight random variation
    const variation = 0.9 + Math.random() * 0.2;
    const finalPitch = pitch * variation;

    switch (weaponId) {
      case 'laser':
        this.playLaserFire(finalPitch);
        break;
      case 'minigun':
        this.playMinigunFire(finalPitch);
        break;
      case 'cannon':
        this.playCannonFire(finalPitch);
        break;
      case 'shotgun':
        this.playShotgunFire(finalPitch);
        break;
      case 'grenade':
        this.playGrenadeFire(finalPitch);
        break;
      case 'railgun':
        this.playRailgunFire(finalPitch);
        break;
      case 'burstRifle':
        this.playBurstRifleFire(finalPitch);
        break;
      default:
        this.playMinigunFire(finalPitch);
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
        noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.03);
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
        noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
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
        noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Generic hit by weapon ID
  playWeaponHit(weaponId: string): void {
    switch (weaponId) {
      case 'laser':
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

  // Small unit death (minigun unit) - quick pop
  playSmallDeath(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Descending tone
    const osc = ctx.createOscillator();
    const gain = this.createGain(0.25);
    if (!gain) return;

    osc.type = 'square';
    osc.frequency.setValueAtTime(400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);

    // Pop noise
    const noiseBuffer = this.createNoiseBuffer(0.15);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1000;

      const noiseGain = this.createGain(0.2);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.25, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Medium unit death (laser/shotgun unit) - electrical fizzle
  playMediumDeath(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Electrical buzz
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = this.createGain(0.2);
    if (!gain) return;

    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(300, ctx.currentTime);
    osc1.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.3);

    osc2.type = 'square';
    osc2.frequency.setValueAtTime(310, ctx.currentTime);
    osc2.frequency.exponentialRampToValueAtTime(55, ctx.currentTime + 0.3);

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    osc1.connect(gain);
    osc2.connect(gain);
    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.3);
    osc2.stop(ctx.currentTime + 0.3);

    // Crackle
    const noiseBuffer = this.createNoiseBuffer(0.25);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 2000;

      const noiseGain = this.createGain(0.15);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.2, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Large unit death (cannon unit) - big explosion
  playLargeDeath(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Deep boom
    const osc = ctx.createOscillator();
    const oscGain = this.createGain(0.4);
    if (oscGain) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(60, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(15, ctx.currentTime + 0.5);
      oscGain.gain.setValueAtTime(0.5, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.connect(oscGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    }

    // Secondary rumble
    const osc2 = ctx.createOscillator();
    const osc2Gain = this.createGain(0.3);
    if (osc2Gain) {
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(100, ctx.currentTime + 0.05);
      osc2.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.45);
      osc2Gain.gain.setValueAtTime(0.35, ctx.currentTime + 0.05);
      osc2Gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
      osc2.connect(osc2Gain);
      osc2.start(ctx.currentTime + 0.05);
      osc2.stop(ctx.currentTime + 0.45);
    }

    // Explosion noise
    const noiseBuffer = this.createNoiseBuffer(0.5);
    if (noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(3000, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.5);

      const noiseGain = this.createGain(0.35);
      if (noiseGain) {
        noiseGain.gain.setValueAtTime(0.4, ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        noise.connect(filter).connect(noiseGain);
        noise.start();
      }
    }
  }

  // Death sound based on weapon type (determines unit "class")
  playUnitDeath(weaponId: string): void {
    switch (weaponId) {
      case 'minigun':
      case 'burstRifle':
        this.playSmallDeath();
        break;
      case 'laser':
      case 'shotgun':
      case 'railgun':
        this.playMediumDeath();
        break;
      case 'cannon':
      case 'grenade':
        this.playLargeDeath();
        break;
      default:
        this.playSmallDeath();
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
}

// Singleton instance
export const audioManager = new AudioManager();
