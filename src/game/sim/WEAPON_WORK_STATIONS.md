# Weapon and Work Station Architecture

This is the authoritative contract for BAR-style weapons and build tools in
the prototype. It deliberately separates a host's capabilities from the
physical mechanisms that present and emit them.

## Mental model

Every weapon or build tool is a **station** attached to a named host piece.
The host owns commands, targeting, economy, damage, and construction. The
station owns only its local joint state and its authoritative emission socket.

The composition is:

`world body pose -> parent piece pose -> local yaw joint -> local pitch joint -> QueryWeapon/QueryWork socket`

This matches the useful part of Beyond All Reason's unit-script model:
`AimFromWeapon` selects the aiming piece, `QueryWeapon` selects the muzzle,
piece `Turn` commands have speed limits, and restore threads return pieces to
rest. Our version adds explicit angular acceleration, inherited linear/angular
socket velocity, rigid host physics, deterministic batching, and schema
validation.

## Blueprint authority

- Weapon motor limits normally live on the emission type in
  `blueprints/turrets.json` under `angularActuator`. A building mount may
  override that actuator when one host's physical mechanism differs without
  changing every user of the weapon. `maxSpeed` is radians per second;
  `maxAcceleration` is radians per second squared.
- Per-mount traverse, rest pose, restore delay, host assistance, and shared
  parent arbitration live on the unit/building mount's `articulation` block.
- `hostAttachment` chooses the moving piece. Bot arms, head, shoulders and
  backpack sockets, plus building `buildingYawPiece` and two-axis
  `buildingAimPiece` sockets, are resolved from the same authoritative
  hierarchy used by firing and presentation.
- `emissionSockets` are the QueryWeapon muzzle lanes. The shot never falls
  back to the entity center when an authored socket exists.
- Guided-shot behavior belongs to `blueprints/shots.json`: `turning.turnRate`,
  `guidanceDelayMs`, `guidanceRampMs`, `guidanceSolveRateHz`,
  `lostTargetBehavior`, and `lostTargetArrivalRadius`. Projectile life belongs
  there as `maxLifespanMs`. Locomotion presets provide medium physics, not
  per-shot guidance or lifetime overrides.
- Build/repair/reclaim origins use the unit/building `workEmitter`.
  Moving QueryWork tools author the same actuator/articulation contract as a
  weapon; fixed factory emitters explicitly use null joints.

Attack stations must explicitly author motor limits. Mounts without a special
traverse compile to a continuous local-yaw station, which gives ordinary
vehicles and base-defense turrets the same parent-relative behavior without
duplicating data.

## Barrel presentation

A station's `presentation.barrel` is the physical mechanism the player reads;
it never changes where a shot comes from.

- `singleCylinderBarrel` / `singleConeBarrel` are one fixed tube. They do not
  rotate.
- `simpleMultiBarrel` (parallel ring) and `coneMultiBarrel` (diverging cone)
  are **rotary clusters**: two or more tubes sharing one mechanical firing
  station. The cluster axis is lowered by the firing orbit radius so exactly
  one tube sits on the aimed centerline, and every emission leaves that single
  centered socket regardless of which lane fired. Lane identity drives burst
  cadence and effects, not geometry.
- **Every multi-barrel cluster rotates.** The shared-socket geometry only
  reads correctly while the cluster turns — a frozen 2+ tube cluster looks
  like a bundle of dead pipes bolted to a head. So the spin envelope is part
  of the contract, not a per-mount style choice: `spin.idle`, `spin.accel` and
  `spin.decel` must be positive and `spin.max >= spin.idle`. Idle is a visible
  creep; engaging spins up toward `max`, disengaging decays back to idle.
  A mount that should hold still authors a single-tube barrel instead.
- `barrelCount` must be at least 2 on both cluster types, must equal the
  station's `emissionLaneCount`, and a cluster may not be `headOnly` (head-only
  presentation suppresses barrel animation, which would freeze the cluster).
- `validateTurretBarrelPresentation` (blueprints/stationArticulation.ts)
  enforces all of the above at the JSON loader boundary for unit and building
  mounts alike, so a dead cluster fails at load rather than shipping as a
  visual bug.
- Spin is presentation state, not simulation state: the renderer integrates it
  per frame from the engagement state on the render turret slab, so it costs
  nothing authoritative and never affects determinism. The detail-level gate
  may freeze the animation at distant rungs and collapse the cluster to one
  visible tube; both resume from the retained angle.

## Fixed-tick order

1. Resolve current QueryWork intent. Shared parent claims are arbitrated by
   priority and stable mount order from current work intent plus the weapon
   intent committed by the preceding fixed sample.
