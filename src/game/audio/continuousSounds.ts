// Continuous sound management (beams, force fields)
// Handles start/stop lifecycle, viewport-based muting, and zoom-based volume

import { AUDIO } from '../../audioConfig';
import type { AudioToolkit } from './audioHelpers';

export interface ContinuousSound {
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
}

export interface ContinuousSoundConfig {
  wave: OscillatorType;
  freq: number;
  randomFrequencyRange?: number;
  filterFreq: number;
  filterQ: number;
  highpassFreq?: number;
  highpassQ?: number;
  fadeIn: number;
  oscVolume: number;
  noiseVolume: number;
  noiseBandFreq: number;
  noiseBandQ: number;
  lfoRate?: number;
  lfoDepth?: number;
}

// Start a continuous sound with oscillator + optional LFO + filter + noise layer
export function startContinuousSound(
  tk: AudioToolkit,
  config: ContinuousSoundConfig,
  entityId: number,
  speed: number,
  volumeMultiplier: number,
  zoomVolume: number,
): ContinuousSound | null {
  const ctx = tk.ctx;

  const osc = ctx.createOscillator();
  const gain = tk.createGain(0, 0);
  if (!gain) return null;

  osc.type = config.wave;
  const freqOffset = config.randomFrequencyRange
    ? (Math.random() * 2 - 1) * config.randomFrequencyRange
    : 0;
  osc.frequency.value = (config.freq + freqOffset) * speed;

  // Optional LFO for frequency wobble
  if (config.lfoRate && config.lfoDepth) {
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = config.lfoRate * speed;
    lfoGain.gain.value = config.lfoDepth * speed;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start();
  }

  // Lowpass filter
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = config.filterFreq * speed;
  filter.Q.value = config.filterQ;

  // Optional highpass filter
  let highpass: BiquadFilterNode | undefined;
  if (config.highpassFreq) {
    highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = config.highpassFreq;
    highpass.Q.value = config.highpassQ ?? 1;
  }

  // Base volumes (without zoom)
  const sfx = (tk as unknown as { sfxVolume: number }).sfxVolume ?? 1;
  const baseOsc = config.oscVolume * sfx * volumeMultiplier;
  const baseNoise = config.noiseVolume * sfx * volumeMultiplier;

  // Smooth fade in
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(baseOsc * zoomVolume, ctx.currentTime + config.fadeIn);

  if (highpass) {
    osc.connect(filter).connect(highpass).connect(gain);
  } else {
    osc.connect(filter).connect(gain);
  }
  osc.start();

  // Noise layer
  const noiseBuffer = tk.createNoiseBuffer(10);
  let noiseSource: AudioBufferSourceNode | undefined;
  let noiseGain: GainNode | undefined;

  if (noiseBuffer) {
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = config.noiseBandFreq * speed;
    noiseFilter.Q.value = config.noiseBandQ;

    noiseGain = tk.createGain(0, 0) ?? undefined;
    if (noiseGain) {
      noiseGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      noiseGain.gain.linearRampToValueAtTime(baseNoise * zoomVolume, ctx.currentTime + config.fadeIn);
      noiseSource.connect(noiseFilter).connect(noiseGain);
      noiseSource.start();
    }
  }

  return {
    oscillator: osc,
    gainNode: gain,
    noiseSource,
    noiseGain,
    targetVolume: baseOsc * zoomVolume,
    noiseTargetVolume: noiseGain ? baseNoise * zoomVolume : 0,
    baseOscVolume: baseOsc,
    baseNoiseVolume: noiseGain ? baseNoise : 0,
    audible: true,
    sourceEntityId: Math.floor(entityId / 100),
  };
}

