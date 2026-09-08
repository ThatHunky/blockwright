# Blockwright — design spec

Date: 2026-09-08. Status: approved for planning.

## Goal

An MCP server that lets an AI assistant build real structures on a live
Minecraft Java server without a modded client and without a bot account.
It compiles voxel models into console commands, reads and writes schematic
files, reads the world back from the server's region files so the assistant
can scout a site and verify what it built, and snapshots every write so it
can undo mistakes. A small optional Paper plugin adds the same abilities for
remote servers and faster, physics-free writes.

Primary user: the repo owner running Claude Code against the Matsuri server
(Paper 26.2, WorldEdit 7.4.5, RCON on localhost). Secondary users: anyone
with a Paper/Spigot/vanilla server and RCON access.

## Non-goals

- Controlling a player or bot (Mineflayer-style). Everything is server-side.
- Depending on WorldEdit. It is fine if it is present; nothing requires it.
- Redstone simulation, entity placement, or authoring tile-entity contents
  (chest items, sign text) in the first release. Existing contents are
  preserved through snapshots and restores.
- Bedrock-specific concerns. Server-side edits are client-agnostic.

## Why not an existing project

Surveyed 12 repos on 2026-09-08. Every build-capable MCP routes commands
through a player because WorldEdit refuses console senders: vibecraft uses a
Fabric client mod and deprecated its RCON path; the Mineflayer bots need an
account that passes LibreLogin and anticheat and only support 1.21.x. The
RCON-only projects are raw command pipes. Nothing does server-side building
with read-back on Paper 26.x.

## Architecture

```
Claude ──stdio──▶ blockwright (Node, TypeScript, @modelcontextprotocol/sdk)
                    │
                    ├─ tools/* ──▶ VoxelSet ──▶ Bridge.apply()
                    │
                    ├─ RconBridge  (Tier 1) ──TCP──▶ Paper console
                    │     compiles VoxelSet → /fill, /setblock
                    │     large pastes → structure .nbt in <world>/generated/ → /place template
                    │     read-back  ← `save-all flush`, then parse <world>/.../region/*.mca
                    │     snapshots  = read the box, write it as structure .nbt; undo = /place template
                    │
                    └─ PluginBridge (Tier 2) ──HTTP 127.0.0.1──▶ blockwright-plugin.jar
                          bulk set (physics off), read region, snapshot/restore, players
```

Tier 1 works on any server with RCON. Its read-back, snapshot, and undo
paths additionally need `BLOCKWRIGHT_SERVER_DIR`, meaning blockwright runs
on the server host or a shared filesystem; without it those tools report
"needs server dir or plugin". Tier 2 is used automatically when the plugin
answers its health check and replaces the structure-block paths with direct
API calls. Tools never talk to RCON or HTTP directly; they produce a
`VoxelSet` and hand it to the active `Bridge`.

### Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `config` | Env vars, optional `server.properties` parsing, tier selection | — |
| `rcon/client` | RCON framing, auth, multi-packet responses, serial queue, reconnect | `net` |
| `voxel/voxels` | `VoxelSet` (sparse map coord→block state), `BlockState` parse/format, rotate/mirror incl. property rotation | — |
| `voxel/spec` | Parse the ASCII-layer build spec into a `VoxelSet` | voxels |
| `voxel/shapes` | Sphere, dome, cylinder, cone, pyramid, line, circle → `VoxelSet` | voxels |
| `voxel/compile` | Greedy box merge → ordered `/fill` + `/setblock` list; fill-limit splitting; two-pass support ordering | voxels |
| `schematic/sponge` | Read Sponge `.schem` v2 and v3, write v3 | `prismarine-nbt` |
| `schematic/structure` | Read/write vanilla structure `.nbt` | `prismarine-nbt` |
| `schematic/index` | Detect format by extension and NBT root, resolve paths | both codecs |
| `preview/ascii` | Layer slices and top-down view as text | voxels |
| `preview/html` | Self-contained three.js viewer HTML with embedded voxels | voxels, block colors |
| `blocks/registry` | Block name and state validation from `minecraft-data`; curated color table for previews | `minecraft-data` |
| `bridge/types` | `Bridge` interface | voxels |
| `bridge/rcon-bridge` | Tier 1 implementation | rcon, compile, structure codec |
| `bridge/plugin-bridge` | Tier 2 implementation | `fetch` |
| `tools/*` | MCP tool handlers, one file per group | everything above |
| `plugin/` | Java Paper plugin: HTTP API on localhost | Paper API only |