2. Step each shared parent once in Rust/WASM, then recompute the moving
   QueryWork AimFrom pivot in the new parent frame and step the work child.
3. Admit construction/economy work only when the achieved work pose is inside
   tolerance. Fixed factory emitters are immediately ready.
4. Integrate command and body movement. Then stamp current body and parent
   piece kinematics for combat targeting.
5. Targeting produces the current world-space weapon intent and rejects
   targets outside hard local traverse. It never writes a joint pose.
6. Convert that intent into the sampled parent frame and step weapon children
   through the same bounded Rust/WASM yaw/pitch motor.
7. Recompose final world pose and QueryWeapon sockets, including
   `omega x radius` velocity at off-center muzzles.
8. Admit fire only when the achieved pose is inside the weapon's aim
   tolerance. Vertical launch systems remain physically fixed upward and give
   guidance the target lock after launch.
9. Snapshot authoritative station/parent poses. Clients interpolate those
   poses and do not independently aim gameplay pieces.

The one-sample weapon-to-parent delay is intentional sampled-control behavior:
a heavy torso responds on the next fixed sample while the child joint can
track inside its current frame. It prevents a parent from being integrated
twice in one tick and remains deterministic across peers.

Idle stations hold their local pose during `restoreDelayMs`, so they remain
rigidly attached while the host turns. After the delay, the same bounded motor
returns them to their authored rest pose.

## Bot policy

- Legs/body provide locomotion and root orientation.
- One bounded upper-body yaw joint is shared by all upper-body stations.
- `upperBodyRestoreDelayMs` holds the torso's last local pose before the same
  bounded motor returns it toward the lower body's forward direction.
- Arms and turrets have limited local traverse; they cannot aim through the
  body or perform a hidden 360-degree swivel.
- A claiming station asks the torso to reduce its residual yaw. It does not
  directly overwrite torso rotation.
- Rex fast rockets live on the right shoulder. Its slow vertical rockets live
  on the left/right backpack launch deck and remain vertical. All inherit the
  moving upper body and launch-point velocity.
- Commander construction emits from the articulated right hand, its beam from
  the left arm, and its disruptor from the moving head.

## Building shared-piece policy

- `buildingYawPiece` gives sibling stations one shared yaw parent while each
  child retains its authored local articulation.
- `buildingAimPiece` gives sibling stations one shared yaw-and-pitch head.
  A ready station receives an exclusive claim and drives both axes through
  the bounded parent motor while it aligns and fires.
- A committed beam pulse pins the claim until that pulse ends. The claim then
  advances round-robin among equally prioritized ready siblings; a bounded
  timeout yields a claim that never reaches firing so one bad solution cannot
  starve the other barrel.
- Weapon stations beneath a `buildingAimPiece` are rigid sockets: runtime
  local yaw and pitch remain zero. A losing station rides the winning head
  pose but cannot fire, even if that pose also aligns with its own target.
- The Heavy Beam Tower uses one `beamHead` aim piece with two barrel sockets;
  it is one physical turret with two logical weapons, not two turrets.
- Stations on one named `buildingYawPiece` author the same pivot and parent
  motor. A stable station row stores that piece's state, and active siblings
  propose world yaw by claim priority and stable mount order exactly like Rex
  upper-body stations; no child writes the parent directly.
- Each child keeps its own local traverse. A zero-width traverse is a rigid
  forward-facing head, so only the common building piece can turn it.
- Off-centre AimFrom and QueryWeapon sockets rotate with the parent and inherit
  its tangential velocity; the render scenegraph uses the same hierarchy.

## Invariants

- Local joint state is never world-space state in disguise.
- Turning a host always moves every attached station and locomotion piece.
- There is one authoritative AimFrom/QueryWeapon or QueryWork transform per
  emission; visuals read it rather than re-deriving a competing transform.
- No weapon may fire through an unreachable traverse or before alignment.
- No TypeScript spring or presentation-only aiming path may bypass the Rust
  motor limits.
- Every presented multi-barrel cluster rotates. A station that should hold
  still authors a single tube instead of a zeroed spin envelope.
- Selection, targeting, recoil, launch inheritance, snapshots, and rendering
  identify the station by stable host id plus mount index/id.
- Physics and targeting math remain deterministic and allocation-free in the
  high-count tick path.

## Extension points

The same station contract can add recoil slides, multi-axis gimbals, folding
launcher doors, deploy prerequisites, damaged/stalled motors, or additional
named pieces. Those are new joint/piece data and state-machine constraints;
they must not create special firing origins or a second aiming authority.
