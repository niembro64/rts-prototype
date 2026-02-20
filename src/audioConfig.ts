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
  fireGain: 1.0,       // Weapon fire sounds
  hitGain: 0.3,        // Projectile hit sounds
  deadGain: 0.1,       // Unit death sounds
  beamGain: 0.03,      // Continuous beam sounds
  fieldGain: 1.0,      // Continuous force field sounds
};
