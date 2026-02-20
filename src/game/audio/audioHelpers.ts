// Shared audio primitives for synth functions

export interface AudioToolkit {
  ctx: AudioContext;
  createGain(volume?: number, autoDisconnectMs?: number): GainNode | null;
  createNoiseBuffer(duration: number): AudioBuffer | null;
}

// Play an oscillator tone with frequency sweep and gain decay
export function playTone(
  tk: AudioToolkit,
  type: OscillatorType,
  startFreq: number,
  endFreq: number,
  duration: number,
  gainVol: number,
  peakVol: number,
  delay: number = 0,
  filterType?: BiquadFilterType,
  filterFreq?: number,
  filterQ?: number,
): void {
  const osc = tk.ctx.createOscillator();
  const gain = tk.createGain(gainVol);
  if (!gain) return;

  const t = tk.ctx.currentTime + delay;

  osc.type = type;
  osc.frequency.setValueAtTime(startFreq, t);
  if (endFreq !== startFreq) {
    osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
  }

  gain.gain.setValueAtTime(peakVol, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + duration);

  if (filterType && filterFreq !== undefined) {
    const filter = tk.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    if (filterQ !== undefined) filter.Q.value = filterQ;
    osc.connect(filter).connect(gain);
  } else {
    osc.connect(gain);
  }

  osc.start(t);
  osc.stop(t + duration);
}

// Play a noise burst through a filter with gain decay
export function playNoiseBurst(
  tk: AudioToolkit,
  noiseDuration: number,
  filterType: BiquadFilterType,
  filterFreq: number,
  filterQ: number,
  gainVol: number,
  peakVol: number,
  decayDuration: number,
  delay: number = 0,
  filterEndFreq?: number,
): void {
  const noiseBuffer = tk.createNoiseBuffer(noiseDuration);
  if (!noiseBuffer) return;

  const noise = tk.ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = tk.ctx.createBiquadFilter();
  filter.type = filterType;
  const t = tk.ctx.currentTime + delay;
  filter.frequency.setValueAtTime(filterFreq, t);
  if (filterEndFreq !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(filterEndFreq, t + decayDuration);
  }
  filter.Q.value = filterQ;

  const gain = tk.createGain(gainVol);
  if (!gain) return;

  gain.gain.setValueAtTime(peakVol, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + decayDuration);

  noise.connect(filter).connect(gain);
  noise.start(t);
}
