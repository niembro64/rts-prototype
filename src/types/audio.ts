// Audio types extracted from audioConfig.ts, audio helpers, and music modules

export type SynthId =
  | 'laser-zap'
  | 'minigun'
  | 'cannon'
  | 'shotgun'
  | 'grenade'
  | 'laserGun'
  | 'burst-rifle'
  | 'force-field'
  | 'insect'
  | 'sizzle'
  | 'bullet'
  | 'heavy'
  | 'explosion'
  | 'small-explosion'
  | 'medium-explosion'
  | 'large-explosion'
  | 'beam-hum';

export type SoundEntry = {
  synth: SynthId;
  volume: number;
  playSpeed: number;
  freq?: number;
};

export type AudioToolkit = {
  ctx: AudioContext;
  createGain(volume?: number, autoDisconnectMs?: number): GainNode | null;
  createNoiseBuffer(duration: number): AudioBuffer | null;
};

export type ContinuousSound = {
  oscillator: OscillatorNode;
  gainNode: GainNode;
  noiseSource?: AudioBufferSourceNode;
  noiseGain?: GainNode;
  targetVolume: number;
  noiseTargetVolume: number;
  baseOscVolume: number;
  baseNoiseVolume: number;
  audible: boolean;
  sourceEntityId: number;
};

export type ContinuousSoundConfig = {
  wave: OscillatorType;
  freq: number;
  randomFrequencyRange?: number;
  filterFreq: number;
  filterQ: number;
  highpassFreq?: number;
  highpassQ?: number;
  fadeIn: number;
  pitchSlideStart?: number;
  pitchSlideTime?: number;
  oscVolume: number;
  noiseVolume: number;
  noiseBandFreq: number;
  noiseBandQ: number;
  lfoRate?: number;
  lfoDepth?: number;
};

export type MidiNote = {
  midi: number;
  time: number;
  duration: number;
  velocity: number;
};

export type MidiState = {
  notes: MidiNote[] | null;
  duration: number;
  loaded: boolean;
  loadPromise: Promise<void> | null;
  startOffset: number;
  position: number;
  mode: boolean;
};

export type MidiEffectsChain = {
  noteTarget: GainNode;
  compressor: DynamicsCompressorNode | null;
  reverbConvolver: ConvolverNode | null;
  reverbDryGain: GainNode | null;
  reverbWetGain: GainNode | null;
};

export type ProceduralState = {
  nextBeatTime: number;
  currentBeat: number;
  currentBar: number;
  sectionCount: number;
  arpPatternIndex: number;
  melodyNote: number;
  keyOffset: number;
};