### `Bridge` interface

```ts
interface Bridge {
  readonly tier: 1 | 2;
  info(): Promise<ServerInfo>;
  players(): Promise<PlayerInfo[]>;
  runCommand(cmd: string): Promise<string>;
  apply(set: VoxelSet, opts: ApplyOptions): Promise<ApplyResult>;   // write
  read(region: Box, world: string): Promise<VoxelSet>;               // tier 1 needs server dir
  snapshot(region: Box, world: string): Promise<SnapshotId>;         // tier 1 needs server dir
  restore(id: SnapshotId): Promise<number>;                          // tier 1 needs server dir
}
```

`ApplyOptions`: `world`, `dryRun`, `physics` (tier 2), `forceload` (tier 1,
default on). `ApplyResult`: blocks changed, bounding box, command count,
elapsed ms, `snapshotId` when tier 2, and any server error lines.

## Voxel model

`VoxelSet` is a `Map<string, BlockState>` keyed by `"x,y,z"` with a cached
bounding box. `BlockState` is `{ name: "minecraft:oak_stairs", props: {facing:"north"} }`
and formats to `oak_stairs[facing=north]`. Positions absent from the set are
untouched by every write path; `air` is an explicit state.

### Build spec (input to `build`, `preview`, `schematic_write`)

```json
{
  "origin": [-147, 70, 181],
  "palette": { "#": "stone_bricks", "W": "oak_planks", "g": "glass_pane", ".": "air" },
  "layers": [
    { "y": 0,      "rows": ["#####", "#...#", "#####"] },
    { "y": [1, 3], "rows": ["#ggg#", "#...#", "#ggg#"] }
  ],
  "blocks": [ { "pos": [2, 4, 1], "block": "lantern[hanging=true]" } ]
}
```

- Rows run north→south (z), characters run west→east (x), layers are y
  offsets from origin. `y` may be a number or an inclusive `[from, to]` range.
- Space means "leave the world alone". Any other character must be in the
  palette or the tool returns an error naming the character and layer.
- Optional `rotation` (0/90/180/270) and `mirror` (`none|x|z`) apply to the
  whole set before placement, with block-state properties rotated too
  (`facing`, `axis`, `rotation`, `shape`, and the four wall-connection
  booleans).

### Compiler (`voxel/compile`)

1. Group voxels by formatted block state.
2. Greedy merge per state: scan in y, z, x order; extend a run along x, then
   widen along z while every cell matches and is unvisited, then along y.
   Mark visited. Emit `fill` for volume > 1, else `setblock`.
3. Split any fill whose volume exceeds `fillLimit` (default 32768, the
   vanilla `commandModificationBlockLimit` default) along its longest axis.
4. Order: pass 1 = air and every self-supporting block; pass 2 = attachables
   (torches, lanterns, ladders, vines, rails, doors, buttons, levers,
   pressure plates, signs, banners, carpets, snow layers, redstone
   components, beds, saplings, flowers, crops, coral, candles, chains,
   bells, and anything whose name ends in `_hanging_sign` or `_wall_*`).
   Inside pass 2, place doors bottom half before top half.
5. Prefix every command, including `forceload`, with
   `execute in <dimension> run` when the target world is not the overworld.

Vanilla `fill` needs loaded chunks. `RconBridge.apply` runs
`forceload add` for the chunk rectangle covering the bounding box, executes
the commands, then `forceload remove` for the same rectangle. A `forceload`
that fails to remove is reported in the result, never silently kept.

