// One-shot hit/impact sound synthesis functions

import type { AudioToolkit } from './audioHelpers';
import { playTone, playNoiseBurst } from './audioHelpers';

// Laser hit - high-frequency sizzle
export function sizzle(tk: AudioToolkit, speed: number, vol: number): void {
  playNoiseBurst(tk, 0.08 / speed, 'highpass', 4000, 1, 0.15 * vol, 0.2 * vol, 0.08 / speed);
}

// Bullet hit - metallic tick/ping (U-shaped: lows + highs, scooped mids)
export function bullet(tk: AudioToolkit, speed: number, vol: number): void {
  // Low sub-thump
  playTone(tk, 'sine', 100 * speed, 50 * speed, 0.04 / speed, 0.18 * vol, 0.18 * vol);
  // High-frequency crack
  playTone(tk, 'square', 4000 * speed, 2000 * speed, 0.012 / speed, 0.12 * vol, 0.12 * vol, 0, 'highpass', 2500 * speed);
  // Noise burst through notch (scoop 800-2000Hz mids)
  const noiseBuffer = tk.createNoiseBuffer(0.02 / speed);
  if (noiseBuffer) {
    const noise = tk.ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const notch = tk.ctx.createBiquadFilter();
    notch.type = 'notch';
    notch.frequency.value = 1200 * speed;
    notch.Q.value = 1.0;
    const gain = tk.createGain(0.08 * vol);
    if (gain) {
      gain.gain.setValueAtTime(0.08 * vol, tk.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, tk.ctx.currentTime + 0.02 / speed);
      noise.connect(notch).connect(gain);
      noise.start(tk.ctx.currentTime);
    }
  }
}

// Heavy hit (cannon impact) - thump + noise
export function heavy(tk: AudioToolkit, speed: number, vol: number): void {
  playTone(tk, 'sine', 150 * speed, 50 * speed, 0.15 / speed, 0.3 * vol, 0.4 * vol);
  playNoiseBurst(tk, 0.1 / speed, 'lowpass', 800, 1, 0.2 * vol, 0.25 * vol, 0.1 / speed);
}

// Explosion hit (grenade splash) - boom + noise
export function explosion(tk: AudioToolkit, speed: number, vol: number): void {
  playTone(tk, 'sine', 80 * speed, 20 * speed, 0.4 / speed, 0.35 * vol, 0.5 * vol);
  playNoiseBurst(tk, 0.4 / speed, 'lowpass', 2000, 1, 0.3 * vol, 0.4 * vol, 0.4 / speed, 0, 200);
}

// Synth name → function mapping
export const HIT_SYNTHS: Record<string, (tk: AudioToolkit, speed: number, vol: number) => void> = {
  'sizzle': sizzle,
  'bullet': bullet,
  'heavy': heavy,
  'explosion': explosion,
};
