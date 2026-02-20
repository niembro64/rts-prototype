/**
 * Audio Configuration
 *
 * Global audio types, synth IDs, and master volume tuning.
 * Per-weapon/projectile/unit sound entries are now in blueprints.
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

  // Music source: 'procedural' for generated music, 'midi' for MIDI file playback
  musicSource: 'midi' as 'procedural' | 'midi',
  midiFile: 'music.mid', // filename in public/

  // MIDI playback settings
  midi: {
    wave: 'sawtooth' as OscillatorType, // oscillator waveform: 'sine' | 'triangle' | 'square' | 'sawtooth'
    transpose: -5, // shift all notes by N semitones (+12 = up one octave, -12 = down one octave)
    speed: 1.0, // playback speed multiplier (0.5 = half speed, 2.0 = double)
    gain: 0.5, // base note gain before velocity scaling
    attack: 0.01, // note attack time in seconds
    release: 0.0, // note release time in seconds

    // Per-note lowpass filter (applied to each oscillator)
    filter: false, // enable per-note lowpass filter
    filterFreq: 2000, // lowpass cutoff frequency (Hz)
    filterQ: 0.3, // filter resonance (0.1 = gentle, 10 = sharp peak)

    // Master compressor (applied to combined MIDI output)
    compressor: true, // enable dynamics compressor
    compressorThreshold: -24, // dB level where compression begins
    compressorKnee: 30, // dB range for soft knee
    compressorRatio: 4, // compression ratio (4:1)
    compressorAttack: 0.0, // compressor attack in seconds
    compressorRelease: 0.25, // compressor release in seconds

    // Reverb (synthetic impulse response, applied to combined MIDI output)
    reverb: true, // enable reverb
    reverbDecay: 2.0, // reverb tail length in seconds
    reverbMix: 0.5, // wet/dry mix (0 = fully dry, 1 = fully wet)
  },
};
