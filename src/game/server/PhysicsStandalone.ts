// Standalone Matter.js physics helpers (no Phaser dependency)

import Matter from 'matter-js';
import type { Entity } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import type { ForceAccumulator } from '../sim/ForceAccumulator';
import { UNIT_MASS_MULTIPLIER } from '../../config';
import { magnitude } from '../math';

// Create a standalone Matter.js engine with zero gravity
export function createStandaloneEngine(): Matter.Engine {
  return Matter.Engine.create({
    gravity: { x: 0, y: 0 },
  });
}

// Create a physics body for a unit (standalone, no Phaser)
export function createUnitBodyStandalone(
  engine: Matter.Engine,
  x: number,
  y: number,
  collisionRadius: number,
  mass: number,
  label: string
): Matter.Body {
  const physicsMass = mass * UNIT_MASS_MULTIPLIER;

  const body = Matter.Bodies.circle(x, y, collisionRadius, {
    friction: 0.01,
    frictionAir: 0.15,
    frictionStatic: 0.1,
    restitution: 0.2,
    label,
  });

  Matter.Body.setMass(body, physicsMass);
  Matter.Body.setInertia(body, physicsMass * collisionRadius * collisionRadius * 0.5);

  Matter.Composite.add(engine.world, body);

  return body;
}

// Create a static physics body for a building (standalone, no Phaser)
export function createBuildingBodyStandalone(
  engine: Matter.Engine,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string
): Matter.Body {
  const body = Matter.Bodies.rectangle(x, y, width, height, {
    isStatic: true,
    friction: 0.8,
    restitution: 0.1,
    label,
  });

  Matter.Composite.add(engine.world, body);

  return body;
}

// Create Matter.js physics bodies for a list of entities
export function createMatterBodiesStandalone(
  engine: Matter.Engine,
  entities: Entity[]
): void {
  for (const entity of entities) {
    if (entity.type === 'unit' && entity.unit) {
      const body = createUnitBodyStandalone(
        engine,
        entity.transform.x,
        entity.transform.y,
        entity.unit.collisionRadius,
        entity.unit.mass,
        `unit_${entity.id}`
      );
      entity.body = { matterBody: body as unknown as MatterJS.BodyType };
    } else if (entity.type === 'building' && entity.building) {
      const body = createBuildingBodyStandalone(
        engine,
        entity.transform.x,
        entity.transform.y,
        entity.building.width,
        entity.building.height,
        `building_${entity.id}`
      );
      entity.body = { matterBody: body as unknown as MatterJS.BodyType };
    }
  }
}

// Apply forces to Matter bodies and sync positions back to entities
export function applyUnitVelocitiesStandalone(
  _engine: Matter.Engine,
  world: WorldState,
  forceAccumulator: ForceAccumulator
): void {
  for (const entity of world.getUnits()) {
    if (!entity.body?.matterBody || !entity.unit) continue;

    const matterBody = entity.body.matterBody as unknown as Matter.Body;

    // Sync position from physics body
    entity.transform.x = matterBody.position.x;
    entity.transform.y = matterBody.position.y;

    // Get the direction unit wants to move
    const dirX = entity.unit.velocityX ?? 0;
    const dirY = entity.unit.velocityY ?? 0;
    const dirMag = magnitude(dirX, dirY);

    // Update rotation to face movement direction
    if (dirMag > 0.01) {
      entity.transform.rotation = Math.atan2(dirY, dirX);
    }

    let thrustForceX = 0;
    let thrustForceY = 0;
    if (dirMag > 0) {
      const MATTER_FORCE_SCALE = 150000;
      const thrustMagnitude = (entity.unit.moveSpeed * world.thrustMultiplier * entity.unit.mass) / MATTER_FORCE_SCALE;
      thrustForceX = (dirX / dirMag) * thrustMagnitude;
      thrustForceY = (dirY / dirMag) * thrustMagnitude;
    }

    // Get external forces from the accumulator
    const externalForce = forceAccumulator.getFinalForce(entity.id);
    const externalFx = (externalForce?.fx ?? 0) / 3600;
    const externalFy = (externalForce?.fy ?? 0) / 3600;

    let totalForceX = thrustForceX + externalFx;
    let totalForceY = thrustForceY + externalFy;

    if (!Number.isFinite(totalForceX) || !Number.isFinite(totalForceY)) {
      continue;
    }

    Matter.Body.applyForce(matterBody, matterBody.position, {
      x: totalForceX,
      y: totalForceY,
    });
  }
}

// Sync actual Matter body velocities back to entities (for snapshot serialization).
// simulation.update() overwrites velocityX/Y with thrust direction each tick,
// so this must run AFTER stepEngine to capture the real post-friction velocity.
export function syncVelocitiesFromPhysics(world: WorldState, physicsTimestepMs: number): void {
  const perSecondScale = 1000 / physicsTimestepMs;
  for (const entity of world.getUnits()) {
    if (!entity.body?.matterBody || !entity.unit) continue;
    const matterBody = entity.body.matterBody as unknown as Matter.Body;
    // Matter velocity is displacement per step; convert to units/second for client dead-reckoning
    entity.unit.velocityX = matterBody.velocity.x * perSecondScale;
    entity.unit.velocityY = matterBody.velocity.y * perSecondScale;
  }
}

// Remove a body from the engine world
export function removeBodyStandalone(engine: Matter.Engine, matterBody: MatterJS.BodyType): void {
  Matter.Composite.remove(engine.world, matterBody as unknown as Matter.Body);
}

// Step the physics engine
export function stepEngine(engine: Matter.Engine, deltaMs: number): void {
  Matter.Engine.update(engine, deltaMs);
}
