// Arachnid leg class - handles leg movement and rendering (client-side only)

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
}

export class ArachnidLeg {
  private config: LegConfig;

  // Current ground point (world coordinates) - where the foot is planted
  private groundX: number = 0;
  private groundY: number = 0;

  // Target ground point when sliding to new position
  private targetGroundX: number = 0;
  private targetGroundY: number = 0;

  // Is the foot currently sliding to a new position?
  private isSliding: boolean = false;

  // Slide progress (0 = at old position, 1 = at new position)
  private slideProgress: number = 0;

  // Slide speed (units per second)
  private slideSpeed: number = 400;

  // Has the leg been initialized with a ground position?
  private initialized: boolean = false;

  constructor(config: LegConfig) {
    this.config = config;
  }

  // Get total leg length (fully extended)
  private get totalLength(): number {
    return this.config.upperLegLength + this.config.lowerLegLength;
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
    const dtSec = dtMs / 1000;

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

    // If sliding, animate toward target
    if (this.isSliding) {
      this.updateSlide(dtSec);
      return;
    }

    // Check if leg is stretched too far behind - need to snap
    const dx = this.groundX - attachX;
    const dy = this.groundY - attachY;
    const distToGround = Math.sqrt(dx * dx + dy * dy);

    // Check if leg is extended enough to consider snapping
    if (distToGround >= this.totalLength * 0.85) {
      // Check if the ground point is behind the attachment point enough to trigger snap
      // Use unit rotation to determine angle from forward
      const groundAngle = Math.atan2(dy, dx);
      const forwardAngle = unitRotation;
      let angleDiff = groundAngle - forwardAngle;

      // Normalize to [-PI, PI]
      while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
      while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

      // Trigger snap when foot is past the trigger angle threshold
      // Front legs trigger earlier (smaller threshold), back legs later (larger threshold)
      if (Math.abs(angleDiff) > this.config.snapTriggerAngle) {
        this.startSlide(attachX, attachY, unitRotation, velocityX, velocityY);
      }
    }
  }

  // Initialize ground point at a natural resting position
  private initializeGroundPoint(attachX: number, attachY: number, unitRotation: number): void {
    // Place foot at target snap angle, at comfortable distance
    const restDistance = this.totalLength * 0.7;
    const angle = unitRotation + this.config.snapTargetAngle;

    this.groundX = attachX + Math.cos(angle) * restDistance;
    this.groundY = attachY + Math.sin(angle) * restDistance;
    this.targetGroundX = this.groundX;
    this.targetGroundY = this.groundY;
  }

  // Start sliding to a new ground position
  private startSlide(
    attachX: number,
    attachY: number,
    unitRotation: number,
    velocityX: number,
    velocityY: number
  ): void {
    // Calculate target position using the snap target angle
    const snapDistance = this.totalLength * 0.7;
    const snapAngle = unitRotation + this.config.snapTargetAngle;

    // Add some velocity-based offset to place foot ahead of where we're going
    const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY);
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
    this.slideProgress = 0;
  }

  // Update slide animation
  private updateSlide(dtSec: number): void {
    const dx = this.targetGroundX - this.groundX;
    const dy = this.targetGroundY - this.groundY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 1) {
      // Reached target
      this.groundX = this.targetGroundX;
      this.groundY = this.targetGroundY;
      this.isSliding = false;
      this.slideProgress = 1;
      return;
    }

    // Move toward target
    const moveAmount = this.slideSpeed * dtSec;
    const t = Math.min(moveAmount / dist, 1);

    this.groundX += dx * t;
    this.groundY += dy * t;
    this.slideProgress = Math.min(this.slideProgress + t, 1);
  }

  // Get the current foot position (for rendering)
  getFootPosition(): { x: number; y: number } {
    return { x: this.groundX, y: this.groundY };
  }

  // Get the knee position using inverse kinematics
  getKneePosition(attachX: number, attachY: number, side: number): { x: number; y: number } {
    const dx = this.groundX - attachX;
    const dy = this.groundY - attachY;
    const dist = Math.sqrt(dx * dx + dy * dy);

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
