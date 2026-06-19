/**
 * Audio Configuration
 *
 * Pure tuning data lives in audioConfig.json so both TypeScript and
 * (eventually) Rust/WASM can read the same source of truth. This
 * module re-exports the JSON under typed names that consumers expect.
 *
 * The old beam-family audio derived pitch from a reciprocal harmonic
 * series: frequency = harmonicSeriesBaseMultiplier / harmonicSeries[i].
 * Beam ray blueprints now store the harmonic index so larger beams can
 * share the same progression without copying frequency literals.
 */

export type {  SoundEntry } from './types/audio';
import type { SoundEntry } from './types/audio';
import type {
  RayBlueprintId,
  ShotBlueprintId,
  TurretBlueprintId,
  UnitBlueprintId,
} from './types/blueprintIds';
import rawConfig from './audioConfig.json';

const BEAM_SOUND_HARMONIC_SERIES = [
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
] as const;

export function isBeamSoundHarmonicIndex(index: number): boolean {
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < BEAM_SOUND_HARMONIC_SERIES.length
  );
}

export function beamSoundFrequencyFromHarmonicIndex(index: number): number {
  if (!isBeamSoundHarmonicIndex(index)) {
    throw new Error(`Invalid beam sound harmonic index: ${index}`);
  }
  const base = AUDIO.continuous.beam.harmonicSeriesBaseMultiplier ?? 32;
  return base / BEAM_SOUND_HARMONIC_SERIES[index];
}

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
  /** One-shot voice limiting: at most `maxStartsPerWindow` synth starts
   *  (and `maxStartsPerSynthPerWindow` per synth id) per `windowMs`
   *  window. Big battles emit hundreds of fire/hit events per second;
   *  past this budget extra one-shots are dropped instead of building
   *  Web Audio node graphs the mix can't resolve anyway. */
  voiceBudget: {
    windowMs: number;
    maxStartsPerWindow: number;
    maxStartsPerSynthPerWindow: number;
  };
  /** Hard cap on concurrent continuous loops per category (beams /
   *  shield fields). Past the cap new loops simply don't start —
   *  hundreds of live node graphs add cost but no audible
   *  information. */
  continuousVoiceCap: {
    beam: number;
    field: number;
  };
  event: {
    fire: Partial<Record<TurretBlueprintId, SoundEntry>>;
    hit: Partial<Record<ShotBlueprintId | RayBlueprintId, SoundEntry>>;
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
  harmonicSeriesBaseMultiplier?: number;
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