// Stop a continuous sound with smooth fade-out
export function stopContinuousSound(
  ctx: AudioContext,
  sound: ContinuousSound,
  fadeTime: number,
  pendingTimeouts: Set<ReturnType<typeof setTimeout>>,
): void {
  sound.gainNode.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + fadeTime);
  if (sound.noiseGain) {
    sound.noiseGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + fadeTime);
  }

  const timeoutId = setTimeout(() => {
    pendingTimeouts.delete(timeoutId);
    try {
      sound.oscillator.stop();
      sound.noiseSource?.stop();
    } catch {
      // Ignore if already stopped
    }
  }, fadeTime * 1000 + 20);
  pendingTimeouts.add(timeoutId);
}

// Mute or unmute a continuous sound (smooth fade)
export function setContinuousAudible(
  ctx: AudioContext,
  sound: ContinuousSound,
  audible: boolean,
): void {
  if (sound.audible === audible) return;

  sound.audible = audible;
  const fadeTime = 0.08;
  const now = ctx.currentTime;

  sound.gainNode.gain.cancelScheduledValues(now);
  sound.gainNode.gain.setValueAtTime(sound.gainNode.gain.value, now);
  sound.gainNode.gain.linearRampToValueAtTime(audible ? sound.targetVolume : 0.0001, now + fadeTime);

  if (sound.noiseGain) {
    sound.noiseGain.gain.cancelScheduledValues(now);
    sound.noiseGain.gain.setValueAtTime(sound.noiseGain.gain.value, now);
    sound.noiseGain.gain.linearRampToValueAtTime(audible ? sound.noiseTargetVolume : 0.0001, now + fadeTime);
  }
}

// Update zoom-based volume for a continuous sound
export function updateContinuousZoom(
  ctx: AudioContext,
  sound: ContinuousSound,
  zoomVolume: number,
): void {
  if (!sound.audible) return;

  const newTarget = sound.baseOscVolume * zoomVolume;
  const newNoiseTarget = sound.baseNoiseVolume * zoomVolume;

  if (Math.abs(newTarget - sound.targetVolume) < 0.0001) return;

  sound.targetVolume = newTarget;
  sound.noiseTargetVolume = newNoiseTarget;

  const now = ctx.currentTime;
  sound.gainNode.gain.cancelScheduledValues(now);
  sound.gainNode.gain.setValueAtTime(sound.gainNode.gain.value, now);
  sound.gainNode.gain.linearRampToValueAtTime(newTarget, now + 0.05);

  if (sound.noiseGain) {
    sound.noiseGain.gain.cancelScheduledValues(now);
    sound.noiseGain.gain.setValueAtTime(sound.noiseGain.gain.value, now);
    sound.noiseGain.gain.linearRampToValueAtTime(newNoiseTarget, now + 0.05);
  }
}

// Get the ContinuousSoundConfig for beam from AUDIO config
export function getBeamConfig(): ContinuousSoundConfig {
  const bc = AUDIO.continuous.beam;
  return {
    wave: bc.wave,
    freq: bc.freq,
    randomFrequencyRange: bc.randomFrequencyRange,
    filterFreq: bc.filterFreq,
    filterQ: bc.filterQ,
    highpassFreq: bc.highpassFreq,
    highpassQ: bc.highpassQ,
    fadeIn: bc.fadeIn,
    oscVolume: bc.oscVolume,
    noiseVolume: bc.noiseVolume,
    noiseBandFreq: bc.noiseBandFreq,
    noiseBandQ: bc.noiseBandQ,
    lfoRate: bc.lfoRate,
    lfoDepth: bc.lfoDepth,
  };
}

// Get the ContinuousSoundConfig for force field from AUDIO config
export function getForceFieldConfig(): ContinuousSoundConfig {
  const fc = AUDIO.continuous.force;
  return {
    wave: fc.wave,
    freq: fc.freq,
    randomFrequencyRange: fc.randomFrequencyRange,
    filterFreq: fc.filterFreq,
    filterQ: fc.filterQ,
    highpassFreq: fc.highpassFreq,
    highpassQ: fc.highpassQ,
    fadeIn: fc.fadeIn,
    oscVolume: fc.oscVolume,
    noiseVolume: fc.noiseVolume,
    noiseBandFreq: fc.noiseBandFreq,
    noiseBandQ: fc.noiseBandQ,
  };
}
