/**
 * Audio Configuration
 *
 * Pure tuning data lives in audioConfig.json so both TypeScript and
 * (eventually) Rust/WASM can read the same source of truth. This
 * module re-exports the JSON under typed names that consumers expect.
 *
 * The handful of harmonic-series ratios the old TS file derived
 * (h[8]/h[6] = 7/9, h[8]/h[1] = 2/9, base/h[8] = 288, base/h[0] = 32)
 * are now inlined as literal decimals in the JSON. The local
 * harmonicSeries / harmonicSeriesBaseMultipler exports those derivations
 * relied on were never imported anywhere and have been removed under
 * Delete The Old Path.
 */

export type { SynthId, SoundEntry } from './types/audio';
import type { SoundEntry } from './types/audio';
import type { ShotBlueprintId, TurretBlueprintId, UnitBlueprintId } from './types/blueprintIds';
import rawConfig from './audioConfig.json';

type AudioConfig = {
  masterVolume: number;
  sfxVolume: number;
  zoomVolumeExponent: number;
  fireGain: number;
  hitGain: number;
  deadGain: number;
  beamGain: number;
  fieldGain: number;
  musicGain: number;
  event: {
    fire: Partial<Record<TurretBlueprintId, SoundEntry>>;
    hit: Partial<Record<ShotBlueprintId, SoundEntry>>;
    death: Record<UnitBlueprintId, SoundEntry>;
  };
  continuous: {
    beam: ContinuousSynthConfig;
    force: ContinuousSynthConfig;
  };
  musicSource: 'procedural' | 'midi';
  midiFile: string;
  midi: MidiSynthConfig;
};

type ContinuousSynthConfig = {
  wave: OscillatorType;
  freq: number;
  randomFrequencyRange: number;
  lfoRate: number;
  lfoDepth: number;
  filterFreq: number;
  filterQ: number;
  highpassFreq: number;
  highpassQ: number;
  fadeIn: number;
  pitchSlideStart?: number;
  pitchSlideTime?: number;
  oscVolume: number;
  noiseVolume: number;
  noiseBandFreq: number;
  noiseBandQ: number;
};

type MidiSynthConfig = {
  wave: OscillatorType;
  transpose: number;
  speed: number;
  gain: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  vibrato: boolean;
  vibratoRate: number;
  vibratoDepth: number;
  tremolo: boolean;
  tremoloRate: number;
  tremoloDepth: number;
  voices: number;
  voiceDetune: number;
  filter: boolean;
  filterFreq: number;
  filterQ: number;
  compressor: boolean;
  compressorThreshold: number;
  compressorKnee: number;
  compressorRatio: number;
  compressorAttack: number;
  compressorRelease: number;
  reverb: boolean;
  reverbDecay: number;
  reverbMix: number;
};

export const AUDIO: AudioConfig = rawConfig as unknown as AudioConfig;
