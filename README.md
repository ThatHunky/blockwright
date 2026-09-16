# blockwright

An MCP server that lets an AI assistant build real structures on a live Minecraft Java server. No client mod, no bot account: it talks to the server console over RCON, previews every build first, reads the world back from the region files, and snapshots before each write so it can undo.

- **Build** from ASCII layers, geometric shapes, or `.schem`/`.nbt` schematic files
- **Terraform**: ramp a building pad into the surrounding hillside with a solved, seamless, walkable slope, smooth rough ground, or raise a hill — then scatter plants and boulders that can only land on real ground
- **Preview** as ASCII slices for the assistant and a self-contained 3D HTML viewer for you, optionally shown in place on the real terrain
- **Read** the world: heightmaps for scouting a site, block reads to verify a build, save any region to a schematic
- **Undo**: every write is snapshotted to disk first and restored with one call
- Works on vanilla, Paper, Spigot, Fabric servers with RCON enabled; tested on Paper 26.2

## Quick start

Requirements: Node ≥ 20 and a server with `enable-rcon=true` in `server.properties`.

Claude Code `.mcp.json` (project) or `~/.claude.json`:

```json
{
  "mcpServers": {
    "blockwright": {
      "command": "npx",
      "args": ["-y", "github:ThatHunky/blockwright"],
      "env": {
        "BLOCKWRIGHT_SERVER_DIR": "/path/to/your/server"
      }
    }
  }
}
```

`BLOCKWRIGHT_SERVER_DIR` is the folder containing `server.properties`. From it blockwright reads the RCON port and password, the level name, the Minecraft version, and the region files it needs for reads and undo. If blockwright runs on another machine, set `BLOCKWRIGHT_RCON_HOST/PORT/PASSWORD` instead; building works, but reads and undo need the server folder (or the plugin, coming in a later release).

An example config for the Matsuri server is in `.mcp.example.json` — copy it to `.mcp.json` (gitignored, since it can carry a real server path) and adjust the paths.

