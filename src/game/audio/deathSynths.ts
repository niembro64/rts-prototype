// One-shot unit death explosion sound synthesis functions

import type { AudioToolkit } from './audioHelpers';
import { playTone, playNoiseBurst } from './audioHelpers';

// Small unit death - quick punchy explosion
export function smallExplosion(tk: AudioToolkit, speed: number, vol: number): void {
  playTone(tk, 'sine', 200 * speed, 40 * speed, 0.12 / speed, 0.3 * vol, 0.4 * vol);
  playNoiseBurst(tk, 0.18 / speed, 'lowpass', 2500, 1, 0.25 * vol, 0.35 * vol, 0.18 / speed, 0, 400);
}

// Medium unit death - solid explosion with debris
export function mediumExplosion(tk: AudioToolkit, speed: number, vol: number): void {
  // Main thump
  playTone(tk, 'sine', 120 * speed, 25 * speed, 0.25 / speed, 0.35 * vol, 0.45 * vol);
  // Secondary mid-freq punch
  playTone(tk, 'triangle', 180 * speed, 50 * speed, 0.2 / speed, 0.2 * vol, 0.3 * vol);
  // Noise burst
  playNoiseBurst(tk, 0.3 / speed, 'lowpass', 3500, 1, 0.3 * vol, 0.4 * vol, 0.3 / speed, 0, 200);
}

// Large unit death - massive explosion with rumble
export function largeExplosion(tk: AudioToolkit, speed: number, vol: number): void {
  // Deep powerful boom
  playTone(tk, 'sine', 80 * speed, 15 * speed, 0.5 / speed, 0.45 * vol, 0.55 * vol);
  // Secondary rumble layer (delayed slightly)
  playTone(tk, 'triangle', 100 * speed, 20 * speed, 0.43 / speed, 0.35 * vol, 0.4 * vol, 0.02 / speed);
  // Third sub-bass layer
  playTone(tk, 'sine', 40 * speed, 12 * speed, 0.6 / speed, 0.3 * vol, 0.35 * vol);
  // Heavy explosion noise
  playNoiseBurst(tk, 0.55 / speed, 'lowpass', 4000, 1, 0.4 * vol, 0.5 * vol, 0.55 / speed, 0, 80);
}

// Synth name → function mapping
export const DEATH_SYNTHS: Record<string, (tk: AudioToolkit, speed: number, vol: number) => void> = {
  'small-explosion': smallExplosion,
  'medium-explosion': mediumExplosion,
  'large-explosion': largeExplosion,
};
