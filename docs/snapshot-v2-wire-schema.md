# Snapshot V2 Wire Schema

Snapshot-v2 is a compact binary format that can coexist with the current
Rust-backed MessagePack path behind a feature flag. It keeps the same authority
model: commands go to the host, snapshots flow down as correction targets, and
clients never become gameplay authority.

## Envelope

Every payload starts with a fixed header followed by a section table and then
section bytes.

```text
magic          u32   "BAS2"
schemaVersion  u16   starts at 1
flags          u16   compression, keyframe, visibility-filtered, reserved bits
tick           varu
sectionCount   varu
sections[]     repeated section table rows
payload[]      concatenated section byte ranges
```

Section table row:

```text
sectionId      varu
sectionVersion varu
flags          varu
byteLength     varu
```

`byteLength` lets older clients skip unknown sections. Section order stays
canonical for stable diagnostics, but decode must use section IDs, not table
position.

## Integer Encoding

- Unsigned integers use LEB128 varints.
- Signed integers use zig-zag varints.
- Fixed-width integers are little-endian inside packed numeric arrays.
- IDs and counts are varints unless a dense section explicitly uses fixed
  arrays.

Fixed-point scales:

| Class | Scale | Type | Notes |
| --- | ---: | --- | --- |
| Entity position | 100 | zig-zag varint or i32 array | 0.01 world-unit precision. |
| Minimap position | 1 | zig-zag varint or i32 array | Whole world units; already shipped as integer MessagePack numbers today. |
| Projectile/beam position | 1 | zig-zag varint or i32 array | Matches current projectile quantization. |
| Velocity | 10 | zig-zag varint or i32 array | 0.1 world-units/sec. |
| Rotation/turret angle | 1000 | zig-zag varint or i32 array | 0.001 rad. |
| Normal/quaternion component | 1000 | zig-zag varint or i16 array | Range usually [-1, 1]. |

## Sections

Initial section IDs:

| ID | Section | Contents |
| ---: | --- | --- |
| 1 | entities | Entity create/update rows, field masks, unit/building subrows. |
| 2 | removedEntityIds | Removed entity id varint list. |
| 3 | projectiles | Spawns, despawns, velocity updates, beam updates. |
| 4 | minimapEntities | Packed minimap contact rows. |
| 5 | economy | Per-player resource rows. |
| 6 | audioEvents | Event kind plus packed event payload rows. |
| 7 | sprayTargets | Commander ability target rows. |
| 8 | shroud | Packed visibility bitmap. |
| 9 | serverMeta | Low-rate server/control metadata. |
| 10 | grid | Debug grid cells; diagnostic only. |
| 11 | terrain | Static terrain tile map; keyframe/bootstrap only. |
| 12 | buildability | Static buildability grid; keyframe/bootstrap only. |

## Entity Rows

The entity section starts with:

```text
entityCount varu
rowLayoutVersion varu
```

Each entity row:

```text
id              varu
entityType      u8      1 unit, 2 building
ownerPlayerId   varu
changedGroups   varu    existing ENTITY_CHANGED_* group mask
fieldMask       varu    v2 field-level mask for packed row fields
payload         bytes   fields in canonical mask order
```

Full/keyframe rows set every baseline field needed for recovery. Delta rows set
only changed groups and only the fields present in `fieldMask`. The baseline
advances per emitted field, matching the current delta semantics.

High-volume repeated subrows are packed as count + arrays:

- Turrets: id, state, target flags, target id, yaw, yaw velocity, pitch,
  pitch velocity, force-field range.
- Actions: command code, target flags, target id, position, grid/build fields.
- Factory queues: unit blueprint codes.
- Waypoints: type code and fixed-point x/y/z.

## Projectile Rows

Projectile section subsections:

```text
spawnCount      varu
despawnCount    varu
velocityCount   varu
beamCount       varu
```

Each subsection owns its row layout version and byte length so beam detail can
evolve independently. Beam paths use `pointCount` plus packed arrays for x/y/z
and velocity. Reflection normals and mirror metadata are optional side arrays
gated by bit masks.

## Negotiation And Migration

1. Add a `snapshotWireVersion` capability to the local and remote handoff path.
2. Ship snapshot-v2 behind `VITE_BA_SNAPSHOT_V2=1` and a URL flag.
3. In development, dual-encode MessagePack and v2, decode both, and compare
   semantic snapshots plus measured byte/CPU deltas.
4. Prefer v2 only when every recipient negotiated support; otherwise send the
   current MessagePack-compatible payload to that recipient.
5. Move sections one at a time. Unknown or unported sections can temporarily
   fall back to the current raw MessagePack section inside a v2 section wrapper.
6. Once all normal gameplay sections are native v2 and parity captures pass,
   remove the fallback for those sections and keep MessagePack only as a legacy
   negotiated path.
