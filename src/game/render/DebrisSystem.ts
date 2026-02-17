// DebrisSystem - Manages death debris fragments (physics, aging, rendering)
// Extracted from renderEntities.ts

import Phaser from 'phaser';
import { BURN_COLOR_COOL, hexToRgb, DEBRIS_CONFIG } from '../../config';

const BURN_COOL_RGB = hexToRgb(BURN_COLOR_COOL);

// Death debris fragment — line segment with physics, color decay like burn marks
export interface DebrisFragment {
  x: number; y: number;         // current center position
  vx: number; vy: number;       // velocity (pixels/sec)
  rotation: number;              // current angle of the segment
  angularVel: number;            // rotation speed (rad/sec)
  length: number;                // segment length
  width: number;                 // line width
  color: number;                 // cached RGB (updated during aging)
  baseColor: number;             // original color at creation
  age: number;                   // ms since creation
  shape: 'line' | 'rect';       // line = segment + caps, rect = filled rectangle
}

// Per-unit-type debris piece template (local coordinates relative to unit center)
export interface DebrisPieceTemplate {
  localX: number;
  localY: number;
  length: number;
  width: number;
  angle: number;       // local angle offset
  colorType: 'base' | 'dark' | 'light' | 'gray' | 'white';
  shape: 'line' | 'rect';
}

const MAX_DEBRIS = DEBRIS_CONFIG.maxFragments;
const DEBRIS_DRAG = DEBRIS_CONFIG.drag;
const _debrisRectPts = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

// Cached debris templates per unit type
const debrisTemplateCache: Map<string, DebrisPieceTemplate[]> = new Map();

function getDebrisTemplateKey(unitType: string, radius: number): string {
  return `${unitType}:${Math.round(radius)}`;
}

/**
 * Generate debris piece templates for a unit type.
 * These are in local coordinates (relative to unit center, unrotated).
 */
