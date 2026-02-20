// One-shot weapon fire sound synthesis functions

import type { AudioToolkit } from './audioHelpers';
import { playTone, playNoiseBurst } from './audioHelpers';

// Laser zap - short bright descending tone
export function laserZap(tk: AudioToolkit, speed: number, vol: number): void {
  const d = 0.12 / speed;
  playTone(tk, 'sawtooth', 300 * speed, 150 * speed, d, 0.2 * vol, 0.25 * vol, 0, 'lowpass', 1500);
}

// Minigun - short punchy noise burst + click
export function minigun(tk: AudioToolkit, speed: number, vol: number): void {
  playNoiseBurst(tk, 0.05 / speed, 'bandpass', 1500 * speed, 2, 0.15 * vol, 0.4 * vol, 0.04 / speed);
  playTone(tk, 'square', 150 * speed, 150 * speed, 0.02 / speed, 0.1 * vol, 0.2 * vol);
}

// Cannon - deep boom + noise
export function cannon(tk: AudioToolkit, speed: number, vol: number): void {
  playTone(tk, 'sine', 120 * speed, 40 * speed, 0.3 / speed, 0.35 * vol, 0.5 * vol);
  playNoiseBurst(tk, 0.2 / speed, 'lowpass', 800, 1, 0.2 * vol, 0.3 * vol, 0.2 / speed, 0, 200);
}

// Shotgun - layered noise bursts + bass thump
export function shotgun(tk: AudioToolkit, speed: number, vol: number): void {
  for (let i = 0; i < 3; i++) {
    const delay = i * 0.008 / speed;
    playNoiseBurst(tk, 0.1 / speed, 'bandpass', (800 + i * 400) * speed, 1, 0.2 * vol, 0.35 * vol, 0.08 / speed, delay);
  }
  playTone(tk, 'sine', 100 * speed, 50 * speed, 0.1 / speed, 0.25 * vol, 0.4 * vol);
}

// Grenade - thunk
export function grenade(tk: AudioToolkit, speed: number, vol: number): void {
  playTone(tk, 'triangle', 200 * speed, 80 * speed, 0.12 / speed, 0.3 * vol, 0.4 * vol);
}

// Railgun - electric zap + crackle
export function railgun(tk: AudioToolkit, speed: number, vol: number): void {
  playTone(tk, 'sawtooth', 2000 * speed, 500 * speed, 0.1 / speed, 0.2 * vol, 0.25 * vol);
  playNoiseBurst(tk, 0.15 / speed, 'highpass', 3000, 1, 0.15 * vol, 0.2 * vol, 0.15 / speed);
}

// Burst rifle - quick noise tap
export function burstRifle(tk: AudioToolkit, speed: number, vol: number): void {
  playNoiseBurst(tk, 0.04 / speed, 'bandpass', 2000 * speed, 1.5, 0.2 * vol, 0.3 * vol, 0.04 / speed);
}

// Insect fire - chittery click + noise
export function insect(tk: AudioToolkit, speed: number, vol: number): void {
  playTone(tk, 'square', 800 * speed, 400 * speed, 0.03 / speed, 0.15 * vol, 0.25 * vol, 0, 'bandpass', 1200 * speed, 3);
  playNoiseBurst(tk, 0.02 / speed, 'highpass', 3000, 1, 0.08 * vol, 0.1 * vol, 0.02 / speed);
}

// Force field fire - deep resonant pulse (multi-layer)
export function forceFieldFire(tk: AudioToolkit, speed: number, vol: number): void {
  // Deep bass pulse
  playTone(tk, 'sine', 80 * speed, 40 * speed, 0.25 / speed, 0.35 * vol, 0.5 * vol);
  // Mid-range resonant tone
  playTone(tk, 'triangle', 200 * speed, 100 * speed, 0.2 / speed, 0.25 * vol, 0.35 * vol);
  // High frequency shimmer
  playNoiseBurst(tk, 0.15 / speed, 'bandpass', 2500, 2, 0.15 * vol, 0.2 * vol, 0.15 / speed);
}

// Synth name → function mapping
export const FIRE_SYNTHS: Record<string, (tk: AudioToolkit, speed: number, vol: number) => void> = {
  'laser-zap': laserZap,
  'minigun': minigun,
  'cannon': cannon,
  'shotgun': shotgun,
  'grenade': grenade,
  'railgun': railgun,
  'burst-rifle': burstRifle,
  'insect': insect,
  'force-field': forceFieldFire,
};
