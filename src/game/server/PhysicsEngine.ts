// Custom physics engine - replaces Matter.js
// Handles force integration, velocity damping, and circle-circle/circle-rect collision response.

import { UNIT_MASS_MULTIPLIER } from '../../config';

export interface PhysicsBody {
  x: number;
  y: number;
  vx: number;           // px/sec
  vy: number;           // px/sec
  radius: number;       // collision radius
  mass: number;
  invMass: number;      // 1/mass (0 for static)
  frictionAir: number;  // per-frame at 60fps (e.g. 0.15)
  restitution: number;  // bounce coefficient
  isStatic: boolean;
  label: string;
  halfW?: number;       // for rectangles (buildings)
  halfH?: number;
}

export class PhysicsEngine {
  private bodies: PhysicsBody[] = [];
  private staticBodies: PhysicsBody[] = [];
  private dynamicBodies: PhysicsBody[] = [];
  private mapWidth: number;
  private mapHeight: number;

  constructor(mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  // Accumulated acceleration per step (cleared after integration)
  private accelX: Map<PhysicsBody, number> = new Map();
  private accelY: Map<PhysicsBody, number> = new Map();

  createUnitBody(
    x: number,
    y: number,
    collisionRadius: number,
    mass: number,
    label: string
  ): PhysicsBody {
    const physicsMass = mass * UNIT_MASS_MULTIPLIER;
    const body: PhysicsBody = {
      x,
      y,
      vx: 0,
      vy: 0,
      radius: collisionRadius,
      mass: physicsMass,
      invMass: 1 / physicsMass,
      frictionAir: 0.15,
      restitution: 0.2,
      isStatic: false,
      label,
    };
    this.addBody(body);
    return body;
  }

  createBuildingBody(
    x: number,
    y: number,
    width: number,
    height: number,
    label: string
  ): PhysicsBody {
    const body: PhysicsBody = {
      x,
      y,
      vx: 0,
      vy: 0,
      radius: 0,
      mass: 0,
      invMass: 0,
      frictionAir: 0,
      restitution: 0.1,
      isStatic: true,
      label,
      halfW: width / 2,
      halfH: height / 2,
    };
    this.addBody(body);
    return body;
  }

  addBody(body: PhysicsBody): void {
    this.bodies.push(body);
    if (body.isStatic) {
      this.staticBodies.push(body);
    } else {
      this.dynamicBodies.push(body);
    }
  }

  removeBody(body: PhysicsBody): void {
    let idx = this.bodies.indexOf(body);
    if (idx !== -1) {
      this.bodies[idx] = this.bodies[this.bodies.length - 1];
      this.bodies.pop();
    }
    if (body.isStatic) {
      idx = this.staticBodies.indexOf(body);
      if (idx !== -1) {
        this.staticBodies[idx] = this.staticBodies[this.staticBodies.length - 1];
        this.staticBodies.pop();
      }
    } else {
      idx = this.dynamicBodies.indexOf(body);
      if (idx !== -1) {
        this.dynamicBodies[idx] = this.dynamicBodies[this.dynamicBodies.length - 1];
        this.dynamicBodies.pop();
      }
    }
    this.accelX.delete(body);
    this.accelY.delete(body);
  }

  // Apply force (Newtons). acceleration = force / mass
  applyForce(body: PhysicsBody, fx: number, fy: number): void {
    if (body.isStatic || body.invMass === 0) return;
    const ax = (this.accelX.get(body) ?? 0) + fx * body.invMass;
    const ay = (this.accelY.get(body) ?? 0) + fy * body.invMass;
    this.accelX.set(body, ax);
    this.accelY.set(body, ay);
  }

  // Main step - variable dt (seconds)
  // Order matches Matter.js Verlet: friction → force integration → position → collisions
  step(dtSec: number): void {
    const dynamic = this.dynamicBodies;
    const numDynamic = dynamic.length;

    // 1. Air friction first (matches Matter.js ordering for exact force-balance equivalence)
    // dt-independent damping: at 60fps v *= (1 - frictionAir), variable dt: pow(1 - frictionAir, dt * 60)
    const dtFrames = dtSec * 60;
    for (let i = 0; i < numDynamic; i++) {
      const b = dynamic[i];
      const damping = Math.pow(1 - b.frictionAir, dtFrames);
      b.vx *= damping;
      b.vy *= damping;
    }

    // 2. Integrate: v += a * dt, pos += v * dt
    for (let i = 0; i < numDynamic; i++) {
      const b = dynamic[i];
      const ax = this.accelX.get(b) ?? 0;
      const ay = this.accelY.get(b) ?? 0;
      b.vx += ax * dtSec;
      b.vy += ay * dtSec;
      b.x += b.vx * dtSec;
      b.y += b.vy * dtSec;
    }

    // 2b. Clamp to map boundaries
    const mapW = this.mapWidth;
    const mapH = this.mapHeight;
    for (let i = 0; i < numDynamic; i++) {
      const b = dynamic[i];
      const r = b.radius;
      if (b.x < r) { b.x = r; if (b.vx < 0) b.vx = 0; }
      else if (b.x > mapW - r) { b.x = mapW - r; if (b.vx > 0) b.vx = 0; }
      if (b.y < r) { b.y = r; if (b.vy < 0) b.vy = 0; }
      else if (b.y > mapH - r) { b.y = mapH - r; if (b.vy > 0) b.vy = 0; }
    }

    // Clear accumulated forces
    this.accelX.clear();
    this.accelY.clear();

    // 3. Resolve collisions
    this.resolveCollisions(dynamic);
  }

  private resolveCollisions(dynamic: PhysicsBody[]): void {
    const numDynamic = dynamic.length;
    const statics = this.staticBodies;
    const numStatic = statics.length;

    // Circle-circle (dynamic vs dynamic)
    for (let i = 0; i < numDynamic; i++) {
      const a = dynamic[i];
      for (let j = i + 1; j < numDynamic; j++) {
        const b = dynamic[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;
        const minDist = a.radius + b.radius;
        if (distSq >= minDist * minDist || distSq === 0) continue;

        const dist = Math.sqrt(distSq);
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;

        // Positional correction proportional to inverse mass
        const totalInvMass = a.invMass + b.invMass;
        if (totalInvMass === 0) continue;
        const corrA = overlap * (a.invMass / totalInvMass);
        const corrB = overlap * (b.invMass / totalInvMass);
        a.x -= nx * corrA;
        a.y -= ny * corrA;
        b.x += nx * corrB;
        b.y += ny * corrB;

        // Impulse-based velocity correction along collision normal
        const relVn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (relVn >= 0) continue; // separating

        const restitution = Math.min(a.restitution, b.restitution);
        const impulseMag = -(1 + restitution) * relVn / totalInvMass;
        a.vx -= impulseMag * a.invMass * nx;
        a.vy -= impulseMag * a.invMass * ny;
        b.vx += impulseMag * b.invMass * nx;
        b.vy += impulseMag * b.invMass * ny;
      }

      // Circle-rect (dynamic vs static buildings)
      for (let s = 0; s < numStatic; s++) {
        const rect = statics[s];
        if (rect.halfW === undefined || rect.halfH === undefined) continue;

        // Find nearest point on AABB to circle center
        const clampedX = Math.max(rect.x - rect.halfW, Math.min(a.x, rect.x + rect.halfW));
        const clampedY = Math.max(rect.y - rect.halfH, Math.min(a.y, rect.y + rect.halfH));

        const dx = a.x - clampedX;
        const dy = a.y - clampedY;
        const distSq = dx * dx + dy * dy;

        if (distSq >= a.radius * a.radius || distSq === 0) {
          // Handle edge case: circle center inside rect
          if (distSq === 0 && a.x >= rect.x - rect.halfW && a.x <= rect.x + rect.halfW &&
              a.y >= rect.y - rect.halfH && a.y <= rect.y + rect.halfH) {
            // Push out along smallest penetration axis
            const leftPen = (a.x - (rect.x - rect.halfW));
            const rightPen = ((rect.x + rect.halfW) - a.x);
            const topPen = (a.y - (rect.y - rect.halfH));
            const bottomPen = ((rect.y + rect.halfH) - a.y);
            const minPen = Math.min(leftPen, rightPen, topPen, bottomPen);
            if (minPen === leftPen) {
              a.x = rect.x - rect.halfW - a.radius;
              if (a.vx > 0) a.vx *= -rect.restitution;
            } else if (minPen === rightPen) {
              a.x = rect.x + rect.halfW + a.radius;
              if (a.vx < 0) a.vx *= -rect.restitution;
            } else if (minPen === topPen) {
              a.y = rect.y - rect.halfH - a.radius;
              if (a.vy > 0) a.vy *= -rect.restitution;
            } else {
              a.y = rect.y + rect.halfH + a.radius;
              if (a.vy < 0) a.vy *= -rect.restitution;
            }
          }
          continue;
        }

        const dist = Math.sqrt(distSq);
        const overlap = a.radius - dist;
        const nx = dx / dist;
        const ny = dy / dist;

        // Push circle out
        a.x += nx * overlap;
        a.y += ny * overlap;

        // Reflect velocity component along penetration normal
        const vDotN = a.vx * nx + a.vy * ny;
        if (vDotN < 0) {
          a.vx -= (1 + rect.restitution) * vDotN * nx;
          a.vy -= (1 + rect.restitution) * vDotN * ny;
        }
      }
    }
  }
}