### Large pastes over RCON

When a `VoxelSet` compiles to more than `structureThreshold` commands
(default 400) and `BLOCKWRIGHT_SERVER_DIR` is set, `RconBridge` writes the set
as vanilla structure files under
`<serverDir>/<levelName>/generated/blockwright/structure/<id>_<n>.nbt`
(the folder is `structure`, singular, verified on Paper 26.2), tiled into
48×48×48 pieces, and runs `place template blockwright:<id>_<n> x y z` for
each. The `generated` folder is read on demand by the server, so no
`/reload` is required. Names are unique per paste (timestamp + hash) because
loaded templates are cached; the bridge deletes files older than the newest
20. Rotation and mirror are applied in the voxel domain first, so the
template is always placed with rotation `none`.

Whether `/place template` accepts templates larger than 48³ is unverified;
the 48 tiling is the safe default and `BLOCKWRIGHT_TEMPLATE_MAX` lets a user
raise it after testing on their server.

### Reading the world over RCON (needs server dir)

Console commands cannot report a block's state, so `RconBridge.read` goes
to the world files:

1. Run `save-all flush` unless blockwright has not written since the last
   save and that save is under 30 seconds old. Loaded chunks are flushed to
   disk; unloaded chunks are already current. Measured at about 0.8 s on
   Matsuri with two players online.
2. Locate the region directory for the dimension. Two layouts are
   supported and detected by existence: Minecraft 26.x
   `<world>/dimensions/minecraft/<overworld|the_nether|the_end>/region/`,
   and the older Bukkit layout `<world>/region/`, `<world>_nether/DIM-1/region/`,
   `<world>_the_end/DIM1/region/`.
3. For each chunk touching the box, read the 4 KB offset table of
   `r.<rx>.<rz>.mca`, inflate the chunk (zlib, gzip, or raw), and decode
   `sections[].block_states` (palette plus packed longs, entry width
   `max(4, ceil(log2(palette length)))`, no entries straddling longs) and
   `block_entities`. `Heightmaps.MOTION_BLOCKING` and `WORLD_SURFACE` are
   decoded the same way at 9 bits per entry for `get_heightmap`, so a
   heightmap never touches block data.

The decoder was checked against Matsuri (DataVersion 4903): three blocks
compared with `execute if block`, all matching, and the heightmap gave the
surface at the demo plot as y=63.

Snapshots reuse this: before a write, `RconBridge.snapshot` reads the
bounding box and writes it as one or more 48³ structure files named
`snap_<id>_<n>.nbt` in the generated folder, with block entities carried
through, plus an index `snapshots.json` (id, world, box, piece names,
timestamp) in the same folder. `restore` runs `place template` for each
piece at its original min corner, which puts back every block including
air. Snapshots survive server restarts because they live on disk; the
newest 50 are kept.

A redstone-triggered structure block save was also verified on Matsuri as a
way to snapshot without a `save-all`, but it only stores the template in
memory (lost on restart) and needs two temporary blocks placed in the
world. It is not used; it remains an option for a future fast-snapshot mode.

## Schematics

- Read: Sponge `.schem` v2 and v3, vanilla `.nbt` structure. Format is
  detected from the NBT root (`Schematic` compound with `Version`, or a
  `size`/`palette`/`blocks` root), not just the extension.
- Write: Sponge v3 (`Version: 3`, `DataVersion`, `Blocks.Palette`,
  `Blocks.Data` varint array, `Offset`) and vanilla structure `.nbt`.
- `DataVersion` comes from the plugin health response when available, else
  `BLOCKWRIGHT_DATA_VERSION`, else the newest version `minecraft-data` knows.
  Matsuri (26.2) is DataVersion 4903.
- Block entities and entities are carried through untouched on read→write of
  the same file but are not placed into the world in this release.
- Relative schematic paths resolve against `BLOCKWRIGHT_SCHEMATIC_DIR`, which
  defaults to `<serverDir>/plugins/WorldEdit/schematics` when that exists,
  otherwise the current working directory.

