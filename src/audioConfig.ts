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

  // Continuous beam sound settings
  beam: {
    wave: 'sawtooth' as OscillatorType, // oscillator waveform
    freq: 180, // base frequency in Hz
    lfoRate: 8, // frequency wobble rate in Hz
    lfoDepth: 15, // frequency wobble depth in Hz (±)
    filterFreq: 1200, // lowpass cutoff frequency
    filterQ: 2, // filter resonance
    fadeIn: 0.12, // fade-in time in seconds
    oscVolume: 0.2, // main oscillator volume multiplier
    noiseVolume: 0.08, // noise layer volume multiplier
    noiseBandFreq: 4000, // noise bandpass center frequency
    noiseBandQ: 1, // noise bandpass Q
  },

  // Continuous force field sound settings
  forceField: {
    wave: 'triangle' as OscillatorType, // oscillator waveform
    freq: 60, // base frequency in Hz
    filterFreq: 400, // lowpass cutoff frequency
    filterQ: 3, // filter resonance
    fadeIn: 0.2, // fade-in time in seconds
    oscVolume: 0.12, // main oscillator volume multiplier
    noiseVolume: 0.04, // noise layer volume multiplier
    noiseBandFreq: 200, // noise bandpass center frequency
    noiseBandQ: 2, // noise bandpass Q
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