export function getDebrisPieces(unitType: string, radius: number): DebrisPieceTemplate[] {
  const key = getDebrisTemplateKey(unitType, radius);
  const cached = debrisTemplateCache.get(key);
  if (cached) return cached;

  const r = radius;
  const pieces: DebrisPieceTemplate[] = [];

  // Helper: add polygon edges as debris
  const addPolygonEdges = (cx: number, cy: number, polyR: number, sides: number, rot: number, width: number, color: DebrisPieceTemplate['colorType'], shape: 'line' | 'rect' = 'line') => {
    for (let i = 0; i < sides; i++) {
      const a1 = rot + (i / sides) * Math.PI * 2;
      const a2 = rot + ((i + 1) / sides) * Math.PI * 2;
      const x1 = cx + Math.cos(a1) * polyR;
      const y1 = cy + Math.sin(a1) * polyR;
      const x2 = cx + Math.cos(a2) * polyR;
      const y2 = cy + Math.sin(a2) * polyR;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      pieces.push({ localX: mx, localY: my, length: Math.sqrt(dx * dx + dy * dy), width, angle: Math.atan2(dy, dx), colorType: color, shape });
    }
  };

  // Helper: add a barrel/line segment
  const addBarrel = (ox: number, oy: number, len: number, width: number, angle: number, color: DebrisPieceTemplate['colorType']) => {
    const mx = ox + Math.cos(angle) * len / 2;
    const my = oy + Math.sin(angle) * len / 2;
    pieces.push({ localX: mx, localY: my, length: len, width, angle, colorType: color, shape: 'line' });
  };

  switch (unitType) {
    case 'widow': {
      // 8 legs — rendered at 6px thickness
      const legLen = r * 1.9;
      const upperLen = legLen * 0.55;
      const lowerLen = legLen * 0.55;
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? -1 : 1;
        const idx = i < 4 ? i : i - 4;
        const attachAngle = (idx / 4 - 0.5) * Math.PI * 0.8 + Math.PI / 2 * side;
        const ax = Math.cos(attachAngle) * r * 0.4;
        const ay = Math.sin(attachAngle) * r * 0.4;
        pieces.push({ localX: ax, localY: ay, length: upperLen, width: 7, angle: attachAngle, colorType: 'dark', shape: 'line' });
        const kx = ax + Math.cos(attachAngle) * upperLen;
        const ky = ay + Math.sin(attachAngle) * upperLen;
        pieces.push({ localX: kx, localY: ky, length: lowerLen, width: 6, angle: attachAngle, colorType: 'dark', shape: 'line' });
      }
      // Abdomen — large oval chunk at rear, r*1.1 long × r*0.85 wide
      pieces.push({ localX: -r * 0.9, localY: 0, length: r * 1.1, width: r * 0.85, angle: 0, colorType: 'dark', shape: 'rect' });
      // Body hexagon edges — outer hex r*0.95 centered at r*0.35 forward
      addPolygonEdges(r * 0.35, 0, r * 0.95, 6, Math.PI / 6, r * 0.3, 'dark', 'rect');
      // 6 beam emitters — r*0.5 long, 2.5px wide
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 + Math.PI / 6;
        const ex = Math.cos(a) * r * 0.65 + r * 0.5;
        const ey = Math.sin(a) * r * 0.65;
        addBarrel(ex, ey, r * 0.5, 2.5, a, 'white');
      }
      // Center beam — r*0.6 long, 3.5px wide
      addBarrel(r * 0.5, 0, r * 0.6, 3.5, 0, 'white');
      break;
    }

    case 'tarantula': {
      // 8 legs — rendered at 4-4.5px thickness (thinner than widow)
      const legLen = r * 1.9;
      const upperLen = legLen * 0.55;
      const lowerLen = legLen * 0.55;
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? -1 : 1;
        const idx = i < 4 ? i : i - 4;
        const attachAngle = (idx / 4 - 0.5) * Math.PI * 0.8 + Math.PI / 2 * side;
        const ax = Math.cos(attachAngle) * r * 0.4;
        const ay = Math.sin(attachAngle) * r * 0.4;
        pieces.push({ localX: ax, localY: ay, length: upperLen, width: 4.5, angle: attachAngle, colorType: 'dark', shape: 'line' });
        const kx = ax + Math.cos(attachAngle) * upperLen;
        const ky = ay + Math.sin(attachAngle) * upperLen;
        pieces.push({ localX: kx, localY: ky, length: lowerLen, width: 4, angle: attachAngle, colorType: 'dark', shape: 'line' });
      }
      // Compact body — 8-point shape ~r*0.6 × r*0.5
      addPolygonEdges(0, 0, r * 0.5, 6, 0, r * 0.2, 'dark', 'rect');
      // Inner carapace hex r*0.3
      addPolygonEdges(0, 0, r * 0.3, 6, 0, r * 0.12, 'light', 'rect');
      break;
    }

    case 'daddy': {
      // 8 long spindly legs — rendered at only 2-2.5px thickness
      const legLen = r * 10;
      const upperLen = legLen * 0.3;
      const lowerLen = legLen * 0.6;
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? -1 : 1;
        const idx = i < 4 ? i : i - 4;
        const attachAngle = (idx / 4 - 0.5) * Math.PI * 0.8 + Math.PI / 2 * side;
        const ax = Math.cos(attachAngle) * r * 0.4;
        const ay = Math.sin(attachAngle) * r * 0.4;
        pieces.push({ localX: ax, localY: ay, length: upperLen, width: 2.5, angle: attachAngle, colorType: 'dark', shape: 'line' });
        const kx = ax + Math.cos(attachAngle) * upperLen;
        const ky = ay + Math.sin(attachAngle) * upperLen;
        pieces.push({ localX: kx, localY: ky, length: lowerLen, width: 2, angle: attachAngle, colorType: 'dark', shape: 'line' });
      }
      // Elongated body — r*0.9 long × r*0.55 wide
      addPolygonEdges(0, 0, r * 0.5, 6, 0, r * 0.2, 'base', 'rect');
      // Central beam emitter — r*0.6 long, 3.5px wide
      addBarrel(0, 0, r * 0.6, 3.5, 0, 'white');
      break;
    }

    case 'commander': {
      // 4 heavy legs — rendered at 6-8px thickness
      const legLen = r * 2.2;
      const upperLen = legLen * 0.5;
      const lowerLen = legLen * 0.5;
      for (let i = 0; i < 4; i++) {
        const side = i < 2 ? -1 : 1;
        const idx = i < 2 ? i : i - 2;
        const attachAngle = (idx === 0 ? 0.3 : -0.3) * Math.PI + Math.PI / 2 * side;
        const ax = Math.cos(attachAngle) * r * 0.5;
        const ay = Math.sin(attachAngle) * r * 0.5;
        pieces.push({ localX: ax, localY: ay, length: upperLen, width: 8, angle: attachAngle, colorType: 'dark', shape: 'line' });
        const kx = ax + Math.cos(attachAngle) * upperLen;
        const ky = ay + Math.sin(attachAngle) * upperLen;
        pieces.push({ localX: kx, localY: ky, length: lowerLen, width: 7, angle: attachAngle, colorType: 'dark', shape: 'line' });
      }
      // Angular chassis — r*0.85 × r*0.7
      addPolygonEdges(0, 0, r * 0.8, 6, 0, r * 0.25, 'base', 'rect');
      // Shoulder pylons — r*0.2 squares offset r*0.55 sideways
      for (const side of [-1, 1]) {
        pieces.push({ localX: 0, localY: r * 0.55 * side, length: r * 0.4, width: r * 0.4, angle: 0, colorType: 'dark', shape: 'rect' });
      }
      // Beam weapon barrel — r*0.7 long, 6px wide
      addBarrel(r * 0.3, 0, r * 0.7, 6, 0, 'white');
      break;
    }

    case 'mammoth': {
      // 2 heavy treads — r*2.0 long × r*0.6 wide, offset r*0.9
      const treadLen = r * 2.0;
      const treadOffset = r * 0.9;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const segLen = treadLen / 3;
          const sx = (i - 1) * segLen;
          pieces.push({ localX: sx, localY: treadOffset * side, length: segLen, width: r * 0.6, angle: 0, colorType: 'gray', shape: 'rect' });
        }
      }
      // Hull square — r*0.85
      addPolygonEdges(0, 0, r * 0.85, 4, 0, r * 0.35, 'base', 'rect');
      // Heavy cannon — r*1.4 long, 7px wide
      addBarrel(0, 0, r * 1.4, 7, 0, 'white');
      break;
    }

    case 'badger': {
      // 2 treads — r*1.7 long × r*0.5 wide, offset r*0.85
      const treadLen = r * 1.7;
      const treadOffset = r * 0.85;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
          const segLen = treadLen / 2;
          const sx = (i - 0.5) * segLen;
          pieces.push({ localX: sx, localY: treadOffset * side, length: segLen, width: r * 0.5, angle: 0, colorType: 'gray', shape: 'rect' });
        }
      }
      // Body pentagon — r*0.8
      addPolygonEdges(0, 0, r * 0.8, 5, 0, r * 0.25, 'dark', 'rect');
      // Shotgun barrel — r*1.0 long, 5px wide
      addBarrel(0, 0, r * 1.0, 5, 0, 'white');
      break;
    }

    case 'jackal': {
      // 4 wheels — at r*0.6/r*0.7, tread r*0.5 × r*0.11
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          pieces.push({ localX: r * 0.6 * sx, localY: r * 0.7 * sy, length: r * 0.5, width: r * 0.11, angle: 0, colorType: 'gray', shape: 'rect' });
        }
      }
      // Diamond body — r*0.55
      addPolygonEdges(0, 0, r * 0.55, 4, Math.PI / 4, r * 0.15, 'light', 'rect');
      // Inner accent — r*0.35
      addPolygonEdges(0, 0, r * 0.35, 4, Math.PI / 4, r * 0.1, 'base', 'rect');
      // Triple barrels — r*1.0 long, 1.5px wide
      for (let i = -1; i <= 1; i++) {
        addBarrel(0, i * 2, r * 1.0, 1.5, 0, 'white');
      }
      break;
    }

    case 'lynx': {
      // 2 large side treads — r*1.6 × r*0.45 at r*0.8 offset
      for (const sy of [-1, 1]) {
        pieces.push({ localX: 0, localY: r * 0.8 * sy, length: r * 1.6, width: r * 0.45, angle: 0, colorType: 'gray', shape: 'rect' });
      }
      // Triangle body — r*0.6
      addPolygonEdges(0, 0, r * 0.6, 3, -Math.PI / 2, r * 0.15, 'light', 'rect');
      // Inner wedge — r*0.38
      addPolygonEdges(0, 0, r * 0.38, 3, -Math.PI / 2, r * 0.1, 'base', 'rect');
      // Dual burst barrels — r*1.1 long, 2.5px wide, 3px apart
      addBarrel(0, -3, r * 1.1, 2.5, 0, 'white');
      addBarrel(0, 3, r * 1.1, 2.5, 0, 'white');
      break;
    }

    case 'scorpion': {
      // 4 wheels — at r*0.65/r*0.7, tread r*0.5 × r*0.11
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          pieces.push({ localX: r * 0.65 * sx, localY: r * 0.7 * sy, length: r * 0.5, width: r * 0.11, angle: 0, colorType: 'gray', shape: 'rect' });
        }
      }
      // Hexagon body — r*0.55
      addPolygonEdges(0, 0, r * 0.55, 6, 0, r * 0.15, 'gray', 'rect');
      // Inner platform — r*0.4
      addPolygonEdges(0, 0, r * 0.4, 6, 0, r * 0.1, 'base', 'rect');
      // Mortar tube — r*0.75 long, 6px wide
      addBarrel(0, 0, r * 0.75, 6, 0, 'white');
      break;
    }

    case 'recluse': {
      // 8 spindly legs — thin lines radiating outward
      const legLen = r * 2.4;
      const upperLen = legLen * 0.5;
      const lowerLen = legLen * 0.55;
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? -1 : 1;
        const idx = i < 4 ? i : i - 4;
        const attachAngle = (idx / 4 - 0.5) * Math.PI * 0.8 + Math.PI / 2 * side;
        const ax = Math.cos(attachAngle) * r * 0.15;
        const ay = Math.sin(attachAngle) * r * 0.15;
        pieces.push({ localX: ax, localY: ay, length: upperLen, width: 2, angle: attachAngle, colorType: 'dark', shape: 'line' });
        const kx = ax + Math.cos(attachAngle) * upperLen;
        const ky = ay + Math.sin(attachAngle) * upperLen;
        pieces.push({ localX: kx, localY: ky, length: lowerLen, width: 1.5, angle: attachAngle, colorType: 'dark', shape: 'line' });
      }
      // Abdomen — rear oval
      pieces.push({ localX: -r * 0.35, localY: 0, length: r * 0.55, width: r * 0.45, angle: 0, colorType: 'base', shape: 'rect' });
      // Cephalothorax — front
      pieces.push({ localX: r * 0.3, localY: 0, length: r * 0.4, width: r * 0.35, angle: 0, colorType: 'light', shape: 'rect' });
      // Long railgun barrel — r*1.6 long, 2px wide
      addBarrel(0, 0, r * 1.6, 2, 0, 'white');
      break;
    }

    default: {
      // Generic fallback: hexagon body + barrel
      addPolygonEdges(0, 0, r * 0.6, 6, 0, r * 0.15, 'base', 'rect');
      addBarrel(0, 0, r * 1.0, 2, 0, 'white');
      break;
    }
  }

  debrisTemplateCache.set(key, pieces);
  return pieces;
}