## Preview

`preview` accepts the same input as `build`, or `{ "shape": ... }`, or
`{ "schematic": "path" }`, and returns:

1. Text: bounding box, block counts per state, a top-down view, and per-layer
   ASCII slices (capped at `maxLayers`, default 12, with a note when
   truncated). This is what the assistant reads to check its own work.
2. A self-contained HTML file written to `BLOCKWRIGHT_PREVIEW_DIR` (default
   `~/.cache/blockwright/previews/<id>.html`): three.js from cdnjs, orbit
   controls, one instanced mesh per block color, block-state-aware colors
   from the curated table with a hashed fallback, a layer slider to hide
   levels above a chosen y, and an axis gizmo. The tool result includes the
   path so the assistant can send it to the user. Files are pruned to the
   newest 30.
3. When `context` is set and a read path is available: the surrounding
   region (default 8 blocks around the bounding box) is read from the world
   and rendered semi-transparent under the planned build so the user sees
   it in place.

## Tools

All write tools accept `dry_run` (compile and preview, touch nothing),
`snapshot` (default true when a read path exists), and `world` (defaults to
the overworld; accepts `overworld|nether|end` or a Bukkit world name). All
return the `ApplyResult` fields listed above.

| Tool | Tier | Input | Notes |
|---|---|---|---|
| `server_info` | 1 | — | Version, tier, bounds, schematic dir, DataVersion, whether WorldEdit and BlueMap exist |
| `get_players` | 1 | — | Name, world, position, gamemode. RCON path uses `data get entity <name> Pos` per player |
| `run_command` | 1 | `command` | Raw console command. Denies `stop`, `restart`, `op`, `deop`, `ban*`, `pardon*`, `whitelist`, `kick`, `save-off`, `reload`, and `execute` wrapping any of those, unless `BLOCKWRIGHT_ALLOW_ADMIN=1` |
| `fill` | 1 | `from`, `to`, `block`, `mode` (`replace|keep|hollow|outline|destroy`), `replace_filter` | Maps to vanilla fill with limit splitting |
| `build` | 1 | build spec | The main tool |
| `place_shape` | 1 | `shape`, `center`/`base`, dimensions, `block`, `hollow`, `thickness` | Sphere, dome, cylinder, cone, pyramid, line, circle |
| `paste_schematic` | 1 | `path`, `origin`, `rotation`, `mirror`, `ignore_air`, `use_offset` | By default `origin` is where the schematic's minimum corner lands. With `use_offset=true` it behaves like WorldEdit's `//paste`: the file's `Offset` is added, so `origin` is the original copy point |
| `schematic_info` | 1 | `path` | Size, format, palette with counts, offset, DataVersion |
| `schematic_write` | 1 | build spec or shape, `path`, `format` | Never touches a server |
| `preview` | 1 | build spec, shape, or schematic; `context` | See Preview |
| `read_region` | R | `from`, `to`, `full` | Palette, RLE data, per-state counts, and a heightmap computed by blockwright from the block data; large regions are summarized unless `full=true` |
| `get_heightmap` | R | `from`, `to` (x/z rectangle), `y_range` | Surface y and surface block per column, as a compact grid; the site-scouting tool |
| `get_block` | R | `pos` | Single block state |
| `save_schematic` | R | `from`, `to`, `path`, `format` | World region to file |
| `undo` | R | `steps` (default 1) | Restores snapshots newest-first |

Tier `R` means read-capable: Tier 1 with `BLOCKWRIGHT_SERVER_DIR`, or Tier 2.

