// Arachnid leg class - handles leg movement and rendering (client-side only)

import { normalizeAngle, magnitude } from '../math';

export type { ArachnidLegConfig as LegConfig } from '@/types/render';
import type { ArachnidLegConfig as LegConfig } from '@/types/render';

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

  // Cached output objects to avoid per-frame allocations
  private _foot = { x: 0, y: 0 };
  private _knee = { x: 0, y: 0 };
  private _attach = { x: 0, y: 0 };

  constructor(config: LegConfig) {
    this.config = config;
    this.lerpDuration = config.lerpDuration ?? 150;
  }

  // Get total leg length (fully extended)
  private get totalLength(): number {
    return this.config.upperLegLength + this.config.lowerLegLength;
  }

  // Initialize leg at a specific unit position (call immediately after construction)
  // This prevents flickering from legs starting at (0,0).
  // `phaseHalfCycle` = true places the foot HALFWAY through its drift
  // cycle (between snap rest and snap trigger angles) so right-side
  // legs step out of phase with left-side legs once the unit moves —
  // an alternating walk gait from frame 1 rather than all legs in sync.
  initializeAt(unitX: number, unitY: number, unitRotation: number, phaseHalfCycle: boolean = false): void {
    const cos = Math.cos(unitRotation);
    const sin = Math.sin(unitRotation);
    const attachX = unitX + cos * this.config.attachOffsetX - sin * this.config.attachOffsetY;
    const attachY = unitY + sin * this.config.attachOffsetX + cos * this.config.attachOffsetY;

    // Place foot at target snap angle and distance, with optional phase
    // offset to start the leg mid-drift.
    const restDistance = this.totalLength * this.config.snapDistanceMultiplier;
    const initAngle = phaseHalfCycle
      ? (this.config.snapTargetAngle
          + this.config.snapTriggerAngle * Math.sign(this.config.snapTargetAngle)) / 2
      : this.config.snapTargetAngle;
    const angle = unitRotation + initAngle;

    this.groundX = attachX + Math.cos(angle) * restDistance;
    this.groundY = attachY + Math.sin(angle) * restDistance;
    this.startGroundX = this.groundX;
    this.startGroundY = this.groundY;
    this.targetGroundX = this.groundX;
    this.targetGroundY = this.groundY;
    this.initialized = true;
  }

  // Initialize or update the leg based on unit position
  // cos/sin are pre-computed Math.cos/sin(unitRotation) — shared across all legs on the same unit
  update(
    unitX: number,
    unitY: number,
    unitRotation: number,
    cos: number,
    sin: number,
    velocityX: number,
    velocityY: number,
    dtMs: number
  ): void {
    // Calculate attachment point in world coordinates (using pre-computed cos/sin)
    const attachX = unitX + cos * this.config.attachOffsetX - sin * this.config.attachOffsetY;
    const attachY = unitY + sin * this.config.attachOffsetX + cos * this.config.attachOffsetY;

    // Initialize ground point on first update
    if (!this.initialized) {
      this.initializeGroundPoint(attachX, attachY, unitRotation);
      this.initialized = true;
      return;
    }

    // Advance lerp if sliding
    if (this.isSliding) {
      this.updateLerp(dtMs);
    }

    // Check if leg needs to snap — always, even mid-lerp
    const dx = this.groundX - attachX;
    const dy = this.groundY - attachY;
    const distSq = dx * dx + dy * dy;

    const groundAngle = Math.atan2(dy, dx);
    const angleDiff = normalizeAngle(groundAngle - unitRotation);

    const angleTriggered = Math.abs(angleDiff) > this.config.snapTriggerAngle;

    // Distance trigger: foot has stretched past its extension threshold
    // in ANY direction (not just behind the unit). When triggered this
    // way, the leg snaps to the OPPOSITE side of the attach to recover.
    const extThresh = this.totalLength * this.config.extensionThreshold;
    const distanceTriggered = distSq >= extThresh * extThresh;

    if (distanceTriggered || angleTriggered) {
      this.startLerp(attachX, attachY, unitRotation, velocityX, velocityY, distanceTriggered);
    }

    // Clamp foot to max leg reach — legs can never stretch beyond physical limits
    this.clampToReach(attachX, attachY);
  }

  // Clamp foot position so it never exceeds total leg length from the hip
  private clampToReach(attachX: number, attachY: number): void {
    const dx = this.groundX - attachX;
    const dy = this.groundY - attachY;
    const distSq = dx * dx + dy * dy;
    const maxDist = this.totalLength;
    if (distSq > maxDist * maxDist) {
      const dist = Math.sqrt(distSq);
      const scale = maxDist / dist;
      this.groundX = attachX + dx * scale;
      this.groundY = attachY + dy * scale;
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
    velocityY: number,
    overExtended: boolean = false,
  ): void {
    // Store current position as start
    this.startGroundX = this.groundX;
    this.startGroundY = this.groundY;

    const snapDistance = this.totalLength * this.config.snapDistanceMultiplier;

    if (overExtended) {
      // Distance-triggered: foot is stretched past max length. Snap to
      // the OPPOSITE side of the attach so the leg recovers in the
      // direction it was being pulled from. No velocity bias here —
      // the snap is reactive recovery, not a forward step.
      const dx = this.groundX - attachX;
      const dy = this.groundY - attachY;
      const dist = Math.hypot(dx, dy);
      const oppX = dist > 1e-6 ? -dx / dist : Math.cos(unitRotation + this.config.snapTargetAngle);
      const oppY = dist > 1e-6 ? -dy / dist : Math.sin(unitRotation + this.config.snapTargetAngle);
      this.targetGroundX = attachX + oppX * snapDistance;
      this.targetGroundY = attachY + oppY * snapDistance;
    } else {
      // Angle-triggered: return to configured rest pose with velocity
      // bias toward unit movement direction (forward step).
      const snapAngle = unitRotation + this.config.snapTargetAngle;
      const speed = magnitude(velocityX, velocityY);
      const velocityOffset = Math.min(speed * 0.15, snapDistance * 0.3);
      let targetAngle = snapAngle;
      if (speed > 1) {
        const moveAngle = Math.atan2(velocityY, velocityX);
        targetAngle = snapAngle * 0.7 + moveAngle * 0.3;
      }
      this.targetGroundX = attachX + Math.cos(targetAngle) * (snapDistance + velocityOffset);
      this.targetGroundY = attachY + Math.sin(targetAngle) * (snapDistance + velocityOffset);
    }

    this.isSliding = true;
    this.lerpProgress = 0;
  }

  // Update lerp animation with easing
  private updateLerp(dtMs: number): void {
    if (this.lerpDuration <= 0) {
      // Instant — jump to target
      this.groundX = this.targetGroundX;
      this.groundY = this.targetGroundY;
      this.isSliding = false;
      return;
    }

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

  // Get the current foot position (for rendering) — returns cached object, do not store
  getFootPosition(): { x: number; y: number } {
    this._foot.x = this.groundX;
    this._foot.y = this.groundY;
    return this._foot;
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

    this._knee.x = attachX + Math.cos(kneeAngle) * upperLen;
    this._knee.y = attachY + Math.sin(kneeAngle) * upperLen;

    return this._knee;
  }

  // Check if the leg is currently sliding
  isCurrentlySliding(): boolean {
    return this.isSliding;
  }

  // Get attachment point in world coordinates — returns cached object, do not store
  // cos/sin are pre-computed Math.cos/sin(unitRotation) — shared across all legs on the same unit
  getAttachmentPoint(unitX: number, unitY: number, cos: number, sin: number): { x: number; y: number } {
    this._attach.x = unitX + cos * this.config.attachOffsetX - sin * this.config.attachOffsetY;
    this._attach.y = unitY + sin * this.config.attachOffsetX + cos * this.config.attachOffsetY;
    return this._attach;
  }
}
