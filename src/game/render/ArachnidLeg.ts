// Arachnid leg class - handles leg movement and rendering (client-side only)

import { normalizeAngle, magnitude } from '../math';

export interface LegConfig {
  // Attachment point offset relative to unit center (in unit's local space)
  attachOffsetX: number;  // Forward/back offset
  attachOffsetY: number;  // Left/right offset (positive = right side)

  // Leg segment lengths
  upperLegLength: number;
  lowerLegLength: number;

  // Snap trigger angle: how far behind (from forward) the foot must be to trigger snap
  // Smaller = triggers earlier (front legs), larger = triggers later (back legs)
  // Value is in radians from forward direction (e.g., PI/2 = 90° behind)
  snapTriggerAngle: number;

  // Snap target angle: direction to snap TO when leg needs to move (radians from forward)
  // Smaller = snaps more forward (front legs), larger = snaps more sideways (back legs)
  // Positive = right side, negative = left side
  snapTargetAngle: number;

  // Snap distance: how far from attachment point the foot snaps to (as multiplier of total leg length)
  // Larger = snaps farther out (front legs reach farther), smaller = snaps closer (back legs)
  snapDistanceMultiplier: number;

  // Extension threshold: how extended the leg must be before considering a snap (0-1)
  // Front legs can snap earlier (~0.85), back legs must be fully extended (~0.95)
  extensionThreshold: number;

  // Lerp duration in milliseconds - how long the foot takes to move to new position
  // Lower = faster/snappier, higher = slower/smoother
  lerpSpeed?: number;
}

