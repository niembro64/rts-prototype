// Physics helpers for Matter.js integration

import type Phaser from 'phaser';
import type { Entity } from '../../sim/types';
import type { WorldState } from '../../sim/WorldState';
import type { ForceAccumulator } from '../../sim/ForceAccumulator';
import { UNIT_MASS_MULTIPLIER } from '../../../config';

// Create a physics body with explicit mass from config
export function createUnitBody(
  matter: Phaser.Physics.Matter.MatterPhysics,
  x: number,
  y: number,
  collisionRadius: number,
  mass: number,
  label: string
): MatterJS.BodyType {
  // Apply global mass multiplier for physics feel tuning
  const physicsMass = mass * UNIT_MASS_MULTIPLIER;

  const body = matter.add.circle(x, y, collisionRadius, {
    friction: 0.01,        // Low ground friction
    frictionAir: 0.15,     // Higher air friction - units slow down quickly when not thrusting
    frictionStatic: 0.1,
    restitution: 0.2,      // Less bounce
    label,
  });

  // Explicitly set mass after creation (Matter.js option doesn't always work)
  matter.body.setMass(body, physicsMass);

  // Set inertia based on mass - heavier units resist rotation more
  matter.body.setInertia(body, physicsMass * collisionRadius * collisionRadius * 0.5);

  return body as unknown as MatterJS.BodyType;
}

// Create Matter.js physics bodies for entities
export function createMatterBodies(
  matter: Phaser.Physics.Matter.MatterPhysics,
  entities: Entity[]
): void {
  for (const entity of entities) {
    if (entity.type === 'unit' && entity.unit) {
      // Circle body for units with proper mass
      const body = createUnitBody(
        matter,
        entity.transform.x,
        entity.transform.y,
        entity.unit.collisionRadius,
        entity.unit.mass,
        `unit_${entity.id}`
      );
      entity.body = { matterBody: body };
    } else if (entity.type === 'building' && entity.building) {
      // Rectangle body for buildings (static)
      const body = matter.add.rectangle(
        entity.transform.x,
        entity.transform.y,
        entity.building.width,
        entity.building.height,
        {
          isStatic: true,
          friction: 0.8,
          restitution: 0.1,
          label: `building_${entity.id}`,
        }
      );

      entity.body = { matterBody: body as unknown as MatterJS.BodyType };
    }
  }
}

// Apply forces to Matter bodies - simple force toward waypoint, friction handles the rest
export function applyUnitVelocities(
  matter: Phaser.Physics.Matter.MatterPhysics,
  world: WorldState,
  forceAccumulator: ForceAccumulator
): void {
  for (const entity of world.getUnits()) {
    if (!entity.body?.matterBody || !entity.unit) continue;

    const matterBody = entity.body.matterBody as MatterJS.BodyType;

    // Sync position from physics body
    entity.transform.x = matterBody.position.x;
    entity.transform.y = matterBody.position.y;

    // Get the direction unit wants to move (stored as velocityX/Y, normalized direction)
    const dirX = entity.unit.velocityX ?? 0;
    const dirY = entity.unit.velocityY ?? 0;
    const dirMag = Math.sqrt(dirX * dirX + dirY * dirY);

    // Update rotation to face movement direction
    if (dirMag > 0.01) {
      entity.transform.rotation = Math.atan2(dirY, dirX);
    }

    // Pure Newtonian physics: F = m × a, so a = F / m
    // Thrust force uses unit's base mass (NOT multiplied by UNIT_MASS_MULTIPLIER)
    // Body mass = unit.mass × UNIT_MASS_MULTIPLIER (set in createUnitBody)
    // Acceleration = thrust / bodyMass = (moveSpeed × mass) / (mass × UNIT_MASS_MULTIPLIER)
    //              = moveSpeed / UNIT_MASS_MULTIPLIER
    // This way UNIT_MASS_MULTIPLIER actually affects acceleration (higher = slower)
    // and heavy units still push light units in collisions due to scaled body mass
    let thrustForceX = 0;
    let thrustForceY = 0;
    if (dirMag > 0) {
      // Matter.js expects small force values - divide by scale factor
      // Use base mass (not multiplied) so UNIT_MASS_MULTIPLIER affects acceleration
      const MATTER_FORCE_SCALE = 150000;
      const thrustMagnitude = (entity.unit.moveSpeed * entity.unit.mass) / MATTER_FORCE_SCALE;
      thrustForceX = (dirX / dirMag) * thrustMagnitude;
      thrustForceY = (dirY / dirMag) * thrustMagnitude;
    }

    // Get external forces (like wave pull, knockback) from the accumulator
    const externalForce = forceAccumulator.getFinalForce(entity.id);
    const externalFx = (externalForce?.fx ?? 0) / 3600; // Scale down to match physics scale
    const externalFy = (externalForce?.fy ?? 0) / 3600;

    // Combine thrust and external forces
    let totalForceX = thrustForceX + externalFx;
    let totalForceY = thrustForceY + externalFy;

    // Safety: skip NaN/Infinity values
    if (!Number.isFinite(totalForceX) || !Number.isFinite(totalForceY)) {
      continue;
    }

    // Apply force at center of mass
    matter.body.applyForce(matterBody, matterBody.position, {
      x: totalForceX,
      y: totalForceY,
    });
  }
}