MCP prompts: `build-workflow` (find players → pick site → preview → dry run →
build → verify → undo if needed). MCP resource: `blockwright://guide/palettes`,
a short block-palette and proportion guide.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BLOCKWRIGHT_RCON_HOST` | `127.0.0.1` | |
| `BLOCKWRIGHT_RCON_PORT` | `25575` | Overrides `server.properties` |
| `BLOCKWRIGHT_RCON_PASSWORD` | — | Overrides `server.properties` |
| `BLOCKWRIGHT_SERVER_DIR` | — | Enables reading `server.properties`, the generated-structure path, and the WorldEdit schematic dir |
| `BLOCKWRIGHT_WORLD` | `level-name` or `world` | Default overworld folder name |
| `BLOCKWRIGHT_PLUGIN_URL` | `http://127.0.0.1:25580` | Tier 2 endpoint |
| `BLOCKWRIGHT_PLUGIN_TOKEN` | — | Bearer token from the plugin's config |
| `BLOCKWRIGHT_BOUNDS` | — | `x1,y1,z1,x2,y2,z2`; writes outside are rejected before any command runs |
| `BLOCKWRIGHT_FILL_LIMIT` | `32768` | |
| `BLOCKWRIGHT_STRUCTURE_THRESHOLD` | `400` | Commands above which the structure path is used |
| `BLOCKWRIGHT_TEMPLATE_MAX` | `48` | Tile size for structure pieces |
| `BLOCKWRIGHT_SCHEMATIC_DIR` | see Schematics | |
| `BLOCKWRIGHT_PREVIEW_DIR` | `~/.cache/blockwright/previews` | |
| `BLOCKWRIGHT_DATA_VERSION` | auto | |
| `BLOCKWRIGHT_ALLOW_ADMIN` | unset | Lifts the `run_command` denylist |

Configuration is read once at startup; `server_info` shows the effective
values with the password masked.

## Paper plugin (Tier 2)

The plugin exists for servers where blockwright cannot reach the world
folder, and for writes with physics off, no visible structure-block blink,
and fewer round trips. It is optional everywhere else.

Java 25, plain `javac` via `plugin/build.sh` that downloads the matching
`paper-api` jar from the PaperMC Maven repository. No Gradle, no external
runtime dependencies: JSON via the Gson that Paper ships, HTTP via
`com.sun.net.httpserver`. Binds `127.0.0.1:25580` by default; a random token
is generated into `plugins/Blockwright/config.yml` on first start and every
request needs `Authorization: Bearer <token>`. Requests lacking or failing the
token get 401 with no body.

All world access runs on the main server thread through the Bukkit
scheduler; the HTTP thread waits on a `CompletableFuture` with a 30 s cap.

| Endpoint | Body | Response |
|---|---|---|
| `GET /v1/health` | — | `{ok, plugin_version, mc_version, data_version, worlds[], has_worldedit, has_bluemap}` |
| `GET /v1/players` | — | `[{name, world, x, y, z, yaw, pitch, gamemode}]` |
| `POST /v1/blocks/get` | `{world, min, max}` | `{size, palette[], rle[[index,count]...]}` in Sponge order (x fastest, then z, then y) |
| `POST /v1/blocks/set` | `{world, palette[], blocks[[x,y,z,paletteIndex]...], physics, snapshot}` | `{changed, snapshot_id}`; max 32768 blocks per request, applied in one tick |
| `POST /v1/snapshot` | `{world, min, max}` | `{snapshot_id}`; kept in memory, newest 50 |
| `POST /v1/restore` | `{snapshot_id}` | `{restored}` |

Regions over 1,000,000 blocks are rejected with 413. `PluginBridge` chunks
larger writes into multiple requests and takes one snapshot for the whole
bounding box before the first write.

## Safety and error handling

- Bounds check, dry-run compile, and block-state validation all happen
  before the first command is sent. Validation errors list every bad block
  name at once.
- Every RCON command's response is captured. Lines containing "Incorrect
  argument", "Unknown", "That position is not loaded", "Too many blocks", or
  "No blocks were filled" are collected into `ApplyResult.errors`; the apply
  continues, and the result says how many commands failed.
- RCON reconnects once on a dropped socket and then fails the tool call
  with the last command that did not get a response, so the caller knows
  where the build stopped.
