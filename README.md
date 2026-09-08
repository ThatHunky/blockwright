# blockwright

An MCP server that lets an AI assistant build real structures on a live Minecraft Java server. No client mod, no bot account: it talks to the server console over RCON, previews every build first, reads the world back from the region files, and snapshots before each write so it can undo.

- **Build** from ASCII layers, geometric shapes, or `.schem`/`.nbt` schematic files
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
| `BLOCKWRIGHT_PREVIEW_DIR` | `~/.cache/blockwright/previews` | Where preview HTML files go |
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
| `build` | Place a structure written as ASCII layers with a character palette |
| `place_shape` | Sphere, dome, cylinder, cone, pyramid, line, circle |
| `fill` | Box fill: replace (with filter), keep, destroy, hollow, outline |
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

## Safety

- Nothing is written without a compiled command list; `dry_run` shows it.
- `BLOCKWRIGHT_BOUNDS` fences the assistant into an area.
- Snapshots are on by default whenever reads are available.
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
