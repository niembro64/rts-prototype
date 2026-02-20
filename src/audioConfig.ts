/**
 * Audio Configuration
 *
 * All audio-related types and settings: synth IDs, sound entries,
 * per-weapon/projectile/unit sound configs, and master volume tuning.
 */

// All available synth sounds — any synth can be used for any sound slot
export type SynthId =
  // One-shot percussive / tonal
  | 'laser-zap' // short bright laser fire zap
  | 'minigun' // rapid metallic rattle
  | 'cannon' // deep booming shot
  | 'shotgun' // wide blast burst
  | 'grenade' // thump launch
  | 'railgun' // electric crack
  | 'burst-rifle' // quick multi-tap
  | 'force-field' // soft energy pulse
  | 'insect' // chittering burst
  | 'sizzle' // bright crackling impact
  | 'bullet' // small metallic ping
  | 'heavy' // deep thud impact
  | 'explosion' // fiery blast
  | 'small-explosion' // quick punchy pop
  | 'medium-explosion' // medium rumble burst
  | 'large-explosion' // massive rolling boom
  // Continuous (used for laser slot)
  | 'beam-hum'; // sustained beam drone

// Sound entry: which synth to use + volume (0 = silent/skip) + playSpeed (1.0 = normal, 2.0 = twice as fast/high)
export interface SoundEntry {
  synth: SynthId;
  volume: number;
  playSpeed: number;
}

// Sounds a turret produces (keyed by weapon id: gatling, beam, etc.)
export interface TurretSoundConfig {
  fire?: SoundEntry;
  laser?: SoundEntry;
}

// Sounds a projectile produces on impact (keyed by projectile type: lightRound, laserBeam, etc.)
export interface ProjectileSoundConfig {
  hit?: SoundEntry;
}

// Sounds a unit produces when it dies (keyed by unit type: jackal, mammoth, etc.)
export interface UnitSoundConfig {
  death?: SoundEntry;
}

export const AUDIO = {
  masterVolume: 0.99, // Global master gain (applied to AudioContext destination)
  sfxVolume: 0.5, // SFX sub-mix multiplier (applied per gain node)
  zoomVolumeExponent: 1.2, // How volume scales with zoom: volume = zoom^exponent (2 = inverse square, 1 = linear, 0 = no scaling)

  // Turret sounds (keyed by weapon id)
  turrets: {
    fireGain: 0.5,
    laserGain: 0.03,
    sounds: {
      gatling: { fire: { synth: 'burst-rifle', volume: 0.2, playSpeed: 0.5 } },
      pulse: { fire: { synth: 'burst-rifle', volume: 0.2, playSpeed: 0.3 } },
      beam: {
        fire: { synth: 'laser-zap', volume: 0.2, playSpeed: 1.0 },
        laser: { synth: 'beam-hum', volume: 1.0, playSpeed: 1.0 },
      },
      megaBeam: {
        fire: { synth: 'laser-zap', volume: 0.2, playSpeed: 1.0 },
        laser: { synth: 'beam-hum', volume: 1.0, playSpeed: 1.0 },
      },
      shotgun: { fire: { synth: 'burst-rifle', volume: 0.4, playSpeed: 0.2 } },
      mortar: { fire: { synth: 'cannon', volume: 0.2, playSpeed: 1.0 } },
      cannon: { fire: { synth: 'cannon', volume: 0.2, playSpeed: 0.8 } },
      railgun: { fire: { synth: 'railgun', volume: 0.03, playSpeed: 0.6 } },
      forceField: {
        fire: { synth: 'force-field', volume: 0.01, playSpeed: 1.0 },
      },
      megaForceField: {
        fire: { synth: 'force-field', volume: 0.01, playSpeed: 2.0 },
      },
      disruptor: { fire: { synth: 'cannon', volume: 0.2, playSpeed: 1.0 } },
      dgun: { fire: { synth: 'cannon', volume: 0.2, playSpeed: 1.0 } },
    } as Record<string, TurretSoundConfig>,
  },

  // Projectile impact sounds (keyed by projectile type)
  projectiles: {
    hitGain: 0.0,
    sounds: {
      lightRound: { hit: { synth: 'heavy', volume: 0.2, playSpeed: 0.5 } },
      heavyRound: { hit: { synth: 'heavy', volume: 0.5, playSpeed: 0.2 } },
      // lightRound:     { hit: { synth: 'bullet',    volume: 0.2, playSpeed: 0.2 } },
      // heavyRound:     { hit: { synth: 'bullet',    volume: 0.5, playSpeed: 0.1 } },
      mortarShell: { hit: { synth: 'heavy', volume: 1.0, playSpeed: 0.1 } },
      cannonShell: { hit: { synth: 'heavy', volume: 1.0, playSpeed: 0.05 } },
      railBeam: { hit: { synth: 'sizzle', volume: 1.0, playSpeed: 1.0 } },
      laserBeam: { hit: { synth: 'sizzle', volume: 1.0, playSpeed: 1.0 } },
      heavyLaserBeam: { hit: { synth: 'sizzle', volume: 1.0, playSpeed: 1.0 } },
      disruptorBolt: { hit: { synth: 'heavy', volume: 1.0, playSpeed: 1.0 } },
    } as Record<string, ProjectileSoundConfig>,
  },

  // Unit death sounds (keyed by unit type)
  units: {
    deathGain: 0.0,
    sounds: {
      jackal: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
      lynx: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
      daddy: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
      badger: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
      mongoose: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
      recluse: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
      mammoth: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
      widow: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
      tarantula: { death: { synth: 'explosion', volume: 1.0, playSpeed: 0.3 } },
    } as Record<string, UnitSoundConfig>,
  },
};
