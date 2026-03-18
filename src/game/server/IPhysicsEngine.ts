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

  step(dtSec: number): void;
}
