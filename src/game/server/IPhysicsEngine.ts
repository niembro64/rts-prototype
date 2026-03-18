// Common interface for PhysicsEngine implementations (JS and WASM)

import type { PhysicsBody } from '@/types/game';

export interface IPhysicsEngine {
  createUnitBody(
    x: number,
    y: number,
    physicsRadius: number,
    mass: number,
    label: string,
  ): PhysicsBody;

  createBuildingBody(
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
  ): PhysicsBody;

  removeBody(body: PhysicsBody): void;

  applyForce(body: PhysicsBody, fx: number, fy: number): void;

  /** Skip circle-rect collision between a dynamic body and a specific static body.
   *  Used for units spawning inside their factory. */
  setIgnoreStatic(dynamicBody: PhysicsBody, staticBody: PhysicsBody): void;

  step(dtSec: number): void;
}
