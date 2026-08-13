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

- Weapon motor limits live on the emission type in
  `blueprints/turrets.json` under `angularActuator`. `maxSpeed` is radians per
  second; `maxAcceleration` is radians per second squared.
- Per-mount traverse, rest pose, restore delay, host assistance, and shared
  parent arbitration live on the unit/building mount's `articulation` block.
- `hostAttachment` chooses the moving piece. Bot arms, head, shoulders, and
  backpack sockets are resolved from the same authoritative rig geometry used
  by firing and presentation.
- `emissionSockets` are the QueryWeapon muzzle lanes. The shot never falls
  back to the entity center when an authored socket exists.
- Guided-shot behavior belongs to `blueprints/shots.json`: `turning.turnRate`,
  `guidanceDelayMs`, and `guidanceRampMs`. Projectile life belongs there as
  `maxLifespanMs`. Locomotion presets provide medium physics, not per-shot
  guidance or lifetime overrides.
- Build/repair/reclaim/resurrect origins use the unit/building `workEmitter`.
  Moving QueryWork tools author the same actuator/articulation contract as a
  weapon; fixed factory emitters explicitly use null joints.

Attack stations must explicitly author motor limits. Mounts without a special
traverse compile to a continuous local-yaw station, which gives ordinary
vehicles and base-defense turrets the same parent-relative behavior without
duplicating data.

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

## Invariants

- Local joint state is never world-space state in disguise.
- Turning a host always moves every attached station and locomotion piece.
- There is one authoritative AimFrom/QueryWeapon or QueryWork transform per
  emission; visuals read it rather than re-deriving a competing transform.
- No weapon may fire through an unreachable traverse or before alignment.
- No TypeScript spring or presentation-only aiming path may bypass the Rust
  motor limits.
- Selection, targeting, recoil, launch inheritance, snapshots, and rendering
  identify the station by stable host id plus mount index/id.
- Physics and targeting math remain deterministic and allocation-free in the
  high-count tick path.

## Extension points

The same station contract can add recoil slides, multi-axis gimbals, folding
launcher doors, deploy prerequisites, damaged/stalled motors, or additional
named pieces. Those are new joint/piece data and state-machine constraints;
they must not create special firing origins or a second aiming authority.