export class DebrisSystem {
  fragments: DebrisFragment[] = [];

  /**
   * Add debris fragments for a destroyed unit.
   * Generates pieces from a per-unit-type template, applies random velocities with hit-direction bias.
   */
  addDebris(
    x: number, y: number,
    unitType: string, rotation: number,
    radius: number, color: number,
    hitDirX: number, hitDirY: number
  ): void {
    const templates = getDebrisPieces(unitType, radius);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    // Resolve color types from the player color
    const baseR = (color >> 16) & 0xFF;
    const baseG = (color >> 8) & 0xFF;
    const baseB = color & 0xFF;
    const darkColor = ((baseR >> 1) << 16) | ((baseG >> 1) << 8) | (baseB >> 1);
    const lightR = Math.min(255, baseR + 60);
    const lightG = Math.min(255, baseG + 60);
    const lightB = Math.min(255, baseB + 60);
    const lightColor = (lightR << 16) | (lightG << 8) | lightB;
    const colorMap: Record<string, number> = {
      base: color,
      dark: darkColor,
      light: lightColor,
      gray: 0x606060,
      white: 0xf0f0f0,
    };

    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      // Transform local position by unit rotation
      const wx = x + cos * t.localX - sin * t.localY;
      const wy = y + sin * t.localX + cos * t.localY;

      // Random velocity with hit-direction bias
      const randAngle = Math.random() * Math.PI * 2;
      const randMag = DEBRIS_CONFIG.randomSpeedMin + Math.random() * DEBRIS_CONFIG.randomSpeedRange;
      const hitBias = DEBRIS_CONFIG.hitBiasMin + Math.random() * DEBRIS_CONFIG.hitBiasRange;
      const vx = Math.cos(randAngle) * randMag + hitDirX * hitBias;
      const vy = Math.sin(randAngle) * randMag + hitDirY * hitBias;

      const angularVel = (Math.random() - 0.5) * DEBRIS_CONFIG.angularSpeedMax;

      const fragColor = colorMap[t.colorType] ?? color;

      this.fragments.push({
        x: wx, y: wy,
        vx, vy,
        rotation: rotation + t.angle,
        angularVel,
        length: t.length,
        width: t.width,
        color: fragColor,
        baseColor: fragColor,
        age: 0,
        shape: t.shape,
      });
    }