// Ease-out cubic for smooth deceleration
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export class ArachnidLeg {
  private config: LegConfig;

  // Current ground point (world coordinates) - where the foot is rendered
  private groundX: number = 0;
  private groundY: number = 0;

  // Start position when lerp began
  private startGroundX: number = 0;
  private startGroundY: number = 0;

  // Target ground point when sliding to new position
  private targetGroundX: number = 0;
  private targetGroundY: number = 0;

  // Is the foot currently sliding to a new position?
  private isSliding: boolean = false;

  // Lerp progress (0 = at start position, 1 = at target position)
  private lerpProgress: number = 0;

  // Lerp duration in milliseconds
  private lerpDuration: number;

  // Has the leg been initialized with a ground position?
  private initialized: boolean = false;

  constructor(config: LegConfig) {
    this.config = config;
    // lerpSpeed is now used as duration in ms (default 150ms for snappy but smooth)
    this.lerpDuration = config.lerpSpeed ?? 150;
  }

  // Get total leg length (fully extended)
  private get totalLength(): number {
    return this.config.upperLegLength + this.config.lowerLegLength;
  }

  // Initialize leg at a specific unit position (call immediately after construction)
  // This prevents flickering from legs starting at (0,0)
  initializeAt(unitX: number, unitY: number, unitRotation: number): void {
    const cos = Math.cos(unitRotation);
    const sin = Math.sin(unitRotation);
    const attachX = unitX + cos * this.config.attachOffsetX - sin * this.config.attachOffsetY;
    const attachY = unitY + sin * this.config.attachOffsetX + cos * this.config.attachOffsetY;

    // Place foot at target snap angle and distance
    const restDistance = this.totalLength * this.config.snapDistanceMultiplier;
    const angle = unitRotation + this.config.snapTargetAngle;

    this.groundX = attachX + Math.cos(angle) * restDistance;
    this.groundY = attachY + Math.sin(angle) * restDistance;
    this.startGroundX = this.groundX;
    this.startGroundY = this.groundY;
    this.targetGroundX = this.groundX;
    this.targetGroundY = this.groundY;
    this.initialized = true;
  }

  // Initialize or update the leg based on unit position
  update(
    unitX: number,
    unitY: number,
    unitRotation: number,
    velocityX: number,
    velocityY: number,
    dtMs: number
  ): void {
    // Calculate attachment point in world coordinates
    const cos = Math.cos(unitRotation);
    const sin = Math.sin(unitRotation);
    const attachX = unitX + cos * this.config.attachOffsetX - sin * this.config.attachOffsetY;
    const attachY = unitY + sin * this.config.attachOffsetX + cos * this.config.attachOffsetY;

    // Initialize ground point on first update
    if (!this.initialized) {
      this.initializeGroundPoint(attachX, attachY, unitRotation);
      this.initialized = true;
      return;
    }

    // If sliding, animate toward target using time-based lerp with easing
    if (this.isSliding) {
      this.updateLerp(dtMs);
      // Let the lerp finish - don't check for new snaps while sliding
      return;
    }

    // Check if leg needs to snap - use current foot position
    const dx = this.groundX - attachX;
    const dy = this.groundY - attachY;
    const distToGround = magnitude(dx, dy);

    // ABSOLUTE MAXIMUM: Force snap if leg is stretched beyond physical limits (any direction)
    // This prevents infinite stretching when unit gets pushed sideways by another unit
    // Uses 105% of totalLength to allow some buffer before forcing a snap
    if (distToGround > this.totalLength * 1.05) {
      this.startLerp(attachX, attachY, unitRotation, velocityX, velocityY);
      return;
    }

    // Check angle - how far behind is the foot?
    const groundAngle = Math.atan2(dy, dx);
    const angleDiff = normalizeAngle(groundAngle - unitRotation);

    // Angle triggers if foot is too far behind
    const angleTriggered = Math.abs(angleDiff) > this.config.snapTriggerAngle;

    // Distance only triggers if foot is also behind perpendicular (not in forward zone)
    // This prevents jittering when leg snaps forward but is still fully extended
    const isBehindPerpendicular = Math.abs(angleDiff) > Math.PI * 0.5;
    const distanceTriggered = isBehindPerpendicular &&
      distToGround >= this.totalLength * this.config.extensionThreshold;

    // Snap if EITHER condition is met
    if (distanceTriggered || angleTriggered) {
      this.startLerp(attachX, attachY, unitRotation, velocityX, velocityY);
    }
  }

  // Initialize ground point at a natural resting position
  private initializeGroundPoint(attachX: number, attachY: number, unitRotation: number): void {
    // Place foot at target snap angle and distance
    const restDistance = this.totalLength * this.config.snapDistanceMultiplier;
    const angle = unitRotation + this.config.snapTargetAngle;

    this.groundX = attachX + Math.cos(angle) * restDistance;
    this.groundY = attachY + Math.sin(angle) * restDistance;
    this.startGroundX = this.groundX;
    this.startGroundY = this.groundY;
    this.targetGroundX = this.groundX;
    this.targetGroundY = this.groundY;
  }

  // Start lerping to a new ground position
  private startLerp(
    attachX: number,
    attachY: number,
    unitRotation: number,
    velocityX: number,
    velocityY: number
  ): void {
    // Store current position as start
    this.startGroundX = this.groundX;
    this.startGroundY = this.groundY;

    // Calculate target position using the snap target angle and distance
    const snapDistance = this.totalLength * this.config.snapDistanceMultiplier;
    const snapAngle = unitRotation + this.config.snapTargetAngle;

    // Add some velocity-based offset to place foot ahead of where we're going
    const speed = magnitude(velocityX, velocityY);
    const velocityOffset = Math.min(speed * 0.15, snapDistance * 0.3);

    let targetAngle = snapAngle;
    if (speed > 1) {
      // Bias toward movement direction
      const moveAngle = Math.atan2(velocityY, velocityX);
      targetAngle = snapAngle * 0.7 + moveAngle * 0.3;
    }

    this.targetGroundX = attachX + Math.cos(targetAngle) * (snapDistance + velocityOffset);
    this.targetGroundY = attachY + Math.sin(targetAngle) * (snapDistance + velocityOffset);

    this.isSliding = true;
    this.lerpProgress = 0;
  }

  // Update lerp animation with easing
  private updateLerp(dtMs: number): void {
    // Advance progress based on time
    this.lerpProgress += dtMs / this.lerpDuration;

    if (this.lerpProgress >= 1) {
      // Lerp complete
      this.lerpProgress = 1;
      this.groundX = this.targetGroundX;
      this.groundY = this.targetGroundY;
      this.isSliding = false;
      return;
    }

    // Apply easing function for smooth deceleration
    const easedT = easeOutCubic(this.lerpProgress);

    // Interpolate position
    this.groundX = this.startGroundX + (this.targetGroundX - this.startGroundX) * easedT;
    this.groundY = this.startGroundY + (this.targetGroundY - this.startGroundY) * easedT;
  }

  // Get the current foot position (for rendering)
  getFootPosition(): { x: number; y: number } {
    return { x: this.groundX, y: this.groundY };
  }

  // Get the knee position using inverse kinematics
  getKneePosition(attachX: number, attachY: number, side: number): { x: number; y: number } {
    const dx = this.groundX - attachX;
    const dy = this.groundY - attachY;
    const dist = magnitude(dx, dy);

    const upperLen = this.config.upperLegLength;
    const lowerLen = this.config.lowerLegLength;

    // Clamp distance to valid range for IK
    const clampedDist = Math.min(dist, upperLen + lowerLen * 0.98);

    // Angle from attachment to foot
    const angleToFoot = Math.atan2(dy, dx);

    // Use law of cosines to find knee angle
    // a = upperLen, b = lowerLen, c = clampedDist
    // cos(A) = (b² + c² - a²) / (2bc) -- angle at foot
    // cos(B) = (a² + c² - b²) / (2ac) -- angle at attachment (knee bend from straight line)

    const a = upperLen;
    const b = lowerLen;
    const c = clampedDist;

    // Angle at attachment point (between upper leg and line to foot)
    let cosB = (a * a + c * c - b * b) / (2 * a * c);
    cosB = Math.max(-1, Math.min(1, cosB)); // Clamp for numerical stability
    const angleB = Math.acos(cosB);

    // Knee bends outward (perpendicular to the body)
    // side > 0 means right side, bend outward (positive angle offset)
    // side < 0 means left side, bend outward (negative angle offset)
    const bendDirection = side > 0 ? 1 : -1;
    const kneeAngle = angleToFoot + bendDirection * angleB;

    const kneeX = attachX + Math.cos(kneeAngle) * upperLen;
    const kneeY = attachY + Math.sin(kneeAngle) * upperLen;

    return { x: kneeX, y: kneeY };
  }

  // Check if the leg is currently sliding
  isCurrentlySliding(): boolean {
    return this.isSliding;
  }

  // Get attachment point in world coordinates
  getAttachmentPoint(unitX: number, unitY: number, unitRotation: number): { x: number; y: number } {
    const cos = Math.cos(unitRotation);
    const sin = Math.sin(unitRotation);
    return {
      x: unitX + cos * this.config.attachOffsetX - sin * this.config.attachOffsetY,
      y: unitY + sin * this.config.attachOffsetX + cos * this.config.attachOffsetY,
    };
  }
}