- Tier 2 write requests are idempotent per block, so a retried request after
  a timeout is safe.
- `run_command` is the only path that bypasses the compiler and is the only
  tool with a denylist.
- The plugin never listens on a non-loopback address unless
  `bind: 0.0.0.0` is set explicitly in its config, and logs a warning when
  it is.

## Testing

Vitest. No test touches a real server unless `BLOCKWRIGHT_INTEGRATION=1`.

- `rcon/client`: fake RCON server in-process; auth success and failure,
  multi-packet responses (4096-byte fragments, same request id, sentinel
  trailer), reconnect after close, command serialization.
- `voxel/spec`: rows/columns orientation, y ranges, unknown character error,
  rotation and mirror of positions and of `facing`/`axis`/`shape`/wall props.
- `voxel/compile`: a 10×10×10 solid cube compiles to one fill; a hollow cube
  to six fills; fill splitting at the limit; attachables placed after
  supports; door halves ordered.
- `schematic/*`: round-trip every fixture through read→write→read and
  compare `VoxelSet`s; a hand-built v2 fixture; a v3 written by WorldEdit
  once the plugin's `save_schematic` produces one on Matsuri.
- `world/anvil`: a region file built in the test from a hand-made chunk
  (two sections, palette of three states, one block entity, heightmaps)
  decodes to the expected blocks and surface heights; missing chunk returns
  undefined; both directory layouts resolve.
- `bridge/rcon-bridge` read path: fake RCON server records `save-all flush`,
  a temp server dir holds the test region file; asserts the save is skipped
  when nothing was written in the last 30 s, snapshots produce tiled
  structure files and an index entry, and `restore` issues one
  `place template` per piece.
- `bridge/plugin-bridge`: fake HTTP server; chunking over 32768, token
  header, 401 handling, snapshot id propagation.
- `preview`: ASCII output for a known 3×3×3 set; HTML file contains the
  serialized voxel array and no external resource other than the cdnjs
  three.js script.
- Integration (Matsuri, `BLOCKWRIGHT_INTEGRATION=1`): `get_heightmap` at
  the demo plot to find the surface, build a 5×5×5 hollow cube at
  `-147, <surface>, 181`, read it back, compare, undo, read back again and
  expect the original. Runs over RCON first and again through the plugin
  once Phase 2 lands.

## Repository layout and distribution

```
blockwright/
  package.json          name "blockwright", bin "blockwright", type module
  src/                  as in Components
  plugin/               build.sh, plugin.yml, src/dev/blockwright/plugin/*.java
  test/                 mirrors src/
  fixtures/             .schem and .nbt samples
  docs/superpowers/specs/2026-09-08-blockwright-design.md
  README.md             quick start for RCON-only, then plugin setup, tool table
  LICENSE               MIT
```

Public repo `ThatHunky/blockwright`. Runs with
`npx -y github:ThatHunky/blockwright` from Claude Code's `.mcp.json`; npm
publish is a follow-up, not part of this spec. Node ≥ 20.

## Phasing

1. **Phase 1 — Tier 1 complete.** RCON client, voxel model, compiler,
   codecs, preview, structure-block read-back, snapshots and undo, every
   tool in the table, README, first push. Verified against Matsuri at the
   demo plot: heightmap, in-place preview, `dry_run`, real build, read-back,
   undo, viewed in BlueMap.
2. **Phase 2 — Tier 2.** Plugin, `PluginBridge`, `read_region`, `get_block`,
   `save_schematic`, `undo`, in-place preview context. Installed on Matsuri
   through the existing wait-and-restart script so no player is kicked.
3. **Stretch (not planned):** `get_player_target`, a raycast from a
   player's position and rotation through a freshly read region to answer
   "build where I am looking"; Litematica import; editing sign text and
   container contents; npm publish.

## Demo plot

Matsuri overworld, corner `x=-147, z=181`, surface y found at integration
time. Spawn is at `17, 81, 46`; the existing spawn build spans roughly
`x 26..60, z 38..54` and must not be touched.