    // Cap debris
    if (this.fragments.length > MAX_DEBRIS) {
      const excess = this.fragments.length - MAX_DEBRIS;
      for (let i = 0; i < MAX_DEBRIS; i++) {
        this.fragments[i] = this.fragments[i + excess];
      }
      this.fragments.length = MAX_DEBRIS;
    }
  }

  /**
   * Age debris fragments — physics update + single-stage color decay (baseColor -> background).
   * @param dtMs - delta time in milliseconds
   * @param burnCutoff - alpha cutoff threshold for pruning faded fragments
   */
  update(dtMs: number, burnCutoff: number): void {
    const debrisFadeTau = DEBRIS_CONFIG.fadeDecayTau;
    let debrisWrite = 0;
    for (let i = 0; i < this.fragments.length; i++) {
      const frag = this.fragments[i];
      frag.age += dtMs;
      const fadeBlend = 1 - Math.exp(-frag.age / debrisFadeTau);
      if (fadeBlend < 1 - burnCutoff) {
        // Update physics
        const dtSec = dtMs / 1000;
        frag.x += frag.vx * dtSec;
        frag.y += frag.vy * dtSec;
        frag.vx *= DEBRIS_DRAG;
        frag.vy *= DEBRIS_DRAG;
        frag.rotation += frag.angularVel * dtSec;
        frag.angularVel *= DEBRIS_DRAG;
        // Direct blend: baseColor -> background
        const keep = 1 - fadeBlend;
        const fragR = (frag.baseColor >> 16) & 0xFF;
        const fragG = (frag.baseColor >> 8) & 0xFF;
        const fragB = frag.baseColor & 0xFF;
        const r = Math.round(fragR * keep + BURN_COOL_RGB.r * fadeBlend);
        const g = Math.round(fragG * keep + BURN_COOL_RGB.g * fadeBlend);
        const b = Math.round(fragB * keep + BURN_COOL_RGB.b * fadeBlend);
        frag.color = (r << 16) | (g << 8) | b;
        this.fragments[debrisWrite++] = frag;
      }
    }
    this.fragments.length = debrisWrite;
  }

  /**
   * Render all debris fragments.
   * @param graphics - Phaser graphics object to draw on
   * @param isInViewport - viewport culling callback (x, y, padding) => boolean
   */
  render(graphics: Phaser.GameObjects.Graphics, isInViewport: (x: number, y: number, padding: number) => boolean): void {
    for (let i = 0; i < this.fragments.length; i++) {
      const frag = this.fragments[i];
      if (!isInViewport(frag.x, frag.y, frag.length)) continue;
      const fragCos = Math.cos(frag.rotation);
      const fragSin = Math.sin(frag.rotation);
      const halfLen = frag.length / 2;
      if (frag.shape === 'rect') {
        // Filled oriented rectangle — 4 rotated corners
        const halfW = frag.width / 2;
        const dx = fragCos * halfLen;
        const dy = fragSin * halfLen;
        const nx = -fragSin * halfW;
        const ny = fragCos * halfW;
        _debrisRectPts[0].x = frag.x - dx + nx; _debrisRectPts[0].y = frag.y - dy + ny;
        _debrisRectPts[1].x = frag.x + dx + nx; _debrisRectPts[1].y = frag.y + dy + ny;
        _debrisRectPts[2].x = frag.x + dx - nx; _debrisRectPts[2].y = frag.y + dy - ny;
        _debrisRectPts[3].x = frag.x - dx - nx; _debrisRectPts[3].y = frag.y - dy - ny;
        graphics.fillStyle(frag.color, 1);
        graphics.fillPoints(_debrisRectPts, true);
      } else {
        // Line segment with rounded caps
        const x1 = frag.x - fragCos * halfLen;
        const y1 = frag.y - fragSin * halfLen;
        const x2 = frag.x + fragCos * halfLen;
        const y2 = frag.y + fragSin * halfLen;
        graphics.lineStyle(frag.width, frag.color, 1);
        graphics.lineBetween(x1, y1, x2, y2);
        const capR = frag.width / 2;
        graphics.fillStyle(frag.color, 1);
        graphics.fillCircle(x1, y1, capR);
        graphics.fillCircle(x2, y2, capR);
      }
    }
  }

  clear(): void {
    this.fragments.length = 0;
  }
}
