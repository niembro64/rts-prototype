# BAR Command Reference Snapshot

Source pages:

- Legacy layout: https://www.beyondallreason.info/commands-20
- Grid layout: https://www.beyondallreason.info/commands-2-0-grid

Snapshot date: 2026-05-11.

This file records the command names and inputs listed by the official Beyond All
Reason command reference. It is a factual implementation reference for our own
command ergonomics; it is not a source for copying BAR art, text, or code.

## Notes

- BAR has separate Legacy and Grid layouts. Do not describe a Legacy binding as
  "the BAR key" without checking whether we are matching Grid or Legacy.
- Patrol is `P` in Legacy and `H` in Grid.
- Grid uses `P` for Gather Wait, not Patrol.
- Grid uses `G` for Stop and `O` for Guard.

## Selection

| Command | Legacy input | Grid input |
| --- | --- | --- |
| Select | Left Mouse | Left Mouse |
| Select Commander | `Ctrl+C` | `Tab` |
| Select all units | `Ctrl+A` | `Ctrl+E` |
| Select all matching units | `Ctrl+Z` | `Ctrl+W` |
| Select all matching units in view | Double Left Mouse | `Q` |
| Split Army | - | `Ctrl+Q` |
| Select idle Builders | `Ctrl+B` | `Ctrl+Tab` |
| Select waiting units | - | `Ctrl+Y` |
| Select Idle Transports | - | `Ctrl+R` |
| Group Select | `0-9` | `0-9` |
| Create Unit Group | `Ctrl+0-9` | `Ctrl+0-9` |
| Create Auto Group | `Alt+0-9` | `Alt+0-9` |
| Remove from Auto Group | `` Alt+` `` | `` Alt+` `` |

## Movement

| Command | Legacy input | Grid input |
| --- | --- | --- |
| Move | Right Mouse | Right Mouse |
| Move in Formation | `Ctrl` + Right Mouse | `Ctrl` + Right Mouse |
| Move Line Drag | Right Mouse Drag | Right Mouse Drag |

## Battle

| Command | Legacy input | Grid input |
| --- | --- | --- |
| Attack | `A` | `A` |
| Attack Line | - | `A` + Right Mouse Drag |
| Attack Area | `Alt+A` + Left Mouse Drag | `Ctrl+A` + Left Mouse Drag |
| Fight | `F` | `F` |
| Guard | `G` | `O` |
| Patrol | `P` | `H` |
| Target Set | `Y` | `S` |
| Target Cancel | - | `Ctrl+S` |

## Construction

| Command | Legacy input | Grid input |
| --- | --- | --- |
| Construction Shortcuts | - | Grid Letter |
| Build Border | `Ctrl+Alt+Shift` | `Ctrl+Alt+Shift` |
| Build Grid | `Shift+Alt` + Left Mouse Drag | `Shift+Alt` + Left Mouse Drag |
| Build Grid/Line Spacing | `Shift+Alt+Z+X` | `Shift+Alt+Z+X` |
| Build Line | `Shift` + Left Mouse Drag | `Shift` + Left Mouse Drag |
| Build Split | `Shift+Space` + Left Mouse Drag | `Shift+Space` + Left Mouse Drag |
| Queue | `Shift` + Right Mouse | `Shift` + Right Mouse |
| Queue to Next | - | `N` |
| Queue Add in Front | `Space` + Left Mouse | `Space` + Left Mouse |
| Quick Build shortcuts | `Z+X+C+V` | - |
| Reclaim | `E` + Left Mouse | `E` + Left Mouse |
| Reclaim Area | Right Mouse Drag | Right Mouse Drag |
| Repair | `R` + Left Mouse | `R` + Left Mouse |
| Repair Area | `R` + Left Mouse Drag | `R` + Left Mouse Drag |
| Rotate Buildings | `[+]` | `[+]` |
| Upgrade T1 Mex Area | Left Mouse Drag | Left Mouse Drag |
| Upgrade T1 -> T2 | Right Mouse | Right Mouse |

## Factories

| Command | Legacy input | Grid input |
| --- | --- | --- |
| Factory Shortcuts | - | Grid Letter |
| Factory Build +5 | `Shift` + Left Mouse | `Shift` + Left Mouse |
| Factory Build +20 | `Ctrl` + Left Mouse | `Ctrl` + Left Mouse |
| Factory Build +100 | `Ctrl+Shift` + Left Mouse | `Ctrl+Shift` + Left Mouse |
| Factory Add in Front | `Alt` + Left Mouse | `Alt` + Left Mouse |
| Factory Cycle Multiple | - | `.` |
| Factory Guard (Stateful) | - | `Ctrl+G` |

## Behavior

| Command | Legacy input | Grid input |
| --- | --- | --- |
| Cloak | `K` | `K` |
| On/Off | `X` | `B` |
| Positioning | - | `:` |
| Repeat | - | `T` |
| Stance | - | `L` |
| Stop | `S` | `G` |
| Trajectory | - | `B` |
| Wait | `W` | `Y` |
| Gather Wait | - | `P` |

## Specials

| Command | Legacy input | Grid input |
| --- | --- | --- |
| Self Destruct | `Ctrl+D` | `Ctrl+B` |
| Resurrect | Right Mouse | `W` + Right Mouse |
| Resurrect Area | Left Mouse Drag | `W` + Left Mouse Drag |
| DGUN | `D` + Left Mouse | `D` + Left Mouse |
| Capture | - | `W` |
| Load Transport | `L` + Left Mouse Drag | `J` + Left Mouse Drag |
| Unload Transport | `U` + Left Mouse Drag | `U` + Left Mouse Drag |

## Game

| Command | Legacy input | Grid input |
| --- | --- | --- |
| Camera 1 | - | `F1-F4` |
| Camera 1 Set | - | `Ctrl+F1-F4` |
| Camera Flip | - | `Alt+O` |
| Camera \| Overhead | `Ctrl+F2` | `Ctrl+F5` |
| Camera \| Spring | `Ctrl+F3` | `Ctrl+F6` |
| Chat | `Enter` | `Enter` |
| Draw on Map | `Q` + Left Mouse Drag | `` ` `` + Left Mouse Drag |
| Erase Drawings on Map | `Q` + Right Mouse Drag | `` ` `` + Right Mouse Drag |
| Gamespeed Adjust | `Alt` + `+` / `-` | `Alt` + `+` / `-` |
| Go to last Ping | `F3` | - |
| Map Details Info | `I` | `Ctrl+I` |
| Map Overview Switch | `Tab` | `Ctrl+T` |
| Mute Sound | `F6` | `Backspace` |
| Options Menu | `F10` | `F10` |
| Pause Game | `Pause` / `Break` | `Pause` / `Break` |
| Ping to map | `Q` + Middle Mouse | `` ` `` + Middle Mouse |
| Show / Hide UI | `F5` | `Ctrl+F7` |
| Show Map Elevation | `F1` | `F8` |
| Show Map Metal | `F4` | `F7` |
| Show Unit Pathing | `F2` | `F6` |
| Take Screenshot | `F12` | `F12` |

## Server Chat Commands

The BAR reference lists these as commands typed in server chat:

| Command |
| --- |
| `!boss name` |
| `!rename name` |
| `!ring` |
| `!forcestart` |
| `!help` |
| `!promote` |
| `!stop` |
| `!resign` |
| `!minratinglevel number` |
| `!maxratinglevel number` |
| `!minchevlevel number` |
| `!maxchevlevel number` |
| `!welcome-message message` |
| `!rotationEndGame random` |
| `$party` |
| `$explain` |
| `$whoami` |
| `$website` |