Then ask: *"Scout a flat spot near me and build a small stone cottage. Preview first."*

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BLOCKWRIGHT_SERVER_DIR` | — | Server folder. Enables reading `server.properties`, `level.dat`, region files, WorldEdit's schematic folder, and the structure-template path used for big pastes and snapshots |
| `BLOCKWRIGHT_RCON_HOST` | `127.0.0.1` | |
| `BLOCKWRIGHT_RCON_PORT` | from `server.properties` (`rcon.port`), else `25575` | |
| `BLOCKWRIGHT_RCON_PASSWORD` | from `server.properties` (`rcon.password`) | Required one way or the other |
| `BLOCKWRIGHT_WORLD` | `level-name` from `server.properties`, else `world` | Overworld folder name |
| `BLOCKWRIGHT_BOUNDS` | — | `x1,y1,z1,x2,y2,z2`; writes outside this box are refused |
| `BLOCKWRIGHT_FILL_LIMIT` | `32768` | Blocks per `fill`, match `commandModificationBlockLimit` if you changed it |
| `BLOCKWRIGHT_MAX_VOXELS` | `5000000` | Upper bound on how many voxels `place_shape` will generate before rejecting the request as too large |
| `BLOCKWRIGHT_STRUCTURE_THRESHOLD` | `400` | Above this many commands, a build is placed as structure templates instead |
| `BLOCKWRIGHT_TEMPLATE_MAX` | `48` | Template tile size |
| `BLOCKWRIGHT_SCHEMATIC_DIR` | `plugins/WorldEdit/schematics` if present, else cwd | Where relative schematic paths resolve |
| `BLOCKWRIGHT_PREVIEW_DIR` | `~/.cache/blockwright/previews` | Where preview HTML and `render` PNGs go |
| `BLOCKWRIGHT_DATA_VERSION`, `BLOCKWRIGHT_MC_VERSION` | from `level.dat` | Override when there is no server folder |
| `BLOCKWRIGHT_ALLOW_ADMIN` | unset | Set to `1` or `true` to let `run_command` run stop/op/ban/whitelist/kick/reload |
| `BLOCKWRIGHT_SAVE_COALESCE_MS` | `30000` | Reads skip `save-all flush` when nothing was written and the last save is younger than this |
| `BLOCKWRIGHT_BLUEMAP_URL` | — | Shown in `server_info` so the assistant can point you at the map |

## Tools

| Tool | What it does |
|---|---|
| `server_info` | Version, players, whether reads/snapshots work, effective config |
| `get_players` | Names, worlds, positions, look direction, gamemode |
| `get_heightmap` | Surface heights and blocks for an x/z rectangle: find a site and the y to build at |
| `preview` | ASCII slices plus a 3D HTML viewer of a build spec, shape, or schematic, optionally with the surrounding terrain |
| `render` | Draw the live world (or a schematic) as PNGs from four isometric corners, a plan view or a straight-on elevation, returned inline |
| `build` | Place a structure written as ASCII layers with a character palette |
| `place_shape` | Sphere, dome, cylinder, cone, pyramid, line, circle |
| `fill` | Box fill: replace (with filter), keep, destroy, hollow, outline |
| `terraform` | Shape natural ground: `blend` a pad into the terrain, `smooth` rough ground, raise a `hill` |
| `scatter` | Plants and boulders on solid ground with air above, by density, palette and seed |
| `paste_schematic` | Paste a `.schem` (Sponge v1-v3) or `.nbt` (vanilla structure) with rotation and mirror |
| `schematic_info`, `schematic_write`, `save_schematic` | Inspect a file, write one from a spec, or copy a world region into one |
| `read_region`, `get_block` | Verify what is in the world |
| `undo`, `list_snapshots` | Restore the snapshot taken before a write |
| `run_command` | Raw console command with an admin denylist |

Every write tool accepts `dry_run`, `snapshot`, `label`, `world` and `allow_unknown_blocks`.

## How it works

- Voxels compile to the fewest `fill`/`setblock` commands (greedy box merging), split under the 32768-block limit, supports before torches and doors, chunks force-loaded for the duration.
- Big pastes are written as vanilla structure files into `<world>/generated/blockwright/structure/` and placed with `place template`, which needs no reload and no physics pass.
- Reads run `save-all flush` and parse the Anvil region files directly (26.x `dimensions/` layout and the classic layout). Heightmaps come straight from the chunk data.
- Snapshots are the read box written as structure files, restored with `place template`, so they survive restarts. The newest 50 are kept.

## Terraforming

`terraform` exists because levelling a site with `fill` leaves a cut cube in the landscape, and hand-rolled slopes come out as terraces or concentric rings. It works on the height field instead:

1. Read the box and find the real ground surface per column — the highest solid block, ignoring leaves, logs, snow and water, so one oak does not put the "surface" twelve blocks up. Without world reads it falls back to a console probe (`execute if block … air`, binary-searched per column), which is slower, capped, and cannot snapshot.
2. Freeze what must not move: the box border (so the result meets real terrain with no seam), the pad given by `keep_from`/`keep_to`, anything in `protect`, and any ungenerated column.
3. Solve the interior as a harmonic field (multigrid Gauss-Seidel) with those frozen values as boundary conditions. A harmonic function has no interior maximum or minimum, so the ramp between pad and terrain can only descend — no terraces, no rings.
4. Add 4 octaves of value-noise fBm at a 32-block base wavelength (the octave counts and wavelengths vanilla uses for its own surface noise), with its amplitude faded to zero at both the pad edge and the border, seeded so the same call always gives the same ground.
5. Box-blur, round to whole blocks, and clamp the height difference between neighbouring columns to `max_step` (default 1) so the result is walkable. When the pad height and the border terrain simply cannot be joined that gently, it says so instead of hiding a cliff.
6. Apply per column: air above the new surface, `top_block`, `soil_depth` blocks of soil, then stone only where there is nothing already — existing stone, ores and caves below the fill are never replaced. Columns that are already at their target emit nothing at all, which is what leaves the border and its trees untouched.

Everything goes through the normal voxel pipeline, so `dry_run`, snapshots and `undo` work as they do for `build`.

`scatter` reads the same column view and places only at `ground + 1` with air above it: two-block plants get both halves, and a boulder (`radius` 1-3) grows each of its sub-columns from that column's own ground, so nothing it emits can be unsupported.

## Looking at what you built

`read_region` counts blocks and `get_heightmap` gives surface heights, but neither shows whether
a build *looks* right. `render` reads a box of the world and returns real PNG images, inline, so
an assistant can see its own work:

```
render  from: [-978, 55, 448]  to: [-960, 76, 498]
        views: ["iso_se", "iso_nw"]
```

- `views` — `iso_ne` / `iso_nw` / `iso_se` / `iso_sw` (the four isometric corners), `top` (a plan,
  north up) and `north` / `south` / `east` / `west` (straight-on elevations). Up to four per call.
- Blocks are drawn with the shape they actually have: a fence is a post, a slab is half a cell,
  a lantern is a small lamp, a plant is a tuft. Drawing them all as cubes is what makes a bridge
  with a gappy deck look like a solid slab — and hides exactly the mistake the picture exists to
  catch.
- `hide` takes block names or globs (`["*_leaves"]`, `["water"]`) so a structure can be seen
  through a forest or a lake.
- `cutaway_y` ignores everything above a height, which lifts the roof off an interior.
- `scale` and `max_pixels` trade detail against size; images over ~900 KB are written to disk and
  their paths returned instead of being inlined.

One corner is not enough. A top-down view hides every vertical mistake there is, so look from at
least two opposite corners before calling anything finished.

## Safety

- Nothing is written without a compiled command list; `dry_run` shows it.
- `BLOCKWRIGHT_BOUNDS` fences the assistant into an area.
- Snapshots are on by default whenever reads are available.
- Running two blockwright processes against the same server directory at once can lose a snapshot record (each process only serializes writes to `snapshots.json` against itself, not against the other). Don't rely on undo in that configuration — run one blockwright process per server directory.
- `run_command` refuses administrative commands unless you opt in.
- The RCON password never appears in tool output.

## Development

```bash
npm install
npm test            # vitest, no server needed
npm run integration # against a real server, see scripts/integration.ts
```

Design spec: `docs/superpowers/specs/2026-09-08-blockwright-design.md`.

## License

MIT
