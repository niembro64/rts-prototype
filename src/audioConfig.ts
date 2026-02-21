/**
 * Audio Configuration
 *
 * Global audio types, synth IDs, and master volume tuning.
 * All per-weapon/projectile/unit sound entries are centralized here.
 */

export const harmonicSeries = [
  1 / 1,
  1 / 2,
  1 / 3,
  1 / 4,
  1 / 5,
  1 / 6,
  1 / 7,
  1 / 8,
  1 / 9,
  1 / 10,
  1 / 11,
  1 / 12,
  1 / 13,
  1 / 14,
];

// All available synth sounds — any synth can be used for any sound slot
export type SynthId =
  // One-shot percussive / tonal
  | 'laser-zap' // short bright laser fire zap
  | 'minigun' // rapid metallic rattle
  | 'cannon' // deep booming shot
  | 'shotgun' // wide blast burst
  | 'grenade' // thump launch
  | 'laserGun' // electric crack
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

export const AUDIO = {
  masterVolume: 0.99, // Global master gain (applied to AudioContext destination)
  sfxVolume: 0.9, // SFX sub-mix multiplier (applied per gain node)
  zoomVolumeExponent: 1.2, // How volume scales with zoom: volume = zoom^exponent (2 = inverse square, 1 = linear, 0 = no scaling)

  // Per-category gain multipliers (match SoundCategory toggles)
  fireGain: 1.0, // Weapon fire sounds
  hitGain: 0.3, // Projectile hit sounds
  deadGain: 0.1, // Unit death sounds
  beamGain: 0.03, // Continuous beam sounds
  fieldGain: 1.0, // Continuous force field sounds
  musicGain: 0.5, // Procedural music volume

  // ==================== EVENT SOUNDS ====================
  event: {
    // Per-turret fire sounds
    fire: {
      gatlingTurret: {
        synth: 'burst-rifle' as SynthId,
        volume: 0.2,
        playSpeed: 0.5,
      },
      pulseTurret: {
        synth: 'burst-rifle' as SynthId,
        volume: 0.2,
        playSpeed: 0.3,
      },
      shotgunTurret: {
        synth: 'burst-rifle' as SynthId,
        volume: 0.4,
        playSpeed: 0.2,
      },
      cannonTurret: { synth: 'cannon' as SynthId, volume: 0.2, playSpeed: 0.8 },
      mortarTurret: { synth: 'cannon' as SynthId, volume: 0.2, playSpeed: 1.0 },
      laserTurret: {
        synth: 'laserGun' as SynthId,
        volume: 0.03,
        playSpeed: 0.6,
      },
      beamTurret: {
        synth: 'laser-zap' as SynthId,
        volume: 0.2,
        playSpeed: 1.0,
      },
      forceTurret: {
        synth: 'force-field' as SynthId,
        volume: 0.5,
        playSpeed: 1.0,
      },
      megaForceTurret: {
        synth: 'force-field' as SynthId,
        volume: 0.5,
        playSpeed: 2.0,
      },
      disruptorTurret: {
        synth: 'cannon' as SynthId,
        volume: 0.2,
        playSpeed: 1.0,
      },
      dgunTurret: { synth: 'cannon' as SynthId, volume: 0.2, playSpeed: 1.0 },
    } as Record<string, SoundEntry>,

    // Per-turret laser/continuous weapon start sounds
    laser: {
      beamTurret: { synth: 'beam-hum' as SynthId, volume: 1.0, playSpeed: 1.0 },
    } as Record<string, SoundEntry>,

    // Per-projectile hit sounds
    hit: {
      lightShot: { synth: 'heavy' as SynthId, volume: 0.2, playSpeed: 0.5 },
      mediumShot: { synth: 'heavy' as SynthId, volume: 0.5, playSpeed: 0.2 },
      mortarShot: { synth: 'heavy' as SynthId, volume: 1.0, playSpeed: 0.1 },
      heavyShot: { synth: 'heavy' as SynthId, volume: 1.0, playSpeed: 0.05 },
      laserShot: { synth: 'sizzle' as SynthId, volume: 1.0, playSpeed: 1.0 },
      beamShot: { synth: 'sizzle' as SynthId, volume: 1.0, playSpeed: 1.0 },
      disruptorShot: { synth: 'heavy' as SynthId, volume: 1.0, playSpeed: 1.0 },
    } as Record<string, SoundEntry>,

    // Per-unit death sounds
    death: {
      jackal: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      lynx: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      daddy: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      badger: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      mongoose: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      tick: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      mammoth: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      widow: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      tarantula: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
      commander: { synth: 'explosion' as SynthId, volume: 1.0, playSpeed: 0.3 },
    } as Record<string, SoundEntry>,
  },

  // ==================== CONTINUOUS SOUNDS ====================
  continuous: {
    // Beam sound settings (oscillator + LFO + filter + noise)
    beam: {
      wave: 'triangle' as OscillatorType, // oscillator waveform
      freq: 32 / harmonicSeries[8], // base frequency in Hz
      randomFrequencyRange: 2, // random ± Hz offset applied at start (each instance gets a unique tone)
      lfoRate: 2, // frequency wobble rate in Hz
      lfoDepth: 1, // frequency wobble depth in Hz (±)
      filterFreq: 1200, // lowpass cutoff frequency
      filterQ: 10, // filter resonance
      fadeIn: 0.12, // fade-in time in seconds
      oscVolume: 0.2, // main oscillator volume multiplier
      noiseVolume: 0.08, // noise layer volume multiplier
      noiseBandFreq: 4000, // noise bandpass center frequency
      noiseBandQ: 1, // noise bandpass Q
    },

    // Force field sound settings (oscillator + LFO + filter + noise)
    force: {
      wave: 'triangle' as OscillatorType, // oscillator waveform
      freq: 32, // base frequency in Hz
      randomFrequencyRange: 1, // random ± Hz offset applied at start (each instance gets a unique tone)
      lfoRate: 10, // frequency wobble rate in Hz
      lfoDepth: 1, // frequency wobble depth in Hz (±)
      filterFreq: 2000, // lowpass cutoff frequency
      filterQ: 3, // filter resonance
      fadeIn: 0.2, // fade-in time in seconds
      oscVolume: 0.12, // main oscillator volume multiplier
      noiseVolume: 0.04, // noise layer volume multiplier
      noiseBandFreq: 200, // noise bandpass center frequency
      noiseBandQ: 2, // noise bandpass Q
    },
  },

  // Music source: 'procedural' for generated music, 'midi' for MIDI file playback
  musicSource: 'midi' as 'procedural' | 'midi',
  midiFile: 'music.mid', // filename in public/

  // MIDI playback settings
  midi: {
    wave: 'sawtooth' as OscillatorType, // oscillator waveform: 'sine' | 'triangle' | 'square' | 'sawtooth'
    transpose: -7, // shift all notes by N semitones (+12 = up one octave, -12 = down one octave)
    speed: 1.0, // playback speed multiplier (0.5 = half speed, 2.0 = double)
    gain: 0.2, // base note gain before velocity scaling

    // ADSR envelope
    attack: 0.0, // time to reach peak gain (seconds)
    decay: 0.1, // time from peak to sustain level (seconds)
    sustain: 1.0, // sustain level as fraction of peak (0-1; 1 = no decay)
    release: 0.1, // fade-out time after note-off (seconds; extends past MIDI duration)

    // Vibrato (frequency LFO — pitch wobble)
    vibrato: true, // enable vibrato
    vibratoRate: 5, // LFO speed in Hz (typical: 4-7)
    vibratoDepth: 20, // depth in cents (typical: 10-50; 100 cents = 1 semitone)

    // Tremolo (gain LFO — volume wobble)
    tremolo: false, // enable tremolo
    tremoloRate: 4, // LFO speed in Hz (typical: 3-8)
    tremoloDepth: 0.2, // modulation depth 0-1 (0 = none, 1 = full silence on troughs)

    // Unison voices (multiple detuned oscillators per note for thickness/chorus)
    voices: 1, // number of oscillators per note (1 = normal, 2-4 = unison)
    voiceDetune: 30, // detune spread in cents (e.g. 12 = voices spread ±12 cents)

    // Per-note lowpass filter (applied to each oscillator)
    filter: true, // enable per-note lowpass filter
    filterFreq: 1000, // lowpass cutoff frequency (Hz)
    filterQ: 0.5, // filter resonance (0.1 = gentle, 10 = sharp peak)

    // Master compressor (applied to combined MIDI output)
    compressor: false, // enable dynamics compressor
    compressorThreshold: -6, // dB level where compression begins
    compressorKnee: 30, // dB range for soft knee
    compressorRatio: 2, // compression ratio (4:1)
    compressorAttack: 0.0, // compressor attack in seconds
    compressorRelease: 0.25, // compressor release in seconds

    // Reverb (synthetic impulse response, applied to combined MIDI output)
    reverb: false, // enable reverb
    reverbDecay: 1.0, // reverb tail length in seconds
    reverbMix: 0.5, // wet/dry mix (0 = fully dry, 1 = fully wet)
  },
};
