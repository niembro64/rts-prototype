# Command UX Direction

This game is being shaped as a large-scale RTS with command ergonomics inspired by
Beyond All Reason. The long-term goal is for unit commands to feel familiar to BAR
players: fast to issue, visually legible, queue-friendly, and consistent across the
main view, minimap, and UI panels.

Reference: https://www.beyondallreason.info/commands-20#Movement

Local snapshot of the BAR Legacy/Grid command tables:
[bar-command-reference.md](./bar-command-reference.md)

## Command Parity Goal

We want to eventually support BAR-style command coverage, including movement,
formation move, fight-move, attack, attack area/line/circle, guard, patrol, target
set/cancel, build line/grid/border/split, reclaim, repair, resurrect, capture,
load/unload, stop, wait, repeat, stance, trajectory, cloak, self-destruct, DGun,
camera commands, map pings, and UI visibility commands.

The implementation should not blindly copy code or art. Command semantics, hotkey
layout, cursor intent, waypoint colors, and feedback patterns should be familiar,
but assets must be either authored in this repo or used only after the license is
explicitly cleared for reuse in this project.

## Current Cursor Standard

The 3D input path uses in-repo SVG data cursors for command intent:

- Select: white selection brackets/crosshair.
- Move: green directional arrows.
- Fight: purple crossed attack-move mark.
- Patrol: blue loop arrows.
- Attack: red reticle.
- Repair: cyan repair tool/plus.
- Build: yellow construction cursor.
- Blocked build: red invalid marker.
- DGun: orange lightning mark.
- Factory waypoint: green rally flag.

Cursor state should come from the same command resolver that decides what a click
will do. If right-click will attack, repair, move, patrol, fight, or set a factory
waypoint, the cursor should advertise exactly that before the click.

## Design Rules

- Prefer one command vocabulary shared by host sim, player client, UI, and docs.
- Keep cursor art and waypoint colors semantically aligned.
- Keep command feedback cheap: cursor changes should not add new per-frame world
  scans beyond existing hover/build validation work.
- Treat BAR as the ergonomics benchmark, not as an asset source.
