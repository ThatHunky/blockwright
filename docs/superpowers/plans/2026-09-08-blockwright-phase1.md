# Blockwright Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship blockwright v0.1: an MCP server that builds structures on a live Minecraft server over RCON, previews them first, reads the world back from region files, snapshots every write, and can undo.

**Architecture:** Tools produce a `VoxelSet`; a `Bridge` applies it. The Tier 1 `RconBridge` compiles voxels into `fill`/`setblock` commands (or vanilla structure files placed with `place template` for big pastes), reads the world by flushing the save and parsing Anvil region files, and snapshots by writing what it read as structure files. Schematic codecs (Sponge v2/v3, vanilla structure) and a dependency-free canvas preview sit beside it. The Paper plugin (Tier 2) is a separate plan.

**Tech Stack:** Node ≥ 20, TypeScript 5.9, `@modelcontextprotocol/sdk` 1.x (`registerTool` with zod raw shapes), `zod` 3, `prismarine-nbt` 2, `minecraft-data` 3 (pc 26.1 block list), `vitest`, `tsx`. No native modules.

**User decisions (already made):**
- Build new, do not fork vibecraft ("1" on 2026-09-08).
- Name `blockwright`, repo `~/repos/blockwright`, public MIT at `ThatHunky/blockwright`.
- Demo plot on Matsuri: corner x=-147, z=181; surface y=63 (measured). Spawn build at x 26..60, z 38..54 is off limits.
- Preview before anything touches the world; world read-back in Phase 1, not deferred to the plugin.
- Language TypeScript; plugin deferred to its own plan.

**Verified facts this plan relies on (measured on Matsuri, Paper 26.2, 2026-09-08):**
- `place template <ns>:<name>` loads files from `<serverDir>/<level>/generated/<ns>/structure/<name>.nbt` (singular `structure`) without any reload.
- Region files live at `<level>/dimensions/minecraft/<dim>/region/r.X.Z.mca` (26.x layout). Chunk NBT: `yPos` (min section, −4), `sections[]` with `Y`, `block_states.palette`, `block_states.data` (packed longs, no straddling), `Heightmaps.*` (9-bit entries), `block_entities[]`, `DataVersion` 4903.
- Heightmap value v ⇒ highest block y = v + minY − 1. Overworld minY = −64, build limit 319.
- `save-all flush` ≈ 0.8 s with two players online.
- Vanilla `fill` needs loaded chunks (`forceload add x1 z1 x2 z2`, max 256 chunks per command) and refuses more than 32768 blocks per command.
- Block state names in region files and structure files carry the `minecraft:` prefix.

---

## File structure

```
blockwright/
├── package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, .gitignore, LICENSE, README.md
├── .mcp.json                      Claude Code config for the Matsuri demo (no secrets)
├── src/
│   ├── index.ts                   entry: load config, build bridge, start stdio server
│   ├── version.ts                 NAME/VERSION from package.json
│   ├── config.ts                  env + server.properties + level.dat → Config
│   ├── server.ts                  createServer(ctx): registers all tool groups, prompts, resources
│   ├── voxel/
│   │   ├── voxels.ts              Vec3, Box helpers, BlockState, VoxelSet
│   │   ├── schemas.ts             zod: Vec3Schema, WorldSchema, RotationSchema, MirrorSchema
│   │   ├── rotate.ts              rotateState/mirrorState/rotatePos/transformSet
│   │   ├── spec.ts                BuildSpec zod shape + buildSpecToVoxels
│   │   ├── shapes.ts              ShapeSpec zod + shapeToVoxels
│   │   └── compile.ts             greedy merge, fill splitting, ordering, dimension prefix
│   ├── rcon/client.ts             RconClient (framing, auth, sentinel, queue, reconnect)
│   ├── nbt/nbt.ts                 prismarine-nbt wrappers and typed accessors
│   ├── schematic/
│   │   ├── clipboard.ts           Clipboard type, clipboardFromVoxels, clipboardVoxelsAt, tileBox
│   │   ├── structure.ts           vanilla .nbt read/write
│   │   ├── sponge.ts              Sponge .schem v1/v2/v3 read, v3 write
│   │   └── index.ts               detect/load/save, path resolution
│   ├── world/
│   │   ├── dimension.ts           world name ↔ dimension ↔ region dir
│   │   └── anvil.ts               region/chunk reader, block lookup, heightmaps
│   ├── blocks/
│   │   ├── registry.ts            validateState via minecraft-data
│   │   └── colors.ts              blockColor for previews
│   ├── preview/
│   │   ├── ascii.ts               renderAscii
│   │   └── html.ts                renderHtml (canvas isometric viewer)
│   ├── bridge/
│   │   ├── types.ts               Bridge, ApplyOptions, ApplyResult, ServerInfo, PlayerInfo
│   │   ├── errors.ts              BridgeError, BoundsError
│   │   └── rcon-bridge.ts         RconBridge
│   └── tools/
│       ├── result.ts              ok/fail helpers, formatApplyResult
│       ├── server-tools.ts        server_info, get_players, run_command, fill
│       ├── build-tools.ts         build, place_shape, paste_schematic, schematic_info, schematic_write
│       ├── read-tools.ts          preview, read_region, get_heightmap, get_block, save_schematic, undo
│       └── prompts.ts             build-workflow prompt, palettes resource
├── scripts/integration.ts         live test against Matsuri (BLOCKWRIGHT_INTEGRATION=1)
└── test/                          mirrors src/, plus helpers/{fake-rcon,fake-bridge,mcp}.ts
```

Conventions used by every task:
- ESM. Imports inside `src/` and `test/` use the `.js` suffix (`import { VoxelSet } from '../src/voxel/voxels.js'`).
- Tests: `npm test` runs vitest once. `npx vitest run test/voxel/voxels.test.ts` runs one file.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never write into `/home/thathunky/games/servers/matsuri` except through the running server (RCON) and the `generated/blockwright/structure` folder the bridge owns. Task 18 is the only task that touches the live server.

---
### Task 0: Project scaffold

**Goal:** A buildable, testable TypeScript package named `blockwright` with a `--version` entry point and one passing test.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `README.md`
- Create: `src/version.ts`, `src/index.ts`
- Test: `test/version.test.ts`

**Acceptance Criteria:**
- [ ] `npm install` succeeds and runs the `prepare` build without errors
- [ ] `npm test` reports 1 passed
- [ ] `node dist/index.js --version` prints `blockwright 0.1.0`

**Verify:** `npm test && npm run build && node dist/index.js --version` → last line `blockwright 0.1.0`

**Steps:**

- [ ] **Step 1: Write package.json and configs**

`package.json`:
```json
{
  "name": "blockwright",
  "version": "0.1.0",
  "description": "MCP server that builds structures and schematics on a live Minecraft server over RCON, with previews, world read-back and undo",
  "type": "module",
  "bin": { "blockwright": "dist/index.js" },
  "main": "dist/index.js",
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepare": "npm run build",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "integration": "BLOCKWRIGHT_INTEGRATION=1 tsx scripts/integration.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "minecraft-data": "^3.116.0",
    "prismarine-nbt": "^2.8.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.23.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  },
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/ThatHunky/blockwright.git" },
  "keywords": ["minecraft", "mcp", "model-context-protocol", "rcon", "schematic", "worldedit", "paper"]
}
```

`tsconfig.json` (typecheck for src and test):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test", "scripts"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 15000 } });
```

`.gitignore`:
```
node_modules/
dist/
.env
*.tgz
.blockwright-previews/
```

`LICENSE`: the MIT license text with `Copyright (c) 2026 ThatHunky`.

`README.md` (expanded in Task 17):
```markdown
# blockwright

MCP server that lets an AI assistant build structures on a live Minecraft Java server over RCON: preview first, build with `fill`/`setblock`/structure templates, read the world back, snapshot and undo. No client mod, no bot account.

Status: under construction. See `docs/superpowers/specs/2026-09-08-blockwright-design.md`.
```

- [ ] **Step 2: Write the failing test**

`test/version.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { NAME, VERSION } from '../src/version.js';

describe('version', () => {
  it('exposes the package name and a semver version', () => {
    expect(NAME).toBe('blockwright');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
```

- [ ] **Step 3: Install and run the test to see it fail**

Run: `cd ~/repos/blockwright && npm install && npx vitest run`
Expected: FAIL, `Cannot find module '../src/version.js'`

- [ ] **Step 4: Write version.ts and the entry stub**

`src/version.ts`:
```ts
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const NAME: string = pkg.name;
export const VERSION: string = pkg.version;
```

`src/index.ts` (Task 17 replaces the body with the real server start; the `--version` flag stays):
```ts
#!/usr/bin/env node
import { NAME, VERSION } from './version.js';

if (process.argv.includes('--version')) {
  console.log(`${NAME} ${VERSION}`);
  process.exit(0);
}
console.error(`${NAME} ${VERSION}: run with --version; the MCP server entry arrives in a later task`);
process.exit(1);
```

- [ ] **Step 5: Run tests and build**

Run: `npm test && npm run build && node dist/index.js --version`
Expected: `Tests 1 passed`, then `blockwright 0.1.0`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold blockwright package

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Voxel model

**Goal:** `BlockState` parsing/formatting and a sparse `VoxelSet` with bounds and counts, the data structure every other module uses.

**Files:**
- Create: `src/voxel/voxels.ts`, `src/voxel/schemas.ts`
- Test: `test/voxel/voxels.test.ts`

**Acceptance Criteria:**
- [ ] `BlockState.parse('oak_stairs[half=top,facing=north]').toString()` is `minecraft:oak_stairs[facing=north,half=top]` (namespaced, props sorted)
- [ ] `toCommand()` drops the `minecraft:` prefix and keeps other namespaces
- [ ] Invalid strings (`stone[`, `stone[facing]`, `bad name`) throw with the offending text in the message
- [ ] `VoxelSet` bounds, counts, translate and clone behave as tested

**Verify:** `npx vitest run test/voxel/voxels.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/voxel/voxels.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet, box, boxSize, boxVolume, boxContains, key, unkey } from '../../src/voxel/voxels.js';

describe('BlockState', () => {
  it('parses a bare name and adds the minecraft namespace', () => {
    const s = BlockState.parse('stone');
    expect(s.name).toBe('minecraft:stone');
    expect(s.props).toEqual({});
    expect(s.toString()).toBe('minecraft:stone');
    expect(s.toCommand()).toBe('stone');
  });
  it('parses properties and sorts them', () => {
    const s = BlockState.parse('oak_stairs[half=top,facing=north]');
    expect(s.toString()).toBe('minecraft:oak_stairs[facing=north,half=top]');
    expect(s.toCommand()).toBe('oak_stairs[facing=north,half=top]');
  });
  it('keeps non-minecraft namespaces in commands', () => {
    expect(BlockState.parse('create:brass_block').toCommand()).toBe('create:brass_block');
  });
  it('rejects malformed input', () => {
    for (const bad of ['stone[', 'stone[facing]', 'bad name', '', 'Stone']) {
      expect(() => BlockState.parse(bad)).toThrow(bad === '' ? /Invalid block state/ : bad);
    }
  });
  it('detects air variants', () => {
    expect(BlockState.parse('air').isAir).toBe(true);
    expect(BlockState.parse('cave_air').isAir).toBe(true);
    expect(BlockState.parse('stone').isAir).toBe(false);
  });
  it('with() returns a new state with merged props', () => {
    const s = BlockState.parse('oak_stairs[facing=north]').with({ half: 'top' });
    expect(s.toString()).toBe('minecraft:oak_stairs[facing=north,half=top]');
  });
});

describe('keys and boxes', () => {
  it('round-trips keys', () => {
    expect(unkey(key(-1, 2, 3))).toEqual([-1, 2, 3]);
  });
  it('normalizes box corners and computes size/volume', () => {
    const b = box([3, 1, 2], [0, 5, -1]);
    expect(b.min).toEqual([0, 1, -1]);
    expect(b.max).toEqual([3, 5, 2]);
    expect(boxSize(b)).toEqual([4, 5, 4]);
    expect(boxVolume(b)).toBe(80);
    expect(boxContains(b, [3, 5, 2])).toBe(true);
    expect(boxContains(b, [4, 5, 2])).toBe(false);
  });
});

describe('VoxelSet', () => {
  it('stores, counts and bounds voxels', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, BlockState.parse('stone'));
    v.set(2, 1, -1, BlockState.parse('stone'));
    v.set(1, 0, 0, BlockState.parse('air'));
    expect(v.size).toBe(3);
    expect(v.get(2, 1, -1)?.toString()).toBe('minecraft:stone');
    expect(v.bounds()).toEqual({ min: [0, 0, -1], max: [2, 1, 0] });
    expect(Object.fromEntries(v.counts())).toEqual({ 'minecraft:stone': 2, 'minecraft:air': 1 });
    expect(v.nonAirCount()).toBe(2);
  });
  it('bounds is undefined when empty and updates after delete', () => {
    const v = new VoxelSet();
    expect(v.bounds()).toBeUndefined();
    v.set(5, 5, 5, BlockState.parse('stone'));
    v.set(9, 9, 9, BlockState.parse('stone'));
    v.delete(9, 9, 9);
    expect(v.bounds()).toEqual({ min: [5, 5, 5], max: [5, 5, 5] });
  });
  it('translates and clones without sharing state', () => {
    const v = new VoxelSet();
    v.set(1, 2, 3, BlockState.parse('stone'));
    const t = v.translate(10, 0, -3);
    expect([...t.entries()][0][0]).toEqual([11, 2, 0]);
    const c = v.clone();
    c.set(0, 0, 0, BlockState.parse('dirt'));
    expect(v.size).toBe(1);
    expect(c.size).toBe(2);
  });
  it('merges another set, later values win', () => {
    const a = new VoxelSet();
    a.set(0, 0, 0, BlockState.parse('stone'));
    const b = new VoxelSet();
    b.set(0, 0, 0, BlockState.parse('dirt'));
    b.set(1, 0, 0, BlockState.parse('dirt'));
    a.merge(b);
    expect(a.get(0, 0, 0)?.toCommand()).toBe('dirt');
    expect(a.size).toBe(2);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/voxel/voxels.test.ts`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement voxels.ts**

`src/voxel/voxels.ts`:
```ts
export type Vec3 = [number, number, number];

/** Inclusive axis-aligned box. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export function box(a: Vec3, b: Vec3): Box {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

export function boxSize(b: Box): Vec3 {
  return [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
}

export function boxVolume(b: Box): number {
  const s = boxSize(b);
  return s[0] * s[1] * s[2];
}

export function boxContains(b: Box, p: Vec3): boolean {
  return (
    p[0] >= b.min[0] && p[0] <= b.max[0] &&
    p[1] >= b.min[1] && p[1] <= b.max[1] &&
    p[2] >= b.min[2] && p[2] <= b.max[2]
  );
}

export function boxExpand(b: Box, n: number): Box {
  return { min: [b.min[0] - n, b.min[1] - n, b.min[2] - n], max: [b.max[0] + n, b.max[1] + n, b.max[2] + n] };
}

export function boxUnion(a: Box, b: Box): Box {
  return box(
    [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  );
}

export function formatVec(v: Vec3): string {
  return `${v[0]} ${v[1]} ${v[2]}`;
}

const NAME_RE = /^[a-z0-9_.\-]+(?::[a-z0-9_.\-/]+)?$/;
const STATE_RE = /^([^\[\]]+)(?:\[(.*)\])?$/;
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

export class BlockState {
  readonly name: string;
  readonly props: Readonly<Record<string, string>>;
  private text: string | undefined;

  constructor(name: string, props: Record<string, string> = {}) {
    this.name = name.includes(':') ? name : `minecraft:${name}`;
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(props).sort()) sorted[k] = props[k];
    this.props = Object.freeze(sorted);
  }

  static parse(text: string): BlockState {
    const trimmed = text.trim();
    const m = STATE_RE.exec(trimmed);
    if (!m || !NAME_RE.test(m[1])) throw new Error(`Invalid block state: "${text}"`);
    const props: Record<string, string> = {};
    if (m[2] !== undefined && m[2].trim() !== '') {
      for (const pair of m[2].split(',')) {
        const eq = pair.indexOf('=');
        if (eq <= 0 || eq === pair.length - 1) throw new Error(`Invalid block state property in "${text}": "${pair}"`);
        props[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
    return new BlockState(m[1], props);
  }

  get isAir(): boolean {
    return AIR.has(this.name);
  }

  /** Name without the minecraft: namespace, for display and commands. */
  get shortName(): string {
    return this.name.startsWith('minecraft:') ? this.name.slice(10) : this.name;
  }

  with(props: Record<string, string>): BlockState {
    return new BlockState(this.name, { ...this.props, ...props });
  }

  private propsText(): string {
    const keys = Object.keys(this.props);
    return keys.length ? `[${keys.map((k) => `${k}=${this.props[k]}`).join(',')}]` : '';
  }

  /** Canonical namespaced form, used as map key and in schematic palettes. */
  toString(): string {
    if (this.text === undefined) this.text = this.name + this.propsText();
    return this.text;
  }

  /** Form accepted by /setblock and /fill. */
  toCommand(): string {
    return this.shortName + this.propsText();
  }

  equals(other: BlockState): boolean {
    return this.toString() === other.toString();
  }
}

export function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function unkey(k: string): Vec3 {
  const parts = k.split(',');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

export class VoxelSet {
  private readonly map = new Map<string, BlockState>();
  private cachedBounds: Box | undefined | null = null; // null = stale

  get size(): number {
    return this.map.size;
  }

  set(x: number, y: number, z: number, state: BlockState): void {
    this.map.set(key(x, y, z), state);
    this.cachedBounds = null;
  }

  get(x: number, y: number, z: number): BlockState | undefined {
    return this.map.get(key(x, y, z));
  }

  has(x: number, y: number, z: number): boolean {
    return this.map.has(key(x, y, z));
  }

  delete(x: number, y: number, z: number): boolean {
    const r = this.map.delete(key(x, y, z));
    if (r) this.cachedBounds = null;
    return r;
  }

  *entries(): Generator<[Vec3, BlockState]> {
    for (const [k, s] of this.map) yield [unkey(k), s];
  }

  bounds(): Box | undefined {
    if (this.cachedBounds !== null) return this.cachedBounds;
    if (this.map.size === 0) return (this.cachedBounds = undefined);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const [p] of this.entries()) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
    return (this.cachedBounds = { min, max });
  }

  /** Count per canonical state string. */
  counts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.map.values()) out.set(s.toString(), (out.get(s.toString()) ?? 0) + 1);
    return out;
  }

  nonAirCount(): number {
    let n = 0;
    for (const s of this.map.values()) if (!s.isAir) n++;
    return n;
  }

  translate(dx: number, dy: number, dz: number): VoxelSet {
    const out = new VoxelSet();
    for (const [p, s] of this.entries()) out.set(p[0] + dx, p[1] + dy, p[2] + dz, s);
    return out;
  }

  clone(): VoxelSet {
    const out = new VoxelSet();
    for (const [k, s] of this.map) out.map.set(k, s);
    return out;
  }

  merge(other: VoxelSet): this {
    for (const [k, s] of other.map) this.map.set(k, s);
    this.cachedBounds = null;
    return this;
  }

  /** Sub-set of voxels inside the box. */
  within(b: Box): VoxelSet {
    const out = new VoxelSet();
    for (const [p, s] of this.entries()) if (boxContains(b, p)) out.set(p[0], p[1], p[2], s);
    return out;
  }
}
```

`src/voxel/schemas.ts`:
```ts
import { z } from 'zod';

export const Vec3Schema = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
export const Vec2Schema = z.tuple([z.number().int(), z.number().int()]);
export const RotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
export const MirrorSchema = z.enum(['none', 'x', 'z']);
export const WorldSchema = z
  .string()
  .describe('overworld (default), nether, end, a minecraft:<dimension> id, or a Bukkit world folder name');
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/voxel/voxels.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/voxel test/voxel
git commit -m "feat(voxel): BlockState and VoxelSet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 2: Rotation and mirroring

**Goal:** Rotate and mirror a `VoxelSet` about the Y axis, including block-state properties (`facing`, `axis`, `rotation`, rail `shape`, stair `shape`, door `hinge`, wall/fence side booleans), with a variant that keeps the min corner in place.

**Files:**
- Create: `src/voxel/rotate.ts`
- Test: `test/voxel/rotate.test.ts`

**Acceptance Criteria:**
- [ ] One clockwise step maps north→east→south→west→north for `facing`, x↔z for `axis`, +4 for sign `rotation`, and shifts wall sides north→east→south→west
- [ ] Rail corner `north_east` becomes `south_east` after one step; stairs keep `inner_left` under rotation but swap to `inner_right` under mirror
- [ ] Positions rotate as (x,z)→(−z,x) per step; mirror `x` negates x, mirror `z` negates z
- [ ] `transformAnchored` keeps `bounds().min` x/z unchanged after any rotation

**Verify:** `npx vitest run test/voxel/rotate.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/voxel/rotate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { rotateState, mirrorState, rotatePos, mirrorPos, transformSet, transformAnchored, stepsFromDegrees } from '../../src/voxel/rotate.js';

const st = (s: string) => BlockState.parse(s);

describe('rotateState', () => {
  it('cycles facing clockwise', () => {
    expect(rotateState(st('oak_stairs[facing=north]'), 1).props.facing).toBe('east');
    expect(rotateState(st('oak_stairs[facing=north]'), 2).props.facing).toBe('south');
    expect(rotateState(st('oak_stairs[facing=north]'), 3).props.facing).toBe('west');
    expect(rotateState(st('oak_stairs[facing=north]'), 0).props.facing).toBe('north');
    expect(rotateState(st('hopper[facing=down]'), 1).props.facing).toBe('down');
  });
  it('swaps log axis and keeps y', () => {
    expect(rotateState(st('oak_log[axis=x]'), 1).props.axis).toBe('z');
    expect(rotateState(st('oak_log[axis=z]'), 1).props.axis).toBe('x');
    expect(rotateState(st('oak_log[axis=y]'), 1).props.axis).toBe('y');
  });
  it('adds 4 to sign rotation modulo 16', () => {
    expect(rotateState(st('oak_sign[rotation=14]'), 1).props.rotation).toBe('2');
  });
  it('rotates rail shapes and leaves stair shapes alone', () => {
    expect(rotateState(st('rail[shape=north_east]'), 1).props.shape).toBe('south_east');
    expect(rotateState(st('rail[shape=north_south]'), 1).props.shape).toBe('east_west');
    expect(rotateState(st('rail[shape=ascending_north]'), 1).props.shape).toBe('ascending_east');
    expect(rotateState(st('oak_stairs[facing=north,shape=inner_left]'), 1).props.shape).toBe('inner_left');
  });
  it('shifts wall sides', () => {
    const w = rotateState(st('cobblestone_wall[east=none,north=low,south=none,west=tall]'), 1);
    expect(w.props).toEqual({ east: 'low', north: 'tall', south: 'none', west: 'none' });
    const f = rotateState(st('oak_fence[north=true]'), 1);
    expect(f.props).toEqual({ east: 'true' });
  });
});

describe('mirrorState', () => {
  it('flips facing on the mirrored axis only', () => {
    expect(mirrorState(st('oak_stairs[facing=east]'), 'x').props.facing).toBe('west');
    expect(mirrorState(st('oak_stairs[facing=north]'), 'x').props.facing).toBe('north');
    expect(mirrorState(st('oak_stairs[facing=north]'), 'z').props.facing).toBe('south');
  });
  it('swaps wall sides and stair handedness and door hinge', () => {
    expect(mirrorState(st('oak_fence[east=true,west=false]'), 'x').props).toEqual({ east: 'false', west: 'true' });
    expect(mirrorState(st('oak_stairs[facing=north,shape=inner_left]'), 'x').props.shape).toBe('inner_right');
    expect(mirrorState(st('oak_door[hinge=left]'), 'z').props.hinge).toBe('right');
  });
  it('mirrors sign rotation', () => {
    expect(mirrorState(st('oak_sign[rotation=4]'), 'x').props.rotation).toBe('12');
    expect(mirrorState(st('oak_sign[rotation=0]'), 'z').props.rotation).toBe('8');
    expect(mirrorState(st('oak_sign[rotation=4]'), 'z').props.rotation).toBe('4');
  });
  it('mirrors rail shapes', () => {
    expect(mirrorState(st('rail[shape=north_east]'), 'x').props.shape).toBe('north_west');
    expect(mirrorState(st('rail[shape=north_east]'), 'z').props.shape).toBe('south_east');
    expect(mirrorState(st('rail[shape=ascending_east]'), 'x').props.shape).toBe('ascending_west');
  });
});

describe('positions and sets', () => {
  it('rotates positions clockwise seen from above', () => {
    expect(rotatePos([1, 5, 0], 1)).toEqual([0, 5, 1]);
    expect(rotatePos([0, 5, 1], 1)).toEqual([-1, 5, 0]);
    expect(rotatePos([1, 5, 0], 4 as never)).toEqual([1, 5, 0]);
  });
  it('mirrors positions', () => {
    expect(mirrorPos([3, 1, 2], 'x')).toEqual([-3, 1, 2]);
    expect(mirrorPos([3, 1, 2], 'z')).toEqual([3, 1, -2]);
    expect(mirrorPos([3, 1, 2], 'none')).toEqual([3, 1, 2]);
  });
  it('converts degrees to steps', () => {
    expect(stepsFromDegrees(270)).toBe(3);
  });
  it('transformSet rotates blocks and positions together', () => {
    const v = new VoxelSet();
    v.set(2, 0, 0, st('oak_stairs[facing=north]'));
    const t = transformSet(v, 1, 'none');
    const [[p, s]] = [...t.entries()];
    expect(p).toEqual([0, 0, 2]);
    expect(s.props.facing).toBe('east');
  });
  it('transformAnchored keeps the min corner', () => {
    const v = new VoxelSet();
    for (let x = 0; x < 5; x++) for (let z = 0; z < 2; z++) v.set(x + 10, 3, z + 20, st('stone'));
    const t = transformAnchored(v, 1, 'none');
    expect(t.bounds()).toEqual({ min: [10, 3, 20], max: [11, 3, 24] });
    const m = transformAnchored(v, 0, 'x');
    expect(m.bounds()).toEqual({ min: [10, 3, 20], max: [14, 3, 21] });
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/voxel/rotate.test.ts`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement rotate.ts**

`src/voxel/rotate.ts`:
```ts
import { BlockState, VoxelSet, type Vec3 } from './voxels.js';

/** Clockwise quarter turns seen from above (+y). Matches vanilla clockwise_90. */
export type RotationSteps = 0 | 1 | 2 | 3;
export type Mirror = 'none' | 'x' | 'z';

export function stepsFromDegrees(deg: 0 | 90 | 180 | 270): RotationSteps {
  return (deg / 90) as RotationSteps;
}

const FACING_CW: Record<string, string> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const RAIL_CW: Record<string, string> = {
  north_south: 'east_west',
  east_west: 'north_south',
  ascending_north: 'ascending_east',
  ascending_east: 'ascending_south',
  ascending_south: 'ascending_west',
  ascending_west: 'ascending_north',
  north_east: 'south_east',
  south_east: 'south_west',
  south_west: 'north_west',
  north_west: 'north_east',
};
const SIDES = ['north', 'east', 'south', 'west'] as const;
const STAIR_MIRROR: Record<string, string> = {
  inner_left: 'inner_right',
  inner_right: 'inner_left',
  outer_left: 'outer_right',
  outer_right: 'outer_left',
};
const RAIL_MIRROR: Record<Exclude<Mirror, 'none'>, Record<string, string>> = {
  x: {
    ascending_east: 'ascending_west',
    ascending_west: 'ascending_east',
    north_east: 'north_west',
    north_west: 'north_east',
    south_east: 'south_west',
    south_west: 'south_east',
  },
  z: {
    ascending_north: 'ascending_south',
    ascending_south: 'ascending_north',
    north_east: 'south_east',
    south_east: 'north_east',
    north_west: 'south_west',
    south_west: 'north_west',
  },
};

function rotateOnce(s: BlockState): BlockState {
  const p: Record<string, string> = { ...s.props };
  if (p.facing !== undefined && FACING_CW[p.facing]) p.facing = FACING_CW[p.facing];
  if (p.axis === 'x') p.axis = 'z';
  else if (p.axis === 'z') p.axis = 'x';
  if (p.rotation !== undefined) p.rotation = String((Number(p.rotation) + 4) % 16);
  if (p.shape !== undefined && RAIL_CW[p.shape]) p.shape = RAIL_CW[p.shape];
  if (SIDES.some((k) => k in s.props)) {
    for (const k of SIDES) delete p[k];
    SIDES.forEach((from, i) => {
      const to = SIDES[(i + 1) % 4];
      if (from in s.props) p[to] = s.props[from];
    });
  }
  return new BlockState(s.name, p);
}

export function rotateState(s: BlockState, steps: RotationSteps): BlockState {
  let out = s;
  for (let i = 0; i < ((steps % 4) + 4) % 4; i++) out = rotateOnce(out);
  return out;
}

export function mirrorState(s: BlockState, mirror: Mirror): BlockState {
  if (mirror === 'none') return s;
  const p: Record<string, string> = { ...s.props };
  const [a, b] = mirror === 'x' ? (['east', 'west'] as const) : (['north', 'south'] as const);
  if (p.facing === a) p.facing = b;
  else if (p.facing === b) p.facing = a;
  if (a in s.props || b in s.props) {
    const va = s.props[a];
    const vb = s.props[b];
    delete p[a];
    delete p[b];
    if (vb !== undefined) p[a] = vb;
    if (va !== undefined) p[b] = va;
  }
  if (p.rotation !== undefined) {
    const r = Number(p.rotation);
    p.rotation = String(mirror === 'x' ? (16 - r) % 16 : (24 - r) % 16);
  }
  if (p.shape !== undefined) p.shape = RAIL_MIRROR[mirror][p.shape] ?? STAIR_MIRROR[p.shape] ?? p.shape;
  if (p.hinge === 'left') p.hinge = 'right';
  else if (p.hinge === 'right') p.hinge = 'left';
  return new BlockState(s.name, p);
}

export function rotatePos(p: Vec3, steps: RotationSteps): Vec3 {
  let [x, z] = [p[0], p[2]];
  for (let i = 0; i < ((steps % 4) + 4) % 4; i++) [x, z] = [-z, x];
  return [x, p[1], z];
}

export function mirrorPos(p: Vec3, mirror: Mirror): Vec3 {
  if (mirror === 'x') return [-p[0], p[1], p[2]];
  if (mirror === 'z') return [p[0], p[1], -p[2]];
  return [p[0], p[1], p[2]];
}

/** Mirror, then rotate, about (0,0,0). */
export function transformSet(set: VoxelSet, steps: RotationSteps, mirror: Mirror): VoxelSet {
  if (steps === 0 && mirror === 'none') return set.clone();
  const out = new VoxelSet();
  for (const [p, s] of set.entries()) {
    const rp = rotatePos(mirrorPos(p, mirror), steps);
    out.set(rp[0], rp[1], rp[2], rotateState(mirrorState(s, mirror), steps));
  }
  return out;
}

/** Like transformSet, then shifted so the bounding box min x/z are unchanged. */
export function transformAnchored(set: VoxelSet, steps: RotationSteps, mirror: Mirror): VoxelSet {
  const before = set.bounds();
  if (!before) return new VoxelSet();
  const t = transformSet(set, steps, mirror);
  const after = t.bounds()!;
  return t.translate(before.min[0] - after.min[0], 0, before.min[2] - after.min[2]);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/voxel/rotate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voxel/rotate.ts test/voxel/rotate.test.ts
git commit -m "feat(voxel): rotation and mirroring with block-state property handling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Build spec parser

**Goal:** Turn the ASCII-layer build spec (origin, palette, layers, blocks, rotation, mirror) into an absolute `VoxelSet`, with precise error messages.

**Files:**
- Create: `src/voxel/spec.ts`
- Test: `test/voxel/spec.test.ts`

**Acceptance Criteria:**
- [ ] Rows map to z (north→south), characters to x (west→east), layers to y, all offset by `origin`
- [ ] A `y: [from, to]` layer repeats its rows for every y in the range
- [ ] Space skips; a character missing from the palette throws `BuildSpecError` naming layer, row, column and character
- [ ] Rotation keeps the min corner at origin

**Verify:** `npx vitest run test/voxel/spec.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/voxel/spec.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BuildSpecSchema, buildSpecToVoxels, BuildSpecError } from '../../src/voxel/spec.js';

const parse = (input: unknown) => buildSpecToVoxels(BuildSpecSchema.parse(input));

describe('buildSpecToVoxels', () => {
  it('maps rows to z, chars to x, layers to y, offset by origin', () => {
    const v = parse({ origin: [100, 64, 200], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['##', ' #'] }] });
    expect(v.size).toBe(3);
    expect(v.get(100, 64, 200)?.toCommand()).toBe('stone');
    expect(v.get(101, 64, 200)?.toCommand()).toBe('stone');
    expect(v.get(100, 64, 201)).toBeUndefined();
    expect(v.get(101, 64, 201)?.toCommand()).toBe('stone');
  });
  it('repeats a y range', () => {
    const v = parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: [1, 3], rows: ['#'] }] });
    expect(v.size).toBe(3);
    expect(v.bounds()).toEqual({ min: [0, 1, 0], max: [0, 3, 0] });
  });
  it('accepts extra single blocks and property strings in the palette', () => {
    const v = parse({
      origin: [0, 0, 0],
      palette: { s: 'oak_stairs[facing=north]' },
      layers: [{ y: 0, rows: ['s'] }],
      blocks: [{ pos: [0, 1, 0], block: 'lantern[hanging=true]' }],
    });
    expect(v.get(0, 0, 0)?.toString()).toBe('minecraft:oak_stairs[facing=north]');
    expect(v.get(0, 1, 0)?.toString()).toBe('minecraft:lantern[hanging=true]');
  });
  it('reports unknown characters with their position', () => {
    expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['#', '#Q'] }] })).toThrow(
      /layer 0 row 1 col 1: character "Q"/,
    );
  });
  it('reports bad palette entries and empty specs', () => {
    expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'sto ne' }, layers: [{ y: 0, rows: ['#'] }] })).toThrow(BuildSpecError);
    expect(() => parse({ origin: [0, 0, 0], palette: {}, layers: [{ y: 0, rows: ['  '] }] })).toThrow(/no blocks/);
  });
  it('rotates about the min corner', () => {
    const v = parse({ origin: [10, 0, 10], palette: { '#': 'stone', s: 'oak_stairs[facing=north]' }, layers: [{ y: 0, rows: ['s###'] }], rotation: 90 });
    expect(v.bounds()).toEqual({ min: [10, 0, 10], max: [10, 0, 13] });
    // the stairs block was at x=0 (west end); after clockwise rotation it is at the north end
    expect(v.get(10, 0, 10)?.props.facing).toBe('east');
  });
  it('applies defaults through the schema', () => {
    const s = BuildSpecSchema.parse({ origin: [0, 0, 0], layers: [{ y: 0, rows: ['#'] }], palette: { '#': 'dirt' } });
    expect(s.rotation).toBe(0);
    expect(s.mirror).toBe('none');
    expect(s.blocks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/voxel/spec.test.ts`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement spec.ts**

`src/voxel/spec.ts`:
```ts
import { z } from 'zod';
import { BlockState, VoxelSet } from './voxels.js';
import { Vec3Schema, RotationSchema, MirrorSchema } from './schemas.js';
import { stepsFromDegrees, transformAnchored } from './rotate.js';

export const buildSpecShape = {
  origin: Vec3Schema.describe('World position that the spec\'s (0,0,0) maps to: the min corner of the build'),
  palette: z
    .record(z.string().length(1), z.string())
    .default({})
    .describe('Single character → block state, e.g. {"#":"stone_bricks","g":"glass_pane","." : "air"}. Space always means "leave the world alone".'),
  layers: z
    .array(
      z.object({
        y: z
          .union([z.number().int(), z.tuple([z.number().int(), z.number().int()])])
          .describe('Height above origin, or an inclusive [from, to] range that repeats the rows'),
        rows: z.array(z.string()).min(1).describe('Rows run north→south (z), characters run west→east (x)'),
      }),
    )
    .default([]),
  blocks: z
    .array(z.object({ pos: Vec3Schema, block: z.string() }))
    .default([])
    .describe('Extra single blocks at positions relative to origin, e.g. {"pos":[2,3,1],"block":"lantern[hanging=true]"}'),
  rotation: RotationSchema.default(0).describe('Clockwise quarter turns seen from above. The min corner stays at origin.'),
  mirror: MirrorSchema.default('none').describe('x flips east↔west, z flips north↔south. Applied before rotation.'),
};

export const BuildSpecSchema = z.object(buildSpecShape);
export type BuildSpec = z.infer<typeof BuildSpecSchema>;

export class BuildSpecError extends Error {}

function range(a: number, b: number): number[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out: number[] = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

/** Relative voxels (before origin/rotation) — used by preview and schematic_write as well. */
export function buildSpecToRelativeVoxels(spec: BuildSpec): VoxelSet {
  const palette = new Map<string, BlockState>();
  for (const [ch, text] of Object.entries(spec.palette)) {
    try {
      palette.set(ch, BlockState.parse(text));
    } catch (e) {
      throw new BuildSpecError(`palette "${ch}": ${(e as Error).message}`);
    }
  }
  const rel = new VoxelSet();
  spec.layers.forEach((layer, li) => {
    const ys = Array.isArray(layer.y) ? range(layer.y[0], layer.y[1]) : [layer.y];
    layer.rows.forEach((row, z) => {
      [...row].forEach((ch, x) => {
        if (ch === ' ') return;
        const state = palette.get(ch);
        if (!state) throw new BuildSpecError(`layer ${li} row ${z} col ${x}: character "${ch}" is not in the palette`);
        for (const y of ys) rel.set(x, y, z, state);
      });
    });
  });
  spec.blocks.forEach((b, i) => {
    try {
      rel.set(b.pos[0], b.pos[1], b.pos[2], BlockState.parse(b.block));
    } catch (e) {
      throw new BuildSpecError(`blocks[${i}]: ${(e as Error).message}`);
    }
  });
  if (rel.size === 0) throw new BuildSpecError('spec produced no blocks (only spaces?)');
  return transformAnchored(rel, stepsFromDegrees(spec.rotation), spec.mirror);
}

export function buildSpecToVoxels(spec: BuildSpec): VoxelSet {
  return buildSpecToRelativeVoxels(spec).translate(spec.origin[0], spec.origin[1], spec.origin[2]);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/voxel/spec.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voxel/spec.ts test/voxel/spec.test.ts
git commit -m "feat(voxel): ASCII layer build spec parser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 4: Shape generators

**Goal:** Sphere, dome, cylinder, cone, pyramid, line and circle generators, filled or hollow, producing a `VoxelSet`.

**Files:**
- Create: `src/voxel/shapes.ts`
- Test: `test/voxel/shapes.test.ts`

**Acceptance Criteria:**
- [ ] Radius r gives a diameter of 2r+1 blocks (sphere r=2 has 81 blocks; cylinder r=1 h=3 has 27)
- [ ] Hollow shapes keep only a wall of `thickness` blocks (hollow sphere r=2 has 62, hollow cylinder r=1 h=3 has 24)
- [ ] Pyramid size 5 has 35 blocks, hollow 25; line (0,0,0)→(3,1,0) has 4 blocks
- [ ] Missing required fields throw `ShapeError` such as `sphere needs center`

**Verify:** `npx vitest run test/voxel/shapes.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/voxel/shapes.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ShapeSpecSchema, shapeToVoxels, ShapeError } from '../../src/voxel/shapes.js';

const gen = (input: unknown) => shapeToVoxels(ShapeSpecSchema.parse(input));

describe('shapes', () => {
  it('sphere', () => {
    const v = gen({ shape: 'sphere', center: [0, 0, 0], radius: 2, block: 'stone' });
    expect(v.size).toBe(81);
    expect(v.bounds()).toEqual({ min: [-2, -2, -2], max: [2, 2, 2] });
    expect(gen({ shape: 'sphere', center: [0, 0, 0], radius: 2, block: 'stone', hollow: true }).size).toBe(62);
  });
  it('dome is the upper half including the base layer', () => {
    expect(gen({ shape: 'dome', center: [0, 10, 0], radius: 2, block: 'stone' }).size).toBe(51);
  });
  it('cylinder and cone', () => {
    expect(gen({ shape: 'cylinder', base: [0, 0, 0], radius: 1, height: 3, block: 'stone' }).size).toBe(27);
    expect(gen({ shape: 'cylinder', base: [0, 0, 0], radius: 1, height: 3, block: 'stone', hollow: true }).size).toBe(24);
    expect(gen({ shape: 'cone', base: [0, 0, 0], radius: 2, height: 3, block: 'stone' }).size).toBe(35);
  });
  it('pyramid', () => {
    const v = gen({ shape: 'pyramid', base: [0, 0, 0], size: 5, block: 'sandstone' });
    expect(v.size).toBe(35);
    expect(v.bounds()).toEqual({ min: [0, 0, 0], max: [4, 2, 4] });
    expect(gen({ shape: 'pyramid', base: [0, 0, 0], size: 5, block: 'sandstone', hollow: true }).size).toBe(25);
  });
  it('line and circle', () => {
    const l = gen({ shape: 'line', from: [0, 0, 0], to: [3, 1, 0], block: 'stone' });
    expect(l.size).toBe(4);
    expect(l.has(3, 1, 0)).toBe(true);
    expect(gen({ shape: 'circle', center: [0, 5, 0], radius: 1, block: 'stone', hollow: true }).size).toBe(8);
    expect(gen({ shape: 'circle', center: [0, 5, 0], radius: 1, block: 'stone' }).size).toBe(9);
  });
  it('rejects missing fields', () => {
    expect(() => gen({ shape: 'sphere', radius: 2, block: 'stone' })).toThrow(ShapeError);
    expect(() => gen({ shape: 'sphere', radius: 2, block: 'stone' })).toThrow(/sphere needs center/);
    expect(() => gen({ shape: 'cylinder', base: [0, 0, 0], radius: 2, block: 'stone' })).toThrow(/cylinder needs height/);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/voxel/shapes.test.ts`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement shapes.ts**

`src/voxel/shapes.ts`:
```ts
import { z } from 'zod';
import { BlockState, VoxelSet, type Vec3 } from './voxels.js';
import { Vec3Schema } from './schemas.js';

export const shapeShape = {
  shape: z.enum(['sphere', 'dome', 'cylinder', 'cone', 'pyramid', 'line', 'circle']),
  block: z.string().describe('Block state, e.g. "stone" or "oak_log[axis=y]"'),
  center: Vec3Schema.optional().describe('sphere: center; dome: center of the flat base; circle: center'),
  base: Vec3Schema.optional().describe('cylinder/cone: center of the bottom disk; pyramid: min corner of the base square'),
  from: Vec3Schema.optional().describe('line start'),
  to: Vec3Schema.optional().describe('line end'),
  radius: z.number().min(0.5).optional().describe('Radius in blocks along x (diameter = 2r+1)'),
  radius_y: z.number().min(0.5).optional().describe('sphere/dome: vertical radius, defaults to radius'),
  radius_z: z.number().min(0.5).optional().describe('Radius along z, defaults to radius'),
  height: z.number().int().min(1).optional().describe('cylinder/cone/pyramid height in blocks'),
  size: z.number().int().min(1).optional().describe('pyramid: base side length'),
  hollow: z.boolean().default(false),
  thickness: z.number().int().min(1).default(1).describe('Wall thickness when hollow'),
};
export const ShapeSpecSchema = z.object(shapeShape);
export type ShapeSpec = z.infer<typeof ShapeSpecSchema>;

export class ShapeError extends Error {}

function need<T>(v: T | undefined, what: string, shape: string): T {
  if (v === undefined) throw new ShapeError(`${shape} needs ${what}`);
  return v;
}

function inside2(dx: number, dz: number, rx: number, rz: number): boolean {
  return (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz) <= 1;
}

function inside3(dx: number, dy: number, dz: number, rx: number, ry: number, rz: number): boolean {
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz) <= 1;
}

/** Horizontal disk; wall=0 fills it, wall>0 keeps a ring of that thickness. */
function disk(cx: number, cz: number, r: number, rz: number, wall: number, put: (x: number, z: number) => void): void {
  const RX = r + 0.5;
  const RZ = rz + 0.5;
  const ix = Math.max(RX - wall, 0);
  const iz = Math.max(RZ - wall, 0);
  const ex = Math.ceil(r);
  const ez = Math.ceil(rz);
  for (let dx = -ex; dx <= ex; dx++) {
    for (let dz = -ez; dz <= ez; dz++) {
      if (!inside2(dx, dz, RX, RZ)) continue;
      if (wall > 0 && inside2(dx, dz, ix, iz)) continue;
      put(cx + dx, cz + dz);
    }
  }
}

function ellipsoid(c: Vec3, r: number, ry: number, rz: number, wall: number, upperHalf: boolean, put: (x: number, y: number, z: number) => void): void {
  const RX = r + 0.5;
  const RY = ry + 0.5;
  const RZ = rz + 0.5;
  const ix = Math.max(RX - wall, 0);
  const iy = Math.max(RY - wall, 0);
  const iz = Math.max(RZ - wall, 0);
  for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
    for (let dy = upperHalf ? 0 : -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
      for (let dz = -Math.ceil(rz); dz <= Math.ceil(rz); dz++) {
        if (!inside3(dx, dy, dz, RX, RY, RZ)) continue;
        if (wall > 0 && inside3(dx, dy, dz, ix, iy, iz)) continue;
        put(c[0] + dx, c[1] + dy, c[2] + dz);
      }
    }
  }
}

export function shapeToVoxels(spec: ShapeSpec): VoxelSet {
  const block = BlockState.parse(spec.block);
  const out = new VoxelSet();
  const put = (x: number, y: number, z: number) => out.set(x, y, z, block);
  const wall = spec.hollow ? spec.thickness : 0;
  switch (spec.shape) {
    case 'sphere':
    case 'dome': {
      const c = need(spec.center, 'center', spec.shape);
      const r = need(spec.radius, 'radius', spec.shape);
      ellipsoid(c, r, spec.radius_y ?? r, spec.radius_z ?? r, wall, spec.shape === 'dome', put);
      break;
    }
    case 'cylinder':
    case 'cone': {
      const b = need(spec.base, 'base', spec.shape);
      const r = need(spec.radius, 'radius', spec.shape);
      const rz = spec.radius_z ?? r;
      const h = need(spec.height, 'height', spec.shape);
      for (let i = 0; i < h; i++) {
        const f = spec.shape === 'cone' ? 1 - i / h : 1;
        disk(b[0], b[2], r * f, rz * f, wall, (x, z) => put(x, b[1] + i, z));
      }
      break;
    }
    case 'pyramid': {
      const b = need(spec.base, 'base', spec.shape);
      const size = need(spec.size, 'size', spec.shape);
      const h = spec.height ?? Math.ceil(size / 2);
      for (let i = 0; i < h; i++) {
        const inset = h === 1 ? 0 : Math.round((i * ((size - 1) / 2)) / (h - 1));
        const lo = inset;
        const hi = size - 1 - inset;
        if (lo > hi) break;
        for (let x = lo; x <= hi; x++) {
          for (let z = lo; z <= hi; z++) {
            if (spec.hollow && x !== lo && x !== hi && z !== lo && z !== hi) continue;
            put(b[0] + x, b[1] + i, b[2] + z);
          }
        }
      }
      break;
    }
    case 'line': {
      const a = need(spec.from, 'from', spec.shape);
      const b = need(spec.to, 'to', spec.shape);
      const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]));
      const stamp = Math.floor((spec.thickness - 1) / 2);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const p: Vec3 = [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
        if (stamp === 0) put(p[0], p[1], p[2]);
        else ellipsoid(p, stamp, stamp, stamp, 0, false, put);
      }
      break;
    }
    case 'circle': {
      const c = need(spec.center, 'center', spec.shape);
      const r = need(spec.radius, 'radius', spec.shape);
      disk(c[0], c[2], r, spec.radius_z ?? r, wall, (x, z) => put(x, c[1], z));
      break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/voxel/shapes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voxel/shapes.ts test/voxel/shapes.test.ts
git commit -m "feat(voxel): shape generators

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Command compiler

**Goal:** Compile a `VoxelSet` into the fewest `fill`/`setblock` commands, split over the fill limit, ordered so supports come before attachables, with a dimension prefix when needed, plus forceload rectangles for a box.

**Files:**
- Create: `src/voxel/compile.ts`
- Test: `test/voxel/compile.test.ts`

**Acceptance Criteria:**
- [ ] Solid 10×10×10 cube → 1 fill of 1000 blocks; hollow cube (walls only) → 6 fills totalling 488 blocks
- [ ] A 40×40×40 fill (64000) with limit 32768 splits into 2 commands
- [ ] A torch on stone compiles to the stone command first
- [ ] `execute in minecraft:the_nether run ` prefixes commands when dimension is the nether, nothing for the overworld
- [ ] `forceloadRects` covers a 40×40 box at chunk borders with one rect and a 300×300 box with 4 rects (each ≤256 chunks)

**Verify:** `npx vitest run test/voxel/compile.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/voxel/compile.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { compile, mergeBoxes, splitBox, isAttachable, prefixDimension, forceloadRects } from '../../src/voxel/compile.js';

const st = (s: string) => BlockState.parse(s);
function cube(n: number, hollow: boolean): VoxelSet {
  const v = new VoxelSet();
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      for (let z = 0; z < n; z++) {
        const edge = x === 0 || y === 0 || z === 0 || x === n - 1 || y === n - 1 || z === n - 1;
        if (!hollow || edge) v.set(x, y, z, st('stone'));
      }
  return v;
}

describe('compile', () => {
  it('merges a solid cube into one fill', () => {
    const cmds = compile(cube(10, false));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].text).toBe('fill 0 0 0 9 9 9 stone');
    expect(cmds[0].blocks).toBe(1000);
  });
  it('merges a hollow cube into six fills', () => {
    const cmds = compile(cube(10, true));
    expect(cmds).toHaveLength(6);
    expect(cmds.reduce((n, c) => n + c.blocks, 0)).toBe(488);
    expect(cmds.every((c) => c.kind === 'fill')).toBe(true);
  });
  it('emits setblock for single voxels', () => {
    const v = new VoxelSet();
    v.set(1, 2, 3, st('oak_log[axis=y]'));
    expect(compile(v)[0].text).toBe('setblock 1 2 3 oak_log[axis=y]');
  });
  it('splits fills over the limit along the longest axis', () => {
    const boxes = splitBox({ min: [0, 0, 0], max: [39, 39, 39] }, 32768);
    expect(boxes).toHaveLength(2);
    expect(boxes.map((b) => (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1))).toEqual([32000, 32000]);
    const v = new VoxelSet();
    for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) for (let z = 0; z < 40; z++) v.set(x, y, z, st('stone'));
    expect(compile(v)).toHaveLength(2);
  });
  it('places attachables after supports, lowest first', () => {
    const v = new VoxelSet();
    v.set(0, 1, 0, st('torch'));
    v.set(0, 0, 0, st('stone'));
    v.set(5, 0, 0, st('oak_door[half=upper]'));
    v.set(5, -1, 0, st('oak_door[half=lower]'));
    const texts = compile(v).map((c) => c.text);
    expect(texts[0]).toBe('setblock 0 0 0 stone');
    expect(texts.indexOf('setblock 5 -1 0 oak_door[half=lower]')).toBeLessThan(texts.indexOf('setblock 5 0 0 oak_door[half=upper]'));
    expect(texts.indexOf('setblock 0 1 0 torch')).toBeGreaterThan(0);
  });
  it('classifies attachables', () => {
    for (const n of ['torch', 'wall_torch', 'lantern', 'ladder', 'oak_door', 'stone_button', 'rail', 'powered_rail', 'red_carpet', 'snow', 'poppy', 'short_grass', 'oak_sign', 'oak_wall_sign', 'redstone_wire', 'glass_pane', 'cave_vines', 'candle'])
      expect(isAttachable(st(n)), n).toBe(true);
    for (const n of ['stone', 'snow_block', 'oak_trapdoor_x', 'cobblestone_wall', 'grass_block', 'mangrove_roots_block', 'oak_planks'])
      expect(isAttachable(st(n)), n).toBe(false);
    expect(isAttachable(st('oak_trapdoor'))).toBe(true);
  });
  it('prefixes non-overworld dimensions', () => {
    expect(prefixDimension('fill 0 0 0 1 1 1 stone', 'minecraft:the_nether')).toBe('execute in minecraft:the_nether run fill 0 0 0 1 1 1 stone');
    expect(prefixDimension('fill 0 0 0 1 1 1 stone', 'minecraft:overworld')).toBe('fill 0 0 0 1 1 1 stone');
    expect(prefixDimension('fill 0 0 0 1 1 1 stone')).toBe('fill 0 0 0 1 1 1 stone');
  });
  it('computes forceload rectangles of at most 256 chunks', () => {
    expect(forceloadRects({ min: [0, 60, 0], max: [39, 70, 39] })).toEqual([{ minX: 0, minZ: 0, maxX: 47, maxZ: 47 }]);
    const rects = forceloadRects({ min: [-150, 60, 180], max: [149, 70, 479] });
    expect(rects).toHaveLength(4);
    for (const r of rects) expect(((r.maxX - r.minX + 1) / 16) * ((r.maxZ - r.minZ + 1) / 16)).toBeLessThanOrEqual(256);
  });
  it('mergeBoxes covers every position exactly once', () => {
    const boxes = mergeBoxes([[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1], [5, 5, 5]]);
    expect(boxes).toEqual([{ min: [0, 0, 0], max: [1, 0, 1] }, { min: [5, 5, 5], max: [5, 5, 5] }]);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/voxel/compile.test.ts`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement compile.ts**

`src/voxel/compile.ts`:
```ts
import { BlockState, VoxelSet, key, formatVec, boxVolume, boxSize, type Box, type Vec3 } from './voxels.js';

export interface Command {
  text: string;
  blocks: number;
  kind: 'fill' | 'setblock';
  box: Box;
  state: BlockState;
}

export interface CompileOptions {
  /** Max blocks per fill (vanilla gamerule commandModificationBlockLimit, default 32768). */
  fillLimit?: number;
  /** minecraft:overworld | minecraft:the_nether | minecraft:the_end */
  dimension?: string;
}

export const DEFAULT_FILL_LIMIT = 32768;

export function prefixDimension(text: string, dimension?: string): string {
  return dimension && dimension !== 'minecraft:overworld' ? `execute in ${dimension} run ${text}` : text;
}

/** Blocks that need a neighbour to exist first (or pop off / drop when placed early). */
const ATTACHABLE = new RegExp(
  '^minecraft:(' +
    [
      'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch', 'redstone_wall_torch',
      'lantern', 'soul_lantern', 'ladder', 'vine', 'glow_lichen', 'rail', '.*_rail',
      '.*_door', '.*_trapdoor', '.*_button', 'lever', '.*_pressure_plate', '.*_sign', '.*_banner',
      '.*_carpet', 'moss_carpet', 'snow', 'redstone_wire', 'repeater', 'comparator', 'tripwire', 'tripwire_hook',
      '.*_bed', '.*_sapling', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', '.*_tulip', 'oxeye_daisy',
      'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower', 'pitcher_plant', 'sunflower', 'lilac',
      'rose_bush', 'peony', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'seagrass',
      'tall_seagrass', 'kelp', 'kelp_plant', 'lily_pad', '.*coral.*', 'candle', '.*_candle', '.*_candle_cake',
      'chain', 'bell', 'flower_pot', 'potted_.*', 'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem',
      'pumpkin_stem', 'attached_.*', 'sugar_cane', 'bamboo', 'bamboo_sapling', 'cactus', 'nether_wart', 'cocoa',
      'sweet_berry_bush', 'cave_vines', 'cave_vines_plant', 'weeping_vines', 'weeping_vines_plant',
      'twisting_vines', 'twisting_vines_plant', 'hanging_roots', 'spore_blossom', '.*_fungus', 'crimson_roots',
      'warped_roots', 'nether_sprouts', 'scaffolding', 'iron_bars', '.*_pane', 'lightning_rod', 'end_rod',
      '.*_head', '.*_skull', 'amethyst_cluster', '.*_amethyst_bud', 'pointed_dripstone', 'small_dripleaf',
      'big_dripleaf', 'big_dripleaf_stem', 'frogspawn', 'sculk_vein', '.*_wall_.*', 'pink_petals', 'wildflowers',
      'leaf_litter', 'bush', 'firefly_bush', 'cactus_flower', 'closed_eyeblossom', 'open_eyeblossom',
    ].join('|') +
    ')$',
);

export function isAttachable(state: BlockState): boolean {
  return ATTACHABLE.test(state.name);
}

/** Greedy merge of positions into axis-aligned boxes: extend along x, then z, then y. */
export function mergeBoxes(positions: Vec3[]): Box[] {
  const cells = new Set(positions.map((p) => key(p[0], p[1], p[2])));
  const visited = new Set<string>();
  const free = (x: number, y: number, z: number): boolean => {
    const k = key(x, y, z);
    return cells.has(k) && !visited.has(k);
  };
  const sorted = [...positions].sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  const boxes: Box[] = [];
  for (const p of sorted) {
    if (!free(p[0], p[1], p[2])) continue;
    let x2 = p[0];
    while (free(x2 + 1, p[1], p[2])) x2++;
    let z2 = p[2];
    outerZ: for (;;) {
      for (let x = p[0]; x <= x2; x++) if (!free(x, p[1], z2 + 1)) break outerZ;
      z2++;
    }
    let y2 = p[1];
    outerY: for (;;) {
      for (let z = p[2]; z <= z2; z++) for (let x = p[0]; x <= x2; x++) if (!free(x, y2 + 1, z)) break outerY;
      y2++;
    }
    for (let y = p[1]; y <= y2; y++) for (let z = p[2]; z <= z2; z++) for (let x = p[0]; x <= x2; x++) visited.add(key(x, y, z));
    boxes.push({ min: [p[0], p[1], p[2]], max: [x2, y2, z2] });
  }
  return boxes;
}

/** Split a box until every piece has at most `limit` blocks, halving the longest axis. */
export function splitBox(b: Box, limit: number): Box[] {
  if (boxVolume(b) <= limit) return [b];
  const size = boxSize(b);
  const axis = size.indexOf(Math.max(...size)) as 0 | 1 | 2;
  const half = Math.floor(size[axis] / 2);
  const aMax: Vec3 = [b.max[0], b.max[1], b.max[2]];
  aMax[axis] = b.min[axis] + half - 1;
  const bMin: Vec3 = [b.min[0], b.min[1], b.min[2]];
  bMin[axis] = b.min[axis] + half;
  return [...splitBox({ min: b.min, max: aMax }, limit), ...splitBox({ min: bMin, max: b.max }, limit)];
}

function toCommand(b: Box, state: BlockState, dimension?: string): Command {
  const blocks = boxVolume(b);
  const text =
    blocks === 1 ? `setblock ${formatVec(b.min)} ${state.toCommand()}` : `fill ${formatVec(b.min)} ${formatVec(b.max)} ${state.toCommand()}`;
  return { text: prefixDimension(text, dimension), blocks, kind: blocks === 1 ? 'setblock' : 'fill', box: b, state };
}

export function compile(set: VoxelSet, opts: CompileOptions = {}): Command[] {
  const limit = Math.max(1, opts.fillLimit ?? DEFAULT_FILL_LIMIT);
  const byState = new Map<string, { state: BlockState; positions: Vec3[] }>();
  for (const [p, s] of set.entries()) {
    const k = s.toString();
    let g = byState.get(k);
    if (!g) byState.set(k, (g = { state: s, positions: [] }));
    g.positions.push(p);
  }
  const pass1: Command[] = [];
  const pass2: Command[] = [];
  for (const { state, positions } of byState.values()) {
    const target = isAttachable(state) ? pass2 : pass1;
    for (const merged of mergeBoxes(positions)) for (const piece of splitBox(merged, limit)) target.push(toCommand(piece, state, opts.dimension));
  }
  const byY = (a: Command, b: Command) => a.box.min[1] - b.box.min[1] || a.box.min[2] - b.box.min[2] || a.box.min[0] - b.box.min[0];
  pass1.sort(byY);
  pass2.sort(byY);
  return [...pass1, ...pass2];
}

export interface ChunkRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Block-coordinate rectangles covering the chunks of a box, each at most 16×16 chunks (the forceload limit of 256). */
export function forceloadRects(b: Box, maxChunksPerSide = 16): ChunkRect[] {
  const cx1 = b.min[0] >> 4;
  const cz1 = b.min[2] >> 4;
  const cx2 = b.max[0] >> 4;
  const cz2 = b.max[2] >> 4;
  const rects: ChunkRect[] = [];
  for (let cx = cx1; cx <= cx2; cx += maxChunksPerSide) {
    for (let cz = cz1; cz <= cz2; cz += maxChunksPerSide) {
      const ex = Math.min(cx + maxChunksPerSide - 1, cx2);
      const ez = Math.min(cz + maxChunksPerSide - 1, cz2);
      rects.push({ minX: cx * 16, minZ: cz * 16, maxX: ex * 16 + 15, maxZ: ez * 16 + 15 });
    }
  }
  return rects;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/voxel/compile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voxel/compile.ts test/voxel/compile.test.ts
git commit -m "feat(voxel): compile voxels to fill/setblock commands

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 6: RCON client

**Goal:** A dependency-free RCON client with correct framing, authentication, multi-packet responses (4096-byte fragments reassembled via a sentinel packet), serialized commands, timeouts and one automatic reconnect; plus an in-process fake RCON server for tests.

**Files:**
- Create: `src/rcon/client.ts`
- Create: `test/helpers/fake-rcon.ts`
- Test: `test/rcon/client.test.ts`

**Acceptance Criteria:**
- [ ] Wrong password rejects `connect()` with `RconError` mentioning authentication
- [ ] A 9000-character response arrives intact as one string
- [ ] Two overlapping `send()` calls execute in call order on the server
- [ ] After the server drops the socket, the next `send()` reconnects and succeeds
- [ ] A server that never answers makes `send()` reject with a timeout error naming the command

**Verify:** `npx vitest run test/rcon/client.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the fake server and the failing tests**

`test/helpers/fake-rcon.ts`:
```ts
import net from 'node:net';
import { encodePacket, decodePackets } from '../../src/rcon/client.js';

/** Minimal Minecraft-compatible RCON server: auth, 4096-byte fragmentation, "Unknown request" for other types. */
export class FakeRcon {
  readonly commands: string[] = [];
  /** Return the response text, or null to never answer (for timeout tests). */
  handler: (cmd: string) => string | null = () => '';
  password = 'secret';
  port = 0;
  private server: net.Server | undefined;
  private sockets = new Set<net.Socket>();

  async start(): Promise<number> {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      let buf = Buffer.alloc(0);
      let authed = false;
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === 3) {
            authed = p.body === this.password;
            socket.write(encodePacket(authed ? p.id : -1, 2, ''));
          } else if (p.type === 2) {
            if (!authed) {
              socket.write(encodePacket(-1, 2, ''));
              continue;
            }
            this.commands.push(p.body);
            const out = this.handler(p.body);
            if (out === null) continue;
            let start = 0;
            do {
              socket.write(encodePacket(p.id, 0, out.slice(start, start + 4096)));
              start += 4096;
            } while (start < out.length);
          } else {
            socket.write(encodePacket(p.id, 0, `Unknown request ${p.type.toString(16)}`));
          }
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.port;
  }

  dropClients(): void {
    for (const s of this.sockets) s.destroy();
  }

  async stop(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
```

`test/rcon/client.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RconClient, RconError, encodePacket, decodePackets } from '../../src/rcon/client.js';
import { FakeRcon } from '../helpers/fake-rcon.js';

describe('packet framing', () => {
  it('round-trips packets and leaves partial data in rest', () => {
    const a = encodePacket(7, 2, 'list');
    const b = encodePacket(8, 100, '');
    const joined = Buffer.concat([a, b, Buffer.from([1, 2, 3])]);
    const { packets, rest } = decodePackets(joined);
    expect(packets).toEqual([
      { id: 7, type: 2, body: 'list' },
      { id: 8, type: 100, body: '' },
    ]);
    expect(rest.length).toBe(3);
    expect(a.readInt32LE(0)).toBe(4 + 4 + 4 + 2);
  });
});

describe('RconClient', () => {
  let fake: FakeRcon;
  let client: RconClient;
  beforeEach(async () => {
    fake = new FakeRcon();
    await fake.start();
  });
  afterEach(async () => {
    await client?.close();
    await fake.stop();
  });

  it('authenticates and sends a command', async () => {
    fake.handler = (cmd) => `echo:${cmd}`;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    await client.connect();
    expect(await client.send('list')).toBe('echo:list');
    expect(fake.commands).toEqual(['list']);
  });

  it('rejects a wrong password', async () => {
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'nope' });
    await expect(client.connect()).rejects.toThrow(/authentication/);
  });

  it('reassembles long responses', async () => {
    const long = 'x'.repeat(9000) + 'END';
    fake.handler = () => long;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    expect(await client.send('help')).toBe(long);
  });

  it('serializes overlapping sends in order', async () => {
    fake.handler = (cmd) => cmd.toUpperCase();
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    const results = await Promise.all([client.send('a'), client.send('b'), client.send('c')]);
    expect(results).toEqual(['A', 'B', 'C']);
    expect(fake.commands).toEqual(['a', 'b', 'c']);
  });

  it('reconnects after the server drops the connection', async () => {
    fake.handler = (cmd) => `ok:${cmd}`;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    expect(await client.send('one')).toBe('ok:one');
    fake.dropClients();
    await new Promise((r) => setTimeout(r, 50));
    expect(await client.send('two')).toBe('ok:two');
    expect(fake.commands).toEqual(['one', 'two']);
  });

  it('times out when the server never answers', async () => {
    fake.handler = () => null;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret', timeoutMs: 200 });
    await expect(client.send('slow')).rejects.toThrow(/timeout.*slow/);
    await expect(client.send('slow')).rejects.toBeInstanceOf(RconError);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/rcon/client.test.ts`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement client.ts**

`src/rcon/client.ts`:
```ts
import net from 'node:net';

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  /** Per-command timeout. Default 15000. */
  timeoutMs?: number;
}

export class RconError extends Error {}

const TYPE_RESPONSE = 0;
const TYPE_COMMAND = 2;
const TYPE_AUTH = 3;
/** Any unknown type; the server answers "Unknown request" with our id, which marks the end of the previous response. */
const TYPE_SENTINEL = 100;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  buf.writeInt32LE(4 + 4 + payload.length + 2, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

export function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let off = 0;
  while (buffer.length - off >= 4) {
    const len = buffer.readInt32LE(off);
    if (buffer.length - off - 4 < len) break;
    packets.push({
      id: buffer.readInt32LE(off + 4),
      type: buffer.readInt32LE(off + 8),
      body: buffer.toString('utf8', off + 12, off + 4 + len - 2),
    });
    off += 4 + len;
  }
  return { packets, rest: buffer.subarray(off) };
}

interface Pending {
  id: number;
  sentinelId: number;
  auth: boolean;
  command: string;
  chunks: string[];
  finish: (body: string, id: number) => void;
  fail: (e: Error) => void;
}

export class RconClient {
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending: Pending | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private authed = false;

  constructor(private readonly opts: RconOptions) {}

  get connected(): boolean {
    return this.authed && this.socket !== undefined && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    await this.close();
    const socket = new net.Socket();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.authed = false;
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.authed = false;
      const p = this.pending;
      this.pending = undefined;
      p?.fail(new RconError(`RCON connection closed while waiting for: ${p.command}`));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => reject(new RconError(`RCON connect to ${this.opts.host}:${this.opts.port} failed: ${e.message}`));
      socket.once('error', onError);
      socket.connect(this.opts.port, this.opts.host, () => {
        socket.off('error', onError);
        resolve();
      });
    });
    const reply = await this.exchange(this.opts.password, true);
    if (reply.id === -1) {
      socket.destroy();
      throw new RconError('RCON authentication failed: wrong password');
    }
    this.authed = true;
  }

  /** Run one command; calls are serialized. Reconnects once if the connection is gone. */
  send(command: string): Promise<string> {
    const run = async (): Promise<string> => {
      if (!this.connected) await this.connect();
      try {
        return (await this.exchange(command, false)).body;
      } catch (e) {
        if (e instanceof RconError && /closed|not connected/.test(e.message)) {
          await this.connect();
          return (await this.exchange(command, false)).body;
        }
        throw e;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    const s = this.socket;
    this.socket = undefined;
    this.authed = false;
    if (s && !s.destroyed) s.destroy();
  }

  private exchange(body: string, auth: boolean): Promise<{ id: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.destroyed) return reject(new RconError('RCON not connected'));
      const id = this.nextId++;
      const sentinelId = auth ? -2 : this.nextId++;
      const ms = this.opts.timeoutMs ?? 15000;
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new RconError(`RCON timeout after ${ms}ms waiting for: ${auth ? '<auth>' : body}`));
      }, ms);
      this.pending = {
        id,
        sentinelId,
        auth,
        command: auth ? '<auth>' : body,
        chunks: [],
        finish: (text, replyId) => {
          clearTimeout(timer);
          this.pending = undefined;
          resolve({ id: replyId, body: text });
        },
        fail: (e) => {
          clearTimeout(timer);
          this.pending = undefined;
          reject(e);
        },
      };
      socket.write(encodePacket(id, auth ? TYPE_AUTH : TYPE_COMMAND, body));
      if (!auth) socket.write(encodePacket(sentinelId, TYPE_SENTINEL, ''));
    });
  }

  private onData(d: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, d]);
    const { packets, rest } = decodePackets(this.buffer);
    this.buffer = rest;
    for (const pkt of packets) this.handlePacket(pkt);
  }

  private handlePacket(pkt: RconPacket): void {
    const p = this.pending;
    if (!p) return;
    if (p.auth) {
      if (pkt.id === p.id || pkt.id === -1) p.finish(pkt.body, pkt.id);
      return;
    }
    if (pkt.id === p.id && pkt.type === TYPE_RESPONSE) p.chunks.push(pkt.body);
    else if (pkt.id === p.sentinelId) p.finish(p.chunks.join(''), p.id);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/rcon/client.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcon test/rcon test/helpers/fake-rcon.ts
git commit -m "feat(rcon): RCON client with fragmentation, queueing and reconnect

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: NBT helpers, Clipboard, vanilla structure codec

**Goal:** Typed helpers over prismarine-nbt, the `Clipboard` type shared by all schematic formats, and read/write of vanilla structure `.nbt` files including block entities.

**Files:**
- Create: `src/nbt/nbt.ts`, `src/schematic/clipboard.ts`, `src/schematic/structure.ts`
- Test: `test/nbt/nbt.test.ts`, `test/schematic/clipboard.test.ts`, `test/schematic/structure.test.ts`

**Acceptance Criteria:**
- [ ] `writeNbtGz`/`parseNbt` round-trip a compound with int, string, list, intArray, longArray
- [ ] `clipboardFromVoxels` shifts voxels so the min corner is (0,0,0), records `size`, and shifts block entities the same way
- [ ] `clipboardVoxelsAt` places the min corner at `origin`; with `useOffset` it adds the stored offset; rotation rotates block entity positions too; `ignoreAir` drops air
- [ ] `tileBox` splits a 60×20×100 box into 1×1×3 = 3 pieces of at most 48 per axis
- [ ] A structure written by `writeStructure` reads back identical (states, positions, a sign block entity), and `readStructure` accepts the `palettes` variant

**Verify:** `npx vitest run test/nbt test/schematic/clipboard.test.ts test/schematic/structure.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/nbt/nbt.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { T, parseNbt, writeNbtGz, writeNbtRaw, num, str, compound, listOf, intList, bytes, longPairToBigInt } from '../../src/nbt/nbt.js';

describe('nbt helpers', () => {
  it('round-trips through gzip and raw', async () => {
    const root = T.comp({ a: T.int(7), s: T.string('hi'), l: T.list(T.int([1, 2, 3])), ia: T.intArray([4, 5]), la: T.longArray([[0, 9]]) }, '');
    for (const buf of [writeNbtGz(root), writeNbtRaw(root)]) {
      const back = await parseNbt(buf);
      expect(num(back.value, 'a')).toBe(7);
      expect(str(back.value, 's')).toBe('hi');
      expect(intList(back.value, 'l')).toEqual([1, 2, 3]);
      expect(intList(back.value, 'ia')).toEqual([4, 5]);
      expect(longPairToBigInt((back.value.la as { value: [number, number][] }).value[0])).toBe(9n);
    }
  });
  it('accessors return defaults and nested compounds', () => {
    const root = T.comp({ inner: T.comp({ x: T.short(3) }), arr: T.byteArray([-1, 2]) }, '');
    expect(num(root.value, 'missing', 42)).toBe(42);
    expect(str(root.value, 'missing', 'd')).toBe('d');
    expect(num(compound(root.value, 'inner')!, 'x')).toBe(3);
    expect(bytes(root.value, 'arr')).toEqual([-1, 2]);
    expect(listOf(root.value, 'nope')).toEqual([]);
  });
});
```

`test/schematic/clipboard.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels, clipboardVoxelsAt, tileBox } from '../../src/schematic/clipboard.js';
import { T } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);

describe('clipboard', () => {
  it('normalizes to a zero min corner and shifts block entities', () => {
    const v = new VoxelSet();
    v.set(10, 5, 20, st('stone'));
    v.set(12, 6, 21, st('oak_sign[rotation=0]'));
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [12, 6, 21], id: 'minecraft:sign', data: T.comp({}).value }]);
    expect(clip.size).toEqual([3, 2, 2]);
    expect(clip.voxels.get(0, 0, 0)?.toCommand()).toBe('stone');
    expect(clip.blockEntities[0].pos).toEqual([2, 1, 1]);
    expect(clip.offset).toEqual([0, 0, 0]);
    expect(clip.dataVersion).toBe(4903);
  });
  it('places at origin, honours useOffset, rotation and ignoreAir', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('oak_stairs[facing=north]'));
    v.set(2, 0, 0, st('air'));
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [0, 0, 0], id: 'minecraft:x', data: {} }], [-1, 0, -1]);
    const plain = clipboardVoxelsAt(clip, [100, 64, 100], {});
    expect(plain.voxels.get(100, 64, 100)?.props.facing).toBe('north');
    expect(plain.voxels.get(102, 64, 100)?.isAir).toBe(true);
    const noAir = clipboardVoxelsAt(clip, [100, 64, 100], { ignoreAir: true });
    expect(noAir.voxels.size).toBe(1);
    const off = clipboardVoxelsAt(clip, [100, 64, 100], { useOffset: true });
    expect(off.voxels.get(99, 64, 99)?.props.facing).toBe('north');
    const rot = clipboardVoxelsAt(clip, [100, 64, 100], { rotation: 1 });
    expect(rot.voxels.bounds()!.min).toEqual([100, 64, 100]);
    expect(rot.voxels.get(100, 64, 100)?.props.facing).toBe('east');
    expect(rot.blockEntities[0].pos).toEqual([100, 64, 100]);
  });
  it('tiles boxes to 48 per axis', () => {
    const tiles = tileBox({ min: [0, 0, 0], max: [59, 19, 99] });
    expect(tiles).toHaveLength(2 * 1 * 3);
    expect(tiles[0]).toEqual({ min: [0, 0, 0], max: [47, 19, 47] });
    expect(tiles[tiles.length - 1]).toEqual({ min: [48, 0, 96], max: [59, 19, 99] });
  });
});
```

`test/schematic/structure.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels } from '../../src/schematic/clipboard.js';
import { readStructure, writeStructure } from '../../src/schematic/structure.js';
import { T, parseNbt, writeNbtGz, compound, listOf } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);

describe('vanilla structure codec', () => {
  it('round-trips blocks, properties and a block entity', async () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('stone'));
    v.set(1, 0, 0, st('oak_stairs[facing=north,half=top]'));
    v.set(1, 1, 0, st('air'));
    v.set(0, 0, 2, st('oak_sign[rotation=8]'));
    const sign = T.comp({ front_text: T.comp({ messages: T.list(T.string(['"hi"', '""', '""', '""'])) }) }).value;
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [0, 0, 2], id: 'minecraft:sign', data: sign }]);
    const root = writeStructure(clip);
    const back = readStructure(await parseNbt(writeNbtGz(root)));
    expect(back.size).toEqual([2, 2, 3]);
    expect(back.dataVersion).toBe(4903);
    expect(back.voxels.size).toBe(4);
    expect(back.voxels.get(1, 0, 0)?.toString()).toBe('minecraft:oak_stairs[facing=north,half=top]');
    expect(back.voxels.get(1, 1, 0)?.isAir).toBe(true);
    expect(back.blockEntities).toHaveLength(1);
    expect(back.blockEntities[0].id).toBe('minecraft:sign');
    expect(back.blockEntities[0].pos).toEqual([0, 0, 2]);
    const frontText = compound(back.blockEntities[0].data, 'front_text');
    expect(frontText).toBeDefined();
    expect(listOf(frontText!, 'messages')).toEqual(['"hi"', '""', '""', '""']);
    expect(back.source).toBe('structure');
  });
  it('accepts the palettes (plural) variant and empty nbt-less blocks', async () => {
    const root = T.comp(
      {
        size: T.list(T.int([1, 1, 1])),
        palettes: T.list(T.list(T.comp([{ Name: T.string('minecraft:dirt') }]))),
        blocks: T.list(T.comp([{ state: T.int(0), pos: T.list(T.int([0, 0, 0])) }])),
        entities: T.list(T.comp([])),
        DataVersion: T.int(4903),
      },
      '',
    );
    const clip = readStructure(await parseNbt(writeNbtGz(root)));
    expect(clip.voxels.get(0, 0, 0)?.toCommand()).toBe('dirt');
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/nbt test/schematic`
Expected: FAIL, cannot find modules

- [ ] **Step 3: Implement nbt.ts**

`src/nbt/nbt.ts`:
```ts
import nbt from 'prismarine-nbt';
import { gzipSync, gunzipSync } from 'node:zlib';

export type NbtRoot = nbt.NBT;
/** A compound's value: tag name → typed tag. */
export type CompoundValue = Record<string, { type: string; value: unknown }>;

export const T = {
  comp: nbt.comp,
  int: nbt.int,
  short: nbt.short,
  byte: nbt.byte,
  long: nbt.long,
  float: nbt.float,
  double: nbt.double,
  string: nbt.string,
  list: nbt.list,
  intArray: nbt.intArray,
  byteArray: nbt.byteArray,
  longArray: nbt.longArray,
};

function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Parse big-endian NBT, gzip-compressed or not. */
export async function parseNbt(buf: Buffer): Promise<NbtRoot> {
  const raw = isGzip(buf) ? gunzipSync(buf) : buf;
  return nbt.parseUncompressed(raw, 'big') as NbtRoot;
}

export function writeNbtRaw(root: NbtRoot): Buffer {
  return nbt.writeUncompressed(root, 'big');
}

export function writeNbtGz(root: NbtRoot): Buffer {
  return gzipSync(writeNbtRaw(root));
}

export function longPairToBigInt(pair: [number, number]): bigint {
  return (BigInt(pair[0] >>> 0) << 32n) | BigInt(pair[1] >>> 0);
}

export function bigIntToLongPair(v: bigint): [number, number] {
  const hi = Number((v >> 32n) & 0xffffffffn) | 0;
  const lo = Number(v & 0xffffffffn) | 0;
  return [hi, lo];
}

export function num(c: CompoundValue, k: string, def?: number): number {
  const t = c[k];
  if (!t) {
    if (def !== undefined) return def;
    throw new Error(`NBT: missing numeric tag "${k}"`);
  }
  if (t.type === 'long') return Number(longPairToBigInt(t.value as [number, number]));
  return t.value as number;
}

export function str(c: CompoundValue, k: string, def?: string): string {
  const t = c[k];
  if (!t) {
    if (def !== undefined) return def;
    throw new Error(`NBT: missing string tag "${k}"`);
  }
  return String(t.value);
}

export function compound(c: CompoundValue, k: string): CompoundValue | undefined {
  const t = c[k];
  return t && t.type === 'compound' ? (t.value as CompoundValue) : undefined;
}

/** Elements of a list tag (compound elements come back as CompoundValue). Empty when missing. */
export function listOf(c: CompoundValue, k: string): unknown[] {
  const t = c[k];
  if (!t || t.type !== 'list') return [];
  const inner = t.value as { type: string; value: unknown[] };
  return inner.value ?? [];
}

/** Ints from either a list of ints or an int array. */
export function intList(c: CompoundValue, k: string): number[] {
  const t = c[k];
  if (!t) return [];
  if (t.type === 'intArray') return [...(t.value as number[])];
  if (t.type === 'list') return [...((t.value as { value: number[] }).value ?? [])];
  throw new Error(`NBT: tag "${k}" is ${t.type}, expected int list`);
}

export function bytes(c: CompoundValue, k: string): number[] {
  const t = c[k];
  if (!t) return [];
  if (t.type !== 'byteArray') throw new Error(`NBT: tag "${k}" is ${t.type}, expected byteArray`);
  return [...(t.value as number[])];
}

export function longPairs(c: CompoundValue, k: string): [number, number][] {
  const t = c[k];
  if (!t) return [];
  if (t.type !== 'longArray') throw new Error(`NBT: tag "${k}" is ${t.type}, expected longArray`);
  return t.value as [number, number][];
}

/** Copy of a compound value without the given keys. */
export function omitKeys(c: CompoundValue, keys: string[]): CompoundValue {
  const out: CompoundValue = {};
  for (const [k, v] of Object.entries(c)) if (!keys.includes(k)) out[k] = v;
  return out;
}
```

- [ ] **Step 4: Implement clipboard.ts**

`src/schematic/clipboard.ts`:
```ts
import { VoxelSet, type Box, type Vec3, boxSize } from '../voxel/voxels.js';
import { transformAnchored, transformSet, rotatePos, mirrorPos, type RotationSteps, type Mirror } from '../voxel/rotate.js';
import type { CompoundValue } from '../nbt/nbt.js';

export interface BlockEntity {
  /** Relative to the clipboard's min corner (or absolute, in world read results). */
  pos: Vec3;
  id: string;
  /** Block entity NBT without id/x/y/z/Id/Pos. */
  data: CompoundValue;
}

export interface Clipboard {
  /** Voxels with min corner at (0,0,0). Air is explicit. */
  voxels: VoxelSet;
  size: Vec3;
  /** Sponge semantics: paste position + offset = min corner. */
  offset: Vec3;
  dataVersion: number;
  blockEntities: BlockEntity[];
  source?: 'sponge' | 'structure';
}

export function clipboardFromVoxels(voxels: VoxelSet, dataVersion: number, blockEntities: BlockEntity[] = [], offset: Vec3 = [0, 0, 0]): Clipboard {
  const b = voxels.bounds();
  if (!b) throw new Error('cannot make a clipboard from an empty voxel set');
  const shifted = voxels.translate(-b.min[0], -b.min[1], -b.min[2]);
  return {
    voxels: shifted,
    size: boxSize(b),
    offset,
    dataVersion,
    blockEntities: blockEntities.map((be) => ({ ...be, pos: [be.pos[0] - b.min[0], be.pos[1] - b.min[1], be.pos[2] - b.min[2]] })),
  };
}

export interface PlaceOptions {
  useOffset?: boolean;
  rotation?: RotationSteps;
  mirror?: Mirror;
  ignoreAir?: boolean;
}

/** World-space voxels for pasting the clipboard at `origin`. */
export function clipboardVoxelsAt(clip: Clipboard, origin: Vec3, opts: PlaceOptions): { voxels: VoxelSet; blockEntities: BlockEntity[] } {
  const steps = opts.rotation ?? 0;
  const mirror = opts.mirror ?? 'none';
  let voxels: VoxelSet;
  let shift: Vec3;
  if (opts.useOffset) {
    voxels = transformSet(clip.voxels.translate(clip.offset[0], clip.offset[1], clip.offset[2]), steps, mirror);
    shift = [0, 0, 0];
  } else {
    voxels = transformAnchored(clip.voxels, steps, mirror);
    const after = transformSet(clip.voxels, steps, mirror).bounds()!;
    shift = [-after.min[0], 0, -after.min[2]];
  }
  const place = (p: Vec3): Vec3 => {
    const base = opts.useOffset ? ([p[0] + clip.offset[0], p[1] + clip.offset[1], p[2] + clip.offset[2]] as Vec3) : p;
    const t = rotatePos(mirrorPos(base, mirror), steps);
    return [t[0] + shift[0] + origin[0], t[1] + shift[1] + origin[1], t[2] + shift[2] + origin[2]];
  };
  voxels = voxels.translate(origin[0], origin[1], origin[2]);
  if (opts.ignoreAir) {
    const filtered = new VoxelSet();
    for (const [p, s] of voxels.entries()) if (!s.isAir) filtered.set(p[0], p[1], p[2], s);
    voxels = filtered;
  }
  return { voxels, blockEntities: clip.blockEntities.map((be) => ({ ...be, pos: place(be.pos) })) };
}

/** Split a box into pieces of at most `max` blocks per axis (structure templates cap at 48). */
export function tileBox(b: Box, max = 48): Box[] {
  const out: Box[] = [];
  for (let x = b.min[0]; x <= b.max[0]; x += max)
    for (let y = b.min[1]; y <= b.max[1]; y += max)
      for (let z = b.min[2]; z <= b.max[2]; z += max)
        out.push({ min: [x, y, z], max: [Math.min(x + max - 1, b.max[0]), Math.min(y + max - 1, b.max[1]), Math.min(z + max - 1, b.max[2])] });
  return out;
}
```

- [ ] **Step 5: Implement structure.ts**

`src/schematic/structure.ts`:
```ts
import { BlockState, VoxelSet, type Vec3 } from '../voxel/voxels.js';
import { T, num, str, compound, listOf, intList, omitKeys, type NbtRoot, type CompoundValue } from '../nbt/nbt.js';
import type { Clipboard, BlockEntity } from './clipboard.js';

function stateFromPalette(entry: CompoundValue): BlockState {
  const props: Record<string, string> = {};
  const p = compound(entry, 'Properties');
  if (p) for (const [k, v] of Object.entries(p)) props[k] = String(v.value);
  return new BlockState(str(entry, 'Name'), props);
}

function paletteEntry(state: BlockState): CompoundValue {
  const entry: CompoundValue = { Name: T.string(state.name) };
  const keys = Object.keys(state.props);
  if (keys.length) {
    const props: CompoundValue = {};
    for (const k of keys) props[k] = T.string(state.props[k]);
    entry.Properties = T.comp(props);
  }
  return entry;
}

export function readStructure(root: NbtRoot): Clipboard {
  const v = root.value as CompoundValue;
  const size = intList(v, 'size');
  if (size.length !== 3) throw new Error('structure: missing size');
  let paletteList = listOf(v, 'palette') as CompoundValue[];
  if (paletteList.length === 0) {
    const palettes = listOf(v, 'palettes') as Array<{ type: string; value: CompoundValue[] } | CompoundValue[]>;
    const first = palettes[0];
    if (first) paletteList = Array.isArray(first) ? first : ((first as { value: CompoundValue[] }).value ?? []);
  }
  const states = paletteList.map(stateFromPalette);
  const voxels = new VoxelSet();
  const blockEntities: BlockEntity[] = [];
  for (const b of listOf(v, 'blocks') as CompoundValue[]) {
    const pos = intList(b, 'pos') as Vec3;
    const state = states[num(b, 'state')];
    if (!state) throw new Error(`structure: block state index ${num(b, 'state')} out of palette range`);
    voxels.set(pos[0], pos[1], pos[2], state);
    const nbtTag = compound(b, 'nbt');
    if (nbtTag) blockEntities.push({ pos, id: str(nbtTag, 'id', state.name), data: omitKeys(nbtTag, ['id', 'x', 'y', 'z']) });
  }
  return { voxels, size: [size[0], size[1], size[2]], offset: [0, 0, 0], dataVersion: num(v, 'DataVersion', 0), blockEntities, source: 'structure' };
}

export function writeStructure(clip: Clipboard): NbtRoot {
  const paletteIndex = new Map<string, number>();
  const palette: CompoundValue[] = [];
  const beByPos = new Map<string, BlockEntity>();
  for (const be of clip.blockEntities) beByPos.set(be.pos.join(','), be);
  const blocks: CompoundValue[] = [];
  for (const [p, s] of clip.voxels.entries()) {
    const k = s.toString();
    let idx = paletteIndex.get(k);
    if (idx === undefined) {
      idx = palette.length;
      paletteIndex.set(k, idx);
      palette.push(paletteEntry(s));
    }
    const entry: CompoundValue = { state: T.int(idx), pos: T.list(T.int([p[0], p[1], p[2]])) };
    const be = beByPos.get(p.join(','));
    if (be) entry.nbt = T.comp({ ...be.data, id: T.string(be.id) });
    blocks.push(entry);
  }
  return T.comp(
    {
      size: T.list(T.int([clip.size[0], clip.size[1], clip.size[2]])),
      palette: T.list(T.comp(palette)),
      blocks: T.list(T.comp(blocks)),
      entities: T.list(T.comp([])),
      DataVersion: T.int(clip.dataVersion),
    },
    '',
  ) as NbtRoot;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/nbt test/schematic`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/nbt src/schematic test/nbt test/schematic
git commit -m "feat(schematic): NBT helpers, clipboard model, vanilla structure codec

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 8: Sponge schematic codec and format detection

**Goal:** Read Sponge `.schem` v1/v2/v3, write v3, detect the format of any file, and resolve schematic paths.

**Files:**
- Create: `src/schematic/sponge.ts`, `src/schematic/index.ts`
- Test: `test/schematic/sponge.test.ts`, `test/schematic/index.test.ts`

**Acceptance Criteria:**
- [ ] A hand-built v2 file (Palette, BlockData varints, Metadata WEOffset) reads with the right blocks and offset
- [ ] A v3 file written by `writeSponge3` reads back identical including a block entity, and palette indices ≥128 encode as two-byte varints
- [ ] `detectFormat` distinguishes sponge (v2 root, v3 nested) from structure and rejects other NBT
- [ ] `resolveSchematicPath` joins relative paths onto the schematic dir and probes `.schem`/`.nbt` extensions for reads

**Verify:** `npx vitest run test/schematic` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/schematic/sponge.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels } from '../../src/schematic/clipboard.js';
import { readSponge, writeSponge3, encodeVarints, decodeVarints } from '../../src/schematic/sponge.js';
import { T, parseNbt, writeNbtGz } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);

describe('varints', () => {
  it('encodes and decodes values above 127', () => {
    const bytes = encodeVarints([0, 1, 127, 128, 300]);
    expect(bytes.length).toBe(1 + 1 + 1 + 2 + 2);
    expect(decodeVarints(bytes, 5)).toEqual([0, 1, 127, 128, 300]);
  });
});

describe('sponge v2', () => {
  it('reads palette, block data and WorldEdit offset metadata', async () => {
    const root = T.comp(
      {
        Version: T.int(2),
        DataVersion: T.int(3700),
        Width: T.short(2),
        Height: T.short(1),
        Length: T.short(2),
        PaletteMax: T.int(3),
        Palette: T.comp({ 'minecraft:air': T.int(0), 'minecraft:stone': T.int(1), 'minecraft:oak_stairs[facing=north,half=bottom]': T.int(2) }),
        BlockData: T.byteArray(encodeVarints([1, 2, 0, 1])),
        BlockEntities: T.list(T.comp([])),
        Metadata: T.comp({ WEOffsetX: T.int(-1), WEOffsetY: T.int(0), WEOffsetZ: T.int(-2) }),
      },
      'Schematic',
    );
    const clip = readSponge(await parseNbt(writeNbtGz(root)));
    expect(clip.size).toEqual([2, 1, 2]);
    expect(clip.offset).toEqual([-1, 0, -2]);
    expect(clip.voxels.get(0, 0, 0)?.toCommand()).toBe('stone');
    expect(clip.voxels.get(1, 0, 0)?.toString()).toBe('minecraft:oak_stairs[facing=north,half=bottom]');
    expect(clip.voxels.get(0, 0, 1)?.isAir).toBe(true);
    expect(clip.voxels.get(1, 0, 1)?.toCommand()).toBe('stone');
    expect(clip.dataVersion).toBe(3700);
    expect(clip.source).toBe('sponge');
  });
});

describe('sponge v3', () => {
  it('round-trips voxels, offset and block entities', async () => {
    const v = new VoxelSet();
    for (let i = 0; i < 200; i++) v.set(i, 0, 0, st(`stone[fake=${i}]`)); // 200 distinct states forces indices >127
    v.set(0, 1, 0, st('chest[facing=north]'));
    const chest = T.comp({ Items: T.list(T.comp([])) }).value;
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [0, 1, 0], id: 'minecraft:chest', data: chest }], [3, 0, 3]);
    const back = readSponge(await parseNbt(writeNbtGz(writeSponge3(clip))));
    expect(back.size).toEqual([200, 2, 1]);
    expect(back.offset).toEqual([3, 0, 3]);
    expect(back.voxels.get(199, 0, 0)?.toString()).toBe('minecraft:stone[fake=199]');
    expect(back.voxels.get(5, 1, 0)?.isAir).toBe(true);
    expect(back.blockEntities).toEqual([{ pos: [0, 1, 0], id: 'minecraft:chest', data: chest }]);
    expect(back.dataVersion).toBe(4903);
  });
});
```

`test/schematic/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels } from '../../src/schematic/clipboard.js';
import { detectFormat, loadClipboard, saveClipboard, resolveSchematicPath } from '../../src/schematic/index.js';
import { writeStructure } from '../../src/schematic/structure.js';
import { writeSponge3 } from '../../src/schematic/sponge.js';
import { T, writeNbtGz } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);
function sample() {
  const v = new VoxelSet();
  v.set(0, 0, 0, st('stone'));
  v.set(1, 0, 0, st('dirt'));
  return clipboardFromVoxels(v, 4903);
}

describe('format detection and IO', () => {
  it('detects formats', () => {
    expect(detectFormat(writeSponge3(sample()))).toBe('sponge');
    expect(detectFormat(writeStructure(sample()))).toBe('structure');
    expect(detectFormat(T.comp({ Version: T.int(2), Palette: T.comp({}) }, 'Schematic'))).toBe('sponge');
    expect(detectFormat(T.comp({ foo: T.int(1) }, ''))).toBeUndefined();
  });
  it('saves and loads both formats by extension', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
    for (const name of ['a.schem', 'b.nbt']) {
      const p = path.join(dir, name);
      await saveClipboard(sample(), p);
      const back = await loadClipboard(p);
      expect(back.voxels.get(1, 0, 0)?.toCommand()).toBe('dirt');
      expect(back.source).toBe(name.endsWith('.nbt') ? 'structure' : 'sponge');
    }
    await writeFile(path.join(dir, 'junk.schem'), writeNbtGz(T.comp({ foo: T.int(1) }, '')));
    await expect(loadClipboard(path.join(dir, 'junk.schem'))).rejects.toThrow(/not a Sponge schematic or vanilla structure/);
  });
  it('resolves relative paths and probes extensions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
    await saveClipboard(sample(), path.join(dir, 'house.schem'));
    expect(resolveSchematicPath('house', dir)).toBe(path.join(dir, 'house.schem'));
    expect(resolveSchematicPath('house.schem', dir)).toBe(path.join(dir, 'house.schem'));
    expect(resolveSchematicPath('/abs/x.nbt', dir)).toBe('/abs/x.nbt');
    expect(resolveSchematicPath('new', dir, true)).toBe(path.join(dir, 'new.schem'));
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/schematic`
Expected: FAIL, cannot find modules sponge/index

- [ ] **Step 3: Implement sponge.ts**

`src/schematic/sponge.ts`:
```ts
import { BlockState, VoxelSet, type Vec3 } from '../voxel/voxels.js';
import { T, num, compound, listOf, intList, bytes, omitKeys, type NbtRoot, type CompoundValue } from '../nbt/nbt.js';
import type { Clipboard, BlockEntity } from './clipboard.js';

export function decodeVarints(data: number[], expected: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < data.length && out.length < expected) {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = data[i++] & 0xff;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('sponge: varint too long');
    }
    out.push(value >>> 0);
  }
  if (out.length !== expected) throw new Error(`sponge: block data has ${out.length} entries, expected ${expected}`);
  return out;
}

export function encodeVarints(values: number[]): number[] {
  const out: number[] = [];
  for (let v of values) {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      out.push(b > 127 ? b - 256 : b);
    } while (v !== 0);
  }
  return out;
}

export function readSponge(root: NbtRoot): Clipboard {
  const rootV = root.value as CompoundValue;
  const sch = compound(rootV, 'Schematic') ?? rootV;
  const version = num(sch, 'Version', 1);
  const W = num(sch, 'Width') & 0xffff;
  const H = num(sch, 'Height') & 0xffff;
  const L = num(sch, 'Length') & 0xffff;
  let offset = intList(sch, 'Offset');
  if (offset.length !== 3) {
    const meta = compound(sch, 'Metadata');
    offset = meta ? [num(meta, 'WEOffsetX', 0), num(meta, 'WEOffsetY', 0), num(meta, 'WEOffsetZ', 0)] : [0, 0, 0];
  }
  let paletteC: CompoundValue | undefined;
  let data: number[];
  let beList: CompoundValue[];
  if (version >= 3) {
    const blocks = compound(sch, 'Blocks');
    if (!blocks) throw new Error('sponge v3: missing Blocks');
    paletteC = compound(blocks, 'Palette');
    data = bytes(blocks, 'Data');
    beList = listOf(blocks, 'BlockEntities') as CompoundValue[];
  } else {
    paletteC = compound(sch, 'Palette');
    data = bytes(sch, 'BlockData');
    beList = listOf(sch, 'BlockEntities') as CompoundValue[];
  }
  if (!paletteC) throw new Error('sponge: missing Palette');
  const states: BlockState[] = [];
  for (const [text, tag] of Object.entries(paletteC)) states[tag.value as number] = BlockState.parse(text);
  const indices = decodeVarints(data, W * H * L);
  const voxels = new VoxelSet();
  for (let i = 0; i < indices.length; i++) {
    const s = states[indices[i]];
    if (!s) throw new Error(`sponge: palette index ${indices[i]} missing`);
    voxels.set(i % W, Math.floor(i / (W * L)), Math.floor(i / W) % L, s);
  }
  const blockEntities: BlockEntity[] = beList.map((be) => {
    const pos = intList(be, 'Pos') as Vec3;
    const id = String(be.Id?.value ?? '');
    const dataC = version >= 3 ? (compound(be, 'Data') ?? {}) : omitKeys(be, ['Pos', 'Id']);
    return { pos, id, data: dataC };
  });
  return { voxels, size: [W, H, L], offset: [offset[0], offset[1], offset[2]], dataVersion: num(sch, 'DataVersion', 0), blockEntities, source: 'sponge' };
}

function short(v: number): ReturnType<typeof T.short> {
  return T.short(v > 32767 ? v - 65536 : v);
}

export function writeSponge3(clip: Clipboard): NbtRoot {
  const [W, H, L] = clip.size;
  const air = BlockState.parse('air');
  const paletteIndex = new Map<string, number>();
  const paletteTags: CompoundValue = {};
  const indexOf = (s: BlockState): number => {
    const k = s.toString();
    let i = paletteIndex.get(k);
    if (i === undefined) {
      i = paletteIndex.size;
      paletteIndex.set(k, i);
      paletteTags[k] = T.int(i);
    }
    return i;
  };
  const values = new Array<number>(W * H * L);
  for (let y = 0; y < H; y++)
    for (let z = 0; z < L; z++)
      for (let x = 0; x < W; x++) values[x + z * W + y * W * L] = indexOf(clip.voxels.get(x, y, z) ?? air);
  const blockEntities = clip.blockEntities.map((be) => ({ Pos: T.intArray(be.pos), Id: T.string(be.id), Data: T.comp(be.data) }));
  const schematic = T.comp({
    Version: T.int(3),
    DataVersion: T.int(clip.dataVersion),
    Width: short(W),
    Height: short(H),
    Length: short(L),
    Offset: T.intArray(clip.offset),
    Blocks: T.comp({ Palette: T.comp(paletteTags), Data: T.byteArray(encodeVarints(values)), BlockEntities: T.list(T.comp(blockEntities)) }),
    Entities: T.list(T.comp([])),
  });
  return T.comp({ Schematic: schematic }, '') as NbtRoot;
}
```

- [ ] **Step 4: Implement index.ts**

`src/schematic/index.ts`:
```ts
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { parseNbt, writeNbtGz, type NbtRoot, type CompoundValue } from '../nbt/nbt.js';
import type { Clipboard } from './clipboard.js';
import { readSponge, writeSponge3 } from './sponge.js';
import { readStructure, writeStructure } from './structure.js';

export type ClipboardFormat = 'sponge' | 'structure';

export function detectFormat(root: NbtRoot): ClipboardFormat | undefined {
  const v = root.value as CompoundValue;
  if (v.Schematic || (v.Version && (v.Palette || v.BlockData))) return 'sponge';
  if (v.size && v.blocks) return 'structure';
  return undefined;
}

export async function loadClipboard(filePath: string): Promise<Clipboard> {
  const root = await parseNbt(await fs.readFile(filePath));
  const format = detectFormat(root);
  if (!format) throw new Error(`${filePath}: not a Sponge schematic or vanilla structure`);
  return format === 'sponge' ? readSponge(root) : readStructure(root);
}

export function formatForPath(p: string, explicit?: ClipboardFormat): ClipboardFormat {
  return explicit ?? (p.toLowerCase().endsWith('.nbt') ? 'structure' : 'sponge');
}

export async function saveClipboard(clip: Clipboard, filePath: string, format?: ClipboardFormat): Promise<{ path: string; format: ClipboardFormat }> {
  const f = formatForPath(filePath, format);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, writeNbtGz(f === 'structure' ? writeStructure(clip) : writeSponge3(clip)));
  return { path: filePath, format: f };
}

const READ_EXTS = ['.schem', '.nbt', '.schematic'];

/** Absolute path for a user-supplied schematic name. For reads, probes known extensions. */
export function resolveSchematicPath(input: string, schematicDir: string, forWrite = false): string {
  let p = path.isAbsolute(input) ? input : path.join(schematicDir, input);
  if (path.extname(p) === '') {
    if (forWrite) return `${p}.schem`;
    for (const ext of READ_EXTS) if (existsSync(p + ext)) return p + ext;
  }
  return p;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/schematic`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/schematic test/schematic
git commit -m "feat(schematic): Sponge v2/v3 codec, format detection, path resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: World dimensions and Anvil region reader

**Goal:** Map world names to dimensions and region directories (26.x and legacy layouts), and read blocks, block entities and heightmaps straight from `.mca` files.

**Files:**
- Create: `src/world/dimension.ts`, `src/world/anvil.ts`
- Create: `test/helpers/anvil-fixture.ts`
- Test: `test/world/dimension.test.ts`, `test/world/anvil.test.ts`

**Acceptance Criteria:**
- [ ] `resolveWorld('nether','world')` → dimension `minecraft:the_nether`, Bukkit name `world_nether`; unknown names throw
- [ ] `resolveRegionDir` prefers `<level>/dimensions/minecraft/<dim>/region` and falls back to the legacy layout
- [ ] A region file built by the test fixture decodes: grass at (5,63,7), stone at (0,48,0), air above, one sign block entity, surface 63 at column (5,7), and a column with no blocks reports minY−1
- [ ] `readVoxels` over a box that spans a missing chunk fills what exists and reports `missingChunks: 1`

**Verify:** `npx vitest run test/world` → all passed

**Steps:**

- [ ] **Step 1: Write the fixture helper and failing tests**

`test/helpers/anvil-fixture.ts`:
```ts
import { deflateSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { T, writeNbtRaw, bigIntToLongPair, type CompoundValue } from '../../src/nbt/nbt.js';
import { packLongs } from '../../src/world/anvil.js';

export interface FixtureChunk {
  cx: number;
  cz: number;
  /** y → {x,z} → block state text ("minecraft:stone" or with [props]) — everything else is air. */
  blocks: Array<{ x: number; y: number; z: number; state: string }>;
  blockEntities?: CompoundValue[];
}

function paletteEntry(text: string): CompoundValue {
  const m = /^([^\[]+)(?:\[(.*)\])?$/.exec(text)!;
  const entry: CompoundValue = { Name: T.string(m[1]) };
  if (m[2]) {
    const props: CompoundValue = {};
    for (const pair of m[2].split(',')) {
      const [k, v] = pair.split('=');
      props[k] = T.string(v);
    }
    entry.Properties = T.comp(props);
  }
  return entry;
}

/** Build chunk NBT the way the game does: 24 sections (−4..19), palette+packed data, MOTION_BLOCKING heightmap. */
export function buildChunk(c: FixtureChunk): Buffer {
  const sections: CompoundValue[] = [];
  const heights = new Array<number>(256).fill(0); // value 0 = no blocks
  for (let sy = -4; sy <= 19; sy++) {
    const inSection = c.blocks.filter((b) => b.y >> 4 === sy);
    const palette = ['minecraft:air'];
    const indices = new Array<number>(4096).fill(0);
    for (const b of inSection) {
      let idx = palette.indexOf(b.state);
      if (idx < 0) {
        idx = palette.length;
        palette.push(b.state);
      }
      indices[((b.y & 15) << 8) | ((b.z & 15) << 4) | (b.x & 15)] = idx;
      const col = ((b.z & 15) << 4) | (b.x & 15);
      heights[col] = Math.max(heights[col], b.y - -64 + 1);
    }
    const blockStates: CompoundValue = { palette: T.list(T.comp(palette.map(paletteEntry))) };
    if (palette.length > 1) {
      const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
      blockStates.data = T.longArray(packLongs(indices, bits).map(bigIntToLongPair));
    }
    sections.push({ Y: T.byte(sy), block_states: T.comp(blockStates) });
  }
  const root = T.comp(
    {
      DataVersion: T.int(4903),
      xPos: T.int(c.cx),
      zPos: T.int(c.cz),
      yPos: T.int(-4),
      Status: T.string('minecraft:full'),
      sections: T.list(T.comp(sections)),
      Heightmaps: T.comp({ MOTION_BLOCKING: T.longArray(packLongs(heights, 9).map(bigIntToLongPair)) }),
      block_entities: T.list(T.comp(c.blockEntities ?? [])),
    },
    '',
  );
  return writeNbtRaw(root);
}

/** Write r.<rx>.<rz>.mca files containing the given chunks into regionDir. */
export async function writeRegionFiles(regionDir: string, chunks: FixtureChunk[]): Promise<void> {
  await fs.mkdir(regionDir, { recursive: true });
  const byRegion = new Map<string, FixtureChunk[]>();
  for (const c of chunks) {
    const k = `${c.cx >> 5}.${c.cz >> 5}`;
    byRegion.set(k, [...(byRegion.get(k) ?? []), c]);
  }
  for (const [k, list] of byRegion) {
    const header = Buffer.alloc(8192);
    const parts: Buffer[] = [header];
    let sector = 2;
    for (const c of list) {
      const compressed = deflateSync(buildChunk(c));
      const body = Buffer.alloc(5 + compressed.length);
      body.writeInt32BE(compressed.length + 1, 0);
      body[4] = 2;
      compressed.copy(body, 5);
      const sectors = Math.ceil(body.length / 4096);
      const padded = Buffer.alloc(sectors * 4096);
      body.copy(padded);
      const idx = 4 * ((c.cx & 31) + (c.cz & 31) * 32);
      header.writeUIntBE(sector, idx, 3);
      header[idx + 3] = sectors;
      parts.push(padded);
      sector += sectors;
    }
    await fs.writeFile(path.join(regionDir, `r.${k}.mca`), Buffer.concat(parts));
  }
}
```

`test/world/dimension.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWorld, resolveRegionDir, regionDirCandidates } from '../../src/world/dimension.js';

describe('resolveWorld', () => {
  it('maps aliases', () => {
    expect(resolveWorld(undefined, 'world')).toEqual({ label: 'overworld', dimension: 'minecraft:overworld', bukkitName: 'world' });
    expect(resolveWorld('nether', 'world')).toEqual({ label: 'nether', dimension: 'minecraft:the_nether', bukkitName: 'world_nether' });
    expect(resolveWorld('minecraft:the_end', 'matsuri')).toEqual({ label: 'end', dimension: 'minecraft:the_end', bukkitName: 'matsuri_the_end' });
    expect(resolveWorld('matsuri_nether', 'matsuri').label).toBe('nether');
    expect(() => resolveWorld('moon', 'world')).toThrow(/Unknown world "moon"/);
  });
});

describe('region directories', () => {
  it('prefers the 26.x layout and falls back to legacy', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
    const modern = path.join(dir, 'world', 'dimensions', 'minecraft', 'the_nether', 'region');
    const legacy = path.join(dir, 'world_nether', 'DIM-1', 'region');
    expect(regionDirCandidates(dir, 'world', 'nether')).toEqual([modern, legacy]);
    expect(resolveRegionDir(dir, 'world', 'nether')).toBeUndefined();
    await mkdir(legacy, { recursive: true });
    expect(resolveRegionDir(dir, 'world', 'nether')).toBe(legacy);
    await mkdir(modern, { recursive: true });
    expect(resolveRegionDir(dir, 'world', 'nether')).toBe(modern);
    expect(regionDirCandidates(dir, 'world', 'overworld')[1]).toBe(path.join(dir, 'world', 'region'));
    expect(regionDirCandidates(dir, 'world', 'end')[1]).toBe(path.join(dir, 'world_the_end', 'DIM1', 'region'));
  });
});
```

`test/world/anvil.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { T } from '../../src/nbt/nbt.js';
import { readChunk, chunkBlock, chunkSurface, readVoxels, readHeightmap, packLongs, unpackLongs } from '../../src/world/anvil.js';
import { writeRegionFiles } from '../helpers/anvil-fixture.js';

let regionDir: string;
beforeAll(async () => {
  regionDir = path.join(await mkdtemp(path.join(tmpdir(), 'bw-')), 'region');
  const blocks = [] as Array<{ x: number; y: number; z: number; state: string }>;
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y <= 62; y++) blocks.push({ x, y, z, state: 'minecraft:stone' });
  blocks.push({ x: 5, y: 63, z: 7, state: 'minecraft:grass_block[snowy=false]' });
  blocks.push({ x: 5, y: 64, z: 7, state: 'minecraft:oak_sign[rotation=8]' });
  await writeRegionFiles(regionDir, [
    { cx: 0, cz: 0, blocks, blockEntities: [{ id: T.string('minecraft:sign'), x: T.int(5), y: T.int(64), z: T.int(7), keepPacked: T.byte(0), front_text: T.comp({}) }] },
    { cx: -10, cz: 11, blocks: [{ x: 3, y: 10, z: 3, state: 'minecraft:dirt' }] },
  ]);
});

describe('packing', () => {
  it('packs and unpacks without straddling longs', () => {
    const values = Array.from({ length: 4096 }, (_, i) => i % 17);
    const packed = packLongs(values, 5);
    expect(packed.length).toBe(Math.ceil(4096 / 12));
    expect(unpackLongs(packed.map((v) => [Number(v >> 32n), Number(v & 0xffffffffn)]), 5, 4096)).toEqual(values);
  });
});

describe('readChunk', () => {
  it('decodes blocks, heightmap and block entities', async () => {
    const chunk = (await readChunk(regionDir, 0, 0))!;
    expect(chunk.minY).toBe(-64);
    expect(chunkBlock(chunk, 5, 63, 7).toString()).toBe('minecraft:grass_block[snowy=false]');
    expect(chunkBlock(chunk, 0, 48, 0).toCommand()).toBe('stone');
    expect(chunkBlock(chunk, 0, 63, 0).isAir).toBe(true);
    expect(chunkBlock(chunk, 0, 300, 0).isAir).toBe(true);
    expect(chunkSurface(chunk, 5, 7)).toBe(64);
    expect(chunkSurface(chunk, 0, 0)).toBe(62);
    expect(chunk.blockEntities).toEqual([{ pos: [5, 64, 7], id: 'minecraft:sign', data: { front_text: T.comp({}) } }]);
  });
  it('returns undefined for a missing chunk and reads negative coordinates', async () => {
    expect(await readChunk(regionDir, 3, 3)).toBeUndefined();
    const far = (await readChunk(regionDir, -10, 11))!;
    expect(chunkBlock(far, -160 + 3, 10, 176 + 3).toCommand()).toBe('dirt');
    expect(chunkSurface(far, -160 + 3, 176 + 3)).toBe(10);
    expect(chunkSurface(far, -160, 176)).toBe(-65);
  });
});

describe('readVoxels / readHeightmap', () => {
  it('reads a box across chunks and counts missing chunks', async () => {
    const r = await readVoxels(regionDir, { min: [4, 62, 6], max: [17, 64, 8] });
    expect(r.voxels.get(5, 63, 7)?.toCommand()).toBe('grass_block[snowy=false]');
    expect(r.voxels.get(4, 62, 6)?.toCommand()).toBe('stone');
    expect(r.voxels.get(17, 62, 6)).toBeUndefined();
    expect(r.missingChunks).toBe(1);
    expect(r.blockEntities).toHaveLength(1);
    const h = await readHeightmap(regionDir, 4, 6, 6, 8);
    expect(h.heights[1][1]).toBe(64);
    expect(h.heights[0][0]).toBe(62);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/world`
Expected: FAIL, cannot find modules

- [ ] **Step 3: Implement dimension.ts**

`src/world/dimension.ts`:
```ts
import { existsSync } from 'node:fs';
import path from 'node:path';

export type Dimension = 'minecraft:overworld' | 'minecraft:the_nether' | 'minecraft:the_end';
export type WorldLabel = 'overworld' | 'nether' | 'end';

export interface WorldRef {
  label: WorldLabel;
  dimension: Dimension;
  /** Bukkit world folder/name, e.g. world, world_nether, world_the_end. */
  bukkitName: string;
}

const DIM: Record<WorldLabel, Dimension> = { overworld: 'minecraft:overworld', nether: 'minecraft:the_nether', end: 'minecraft:the_end' };

export function resolveWorld(input: string | undefined, levelName: string): WorldRef {
  const s = (input ?? 'overworld').trim().toLowerCase();
  const aliases: Record<string, WorldLabel> = {
    overworld: 'overworld', world: 'overworld', 'minecraft:overworld': 'overworld', [levelName.toLowerCase()]: 'overworld',
    nether: 'nether', the_nether: 'nether', 'minecraft:the_nether': 'nether', world_nether: 'nether', [`${levelName.toLowerCase()}_nether`]: 'nether',
    end: 'end', the_end: 'end', 'minecraft:the_end': 'end', world_the_end: 'end', [`${levelName.toLowerCase()}_the_end`]: 'end',
  };
  const label = aliases[s];
  if (!label) throw new Error(`Unknown world "${input}". Use overworld, nether or end.`);
  const bukkitName = label === 'overworld' ? levelName : label === 'nether' ? `${levelName}_nether` : `${levelName}_the_end`;
  return { label, dimension: DIM[label], bukkitName };
}

/** [26.x layout, legacy Bukkit layout] */
export function regionDirCandidates(serverDir: string, levelName: string, label: WorldLabel): string[] {
  const dimFolder = label === 'overworld' ? 'overworld' : label === 'nether' ? 'the_nether' : 'the_end';
  const modern = path.join(serverDir, levelName, 'dimensions', 'minecraft', dimFolder, 'region');
  const legacy =
    label === 'overworld'
      ? path.join(serverDir, levelName, 'region')
      : label === 'nether'
        ? path.join(serverDir, `${levelName}_nether`, 'DIM-1', 'region')
        : path.join(serverDir, `${levelName}_the_end`, 'DIM1', 'region');
  return [modern, legacy];
}

export function resolveRegionDir(serverDir: string, levelName: string, label: WorldLabel): string | undefined {
  return regionDirCandidates(serverDir, levelName, label).find((d) => existsSync(d));
}
```

- [ ] **Step 4: Implement anvil.ts**

`src/world/anvil.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateSync, gunzipSync } from 'node:zlib';
import { BlockState, VoxelSet, type Box, type Vec3 } from '../voxel/voxels.js';
import { parseNbt, num, str, compound, listOf, longPairs, longPairToBigInt, omitKeys, type CompoundValue } from '../nbt/nbt.js';
import type { BlockEntity } from '../schematic/clipboard.js';

const AIR = BlockState.parse('air');

export interface Section {
  y: number;
  palette: BlockState[];
  /** 4096 palette indices ordered (y<<8)|(z<<4)|x, or undefined when the section is all palette[0]. */
  indices: Uint16Array | undefined;
}

export interface ChunkData {
  cx: number;
  cz: number;
  minY: number;
  sections: Map<number, Section>;
  heightmaps: Map<string, number[]>;
  blockEntities: BlockEntity[];
  dataVersion: number;
}

/** Unpack Minecraft's non-straddling packed longs. */
export function unpackLongs(longs: [number, number][], bits: number, count: number): number[] {
  const per = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const out: number[] = [];
  for (const pair of longs) {
    const v = longPairToBigInt(pair);
    for (let k = 0; k < per && out.length < count; k++) out.push(Number((v >> BigInt(bits * k)) & mask));
    if (out.length >= count) break;
  }
  while (out.length < count) out.push(0);
  return out;
}

export function packLongs(values: number[], bits: number): bigint[] {
  const per = Math.floor(64 / bits);
  const out: bigint[] = [];
  for (let i = 0; i < values.length; i += per) {
    let v = 0n;
    for (let k = 0; k < per && i + k < values.length; k++) v |= BigInt(values[i + k]) << BigInt(bits * k);
    out.push(v);
  }
  return out;
}

function stateFromPalette(entry: CompoundValue): BlockState {
  const props: Record<string, string> = {};
  const p = compound(entry, 'Properties');
  if (p) for (const [k, v] of Object.entries(p)) props[k] = String(v.value);
  return new BlockState(str(entry, 'Name'), props);
}

export function decodeSection(sec: CompoundValue): Section {
  const y = num(sec, 'Y');
  const bs = compound(sec, 'block_states');
  if (!bs) return { y, palette: [AIR], indices: undefined };
  const palette = (listOf(bs, 'palette') as CompoundValue[]).map(stateFromPalette);
  if (palette.length === 0) return { y, palette: [AIR], indices: undefined };
  const data = longPairs(bs, 'data');
  if (palette.length === 1 || data.length === 0) return { y, palette, indices: undefined };
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
  return { y, palette, indices: Uint16Array.from(unpackLongs(data, bits, 4096)) };
}

export async function readChunk(regionDir: string, cx: number, cz: number): Promise<ChunkData | undefined> {
  const file = path.join(regionDir, `r.${cx >> 5}.${cz >> 5}.mca`);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const head = Buffer.alloc(4);
    const idx = 4 * ((cx & 31) + (cz & 31) * 32);
    const r = await handle.read(head, 0, 4, idx);
    if (r.bytesRead < 4) return undefined;
    const offset = head.readUIntBE(0, 3) * 4096;
    if (offset === 0 || head[3] === 0) return undefined;
    const lenBuf = Buffer.alloc(5);
    await handle.read(lenBuf, 0, 5, offset);
    const length = lenBuf.readInt32BE(0);
    const compression = lenBuf[4];
    if (compression & 0x80) throw new Error(`chunk ${cx},${cz}: external .mcc chunk files are not supported`);
    const raw = Buffer.alloc(length - 1);
    await handle.read(raw, 0, length - 1, offset + 5);
    const nbtBuf = compression === 2 ? inflateSync(raw) : compression === 1 ? gunzipSync(raw) : compression === 3 ? raw : undefined;
    if (!nbtBuf) throw new Error(`chunk ${cx},${cz}: unknown compression ${compression}`);
    const root = (await parseNbt(nbtBuf)).value as CompoundValue;
    const sections = new Map<number, Section>();
    for (const sec of listOf(root, 'sections') as CompoundValue[]) {
      const s = decodeSection(sec);
      sections.set(s.y, s);
    }
    const heightmaps = new Map<string, number[]>();
    const hm = compound(root, 'Heightmaps');
    if (hm) for (const k of Object.keys(hm)) heightmaps.set(k, unpackLongs(longPairs(hm, k), 9, 256));
    const blockEntities: BlockEntity[] = (listOf(root, 'block_entities') as CompoundValue[]).map((be) => ({
      pos: [num(be, 'x'), num(be, 'y'), num(be, 'z')],
      id: str(be, 'id', 'unknown'),
      data: omitKeys(be, ['id', 'x', 'y', 'z', 'keepPacked']),
    }));
    return { cx, cz, minY: num(root, 'yPos', -4) * 16, sections, heightmaps, blockEntities, dataVersion: num(root, 'DataVersion', 0) };
  } finally {
    await handle.close();
  }
}

export function chunkBlock(chunk: ChunkData, x: number, y: number, z: number): BlockState {
  const sec = chunk.sections.get(y >> 4);
  if (!sec) return AIR;
  if (!sec.indices) return sec.palette[0];
  return sec.palette[sec.indices[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]] ?? AIR;
}

/** Highest block y in the column per the given heightmap, or minY−1 when the column is empty. */
export function chunkSurface(chunk: ChunkData, x: number, z: number, type = 'MOTION_BLOCKING'): number {
  const hm = chunk.heightmaps.get(type);
  if (!hm) return chunk.minY - 1;
  const v = hm[((z & 15) << 4) | (x & 15)];
  return v + chunk.minY - 1;
}

async function chunksFor(regionDir: string, minX: number, minZ: number, maxX: number, maxZ: number): Promise<{ chunks: Map<string, ChunkData>; missing: number }> {
  const chunks = new Map<string, ChunkData>();
  let missing = 0;
  for (let cx = minX >> 4; cx <= maxX >> 4; cx++) {
    for (let cz = minZ >> 4; cz <= maxZ >> 4; cz++) {
      const c = await readChunk(regionDir, cx, cz);
      if (c) chunks.set(`${cx},${cz}`, c);
      else missing++;
    }
  }
  return { chunks, missing };
}

export async function readVoxels(regionDir: string, box: Box): Promise<{ voxels: VoxelSet; blockEntities: BlockEntity[]; missingChunks: number }> {
  const { chunks, missing } = await chunksFor(regionDir, box.min[0], box.min[2], box.max[0], box.max[2]);
  const voxels = new VoxelSet();
  const blockEntities: BlockEntity[] = [];
  for (const c of chunks.values()) {
    const x0 = Math.max(box.min[0], c.cx * 16);
    const x1 = Math.min(box.max[0], c.cx * 16 + 15);
    const z0 = Math.max(box.min[2], c.cz * 16);
    const z1 = Math.min(box.max[2], c.cz * 16 + 15);
    for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) voxels.set(x, y, z, chunkBlock(c, x, y, z));
    for (const be of c.blockEntities) {
      const p = be.pos;
      if (p[0] >= box.min[0] && p[0] <= box.max[0] && p[1] >= box.min[1] && p[1] <= box.max[1] && p[2] >= box.min[2] && p[2] <= box.max[2]) blockEntities.push(be);
    }
  }
  return { voxels, blockEntities, missingChunks: missing };
}

/** heights[z - minZ][x - minX]; null where the chunk is missing. */
export async function readHeightmap(regionDir: string, minX: number, minZ: number, maxX: number, maxZ: number, type = 'MOTION_BLOCKING'): Promise<{ heights: (number | null)[][]; missingChunks: number; chunks: Map<string, ChunkData> }> {
  const { chunks, missing } = await chunksFor(regionDir, minX, minZ, maxX, maxZ);
  const heights: (number | null)[][] = [];
  for (let z = minZ; z <= maxZ; z++) {
    const row: (number | null)[] = [];
    for (let x = minX; x <= maxX; x++) {
      const c = chunks.get(`${x >> 4},${z >> 4}`);
      row.push(c ? chunkSurface(c, x, z, type) : null);
    }
    heights.push(row);
  }
  return { heights, missingChunks: missing, chunks };
}

export function surfaceBlock(chunks: Map<string, ChunkData>, x: number, z: number, y: number): BlockState {
  const c = chunks.get(`${x >> 4},${z >> 4}`);
  return c ? chunkBlock(c, x, y, z) : AIR;
}

export type { Vec3 };
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/world`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/world test/world test/helpers/anvil-fixture.ts
git commit -m "feat(world): dimension mapping and Anvil region reader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 10: Configuration

**Goal:** Load configuration from environment variables, `server.properties` and `level.dat`, with sane defaults and a masked description for `server_info`.

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Acceptance Criteria:**
- [ ] With only `BLOCKWRIGHT_SERVER_DIR` set, RCON port and password come from `server.properties`, `levelName` from `level-name`, and `dataVersion`/`mcVersion` from `level.dat`
- [ ] Env vars override file values; missing password throws a clear error
- [ ] `BLOCKWRIGHT_BOUNDS=1,2,3,10,20,30` becomes a normalized box; malformed bounds throw
- [ ] `describeConfig` never contains the password

**Verify:** `npx vitest run test/config.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, parseProperties, parseBounds, describeConfig } from '../../src/config.js';
import { T, writeNbtGz } from '../../src/nbt/nbt.js';

async function fakeServer(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bw-srv-'));
  await writeFile(path.join(dir, 'server.properties'), '#comment\nrcon.port=25599\nrcon.password=pw123\nlevel-name=matsuri\nenable-rcon=true\n');
  await mkdir(path.join(dir, 'matsuri'), { recursive: true });
  const level = T.comp({ Data: T.comp({ DataVersion: T.int(4903), Version: T.comp({ Name: T.string('26.2'), Id: T.int(4903) }) }) }, '');
  await writeFile(path.join(dir, 'matsuri', 'level.dat'), writeNbtGz(level));
  await mkdir(path.join(dir, 'plugins', 'WorldEdit', 'schematics'), { recursive: true });
  return dir;
}

describe('parsers', () => {
  it('parses properties and bounds', () => {
    expect(parseProperties('a=1\n# c\nb = two\n')).toEqual({ a: '1', b: 'two' });
    expect(parseBounds('10,2,30,1,20,3')).toEqual({ min: [1, 2, 3], max: [10, 20, 30] });
    expect(() => parseBounds('1,2,3')).toThrow(/BLOCKWRIGHT_BOUNDS/);
  });
});

describe('loadConfig', () => {
  it('reads the server folder', async () => {
    const dir = await fakeServer();
    const c = await loadConfig({ BLOCKWRIGHT_SERVER_DIR: dir });
    expect(c.rcon).toEqual({ host: '127.0.0.1', port: 25599, password: 'pw123' });
    expect(c.levelName).toBe('matsuri');
    expect(c.dataVersion).toBe(4903);
    expect(c.mcVersion).toBe('26.2');
    expect(c.schematicDir).toBe(path.join(dir, 'plugins', 'WorldEdit', 'schematics'));
    expect(c.fillLimit).toBe(32768);
    expect(c.structureThreshold).toBe(400);
    expect(c.templateMax).toBe(48);
    expect(c.allowAdmin).toBe(false);
    expect(JSON.stringify(describeConfig(c))).not.toContain('pw123');
  });
  it('lets env override files and validates', async () => {
    const dir = await fakeServer();
    const c = await loadConfig({
      BLOCKWRIGHT_SERVER_DIR: dir,
      BLOCKWRIGHT_RCON_PASSWORD: 'override',
      BLOCKWRIGHT_RCON_PORT: '1234',
      BLOCKWRIGHT_BOUNDS: '0,0,0,100,100,100',
      BLOCKWRIGHT_FILL_LIMIT: '1000',
      BLOCKWRIGHT_ALLOW_ADMIN: '1',
      BLOCKWRIGHT_SCHEMATIC_DIR: '/tmp/schems',
    });
    expect(c.rcon.password).toBe('override');
    expect(c.rcon.port).toBe(1234);
    expect(c.bounds).toEqual({ min: [0, 0, 0], max: [100, 100, 100] });
    expect(c.fillLimit).toBe(1000);
    expect(c.allowAdmin).toBe(true);
    expect(c.schematicDir).toBe('/tmp/schems');
  });
  it('works without a server dir and requires a password', async () => {
    const c = await loadConfig({ BLOCKWRIGHT_RCON_PASSWORD: 'x' });
    expect(c.serverDir).toBeUndefined();
    expect(c.levelName).toBe('world');
    expect(c.dataVersion).toBe(4903);
    await expect(loadConfig({})).rejects.toThrow(/RCON password/);
    await expect(loadConfig({ BLOCKWRIGHT_SERVER_DIR: '/nonexistent/dir' })).rejects.toThrow(/BLOCKWRIGHT_SERVER_DIR/);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement config.ts**

`src/config.ts`:
```ts
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseNbt, compound, num, str, type CompoundValue } from './nbt/nbt.js';
import { box, type Box } from './voxel/voxels.js';

/** Minecraft 26.2. Overridden by level.dat or BLOCKWRIGHT_DATA_VERSION. */
export const DEFAULT_DATA_VERSION = 4903;
export const DEFAULT_MC_VERSION = '26.2';

export interface Config {
  rcon: { host: string; port: number; password: string };
  serverDir?: string;
  levelName: string;
  pluginUrl: string;
  pluginToken?: string;
  bounds?: Box;
  fillLimit: number;
  structureThreshold: number;
  templateMax: number;
  schematicDir: string;
  previewDir: string;
  dataVersion: number;
  mcVersion: string;
  allowAdmin: boolean;
  bluemapUrl?: string;
  /** Skip save-all before a read when nothing was written and the last save is younger than this. */
  saveCoalesceMs: number;
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const eq = t.indexOf('=');
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

export function parseBounds(text: string): Box {
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 6 || parts.some((n) => !Number.isInteger(n))) throw new Error(`BLOCKWRIGHT_BOUNDS must be "x1,y1,z1,x2,y2,z2", got "${text}"`);
  return box([parts[0], parts[1], parts[2]], [parts[3], parts[4], parts[5]]);
}

export async function readLevelVersion(levelDat: string): Promise<{ dataVersion: number; name: string } | undefined> {
  try {
    const root = (await parseNbt(await fs.readFile(levelDat))).value as CompoundValue;
    const data = compound(root, 'Data');
    if (!data) return undefined;
    const version = compound(data, 'Version');
    return { dataVersion: num(data, 'DataVersion', DEFAULT_DATA_VERSION), name: version ? str(version, 'Name', DEFAULT_MC_VERSION) : DEFAULT_MC_VERSION };
  } catch {
    return undefined;
  }
}

function intEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${v}"`);
  return n;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let serverDir: string | undefined;
  let props: Record<string, string> = {};
  if (env.BLOCKWRIGHT_SERVER_DIR) {
    serverDir = path.resolve(env.BLOCKWRIGHT_SERVER_DIR);
    if (!existsSync(serverDir)) throw new Error(`BLOCKWRIGHT_SERVER_DIR does not exist: ${serverDir}`);
    const propsPath = path.join(serverDir, 'server.properties');
    if (existsSync(propsPath)) props = parseProperties(await fs.readFile(propsPath, 'utf8'));
  }
  const password = env.BLOCKWRIGHT_RCON_PASSWORD ?? props['rcon.password'] ?? '';
  if (!password) throw new Error('RCON password not configured: set BLOCKWRIGHT_RCON_PASSWORD or BLOCKWRIGHT_SERVER_DIR (reads server.properties)');
  const levelName = env.BLOCKWRIGHT_WORLD ?? props['level-name'] ?? 'world';
  let dataVersion = DEFAULT_DATA_VERSION;
  let mcVersion = DEFAULT_MC_VERSION;
  if (serverDir) {
    const lv = await readLevelVersion(path.join(serverDir, levelName, 'level.dat'));
    if (lv) {
      dataVersion = lv.dataVersion;
      mcVersion = lv.name;
    }
  }
  if (env.BLOCKWRIGHT_DATA_VERSION) dataVersion = intEnv(env, 'BLOCKWRIGHT_DATA_VERSION', dataVersion);
  if (env.BLOCKWRIGHT_MC_VERSION) mcVersion = env.BLOCKWRIGHT_MC_VERSION;
  const weDir = serverDir ? path.join(serverDir, 'plugins', 'WorldEdit', 'schematics') : undefined;
  const schematicDir = env.BLOCKWRIGHT_SCHEMATIC_DIR ?? (weDir && existsSync(weDir) ? weDir : process.cwd());
  return {
    rcon: { host: env.BLOCKWRIGHT_RCON_HOST ?? '127.0.0.1', port: intEnv(env, 'BLOCKWRIGHT_RCON_PORT', Number(props['rcon.port'] ?? 25575)), password },
    serverDir,
    levelName,
    pluginUrl: env.BLOCKWRIGHT_PLUGIN_URL ?? 'http://127.0.0.1:25580',
    pluginToken: env.BLOCKWRIGHT_PLUGIN_TOKEN,
    bounds: env.BLOCKWRIGHT_BOUNDS ? parseBounds(env.BLOCKWRIGHT_BOUNDS) : undefined,
    fillLimit: intEnv(env, 'BLOCKWRIGHT_FILL_LIMIT', 32768),
    structureThreshold: intEnv(env, 'BLOCKWRIGHT_STRUCTURE_THRESHOLD', 400),
    templateMax: intEnv(env, 'BLOCKWRIGHT_TEMPLATE_MAX', 48),
    schematicDir,
    previewDir: env.BLOCKWRIGHT_PREVIEW_DIR ?? path.join(os.homedir(), '.cache', 'blockwright', 'previews'),
    dataVersion,
    mcVersion,
    allowAdmin: env.BLOCKWRIGHT_ALLOW_ADMIN === '1' || env.BLOCKWRIGHT_ALLOW_ADMIN === 'true',
    bluemapUrl: env.BLOCKWRIGHT_BLUEMAP_URL,
    saveCoalesceMs: intEnv(env, 'BLOCKWRIGHT_SAVE_COALESCE_MS', 30000),
  };
}

export function describeConfig(c: Config): Record<string, unknown> {
  return {
    rcon: { host: c.rcon.host, port: c.rcon.port, password: '***' },
    serverDir: c.serverDir ?? null,
    levelName: c.levelName,
    bounds: c.bounds ?? null,
    fillLimit: c.fillLimit,
    structureThreshold: c.structureThreshold,
    templateMax: c.templateMax,
    schematicDir: c.schematicDir,
    previewDir: c.previewDir,
    dataVersion: c.dataVersion,
    mcVersion: c.mcVersion,
    allowAdmin: c.allowAdmin,
    bluemapUrl: c.bluemapUrl ?? null,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: configuration from env, server.properties and level.dat

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Block registry and colors

**Goal:** Validate block names and properties against `minecraft-data`, and give every block a preview color.

**Files:**
- Create: `src/blocks/registry.ts`, `src/blocks/colors.ts`
- Test: `test/blocks/registry.test.ts`, `test/blocks/colors.test.ts`

**Acceptance Criteria:**
- [ ] `validateState` accepts `oak_stairs[facing=north,half=top]`, rejects `stoen` (unknown block), `oak_stairs[facing=up]` (bad enum), `oak_stairs[color=red]` (unknown property), and ignores non-`minecraft:` namespaces
- [ ] `validateSet` returns one issue per distinct bad state and `suggestBlocks('stoen')` includes `stone`
- [ ] `blockColor` returns the table color for `stone`, a red for `red_wool`, an oak tint for `oak_stairs`, alpha < 1 for glass, and a stable hashed color for unknown names

**Verify:** `npx vitest run test/blocks` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/blocks/registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { validateState, validateSet, suggestBlocks } from '../../src/blocks/registry.js';

const st = (s: string) => BlockState.parse(s);

describe('validateState', () => {
  it('accepts valid states', () => {
    expect(validateState(st('stone'))).toBeUndefined();
    expect(validateState(st('oak_stairs[facing=north,half=top]'))).toBeUndefined();
    expect(validateState(st('oak_sign[rotation=13]'))).toBeUndefined();
    expect(validateState(st('create:brass_block'))).toBeUndefined();
  });
  it('rejects bad names, properties and values', () => {
    expect(validateState(st('stoen'))?.message).toMatch(/unknown block "stoen"/);
    expect(validateState(st('oak_stairs[facing=up]'))?.message).toMatch(/facing.*north/);
    expect(validateState(st('oak_stairs[color=red]'))?.message).toMatch(/no property "color"/);
    expect(validateState(st('oak_stairs[waterlogged=maybe]'))?.message).toMatch(/true or false/);
  });
  it('validates a set and suggests names', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('stoen'));
    v.set(1, 0, 0, st('stoen'));
    v.set(2, 0, 0, st('dirt'));
    expect(validateSet(v)).toHaveLength(1);
    expect(suggestBlocks('stoen')).toContain('stone');
    expect(suggestBlocks('oak_plank')).toContain('oak_planks');
  });
});
```

`test/blocks/colors.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState } from '../../src/voxel/voxels.js';
import { blockColor, cssColor } from '../../src/blocks/colors.js';

const st = (s: string) => BlockState.parse(s);

describe('blockColor', () => {
  it('uses the table, colour words and material keywords', () => {
    expect(blockColor(st('stone'))).toEqual({ r: 125, g: 125, b: 125, a: 1 });
    const red = blockColor(st('red_wool'));
    expect(red.r).toBeGreaterThan(red.g + 50);
    const oak = blockColor(st('oak_stairs[facing=north]'));
    expect(oak).toEqual(blockColor(st('oak_planks')));
    expect(blockColor(st('glass')).a).toBeLessThan(1);
    expect(blockColor(st('air')).a).toBe(0);
  });
  it('hashes unknown names deterministically', () => {
    const a = blockColor(st('mod:weird_block'));
    expect(a).toEqual(blockColor(st('mod:weird_block')));
    expect(a).not.toEqual(blockColor(st('mod:other_block')));
    expect(cssColor(a)).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/blocks`
Expected: FAIL, cannot find modules

- [ ] **Step 3: Implement registry.ts**

`src/blocks/registry.ts`:
```ts
import minecraftData from 'minecraft-data';
import type { BlockState, VoxelSet } from '../voxel/voxels.js';

/** Newest pc version shipped by minecraft-data at plan time. 26.2 adds no block renames that matter for validation. */
export const REGISTRY_MC_VERSION = '26.1';

type Registry = ReturnType<typeof minecraftData>;
let cached: Registry | undefined;
function registry(): Registry {
  cached ??= minecraftData(REGISTRY_MC_VERSION);
  return cached;
}

export interface ValidationIssue {
  block: string;
  message: string;
}

export function validateState(state: BlockState): ValidationIssue | undefined {
  if (!state.name.startsWith('minecraft:')) return undefined;
  const short = state.shortName;
  const def = registry().blocksByName[short];
  if (!def) return { block: state.toString(), message: `unknown block "${short}"${hint(short)}` };
  const props = def.states ?? [];
  for (const [k, v] of Object.entries(state.props)) {
    const p = props.find((s) => s.name === k);
    if (!p) return { block: state.toString(), message: `block "${short}" has no property "${k}" (has: ${props.map((s) => s.name).join(', ') || 'none'})` };
    if (p.type === 'bool' && v !== 'true' && v !== 'false') return { block: state.toString(), message: `property "${k}" of "${short}" must be true or false` };
    if ((p.type === 'enum' || p.type === 'direction') && p.values && !p.values.map(String).includes(v))
      return { block: state.toString(), message: `property "${k}" of "${short}" must be one of ${p.values.join(', ')}` };
    if (p.type === 'int' && !/^-?\d+$/.test(v)) return { block: state.toString(), message: `property "${k}" of "${short}" must be an integer` };
  }
  return undefined;
}

function hint(name: string): string {
  const s = suggestBlocks(name);
  return s.length ? ` (did you mean ${s.slice(0, 3).join(', ')}?)` : '';
}

/** One issue per distinct invalid state. */
export function validateSet(set: VoxelSet): ValidationIssue[] {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const [, s] of set.entries()) {
    const k = s.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    const issue = validateState(s);
    if (issue) issues.push(issue);
  }
  return issues;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Closest block names by edit distance, then substring matches. */
export function suggestBlocks(name: string, limit = 5): string[] {
  const names = Object.keys(registry().blocksByName);
  const scored = names.map((n) => ({ n, d: editDistance(name, n) })).filter((x) => x.d <= Math.max(2, Math.floor(name.length / 3)));
  scored.sort((a, b) => a.d - b.d || a.n.localeCompare(b.n));
  const out = scored.map((x) => x.n);
  for (const n of names) if (out.length < limit && !out.includes(n) && n.includes(name)) out.push(n);
  return out.slice(0, limit);
}
```

- [ ] **Step 4: Implement colors.ts**

`src/blocks/colors.ts`:
```ts
import type { BlockState } from '../voxel/voxels.js';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

type Rgb = [number, number, number];

const TABLE: Record<string, Rgb> = {
  stone: [125, 125, 125], cobblestone: [110, 110, 110], stone_bricks: [122, 122, 122], mossy_cobblestone: [95, 110, 85],
  mossy_stone_bricks: [105, 118, 95], smooth_stone: [160, 160, 160], andesite: [136, 136, 136], diorite: [188, 188, 188],
  granite: [150, 105, 90], deepslate: [80, 80, 82], cobbled_deepslate: [77, 77, 80], deepslate_bricks: [70, 70, 72],
  deepslate_tiles: [60, 60, 62], tuff: [110, 112, 100], calcite: [223, 224, 220], dripstone_block: [134, 107, 92],
  dirt: [134, 96, 67], coarse_dirt: [119, 85, 59], rooted_dirt: [144, 103, 76], grass_block: [95, 159, 53], podzol: [92, 63, 24],
  mud: [60, 57, 60], mud_bricks: [137, 103, 79], mycelium: [111, 99, 105], farmland: [110, 78, 52], dirt_path: [148, 121, 65],
  sand: [219, 207, 163], red_sand: [190, 102, 33], sandstone: [216, 203, 155], smooth_sandstone: [220, 208, 160],
  cut_sandstone: [214, 200, 150], red_sandstone: [186, 99, 30], gravel: [131, 127, 126], clay: [160, 166, 179],
  terracotta: [152, 94, 67], bricks: [150, 97, 83], nether_bricks: [44, 22, 26], red_nether_bricks: [110, 20, 20],
  netherrack: [111, 54, 52], soul_sand: [81, 62, 50], soul_soil: [75, 57, 46], basalt: [80, 81, 86], smooth_basalt: [72, 72, 78],
  blackstone: [42, 36, 41], polished_blackstone: [53, 48, 56], polished_blackstone_bricks: [48, 43, 50], obsidian: [15, 10, 24],
  crying_obsidian: [32, 10, 60], end_stone: [219, 222, 158], end_stone_bricks: [218, 224, 162], purpur_block: [169, 125, 169],
  quartz_block: [235, 229, 222], smooth_quartz: [236, 230, 223], quartz_bricks: [233, 227, 219], prismarine: [99, 156, 151],
  prismarine_bricks: [99, 171, 158], dark_prismarine: [51, 91, 75], sea_lantern: [172, 199, 190], glowstone: [171, 131, 84],
  shroomlight: [240, 146, 70], magma_block: [140, 60, 30], bedrock: [85, 85, 85], water: [63, 118, 228], lava: [207, 92, 21],
  ice: [145, 183, 253], packed_ice: [141, 180, 250], blue_ice: [116, 167, 253], snow: [249, 254, 254], snow_block: [249, 254, 254],
  powder_snow: [248, 253, 253], oak_planks: [162, 130, 78], spruce_planks: [114, 84, 48], birch_planks: [192, 175, 121],
  jungle_planks: [160, 115, 80], acacia_planks: [168, 90, 50], dark_oak_planks: [66, 43, 20], mangrove_planks: [117, 54, 48],
  cherry_planks: [227, 178, 172], bamboo_planks: [193, 173, 80], crimson_planks: [101, 48, 70], warped_planks: [43, 104, 99],
  pale_oak_planks: [227, 220, 210], oak_log: [109, 85, 50], spruce_log: [58, 37, 16], birch_log: [216, 215, 210],
  jungle_log: [85, 67, 25], acacia_log: [103, 96, 86], dark_oak_log: [52, 40, 24], mangrove_log: [83, 66, 41], cherry_log: [54, 33, 44],
  stripped_oak_log: [177, 144, 86], stripped_spruce_log: [116, 89, 52], stripped_birch_log: [196, 176, 118],
  stripped_dark_oak_log: [72, 56, 36], oak_leaves: [72, 128, 40], spruce_leaves: [50, 84, 50], birch_leaves: [100, 140, 70],
  jungle_leaves: [60, 130, 40], acacia_leaves: [90, 130, 50], dark_oak_leaves: [50, 100, 30], mangrove_leaves: [70, 115, 40],
  cherry_leaves: [235, 160, 190], azalea_leaves: [90, 130, 60], iron_block: [220, 220, 220], gold_block: [246, 208, 61],
  diamond_block: [98, 219, 214], emerald_block: [42, 203, 87], netherite_block: [66, 61, 63], copper_block: [192, 107, 79],
  exposed_copper: [161, 125, 103], weathered_copper: [108, 153, 110], oxidized_copper: [82, 162, 132], lapis_block: [30, 67, 140],
  redstone_block: [170, 24, 6], coal_block: [16, 15, 15], amethyst_block: [133, 97, 191], hay_block: [166, 136, 38],
  bookshelf: [117, 94, 58], crafting_table: [123, 90, 54], furnace: [110, 110, 110], chest: [160, 115, 55], barrel: [125, 95, 55],
  lantern: [230, 170, 90], soul_lantern: [110, 190, 200], torch: [255, 210, 120], campfire: [120, 80, 40], glass: [200, 235, 245],
  tinted_glass: [40, 35, 45], glass_pane: [200, 235, 245], pumpkin: [198, 118, 24], carved_pumpkin: [198, 118, 24],
  jack_o_lantern: [220, 140, 30], melon: [110, 160, 40], cactus: [80, 130, 40], bamboo: [95, 140, 40], moss_block: [89, 109, 45],
  moss_carpet: [89, 109, 45], sponge: [195, 192, 74], honey_block: [251, 185, 52], slime_block: [140, 210, 100], air: [0, 0, 0],
  cave_air: [0, 0, 0], void_air: [0, 0, 0], barrier: [255, 0, 0], structure_void: [0, 0, 0],
};

const COLOR_WORDS: Record<string, Rgb> = {
  white: [233, 236, 236], light_gray: [142, 142, 134], gray: [62, 68, 71], black: [20, 21, 25], brown: [114, 71, 40],
  red: [160, 39, 34], orange: [240, 118, 19], yellow: [248, 197, 39], lime: [112, 185, 25], green: [84, 109, 27],
  cyan: [21, 137, 145], light_blue: [58, 175, 217], blue: [53, 57, 157], purple: [121, 42, 172], magenta: [189, 68, 179],
  pink: [237, 141, 172],
};

const MATERIALS: Array<[RegExp, string]> = [
  [/^(stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_(?!leaves|log|wood)/, '$2_planks'],
  [/_leaves$/, 'oak_leaves'], [/_(log|wood)$/, 'oak_log'], [/deepslate/, 'deepslate'], [/blackstone/, 'blackstone'],
  [/nether_brick/, 'nether_bricks'], [/end_stone/, 'end_stone'], [/purpur/, 'purpur_block'], [/quartz/, 'quartz_block'],
  [/prismarine/, 'prismarine'], [/sandstone/, 'sandstone'], [/red_sand/, 'red_sand'], [/sand/, 'sand'], [/cobble/, 'cobblestone'],
  [/stone_brick/, 'stone_bricks'], [/brick/, 'bricks'], [/andesite/, 'andesite'], [/diorite/, 'diorite'], [/granite/, 'granite'],
  [/tuff/, 'tuff'], [/copper/, 'copper_block'], [/iron/, 'iron_block'], [/gold/, 'gold_block'], [/diamond/, 'diamond_block'],
  [/emerald/, 'emerald_block'], [/amethyst/, 'amethyst_block'], [/glass/, 'glass'], [/ice/, 'ice'], [/snow/, 'snow'],
  [/water|kelp|seagrass/, 'water'], [/lava|magma/, 'lava'], [/grass|fern|vine|moss|bush|leaf|sapling|azalea|lichen/, 'oak_leaves'],
  [/dirt|mud|soil/, 'dirt'], [/stone|calcite|dripstone/, 'stone'], [/lantern|torch|candle|glow/, 'lantern'],
  [/flower|tulip|poppy|dandelion|orchid|allium|petals|rose/, 'pink_petals_placeholder'],
];

function hashColor(name: string): Rgb {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const hue = h % 360;
  const s = 0.45;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbFor(short: string): Rgb {
  if (TABLE[short]) return TABLE[short];
  for (const word of Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length)) {
    if (short === word || short.startsWith(`${word}_`)) return COLOR_WORDS[word];
  }
  for (const [re, target] of MATERIALS) {
    const m = re.exec(short);
    if (!m) continue;
    if (target === 'pink_petals_placeholder') return [230, 120, 150];
    const key = target.replace('$2', m[2] ?? '');
    if (TABLE[key]) return TABLE[key];
  }
  return hashColor(short);
}

export function blockColor(state: BlockState): Rgba {
  const short = state.shortName;
  const [r, g, b] = state.name.startsWith('minecraft:') ? rgbFor(short) : hashColor(state.name);
  let a = 1;
  if (state.isAir || short === 'structure_void') a = 0;
  else if (/glass|ice$|water|barrier|pane|tinted/.test(short)) a = 0.55;
  return { r, g, b, a };
}

export function cssColor(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/blocks`
Expected: PASS (the first run loads minecraft-data and may take a few seconds)

- [ ] **Step 6: Commit**

```bash
git add src/blocks test/blocks
git commit -m "feat(blocks): validation against minecraft-data and preview colors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Previews (ASCII and HTML)

**Goal:** Render a `VoxelSet` as ASCII layer slices for the assistant and as a self-contained isometric HTML viewer for the user, with optional semi-transparent world context.

**Files:**
- Create: `src/preview/ascii.ts`, `src/preview/html.ts`
- Test: `test/preview/ascii.test.ts`, `test/preview/html.test.ts`

**Acceptance Criteria:**
- [ ] ASCII output has a legend ordered by count, a top-down view, and one slice per layer up to `maxLayers` with an "omitted" note beyond that
- [ ] HTML output is a single document with no external `http`/`https` references, embeds every voxel, names the palette, and includes rotate, zoom, layer and context controls
- [ ] Context voxels are embedded separately and rendered at reduced alpha

**Verify:** `npx vitest run test/preview` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/preview/ascii.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { renderAscii } from '../../src/preview/ascii.js';

const st = (s: string) => BlockState.parse(s);

function hut(): VoxelSet {
  const v = new VoxelSet();
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) v.set(x + 10, 60, z + 20, st('stone_bricks'));
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) if (x === 1 && z === 1) v.set(x + 10, 61, z + 20, st('air')); else v.set(x + 10, 61, z + 20, st('oak_planks'));
  v.set(11, 62, 21, st('torch'));
  return v;
}

describe('renderAscii', () => {
  it('renders legend, top-down view and layers', () => {
    const r = renderAscii(hut());
    expect(r.legend['#']).toBe('minecraft:stone_bricks');
    expect(r.legend['@']).toBe('minecraft:oak_planks');
    expect(r.text).toContain('Bounds: (10, 60, 20) to (12, 62, 22), size 3x3x3, 19 blocks (18 non-air)');
    expect(r.text).toContain('# stone_bricks (9)');
    expect(r.text).toContain('. air (1)');
    expect(r.text).toContain('Layer y=61 (+1):');
    expect(r.text).toMatch(/@@@\n\s*@\.@\n\s*@@@/);
    expect(r.text).toContain('Top-down');
  });
  it('caps layers', () => {
    const v = new VoxelSet();
    for (let y = 0; y < 30; y++) v.set(0, y, 0, st('stone'));
    const r = renderAscii(v, { maxLayers: 4 });
    expect((r.text.match(/Layer y=/g) ?? []).length).toBe(4);
    expect(r.text).toContain('26 more layers omitted');
  });
});
```

`test/preview/html.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { renderHtml } from '../../src/preview/html.js';

const st = (s: string) => BlockState.parse(s);

describe('renderHtml', () => {
  it('embeds voxels, palette and controls without external resources', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('stone'));
    v.set(1, 0, 0, st('oak_planks'));
    const ctx = new VoxelSet();
    ctx.set(0, -1, 0, st('grass_block'));
    const html = renderHtml(v, { title: 'Test hut', context: ctx });
    expect(html).toContain('<title>Test hut</title>');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('"minecraft:stone"');
    expect(html).toContain('"minecraft:oak_planks"');
    expect(html).toContain('"context":[[0,-1,0,');
    expect(html).toContain('id="rotate"');
    expect(html).toContain('id="zoom"');
    expect(html).toContain('id="layer"');
    expect(html).toContain('id="context"');
    expect(html).toContain('<canvas');
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/preview`
Expected: FAIL, cannot find modules

- [ ] **Step 3: Implement ascii.ts**

`src/preview/ascii.ts`:
```ts
import { VoxelSet, BlockState } from '../voxel/voxels.js';

export interface AsciiOptions {
  maxLayers?: number;
}

export interface AsciiResult {
  text: string;
  /** char → canonical state string */
  legend: Record<string, string>;
}

const CHARS = '#@%&*+=oxO^~$8ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwyz';

export function renderAscii(set: VoxelSet, opts: AsciiOptions = {}): AsciiResult {
  const maxLayers = opts.maxLayers ?? 12;
  const b = set.bounds();
  if (!b) return { text: '(empty)', legend: {} };
  const counts = [...set.counts().entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const charOf = new Map<string, string>();
  const legend: Record<string, string> = {};
  let next = 0;
  for (const [state] of counts) {
    const s = BlockState.parse(state);
    const ch = s.isAir ? '.' : next < CHARS.length ? CHARS[next++] : '?';
    charOf.set(state, ch);
    if (ch !== '?' || !legend['?']) legend[ch] = state;
  }
  const [w, h, l] = [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
  const lines: string[] = [];
  lines.push(`Bounds: (${b.min.join(', ')}) to (${b.max.join(', ')}), size ${w}x${h}x${l}, ${set.size} blocks (${set.nonAirCount()} non-air)`);
  lines.push('Legend: ' + counts.map(([state, n]) => `${charOf.get(state)} ${BlockState.parse(state).toCommand()} (${n})`).join(', ') + ', space = untouched');
  lines.push('');
  lines.push(`Top-down (north/−z at top, west/−x at left; highest non-air block per column). Columns x=${b.min[0]}..${b.max[0]}, rows z=${b.min[2]}..${b.max[2]}`);
  for (let z = b.min[2]; z <= b.max[2]; z++) {
    let row = '';
    for (let x = b.min[0]; x <= b.max[0]; x++) {
      let ch = ' ';
      for (let y = b.max[1]; y >= b.min[1]; y--) {
        const s = set.get(x, y, z);
        if (s && !s.isAir) {
          ch = charOf.get(s.toString()) ?? '?';
          break;
        }
      }
      row += ch;
    }
    lines.push(`  ${row}`);
  }
  lines.push('');
  const shown = Math.min(h, maxLayers);
  for (let i = 0; i < shown; i++) {
    const y = b.min[1] + i;
    lines.push(`Layer y=${y} (+${i}):`);
    for (let z = b.min[2]; z <= b.max[2]; z++) {
      let row = '';
      for (let x = b.min[0]; x <= b.max[0]; x++) {
        const s = set.get(x, y, z);
        row += s ? (charOf.get(s.toString()) ?? '?') : ' ';
      }
      lines.push(`  ${row}`);
    }
  }
  if (h > shown) lines.push(`(${h - shown} more layers omitted; raise maxLayers to see them)`);
  return { text: lines.join('\n'), legend };
}
```

- [ ] **Step 4: Implement html.ts**

`src/preview/html.ts`:
```ts
import { VoxelSet, BlockState } from '../voxel/voxels.js';
import { blockColor } from '../blocks/colors.js';

export interface HtmlOptions {
  title: string;
  /** Surrounding world blocks, drawn semi-transparent. */
  context?: VoxelSet;
}

interface Payload {
  title: string;
  palette: Array<{ name: string; color: [number, number, number, number] }>;
  voxels: number[][];
  context: number[][];
  bounds: { min: number[]; max: number[] };
  counts: Array<[string, number]>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function renderHtml(set: VoxelSet, opts: HtmlOptions): string {
  const paletteIndex = new Map<string, number>();
  const palette: Payload['palette'] = [];
  const idx = (s: BlockState): number => {
    const k = s.toString();
    let i = paletteIndex.get(k);
    if (i === undefined) {
      i = palette.length;
      paletteIndex.set(k, i);
      const c = blockColor(s);
      palette.push({ name: k, color: [c.r, c.g, c.b, c.a] });
    }
    return i;
  };
  const voxels: number[][] = [];
  for (const [p, s] of set.entries()) if (!s.isAir) voxels.push([p[0], p[1], p[2], idx(s)]);
  const context: number[][] = [];
  if (opts.context) for (const [p, s] of opts.context.entries()) if (!s.isAir && !set.has(p[0], p[1], p[2])) context.push([p[0], p[1], p[2], idx(s)]);
  const b = set.bounds() ?? { min: [0, 0, 0], max: [0, 0, 0] };
  const payload: Payload = {
    title: opts.title,
    palette,
    voxels,
    context,
    bounds: { min: [...b.min], max: [...b.max] },
    counts: [...set.counts().entries()].filter(([k]) => !BlockState.parse(k).isAir).sort((a, c) => c[1] - a[1]),
  };
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1b1d22; color: #e8e8e8; font: 14px system-ui, sans-serif; }
  #bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 8px 12px; background: #262930; }
  #bar label { display: flex; gap: 6px; align-items: center; }
  #wrap { position: relative; height: calc(100% - 46px); }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  #legend { position: absolute; right: 8px; top: 8px; background: rgba(0,0,0,.55); padding: 8px 10px; border-radius: 6px; max-height: 60%; overflow: auto; font-size: 12px; }
  #legend div { display: flex; gap: 6px; align-items: center; margin: 2px 0; }
  #legend i { display: inline-block; width: 12px; height: 12px; border-radius: 2px; border: 1px solid rgba(255,255,255,.3); }
  #info { position: absolute; left: 8px; bottom: 8px; background: rgba(0,0,0,.55); padding: 6px 10px; border-radius: 6px; font-size: 12px; }
  button { background: #3a3f4b; color: #fff; border: 0; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
<div id="bar">
  <strong>${escapeHtml(opts.title)}</strong>
  <button id="rotate">Rotate 90°</button>
  <label>Zoom <input id="zoom" type="range" min="4" max="40" value="14"></label>
  <label>Show up to y <input id="layer" type="range"><span id="layerv"></span></label>
  <label><input id="context" type="checkbox" checked> Surroundings</label>
  <span id="view"></span>
</div>
<div id="wrap">
  <canvas id="c"></canvas>
  <div id="legend"></div>
  <div id="info"></div>
</div>
<script>
const DATA = ${json};
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const VIEWS = ['from south-east', 'from south-west', 'from north-west', 'from north-east'];
let view = 0, zoom = 14, showContext = true, panX = 0, panY = 0, dragging = null;
let minY = DATA.bounds.min[1], maxY = DATA.bounds.max[1];
for (const v of DATA.context) { minY = Math.min(minY, v[1]); }
const layer = document.getElementById('layer');
layer.min = String(DATA.bounds.min[1]); layer.max = String(DATA.bounds.max[1]); layer.value = String(DATA.bounds.max[1]);
document.getElementById('layerv').textContent = layer.value;
function rot(x, z) { for (let i = 0; i < view; i++) { const t = x; x = -z; z = t; } return [x, z]; }
function shade(c, f) { return 'rgb(' + Math.round(c[0] * f) + ',' + Math.round(c[1] * f) + ',' + Math.round(c[2] * f) + ')'; }
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const W = zoom, H = zoom;
  const cap = Number(layer.value);
  const items = [];
  const solid = new Set();
  const push = (list, alpha) => {
    for (const [x, y, z, i] of list) {
      if (y > cap) continue;
      const [rx, rz] = rot(x, z);
      const c = DATA.palette[i];
      items.push({ x: rx, y, z: rz, c, alpha });
      if (alpha === 1 && c.color[3] === 1) solid.add(rx + ',' + y + ',' + rz);
    }
  };
  push(DATA.voxels, 1);
  if (showContext) push(DATA.context, 0.35);
  items.sort((a, b) => (a.x + a.z) - (b.x + b.z) || a.y - b.y);
  const P = (x, y, z) => [(x - z) * W, (x + z) * (W / 2) - y * H];
  let minX = Infinity, maxX = -Infinity, minPy = Infinity, maxPy = -Infinity;
  for (const it of items) for (const [px, py] of [P(it.x, it.y, it.z), P(it.x + 1, it.y + 1, it.z + 1), P(it.x + 1, it.y, it.z), P(it.x, it.y + 1, it.z + 1)]) {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minPy = Math.min(minPy, py); maxPy = Math.max(maxPy, py);
  }
  const ox = w / 2 - (minX + maxX) / 2 + panX, oy = h / 2 - (minPy + maxPy) / 2 + panY;
  const poly = (pts, fill) => { ctx.beginPath(); ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + ox, pts[i][1] + oy); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); if (W >= 10) { ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.stroke(); } };
  for (const it of items) {
    const { x, y, z, c } = it;
    if (c.color[3] === 0) continue;
    const top = !solid.has(x + ',' + (y + 1) + ',' + z), right = !solid.has((x + 1) + ',' + y + ',' + z), left = !solid.has(x + ',' + y + ',' + (z + 1));
    if (!top && !right && !left) continue;
    ctx.globalAlpha = it.alpha * c.color[3];
    if (top) poly([P(x, y + 1, z), P(x + 1, y + 1, z), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], shade(c.color, 1));
    if (right) poly([P(x + 1, y, z), P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x + 1, y + 1, z)], shade(c.color, 0.78));
    if (left) poly([P(x, y, z + 1), P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], shade(c.color, 0.6));
  }
  ctx.globalAlpha = 1;
  document.getElementById('view').textContent = 'View ' + VIEWS[view] + ' · north is ' + ['up-left', 'up-right', 'down-right', 'down-left'][view];
  const b = DATA.bounds;
  document.getElementById('info').textContent = 'Bounds (' + b.min.join(', ') + ') to (' + b.max.join(', ') + ') · ' + DATA.voxels.length + ' blocks · drag to pan, wheel to zoom';
}
document.getElementById('legend').innerHTML = DATA.counts.map(([name, n]) => {
  const p = DATA.palette.find((e) => e.name === name);
  const c = p ? p.color : [128, 128, 128, 1];
  return '<div><i style="background:rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')"></i>' + name.replace('minecraft:', '') + ' × ' + n + '</div>';
}).join('');
document.getElementById('rotate').onclick = () => { view = (view + 1) % 4; draw(); };
document.getElementById('zoom').oninput = (e) => { zoom = Number(e.target.value); draw(); };
layer.oninput = () => { document.getElementById('layerv').textContent = layer.value; draw(); };
document.getElementById('context').onchange = (e) => { showContext = e.target.checked; draw(); };
canvas.addEventListener('mousedown', (e) => { dragging = [e.clientX - panX, e.clientY - panY]; });
window.addEventListener('mousemove', (e) => { if (dragging) { panX = e.clientX - dragging[0]; panY = e.clientY - dragging[1]; draw(); } });
window.addEventListener('mouseup', () => { dragging = null; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.max(4, Math.min(40, zoom + (e.deltaY < 0 ? 2 : -2))); document.getElementById('zoom').value = String(zoom); draw(); }, { passive: false });
window.addEventListener('resize', draw);
draw();
</script>
</body>
</html>
`;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/preview`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/preview test/preview
git commit -m "feat(preview): ASCII slices and self-contained isometric HTML viewer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 13: RCON bridge (write, read, snapshot, undo)

**Goal:** The Tier 1 `Bridge`: compiles and runs commands with forceload and error capture, switches to structure templates for big pastes, reads the world after `save-all flush`, and keeps disk snapshots that `restore` puts back with `place template`.

**Files:**
- Create: `src/bridge/types.ts`, `src/bridge/errors.ts`, `src/bridge/rcon-bridge.ts`
- Create: `test/helpers/config.ts`, `test/helpers/server-dir.ts`
- Test: `test/bridge/rcon-bridge.test.ts`

**Acceptance Criteria:**
- [ ] `apply` sends `forceload add`, the compiled commands in order, then `forceload remove`, and reports commands whose response matches an error pattern without aborting
- [ ] `dry_run` sends nothing; writes outside `bounds` throw `BoundsError` before any command
- [ ] With `structureThreshold: 0` and a server dir, `apply` writes `paste_<id>_<n>.nbt` under `<level>/generated/blockwright/structure/` and sends one `place template` per piece
- [ ] `read` runs `save-all flush` once for two back-to-back reads and again after a write
- [ ] `snapshot` writes `snap_*` pieces plus `snapshots.json`; `restore` sends one `place template` per piece and removes the record and files
- [ ] `info` and `players` parse the vanilla `list`, `list uuids` and `data get entity` responses

**Verify:** `npx vitest run test/bridge` → all passed

**Steps:**

- [ ] **Step 1: Write helpers and the failing tests**

`test/helpers/config.ts`:
```ts
import type { Config } from '../../src/config.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    rcon: { host: '127.0.0.1', port: 0, password: 'secret' },
    serverDir: undefined,
    levelName: 'world',
    pluginUrl: 'http://127.0.0.1:25580',
    pluginToken: undefined,
    bounds: undefined,
    fillLimit: 32768,
    structureThreshold: 400,
    templateMax: 48,
    schematicDir: '/tmp',
    previewDir: '/tmp',
    dataVersion: 4903,
    mcVersion: '26.2',
    allowAdmin: false,
    bluemapUrl: undefined,
    saveCoalesceMs: 30000,
    ...overrides,
  };
}
```

`test/helpers/server-dir.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRegionFiles, type FixtureChunk } from './anvil-fixture.js';

/** A temp server folder with a 26.x overworld region containing the given chunks. */
export async function fakeServerDir(chunks: FixtureChunk[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bw-srv-'));
  await writeRegionFiles(path.join(dir, 'world', 'dimensions', 'minecraft', 'overworld', 'region'), chunks);
  return dir;
}

/** Chunk 0,0: stone from −64 to 62 everywhere, grass at (5,63,7). */
export function flatChunk(): FixtureChunk {
  const blocks: FixtureChunk['blocks'] = [];
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y <= 62; y++) blocks.push({ x, y, z, state: 'minecraft:stone' });
  blocks.push({ x: 5, y: 63, z: 7, state: 'minecraft:grass_block[snowy=false]' });
  return { cx: 0, cz: 0, blocks };
}
```

`test/bridge/rcon-bridge.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { RconClient } from '../../src/rcon/client.js';
import { RconBridge } from '../../src/bridge/rcon-bridge.js';
import { BoundsError, NeedsReadError } from '../../src/bridge/errors.js';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { resolveWorld } from '../../src/world/dimension.js';
import { FakeRcon } from '../helpers/fake-rcon.js';
import { testConfig } from '../helpers/config.js';
import { fakeServerDir, flatChunk } from '../helpers/server-dir.js';

const st = (s: string) => BlockState.parse(s);
const UUID = '11111111-2222-3333-4444-555555555555';

function vanillaHandler(cmd: string): string {
  if (cmd === 'list') return 'There are 1 of a max of 20 players online: Steve';
  if (cmd === 'list uuids') return `There are 1 of a max of 20 players online: Steve (${UUID})`;
  if (cmd.endsWith('Pos')) return 'Steve has the following entity data: [10.5d, 64.0d, -3.2d]';
  if (cmd.endsWith('Rotation')) return 'Steve has the following entity data: [90.0f, 10.0f]';
  if (cmd.endsWith('Dimension')) return 'Steve has the following entity data: "minecraft:the_nether"';
  if (cmd.endsWith('playerGameType')) return 'Steve has the following entity data: 1';
  if (cmd === 'save-all flush') return 'Saving the game (this may take a moment!)Saved the game';
  if (cmd.startsWith('forceload')) return 'Marked chunk [0, 0] in minecraft:overworld to be force loaded';
  if (cmd.includes('obsidian')) return 'No blocks were filled';
  if (cmd.startsWith('fill') || cmd.startsWith('execute')) return 'Successfully filled 8 blocks';
  if (cmd.startsWith('setblock')) return 'Changed the block at 0, 0, 0';
  if (cmd.startsWith('place template')) return `Loaded template "${cmd.split(' ')[2]}" at 0, 0, 0`;
  return '';
}

let fake: FakeRcon;
let rcon: RconClient;
let clock = 1_000_000;
const now = () => clock;

beforeEach(async () => {
  fake = new FakeRcon();
  fake.handler = vanillaHandler;
  await fake.start();
  rcon = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
});
afterEach(async () => {
  await rcon.close();
  await fake.stop();
});

const overworld = resolveWorld('overworld', 'world');

function cube(block: string): VoxelSet {
  const v = new VoxelSet();
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) v.set(x, y + 64, z, st(block));
  return v;
}

describe('info and players', () => {
  it('parses list and entity data', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const info = await bridge.info();
    expect(info).toMatchObject({ tier: 1, playersOnline: 1, maxPlayers: 20, players: ['Steve'], canRead: false });
    expect(info.notes[0]).toMatch(/BLOCKWRIGHT_SERVER_DIR/);
    const players = await bridge.players();
    expect(players).toEqual([{ name: 'Steve', uuid: UUID, world: 'minecraft:the_nether', pos: [10, 64, -4], yaw: 90, pitch: 10, gamemode: 'creative' }]);
  });
});

describe('apply over commands', () => {
  it('forceloads, runs commands in order, and captures errors', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const set = cube('stone');
    set.set(5, 64, 5, st('obsidian'));
    const r = await bridge.apply(set, { world: overworld, snapshot: false });
    expect(fake.commands[0]).toBe('forceload add 0 0 15 15');
    expect(fake.commands[1]).toBe('fill 0 64 0 1 65 1 stone');
    expect(fake.commands[2]).toBe('setblock 5 64 5 obsidian');
    expect(fake.commands[3]).toBe('forceload remove 0 0 15 15');
    expect(r).toMatchObject({ method: 'commands', blocks: 9, commands: 2, failed: 1, dryRun: false });
    expect(r.errors[0]).toMatch(/obsidian → No blocks were filled/);
  });
  it('prefixes the dimension and sends nothing on dry run', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const dry = await bridge.apply(cube('stone'), { world: resolveWorld('nether', 'world'), dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.sample[0]).toBe('execute in minecraft:the_nether run fill 0 64 0 1 65 1 stone');
    expect(fake.commands).toEqual([]);
  });
  it('refuses writes outside bounds', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig({ bounds: { min: [100, 0, 100], max: [200, 100, 200] } }), now });
    await expect(bridge.apply(cube('stone'), { world: overworld })).rejects.toBeInstanceOf(BoundsError);
    expect(fake.commands).toEqual([]);
  });
  it('runs raw commands through applyCommands', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const r = await bridge.applyCommands(['fill 0 64 0 3 64 3 dirt keep'], { min: [0, 64, 0], max: [3, 64, 3] }, 16, { world: overworld, snapshot: false });
    expect(r.failed).toBe(0);
    expect(fake.commands[1]).toBe('fill 0 64 0 3 64 3 dirt keep');
  });
});

describe('structure path', () => {
  it('writes template pieces and places them', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir, structureThreshold: 0, templateMax: 48 }), now });
    const r = await bridge.apply(cube('stone'), { world: overworld, snapshot: false });
    const dir = path.join(serverDir, 'world', 'generated', 'blockwright', 'structure');
    const files = readdirSync(dir).filter((f) => f.startsWith('paste_'));
    expect(files).toHaveLength(1);
    const place = fake.commands.find((c) => c.startsWith('place template'))!;
    expect(place).toMatch(/^place template blockwright:paste_\w+_0 0 64 0$/);
    expect(r).toMatchObject({ method: 'structure', failed: 0, commands: 1, blocks: 8 });
  });
});

describe('read, snapshot, restore', () => {
  it('needs a server dir', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    await expect(bridge.read({ min: [0, 60, 0], max: [1, 61, 1] }, overworld)).rejects.toBeInstanceOf(NeedsReadError);
  });
  it('coalesces save-all and reads blocks and heightmaps', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    const r1 = await bridge.read({ min: [4, 62, 6], max: [6, 64, 8] }, overworld);
    expect(r1.voxels.get(5, 63, 7)?.toCommand()).toBe('grass_block[snowy=false]');
    expect(r1.voxels.get(5, 64, 7)?.isAir).toBe(true);
    await bridge.read({ min: [0, 62, 0], max: [1, 62, 1] }, overworld);
    expect(fake.commands.filter((c) => c === 'save-all flush')).toHaveLength(1);
    clock += 60_000;
    const hm = await bridge.heightmap(4, 6, 6, 8, overworld);
    expect(fake.commands.filter((c) => c === 'save-all flush')).toHaveLength(2);
    expect(hm.heights[1][1]).toBe(63);
    expect(hm.surface[1][1]).toBe('grass_block[snowy=false]');
    expect(hm.heights[0][0]).toBe(62);
    await bridge.apply(cube('stone'), { world: overworld, snapshot: false });
    await bridge.read({ min: [0, 62, 0], max: [1, 62, 1] }, overworld);
    expect(fake.commands.filter((c) => c === 'save-all flush')).toHaveLength(3);
  });
  it('snapshots before a write and restores', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    const r = await bridge.apply(cube('stone'), { world: overworld, label: 'test cube' });
    expect(r.snapshotId).toBeDefined();
    const dir = path.join(serverDir, 'world', 'generated', 'blockwright', 'structure');
    expect(existsSync(path.join(dir, 'snapshots.json'))).toBe(true);
    const snaps = await bridge.listSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ id: r.snapshotId, world: 'overworld', box: { min: [0, 64, 0], max: [1, 65, 1] }, label: 'test cube' });
    expect(existsSync(path.join(dir, `${snaps[0].pieces[0].name}.nbt`))).toBe(true);
    const before = fake.commands.length;
    const res = await bridge.restore(r.snapshotId!);
    expect(res.restored).toBe(1);
    expect(fake.commands.slice(before)).toEqual(['forceload add 0 0 15 15', `place template blockwright:${snaps[0].pieces[0].name} 0 64 0`, 'forceload remove 0 0 15 15']);
    expect(await bridge.listSnapshots()).toHaveLength(0);
    expect(existsSync(path.join(dir, `${snaps[0].pieces[0].name}.nbt`))).toBe(false);
    await expect(bridge.restore('nope')).rejects.toThrow(/no snapshot/);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/bridge`
Expected: FAIL, cannot find modules

- [ ] **Step 3: Implement types.ts and errors.ts**

`src/bridge/types.ts`:
```ts
import type { Box, Vec3, VoxelSet } from '../voxel/voxels.js';
import type { BlockEntity } from '../schematic/clipboard.js';
import type { WorldRef } from '../world/dimension.js';

export interface ServerInfo {
  tier: 1 | 2;
  mcVersion: string;
  dataVersion: number;
  playersOnline: number;
  maxPlayers: number;
  players: string[];
  canRead: boolean;
  canSnapshot: boolean;
  notes: string[];
}

export interface PlayerInfo {
  name: string;
  uuid?: string;
  world: string;
  pos: Vec3;
  yaw?: number;
  pitch?: number;
  gamemode?: string;
}

export interface ApplyOptions {
  world: WorldRef;
  dryRun?: boolean;
  /** Default true when the bridge can read. */
  snapshot?: boolean;
  label?: string;
  /** Default true. */
  forceload?: boolean;
  /** Absolute positions; placed only by the structure and plugin paths. */
  blockEntities?: BlockEntity[];
}

export interface ApplyResult {
  dryRun: boolean;
  method: 'commands' | 'structure' | 'plugin' | 'none';
  blocks: number;
  commands: number;
  failed: number;
  errors: string[];
  box?: Box;
  elapsedMs: number;
  snapshotId?: string;
  /** First commands (or a description) for dry runs and logs. */
  sample: string[];
}

export interface ReadResult {
  voxels: VoxelSet;
  blockEntities: BlockEntity[];
  missingChunks: number;
}

export interface HeightmapResult {
  /** [z - minZ][x - minX]; null where the chunk does not exist. */
  heights: (number | null)[][];
  surface: (string | null)[][];
  missingChunks: number;
}

export interface SnapshotRecord {
  id: string;
  world: string;
  box: Box;
  pieces: Array<{ name: string; origin: Vec3 }>;
  createdAt: string;
  label?: string;
}

export interface Bridge {
  readonly tier: 1 | 2;
  info(): Promise<ServerInfo>;
  players(): Promise<PlayerInfo[]>;
  runCommand(command: string): Promise<string>;
  apply(set: VoxelSet, opts: ApplyOptions): Promise<ApplyResult>;
  applyCommands(commands: string[], box: Box, blocks: number, opts: ApplyOptions): Promise<ApplyResult>;
  canRead(): boolean;
  read(box: Box, world: WorldRef): Promise<ReadResult>;
  heightmap(minX: number, minZ: number, maxX: number, maxZ: number, world: WorldRef): Promise<HeightmapResult>;
  snapshot(box: Box, world: WorldRef, label?: string): Promise<SnapshotRecord>;
  restore(id: string): Promise<{ restored: number; record: SnapshotRecord }>;
  listSnapshots(): Promise<SnapshotRecord[]>;
  close(): Promise<void>;
}
```

`src/bridge/errors.ts`:
```ts
import type { Box } from '../voxel/voxels.js';

export class BridgeError extends Error {}

export class BoundsError extends BridgeError {
  constructor(
    readonly box: Box,
    readonly bounds: Box,
  ) {
    super(`Refusing to write outside BLOCKWRIGHT_BOUNDS: target (${box.min.join(', ')}) to (${box.max.join(', ')}) is not within (${bounds.min.join(', ')}) to (${bounds.max.join(', ')})`);
  }
}

export class NeedsReadError extends BridgeError {
  constructor(what: string) {
    super(`${what} needs world access: set BLOCKWRIGHT_SERVER_DIR to the server folder (blockwright must run on the server host or a shared filesystem), or install the blockwright plugin.`);
  }
}
```

- [ ] **Step 4: Implement rcon-bridge.ts**

`src/bridge/rcon-bridge.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { RconClient } from '../rcon/client.js';
import { VoxelSet, boxContains, formatVec, type Box } from '../voxel/voxels.js';
import { compile, forceloadRects, prefixDimension } from '../voxel/compile.js';
import { clipboardFromVoxels, tileBox } from '../schematic/clipboard.js';
import { writeStructure } from '../schematic/structure.js';
import { writeNbtGz } from '../nbt/nbt.js';
import { resolveRegionDir, resolveWorld, type WorldRef } from '../world/dimension.js';
import { readVoxels, readHeightmap, surfaceBlock } from '../world/anvil.js';
import { BridgeError, BoundsError, NeedsReadError } from './errors.js';
import type { Bridge, ApplyOptions, ApplyResult, ServerInfo, PlayerInfo, ReadResult, HeightmapResult, SnapshotRecord } from './types.js';

const ERROR_RE =
  /Incorrect argument|Unknown or incomplete command|not loaded|Too many blocks|Too many chunks|No blocks were filled|Could not set the block|out of this world|no template|Expected |Invalid |Unknown block|Unknown item|Unknown request|That position|Failed/i;
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const KEEP_PASTES = 20;
const KEEP_SNAPSHOTS = 50;

export interface RconBridgeDeps {
  rcon: Pick<RconClient, 'send' | 'close'>;
  config: Config;
  now?: () => number;
}

function newId(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

export class RconBridge implements Bridge {
  readonly tier = 1 as const;
  private lastSaveAt = -Infinity;
  private dirty = true;
  private readonly now: () => number;

  constructor(private readonly deps: RconBridgeDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get config(): Config {
    return this.deps.config;
  }

  private send(cmd: string): Promise<string> {
    return this.deps.rcon.send(cmd);
  }

  canRead(): boolean {
    const d = this.config.serverDir;
    return d !== undefined && resolveRegionDir(d, this.config.levelName, 'overworld') !== undefined;
  }

  private regionDir(world: WorldRef): string {
    const d = this.config.serverDir;
    if (!d) throw new NeedsReadError('Reading the world');
    const r = resolveRegionDir(d, this.config.levelName, world.label);
    if (!r) throw new NeedsReadError(`Reading the ${world.label} (no region folder found under ${d})`);
    return r;
  }

  private generatedDir(): string {
    const d = this.config.serverDir;
    if (!d) throw new NeedsReadError('Structure templates');
    return path.join(d, this.config.levelName, 'generated', 'blockwright', 'structure');
  }

  async runCommand(command: string): Promise<string> {
    return this.send(command.replace(/^\//, '').trim());
  }

  async info(): Promise<ServerInfo> {
    const list = await this.send('list');
    const m = /There are (\d+) of a max of (\d+) players online:?\s*(.*)/.exec(list);
    const players = m && m[3] ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const notes: string[] = [];
    if (!m) notes.push(`unexpected "list" response: ${list.slice(0, 120)}`);
    if (!this.canRead())
      notes.push('Read tools (read_region, get_heightmap, get_block, save_schematic, undo, preview context) need BLOCKWRIGHT_SERVER_DIR pointing at the server folder, or the blockwright plugin.');
    return {
      tier: 1,
      mcVersion: this.config.mcVersion,
      dataVersion: this.config.dataVersion,
      playersOnline: m ? Number(m[1]) : players.length,
      maxPlayers: m ? Number(m[2]) : 0,
      players,
      canRead: this.canRead(),
      canSnapshot: this.canRead(),
      notes,
    };
  }

  async players(): Promise<PlayerInfo[]> {
    const list = await this.send('list uuids');
    const out: PlayerInfo[] = [];
    for (const m of list.matchAll(/([^\s,:()]+) \(([0-9a-f-]{36})\)/g)) {
      const [, name, uuid] = m;
      const pos = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(await this.send(`data get entity ${uuid} Pos`));
      if (!pos) continue;
      const rot = /\[(-?[\d.]+)f, (-?[\d.]+)f\]/.exec(await this.send(`data get entity ${uuid} Rotation`));
      const dim = /"([^"]+)"/.exec(await this.send(`data get entity ${uuid} Dimension`));
      const gm = /: (\d+)/.exec(await this.send(`data get entity ${uuid} playerGameType`));
      out.push({
        name,
        uuid,
        world: dim?.[1] ?? 'minecraft:overworld',
        pos: [Math.floor(Number(pos[1])), Math.floor(Number(pos[2])), Math.floor(Number(pos[3]))],
        yaw: rot ? Number(rot[1]) : undefined,
        pitch: rot ? Number(rot[2]) : undefined,
        gamemode: gm ? GAMEMODES[Number(gm[1])] : undefined,
      });
    }
    return out;
  }

  private checkBounds(box: Box): void {
    const b = this.config.bounds;
    if (!b) return;
    if (!boxContains(b, box.min) || !boxContains(b, box.max)) throw new BoundsError(box, b);
  }

  private async forceload(box: Box, world: WorldRef, add: boolean, errors: string[]): Promise<void> {
    for (const r of forceloadRects(box)) {
      const cmd = prefixDimension(`forceload ${add ? 'add' : 'remove'} ${r.minX} ${r.minZ} ${r.maxX} ${r.maxZ}`, world.dimension);
      const resp = await this.send(cmd);
      if (ERROR_RE.test(resp)) errors.push(`${cmd} → ${resp}`);
    }
  }

  private async maybeSnapshot(box: Box, opts: ApplyOptions): Promise<string | undefined> {
    if (opts.snapshot === false || !this.canRead()) return undefined;
    return (await this.snapshot(box, opts.world, opts.label)).id;
  }

  async applyCommands(commands: string[], box: Box, blocks: number, opts: ApplyOptions): Promise<ApplyResult> {
    const start = this.now();
    this.checkBounds(box);
    const base = { blocks, commands: commands.length, box, sample: commands.slice(0, 20) };
    if (opts.dryRun) return { ...base, dryRun: true, method: 'none', failed: 0, errors: [], elapsedMs: 0 };
    const errors: string[] = [];
    const snapshotId = await this.maybeSnapshot(box, opts);
    let failed = 0;
    if (opts.forceload !== false) await this.forceload(box, opts.world, true, errors);
    try {
      for (const cmd of commands) {
        const resp = await this.send(cmd);
        if (ERROR_RE.test(resp)) {
          failed++;
          if (errors.length < 50) errors.push(`${cmd} → ${resp}`);
        }
      }
    } finally {
      this.dirty = true;
      if (opts.forceload !== false) await this.forceload(box, opts.world, false, errors);
    }
    return { ...base, dryRun: false, method: 'commands', failed, errors, elapsedMs: this.now() - start, snapshotId };
  }

  async apply(set: VoxelSet, opts: ApplyOptions): Promise<ApplyResult> {
    const box = set.bounds();
    if (!box) throw new BridgeError('nothing to place: the voxel set is empty');
    this.checkBounds(box);
    const commands = compile(set, { fillLimit: this.config.fillLimit, dimension: opts.world.dimension });
    const useStructure = commands.length > this.config.structureThreshold && this.config.serverDir !== undefined;
    if (!useStructure) return this.applyCommands(commands.map((c) => c.text), box, set.size, opts);
    return this.applyStructure(set, box, commands.length, opts);
  }

  private async applyStructure(set: VoxelSet, box: Box, commandCount: number, opts: ApplyOptions): Promise<ApplyResult> {
    const start = this.now();
    const tiles = tileBox(box, this.config.templateMax).filter((t) => set.within(t).size > 0);
    const base = {
      blocks: set.size,
      commands: tiles.length,
      box,
      sample: [`${commandCount} fill/setblock commands exceed BLOCKWRIGHT_STRUCTURE_THRESHOLD; placing ${tiles.length} structure template(s) instead`],
    };
    if (opts.dryRun) return { ...base, dryRun: true, method: 'structure', failed: 0, errors: [], elapsedMs: 0 };
    const errors: string[] = [];
    const snapshotId = await this.maybeSnapshot(box, opts);
    const dir = this.generatedDir();
    await fs.mkdir(dir, { recursive: true });
    const id = newId();
    let failed = 0;
    await this.forceload(box, opts.world, true, errors);
    try {
      for (const [n, tile] of tiles.entries()) {
        const sub = set.within(tile);
        const bes = (opts.blockEntities ?? []).filter((be) => boxContains(tile, be.pos));
        const clip = clipboardFromVoxels(sub, this.config.dataVersion, bes);
        const name = `paste_${id}_${n}`;
        await fs.writeFile(path.join(dir, `${name}.nbt`), writeNbtGz(writeStructure(clip)));
        const cmd = prefixDimension(`place template blockwright:${name} ${formatVec(sub.bounds()!.min)}`, opts.world.dimension);
        const resp = await this.send(cmd);
        if (!/Loaded template/.test(resp)) {
          failed++;
          errors.push(`${cmd} → ${resp}`);
        }
      }
    } finally {
      this.dirty = true;
      await this.forceload(box, opts.world, false, errors);
      await this.prune(dir, /^paste_/, KEEP_PASTES);
    }
    return { ...base, dryRun: false, method: 'structure', failed, errors, elapsedMs: this.now() - start, snapshotId };
  }

  private async prune(dir: string, pattern: RegExp, keep: number): Promise<void> {
    const entries = (await fs.readdir(dir)).filter((f) => pattern.test(f));
    const withTime = await Promise.all(entries.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
    withTime.sort((a, b) => b.t - a.t);
    for (const { f } of withTime.slice(keep)) await fs.rm(path.join(dir, f), { force: true });
  }

  private async ensureSaved(): Promise<void> {
    if (!this.dirty && this.now() - this.lastSaveAt < this.config.saveCoalesceMs) return;
    const resp = await this.send('save-all flush');
    if (!/Saved the game/i.test(resp)) throw new BridgeError(`save-all flush did not confirm: ${resp}`);
    this.lastSaveAt = this.now();
    this.dirty = false;
  }

  async read(box: Box, world: WorldRef): Promise<ReadResult> {
    const dir = this.regionDir(world);
    await this.ensureSaved();
    return readVoxels(dir, box);
  }

  async heightmap(minX: number, minZ: number, maxX: number, maxZ: number, world: WorldRef): Promise<HeightmapResult> {
    const dir = this.regionDir(world);
    await this.ensureSaved();
    const { heights, missingChunks, chunks } = await readHeightmap(dir, minX, minZ, maxX, maxZ);
    const surface = heights.map((row, zi) => row.map((h, xi) => (h === null ? null : surfaceBlock(chunks, minX + xi, minZ + zi, h).toCommand())));
    return { heights, surface, missingChunks };
  }

  private indexPath(): string {
    return path.join(this.generatedDir(), 'snapshots.json');
  }

  async listSnapshots(): Promise<SnapshotRecord[]> {
    try {
      return (JSON.parse(await fs.readFile(this.indexPath(), 'utf8')) as { snapshots: SnapshotRecord[] }).snapshots;
    } catch {
      return [];
    }
  }

  private async writeIndex(records: SnapshotRecord[]): Promise<void> {
    await fs.mkdir(this.generatedDir(), { recursive: true });
    await fs.writeFile(this.indexPath(), JSON.stringify({ snapshots: records }, null, 2));
  }

  async snapshot(box: Box, world: WorldRef, label?: string): Promise<SnapshotRecord> {
    const { voxels, blockEntities } = await this.read(box, world);
    const dir = this.generatedDir();
    await fs.mkdir(dir, { recursive: true });
    const id = newId();
    const pieces: SnapshotRecord['pieces'] = [];
    for (const [n, tile] of tileBox(box, this.config.templateMax).entries()) {
      const sub = voxels.within(tile);
      if (sub.size === 0) continue; // chunk not generated yet: nothing to restore there
      const clip = clipboardFromVoxels(sub, this.config.dataVersion, blockEntities.filter((be) => boxContains(tile, be.pos)));
      const name = `snap_${id}_${n}`;
      await fs.writeFile(path.join(dir, `${name}.nbt`), writeNbtGz(writeStructure(clip)));
      pieces.push({ name, origin: sub.bounds()!.min });
    }
    const record: SnapshotRecord = { id, world: world.label, box, pieces, createdAt: new Date(this.now()).toISOString(), label };
    const records = [record, ...(await this.listSnapshots())];
    for (const old of records.splice(KEEP_SNAPSHOTS)) for (const p of old.pieces) await fs.rm(path.join(dir, `${p.name}.nbt`), { force: true });
    await this.writeIndex(records);
    return record;
  }

  async restore(id: string): Promise<{ restored: number; record: SnapshotRecord }> {
    const records = await this.listSnapshots();
    const record = records.find((r) => r.id === id);
    if (!record) throw new BridgeError(`no snapshot with id ${id}`);
    const world = resolveWorld(record.world, this.config.levelName);
    const errors: string[] = [];
    let restored = 0;
    await this.forceload(record.box, world, true, errors);
    try {
      for (const p of record.pieces) {
        const resp = await this.send(prefixDimension(`place template blockwright:${p.name} ${formatVec(p.origin)}`, world.dimension));
        if (/Loaded template/.test(resp)) restored++;
        else errors.push(`${p.name} → ${resp}`);
      }
    } finally {
      this.dirty = true;
      await this.forceload(record.box, world, false, errors);
    }
    if (errors.length) throw new BridgeError(`restore ${id}: ${restored}/${record.pieces.length} pieces placed; ${errors.join('; ')}`);
    const dir = this.generatedDir();
    for (const p of record.pieces) await fs.rm(path.join(dir, `${p.name}.nbt`), { force: true });
    await this.writeIndex(records.filter((r) => r.id !== id));
    return { restored, record };
  }

  async close(): Promise<void> {
    await this.deps.rcon.close();
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/bridge`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/bridge test/bridge test/helpers/config.ts test/helpers/server-dir.ts
git commit -m "feat(bridge): RCON bridge with structure pastes, region reads, snapshots and restore

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 14: MCP server skeleton and server tools

**Goal:** `createServer` wired to a `Bridge`, shared result helpers, and the first tool group: `server_info`, `get_players`, `run_command` (with denylist) and `fill`; tested end-to-end through an in-memory MCP client with a fake bridge.

**Files:**
- Create: `src/server.ts`, `src/tools/result.ts`, `src/tools/common.ts`, `src/tools/server-tools.ts`
- Create: `test/helpers/fake-bridge.ts`, `test/helpers/mcp.ts`
- Test: `test/tools/server-tools.test.ts`

**Acceptance Criteria:**
- [ ] `listTools` returns `server_info`, `get_players`, `run_command`, `fill`
- [ ] `run_command` refuses `stop`, `/op x`, `execute as @a run kick @s` unless `allowAdmin`, and passes `time set day` through
- [ ] `fill` in `replace` mode sends one raw fill command (split over the limit); `hollow` applies walls plus interior air through the voxel path; `dry_run` changes nothing and says so; an unknown block returns an error with a suggestion

**Verify:** `npx vitest run test/tools/server-tools.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write helpers and failing tests**

`test/helpers/fake-bridge.ts`:
```ts
import { VoxelSet, BlockState, type Box } from '../../src/voxel/voxels.js';
import type { Bridge, ApplyOptions, ApplyResult, ServerInfo, PlayerInfo, ReadResult, HeightmapResult, SnapshotRecord } from '../../src/bridge/types.js';
import type { WorldRef } from '../../src/world/dimension.js';

const AIR = BlockState.parse('air');

/** In-memory world. apply() merges voxels; read() returns the box with air where nothing was set. */
export class FakeBridge implements Bridge {
  readonly tier = 1 as const;
  world = new VoxelSet();
  calls: Array<{ method: string; args: unknown[] }> = [];
  playersList: PlayerInfo[] = [{ name: 'Steve', world: 'minecraft:overworld', pos: [0, 64, 0], gamemode: 'creative' }];
  readable = true;
  snapshots: SnapshotRecord[] = [];
  private saved = new Map<string, VoxelSet>();
  private seq = 0;

  async info(): Promise<ServerInfo> {
    return { tier: 1, mcVersion: '26.2', dataVersion: 4903, playersOnline: this.playersList.length, maxPlayers: 20, players: this.playersList.map((p) => p.name), canRead: this.readable, canSnapshot: this.readable, notes: [] };
  }
  async players(): Promise<PlayerInfo[]> {
    return this.playersList;
  }
  async runCommand(command: string): Promise<string> {
    this.calls.push({ method: 'runCommand', args: [command] });
    return `ok: ${command}`;
  }
  async apply(set: VoxelSet, opts: ApplyOptions): Promise<ApplyResult> {
    this.calls.push({ method: 'apply', args: [set, opts] });
    const box = set.bounds()!;
    if (opts.dryRun) return { dryRun: true, method: 'none', blocks: set.size, commands: 1, failed: 0, errors: [], box, elapsedMs: 0, sample: ['(dry run)'] };
    const snapshotId = opts.snapshot !== false && this.readable ? (await this.snapshot(box, opts.world, opts.label)).id : undefined;
    this.world.merge(set);
    return { dryRun: false, method: 'commands', blocks: set.size, commands: 1, failed: 0, errors: [], box, elapsedMs: 1, snapshotId, sample: [] };
  }
  async applyCommands(commands: string[], box: Box, blocks: number, opts: ApplyOptions): Promise<ApplyResult> {
    this.calls.push({ method: 'applyCommands', args: [commands, box, blocks, opts] });
    return { dryRun: !!opts.dryRun, method: opts.dryRun ? 'none' : 'commands', blocks, commands: commands.length, failed: 0, errors: [], box, elapsedMs: 1, sample: commands.slice(0, 20) };
  }
  canRead(): boolean {
    return this.readable;
  }
  async read(box: Box): Promise<ReadResult> {
    const voxels = new VoxelSet();
    for (let x = box.min[0]; x <= box.max[0]; x++) for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = box.min[2]; z <= box.max[2]; z++) voxels.set(x, y, z, this.world.get(x, y, z) ?? AIR);
    return { voxels, blockEntities: [], missingChunks: 0 };
  }
  async heightmap(minX: number, minZ: number, maxX: number, maxZ: number): Promise<HeightmapResult> {
    const heights: number[][] = [];
    const surface: (string | null)[][] = [];
    for (let z = minZ; z <= maxZ; z++) {
      const hr: number[] = [];
      const sr: (string | null)[] = [];
      for (let x = minX; x <= maxX; x++) {
        let top = -65;
        let block: string | null = null;
        for (const [p, s] of this.world.entries()) if (p[0] === x && p[2] === z && !s.isAir && p[1] > top) { top = p[1]; block = s.toCommand(); }
        hr.push(top);
        sr.push(block);
      }
      heights.push(hr);
      surface.push(sr);
    }
    return { heights, surface, missingChunks: 0 };
  }
  async snapshot(box: Box, world: WorldRef, label?: string): Promise<SnapshotRecord> {
    const id = `snap${++this.seq}`;
    this.saved.set(id, (await this.read(box)).voxels);
    const record: SnapshotRecord = { id, world: world.label, box, pieces: [{ name: id, origin: box.min }], createdAt: new Date(0).toISOString(), label };
    this.snapshots.unshift(record);
    return record;
  }
  async restore(id: string): Promise<{ restored: number; record: SnapshotRecord }> {
    const record = this.snapshots.find((r) => r.id === id);
    if (!record) throw new Error(`no snapshot with id ${id}`);
    this.world.merge(this.saved.get(id)!);
    this.snapshots = this.snapshots.filter((r) => r.id !== id);
    return { restored: 1, record };
  }
  async listSnapshots(): Promise<SnapshotRecord[]> {
    return this.snapshots;
  }
  async close(): Promise<void> {}
}
```

`test/helpers/mcp.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type AppContext } from '../../src/server.js';

export async function connect(ctx: AppContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(ctx);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return { text, isError: r.isError === true };
}
```

`test/tools/server-tools.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';
import { isDenied } from '../../src/tools/server-tools.js';

let bridge: FakeBridge;
let client: Client;
beforeEach(async () => {
  bridge = new FakeBridge();
  client = await connect({ config: testConfig(), bridge });
});

describe('tool listing and info', () => {
  it('lists the server tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['server_info', 'get_players', 'run_command', 'fill']) expect(names).toContain(n);
  });
  it('server_info returns JSON with tier and masked config', async () => {
    const r = await call(client, 'server_info');
    const info = JSON.parse(r.text);
    expect(info.tier).toBe(1);
    expect(info.players).toEqual(['Steve']);
    expect(info.config.rcon.password).toBe('***');
  });
  it('get_players returns positions', async () => {
    const r = await call(client, 'get_players');
    expect(JSON.parse(r.text)[0]).toMatchObject({ name: 'Steve', pos: [0, 64, 0] });
  });
});

describe('run_command', () => {
  it('denies admin commands', () => {
    for (const c of ['stop', '/op steve', 'minecraft:ban x', 'execute as @a run kick @s', 'whitelist off', 'reload']) expect(isDenied(c), c).toBe(true);
    for (const c of ['time set day', 'say hi', 'fill 0 0 0 1 1 1 stone', 'execute as @a run tp @s 0 64 0']) expect(isDenied(c), c).toBe(false);
  });
  it('passes safe commands to the bridge and refuses others', async () => {
    const ok = await call(client, 'run_command', { command: 'time set day' });
    expect(ok.isError).toBe(false);
    expect(ok.text).toBe('ok: time set day');
    const bad = await call(client, 'run_command', { command: 'stop' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/refused/);
    expect(bridge.calls.filter((c) => c.method === 'runCommand')).toHaveLength(1);
  });
});

describe('fill', () => {
  it('replace mode sends a raw fill command', async () => {
    const r = await call(client, 'fill', { from: [0, 64, 0], to: [3, 64, 3], block: 'stone', mode: 'replace', replace_filter: 'dirt' });
    expect(r.isError).toBe(false);
    const c = bridge.calls.find((c) => c.method === 'applyCommands')!;
    expect(c.args[0]).toEqual(['fill 0 64 0 3 64 3 stone replace dirt']);
    expect(r.text).toMatch(/16 blocks/);
  });
  it('hollow mode builds walls with an air interior', async () => {
    await call(client, 'fill', { from: [0, 64, 0], to: [4, 68, 4], block: 'stone_bricks', mode: 'hollow' });
    expect(bridge.world.get(0, 64, 0)?.toCommand()).toBe('stone_bricks');
    expect(bridge.world.get(2, 66, 2)?.isAir).toBe(true);
    expect(bridge.world.size).toBe(125);
  });
  it('outline mode leaves the interior untouched', async () => {
    await call(client, 'fill', { from: [0, 64, 0], to: [4, 68, 4], block: 'stone', mode: 'outline' });
    expect(bridge.world.size).toBe(125 - 27);
  });
  it('dry run touches nothing and says so', async () => {
    const r = await call(client, 'fill', { from: [0, 64, 0], to: [1, 64, 1], block: 'stone', mode: 'hollow', dry_run: true });
    expect(r.text).toMatch(/DRY RUN/);
    expect(bridge.world.size).toBe(0);
  });
  it('rejects unknown blocks with a suggestion', async () => {
    const r = await call(client, 'fill', { from: [0, 64, 0], to: [1, 64, 1], block: 'stoen' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown block "stoen".*stone/);
    const forced = await call(client, 'fill', { from: [0, 64, 0], to: [1, 64, 1], block: 'stoen', allow_unknown_blocks: true });
    expect(forced.isError).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/tools/server-tools.test.ts`
Expected: FAIL, cannot find modules

- [ ] **Step 3: Implement result.ts and common.ts**

`src/tools/result.ts`:
```ts
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApplyResult } from '../bridge/types.js';

export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function formatApplyResult(r: ApplyResult, what: string): string {
  const box = r.box ? `(${r.box.min.join(', ')}) to (${r.box.max.join(', ')})` : 'n/a';
  const lines: string[] = [];
  if (r.dryRun) {
    lines.push(`DRY RUN — nothing was changed. ${what}: ${r.blocks} blocks in ${r.commands} command(s), box ${box}.`);
    if (r.sample.length) lines.push('First commands:', ...r.sample.map((s) => `  ${s}`));
    return lines.join('\n');
  }
  lines.push(`${what}: ${r.blocks} blocks via ${r.method} in ${r.commands} command(s), box ${box}, ${r.elapsedMs} ms.`);
  if (r.snapshotId) lines.push(`Snapshot ${r.snapshotId} taken; call undo to revert.`);
  else lines.push('No snapshot taken (world reads unavailable or snapshot=false); undo is not possible for this change.');
  if (r.failed) lines.push(`${r.failed} command(s) failed:`, ...r.errors.map((e) => `  ${e}`));
  else if (r.errors.length) lines.push('Warnings:', ...r.errors.map((e) => `  ${e}`));
  return lines.join('\n');
}
```

`src/tools/common.ts`:
```ts
import { z } from 'zod';
import type { VoxelSet } from '../voxel/voxels.js';
import { WorldSchema } from '../voxel/schemas.js';
import { resolveWorld } from '../world/dimension.js';
import { validateSet } from '../blocks/registry.js';
import type { ApplyOptions } from '../bridge/types.js';
import type { AppContext } from '../server.js';

export const writeOptionsShape = {
  world: WorldSchema.optional(),
  dry_run: z.boolean().default(false).describe('Compile and report without changing the world'),
  snapshot: z.boolean().default(true).describe('Snapshot the affected box first so undo can revert it (needs world read access)'),
  label: z.string().optional().describe('Short label stored with the snapshot, e.g. "cottage walls"'),
  allow_unknown_blocks: z.boolean().default(false).describe('Skip block-name validation (for blocks newer than the bundled registry)'),
};

export interface WriteArgs {
  world?: string;
  dry_run: boolean;
  snapshot: boolean;
  label?: string;
  allow_unknown_blocks: boolean;
}

export function applyOptionsFrom(args: WriteArgs, ctx: AppContext): ApplyOptions {
  return { world: resolveWorld(args.world, ctx.config.levelName), dryRun: args.dry_run, snapshot: args.snapshot, label: args.label };
}

/** Returns an error message listing every invalid state, or undefined. */
export function validationError(set: VoxelSet, allowUnknown: boolean): string | undefined {
  if (allowUnknown) return undefined;
  const issues = validateSet(set);
  if (!issues.length) return undefined;
  return `Invalid block states (pass allow_unknown_blocks=true to override):\n${issues.map((i) => `  ${i.block}: ${i.message}`).join('\n')}`;
}
```

- [ ] **Step 4: Implement server.ts and server-tools.ts**

`src/server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { Bridge } from './bridge/types.js';
import { VERSION } from './version.js';
import { registerServerTools } from './tools/server-tools.js';

export interface AppContext {
  config: Config;
  bridge: Bridge;
}

const INSTRUCTIONS = `blockwright builds structures on a live Minecraft server over RCON.
Workflow: server_info → get_players (where people are) → get_heightmap (scout the site) → preview (check the design, send the HTML to the user) → build/place_shape/paste_schematic with dry_run=true → the same with dry_run=false → read_region to verify → undo if wrong.
Coordinates: x east, y up, z south. Build specs: rows run north→south (z), characters west→east (x). Every write snapshots first when world access is available.`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: 'blockwright', version: VERSION }, { instructions: INSTRUCTIONS });
  registerServerTools(server, ctx);
  return server;
}
```

`src/tools/server-tools.ts`:
```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { describeConfig } from '../config.js';
import { BlockState, VoxelSet, box, boxVolume, formatVec } from '../voxel/voxels.js';
import { Vec3Schema } from '../voxel/schemas.js';
import { splitBox, prefixDimension } from '../voxel/compile.js';
import { ok, json, fail, errorMessage, formatApplyResult } from './result.js';
import { writeOptionsShape, applyOptionsFrom, validationError } from './common.js';

const DENIED =
  /^\/?\s*(minecraft:)?(stop|restart|op|deop|ban|ban-ip|banlist|pardon|pardon-ip|whitelist|kick|save-off|reload|rl|bukkit:reload|paper:reload)\b|\brun\s+(minecraft:)?(stop|restart|op|deop|ban|ban-ip|pardon|pardon-ip|whitelist|kick|save-off|reload)\b/i;

export function isDenied(command: string): boolean {
  return DENIED.test(command.trim());
}

export function registerServerTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'server_info',
    { title: 'Server info', description: 'Minecraft version, player count, whether world reads/snapshots are available, and the effective blockwright configuration.', inputSchema: {} },
    async () => {
      try {
        return json({ ...(await ctx.bridge.info()), config: describeConfig(ctx.config) });
      } catch (e) {
        return fail(`server_info failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'get_players',
    { title: 'Online players', description: 'Names, worlds, block positions, look direction and gamemode of online players. Use to pick a build site near someone.', inputSchema: {} },
    async () => {
      try {
        return json(await ctx.bridge.players());
      } catch (e) {
        return fail(`get_players failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run console command',
      description: 'Run a raw server console command and return its output. Administrative commands (stop, op, ban, whitelist, kick, reload…) are refused unless BLOCKWRIGHT_ALLOW_ADMIN=1. Prefer the build tools; use this for things like time, weather, tp, give, say.',
      inputSchema: { command: z.string().describe('Command without a leading slash, e.g. "time set day"') },
    },
    async ({ command }) => {
      if (!ctx.config.allowAdmin && isDenied(command)) return fail(`refused: "${command}" is an administrative command. Set BLOCKWRIGHT_ALLOW_ADMIN=1 to allow it.`);
      try {
        const out = await ctx.bridge.runCommand(command);
        return ok(out.trim() || '(no output)');
      } catch (e) {
        return fail(`run_command failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'fill',
    {
      title: 'Fill a box',
      description: 'Fill a box with one block. Modes: replace (optionally only blocks matching replace_filter), keep (only air), destroy (drop items), hollow (walls + air inside), outline (walls only, interior untouched). Splits over the 32768-block command limit automatically.',
      inputSchema: {
        from: Vec3Schema,
        to: Vec3Schema,
        block: z.string().describe('Block state, e.g. "stone" or "oak_log[axis=y]"'),
        mode: z.enum(['replace', 'keep', 'hollow', 'outline', 'destroy']).default('replace'),
        replace_filter: z.string().optional().describe('With mode=replace: only replace blocks matching this state, e.g. "dirt" or "#minecraft:logs"'),
        ...writeOptionsShape,
      },
    },
    async (args) => {
      let state: BlockState;
      try {
        state = BlockState.parse(args.block);
      } catch (e) {
        return fail(errorMessage(e));
      }
      const b = box(args.from, args.to);
      const opts = applyOptionsFrom(args, ctx);
      try {
        if (args.mode === 'hollow' || args.mode === 'outline') {
          const set = new VoxelSet();
          const air = BlockState.parse('air');
          for (let x = b.min[0]; x <= b.max[0]; x++)
            for (let y = b.min[1]; y <= b.max[1]; y++)
              for (let z = b.min[2]; z <= b.max[2]; z++) {
                const edge = x === b.min[0] || x === b.max[0] || y === b.min[1] || y === b.max[1] || z === b.min[2] || z === b.max[2];
                if (edge) set.set(x, y, z, state);
                else if (args.mode === 'hollow') set.set(x, y, z, air);
              }
          const err = validationError(set, args.allow_unknown_blocks);
          if (err) return fail(err);
          return ok(formatApplyResult(await ctx.bridge.apply(set, opts), `fill ${args.mode}`));
        }
        const probe = new VoxelSet();
        probe.set(0, 0, 0, state);
        const err = validationError(probe, args.allow_unknown_blocks);
        if (err) return fail(err);
        const suffix = args.mode === 'replace' ? (args.replace_filter ? ` replace ${args.replace_filter}` : '') : ` ${args.mode}`;
        const commands = splitBox(b, ctx.config.fillLimit).map((p) => prefixDimension(`fill ${formatVec(p.min)} ${formatVec(p.max)} ${state.toCommand()}${suffix}`, opts.world.dimension));
        return ok(formatApplyResult(await ctx.bridge.applyCommands(commands, b, boxVolume(b), opts), `fill ${args.mode}`));
      } catch (e) {
        return fail(`fill failed: ${errorMessage(e)}`);
      }
    },
  );
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/tools/server-tools.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/tools test/tools test/helpers/fake-bridge.ts test/helpers/mcp.ts
git commit -m "feat(mcp): server skeleton with server_info, get_players, run_command, fill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Build tools

**Goal:** `build`, `place_shape`, `paste_schematic`, `schematic_info` and `schematic_write`.

**Files:**
- Create: `src/tools/build-tools.ts`
- Modify: `src/server.ts` (register the group)
- Test: `test/tools/build-tools.test.ts`

**Acceptance Criteria:**
- [ ] `build` places the spec's blocks at origin (rotation honoured), returns the apply summary with a snapshot id, and reports palette errors as tool errors
- [ ] `place_shape` places a sphere with the expected block count
- [ ] `schematic_write` writes a `.schem` from a build spec; `schematic_info` reports its size and palette; `paste_schematic` places it at an origin with `ignore_air`
- [ ] `dry_run` on every write tool leaves the world untouched

**Verify:** `npx vitest run test/tools/build-tools.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/tools/build-tools.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';

let bridge: FakeBridge;
let client: Client;
let schematicDir: string;
beforeEach(async () => {
  bridge = new FakeBridge();
  schematicDir = await mkdtemp(path.join(tmpdir(), 'bw-schem-'));
  client = await connect({ config: testConfig({ schematicDir }), bridge });
});

const hut = {
  origin: [100, 64, 200],
  palette: { '#': 'stone_bricks', s: 'oak_stairs[facing=north]' },
  layers: [
    { y: 0, rows: ['###', '###', '###'] },
    { y: 1, rows: ['s  ', '   ', '   '] },
  ],
};

describe('build', () => {
  it('places blocks and reports a snapshot', async () => {
    const r = await call(client, 'build', hut);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/build: 10 blocks/);
    expect(r.text).toMatch(/Snapshot snap1/);
    expect(bridge.world.get(102, 64, 202)?.toCommand()).toBe('stone_bricks');
    expect(bridge.world.get(100, 65, 200)?.props.facing).toBe('north');
  });
  it('rotates about the min corner', async () => {
    await call(client, 'build', { ...hut, rotation: 90 });
    expect(bridge.world.get(102, 65, 200)?.props.facing).toBe('east');
    expect(bridge.world.bounds()!.min).toEqual([100, 64, 200]);
  });
  it('reports spec errors and validation errors', async () => {
    const bad = await call(client, 'build', { origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['#Q'] }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/character "Q"/);
    const typo = await call(client, 'build', { origin: [0, 0, 0], palette: { '#': 'stone_brick' }, layers: [{ y: 0, rows: ['#'] }] });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/stone_bricks/);
  });
  it('dry run changes nothing', async () => {
    const r = await call(client, 'build', { ...hut, dry_run: true });
    expect(r.text).toMatch(/DRY RUN/);
    expect(bridge.world.size).toBe(0);
  });
});

describe('place_shape', () => {
  it('places a sphere', async () => {
    const r = await call(client, 'place_shape', { shape: 'sphere', center: [0, 70, 0], radius: 2, block: 'glass' });
    expect(r.isError).toBe(false);
    expect(bridge.world.size).toBe(81);
  });
  it('reports missing fields', async () => {
    const r = await call(client, 'place_shape', { shape: 'cylinder', base: [0, 70, 0], radius: 2, block: 'glass' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cylinder needs height/);
  });
});

describe('schematics', () => {
  it('writes, inspects and pastes', async () => {
    const w = await call(client, 'schematic_write', { path: 'hut', build: { ...hut, origin: [0, 0, 0] } });
    expect(w.isError).toBe(false);
    expect(existsSync(path.join(schematicDir, 'hut.schem'))).toBe(true);
    const info = await call(client, 'schematic_info', { path: 'hut' });
    const parsed = JSON.parse(info.text);
    expect(parsed.size).toEqual([3, 2, 3]);
    expect(parsed.format).toBe('sponge');
    expect(parsed.palette['minecraft:stone_bricks']).toBe(9);
    expect(parsed.palette['minecraft:air']).toBe(8);
    const p = await call(client, 'paste_schematic', { path: 'hut', origin: [10, 60, 10], ignore_air: true });
    expect(p.isError).toBe(false);
    expect(bridge.world.size).toBe(10);
    expect(bridge.world.get(10, 61, 10)?.props.facing).toBe('north');
    const withAir = await call(client, 'paste_schematic', { path: 'hut', origin: [50, 60, 50], rotation: 180 });
    expect(withAir.isError).toBe(false);
    expect(bridge.world.get(52, 61, 52)?.props.facing).toBe('south');
    expect(bridge.world.get(50, 61, 50)?.isAir).toBe(true);
  });
  it('reports missing files', async () => {
    const r = await call(client, 'paste_schematic', { path: 'nope', origin: [0, 0, 0] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/nope/);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/tools/build-tools.test.ts`
Expected: FAIL, unknown tool / cannot find module

- [ ] **Step 3: Implement build-tools.ts**

`src/tools/build-tools.ts`:
```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { VoxelSet, type Vec3 } from '../voxel/voxels.js';
import { Vec3Schema, RotationSchema, MirrorSchema } from '../voxel/schemas.js';
import { buildSpecShape, BuildSpecSchema, buildSpecToVoxels, buildSpecToRelativeVoxels } from '../voxel/spec.js';
import { shapeShape, ShapeSpecSchema, shapeToVoxels } from '../voxel/shapes.js';
import { stepsFromDegrees } from '../voxel/rotate.js';
import { clipboardFromVoxels, clipboardVoxelsAt } from '../schematic/clipboard.js';
import { loadClipboard, saveClipboard, resolveSchematicPath } from '../schematic/index.js';
import { ok, json, fail, errorMessage, formatApplyResult } from './result.js';
import { writeOptionsShape, applyOptionsFrom, validationError, type WriteArgs } from './common.js';
import type { ApplyOptions } from '../bridge/types.js';

async function applySet(ctx: AppContext, set: VoxelSet, args: WriteArgs, what: string, extra: Partial<ApplyOptions> = {}) {
  const err = validationError(set, args.allow_unknown_blocks);
  if (err) return fail(err);
  const result = await ctx.bridge.apply(set, { ...applyOptionsFrom(args, ctx), ...extra });
  return ok(formatApplyResult(result, what));
}

export function registerBuildTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'build',
    {
      title: 'Build from ASCII layers',
      description:
        'Place a structure described as layers of characters. palette maps one character to a block state; rows run north→south (z), characters west→east (x); y is height above origin. Space leaves the world alone. Extra single blocks go in "blocks". Rotation keeps the min corner at origin. Run with dry_run=true first, and preview before that.',
      inputSchema: { ...buildSpecShape, ...writeOptionsShape },
    },
    async (args) => {
      try {
        const set = buildSpecToVoxels(BuildSpecSchema.parse(args));
        return await applySet(ctx, set, args, 'build');
      } catch (e) {
        return fail(`build failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'place_shape',
    {
      title: 'Place a geometric shape',
      description: 'Sphere, dome, cylinder, cone, pyramid, line or circle, filled or hollow. Radius r gives a diameter of 2r+1.',
      inputSchema: { ...shapeShape, ...writeOptionsShape },
    },
    async (args) => {
      try {
        const set = shapeToVoxels(ShapeSpecSchema.parse(args));
        return await applySet(ctx, set, args, `place_shape ${args.shape}`);
      } catch (e) {
        return fail(`place_shape failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'paste_schematic',
    {
      title: 'Paste a schematic file',
      description:
        'Paste a Sponge .schem or vanilla structure .nbt. By default origin is where the schematic\'s min corner lands; use_offset=true adds the file\'s stored offset like WorldEdit //paste. ignore_air skips air so the surroundings survive.',
      inputSchema: {
        path: z.string().describe('File name in the schematic dir (extension optional) or an absolute path'),
        origin: Vec3Schema,
        rotation: RotationSchema.default(0),
        mirror: MirrorSchema.default('none'),
        use_offset: z.boolean().default(false),
        ignore_air: z.boolean().default(false),
        ...writeOptionsShape,
      },
    },
    async (args) => {
      try {
        const file = resolveSchematicPath(args.path, ctx.config.schematicDir);
        const clip = await loadClipboard(file);
        const { voxels, blockEntities } = clipboardVoxelsAt(clip, args.origin, { useOffset: args.use_offset, rotation: stepsFromDegrees(args.rotation), mirror: args.mirror, ignoreAir: args.ignore_air });
        return await applySet(ctx, voxels, args, `paste ${args.path}`, { blockEntities });
      } catch (e) {
        return fail(`paste_schematic failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'schematic_info',
    {
      title: 'Inspect a schematic file',
      description: 'Format, size, offset, DataVersion, block counts and block-entity count of a .schem/.nbt file.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => {
      try {
        const file = resolveSchematicPath(p, ctx.config.schematicDir);
        const clip = await loadClipboard(file);
        const palette: Record<string, number> = {};
        for (const [k, n] of [...clip.voxels.counts().entries()].sort((a, b) => b[1] - a[1])) palette[k] = n;
        return json({ file, format: clip.source, size: clip.size, offset: clip.offset, dataVersion: clip.dataVersion, blocks: clip.voxels.size, nonAir: clip.voxels.nonAirCount(), blockEntities: clip.blockEntities.length, palette });
      } catch (e) {
        return fail(`schematic_info failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'schematic_write',
    {
      title: 'Write a schematic file',
      description: 'Save a build spec or a shape as a .schem (Sponge v3) or .nbt (vanilla structure) file without touching any server. Relative paths go to the schematic dir.',
      inputSchema: {
        path: z.string(),
        format: z.enum(['sponge', 'structure']).optional().describe('Defaults from the extension: .nbt → structure, anything else → sponge'),
        build: z.object({ ...buildSpecShape, origin: Vec3Schema.default([0, 0, 0]) }).optional(),
        shape: z.object(shapeShape).optional(),
      },
    },
    async (args) => {
      try {
        if (!args.build && !args.shape) return fail('schematic_write needs either "build" or "shape"');
        const set = args.build ? buildSpecToRelativeVoxels(BuildSpecSchema.parse(args.build)) : shapeToVoxels(ShapeSpecSchema.parse(args.shape));
        const clip = clipboardFromVoxels(set, ctx.config.dataVersion);
        const file = resolveSchematicPath(args.path, ctx.config.schematicDir, true);
        const saved = await saveClipboard(clip, file, args.format);
        return ok(`Wrote ${saved.format} schematic ${saved.path}: size ${clip.size.join('x')}, ${clip.voxels.size} blocks (${clip.voxels.nonAirCount()} non-air).`);
      } catch (e) {
        return fail(`schematic_write failed: ${errorMessage(e)}`);
      }
    },
  );
}

export type { Vec3 };
```

- [ ] **Step 4: Register in server.ts**

In `src/server.ts` add the import and call:
```ts
import { registerBuildTools } from './tools/build-tools.js';
// inside createServer, after registerServerTools(server, ctx):
  registerBuildTools(server, ctx);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/tools`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/tools/build-tools.ts test/tools/build-tools.test.ts
git commit -m "feat(mcp): build, place_shape, paste_schematic, schematic_info, schematic_write

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 16: Read tools and preview

**Goal:** `preview`, `read_region`, `get_block`, `get_heightmap`, `save_schematic`, `undo` and `list_snapshots`.

**Files:**
- Create: `src/tools/read-tools.ts`
- Modify: `src/server.ts` (register the group)
- Test: `test/tools/read-tools.test.ts`

**Acceptance Criteria:**
- [ ] `preview` accepts exactly one of `build`, `shape`, `schematic`; returns ASCII slices and writes an HTML file under `previewDir`, embedding surrounding blocks when `context > 0` and reads are available
- [ ] `read_region` returns counts always and ASCII slices when `full=true` or the box is ≤ 4096 blocks; `get_block` returns one state
- [ ] `get_heightmap` prints a sampled grid of surface heights and the surface-block histogram
- [ ] `save_schematic` writes the region to a file; `undo` restores the newest snapshot(s) and reports them; `list_snapshots` lists them

**Verify:** `npx vitest run test/tools/read-tools.test.ts` → all passed

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/tools/read-tools.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';
import { BlockState } from '../../src/voxel/voxels.js';

let bridge: FakeBridge;
let client: Client;
let previewDir: string;
let schematicDir: string;
beforeEach(async () => {
  bridge = new FakeBridge();
  previewDir = await mkdtemp(path.join(tmpdir(), 'bw-prev-'));
  schematicDir = await mkdtemp(path.join(tmpdir(), 'bw-schem-'));
  client = await connect({ config: testConfig({ previewDir, schematicDir }), bridge });
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) bridge.world.set(x, 63, z, BlockState.parse('grass_block'));
});

const hut = { origin: [1, 64, 1], palette: { '#': 'stone_bricks' }, layers: [{ y: [0, 1], rows: ['###', '# #', '###'] }] };

describe('preview', () => {
  it('renders ASCII and writes HTML with context', async () => {
    const r = await call(client, 'preview', { build: hut, context: 1, title: 'Hut' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Layer y=64/);
    const m = /HTML preview written to (\S+)/.exec(r.text)!;
    expect(existsSync(m[1])).toBe(true);
    const html = await readFile(m[1], 'utf8');
    expect(html).toContain('<title>Hut</title>');
    expect(html).toContain('"minecraft:grass_block"');
    expect(html).toMatch(/"context":\[\[/);
  });
  it('previews shapes and schematics and requires exactly one input', async () => {
    const s = await call(client, 'preview', { shape: { shape: 'sphere', center: [0, 70, 0], radius: 1, block: 'glass' } });
    expect(s.text).toMatch(/19 blocks/);
    const none = await call(client, 'preview', {});
    expect(none.isError).toBe(true);
    const two = await call(client, 'preview', { build: hut, shape: { shape: 'sphere', center: [0, 70, 0], radius: 1, block: 'glass' } });
    expect(two.isError).toBe(true);
  });
  it('warns about invalid blocks but still previews', async () => {
    const r = await call(client, 'preview', { build: { ...hut, palette: { '#': 'stone_brick' } } });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Invalid block states/);
  });
});

describe('reading the world', () => {
  it('read_region, get_block and get_heightmap', async () => {
    await call(client, 'build', hut);
    const full = await call(client, 'read_region', { from: [1, 64, 1], to: [3, 65, 3] });
    expect(full.text).toMatch(/stone_bricks \(16\)/);
    expect(full.text).toMatch(/Layer y=64/);
    const big = await call(client, 'read_region', { from: [0, 0, 0], to: [40, 40, 40] });
    expect(big.text).not.toMatch(/Layer y=/);
    expect(big.text).toMatch(/full=true/);
    const one = await call(client, 'get_block', { pos: [1, 64, 1] });
    expect(one.text).toBe('minecraft:stone_bricks');
    const air = await call(client, 'get_block', { pos: [2, 64, 2] });
    expect(air.text).toBe('minecraft:air');
    const hm = await call(client, 'get_heightmap', { from: [0, 0], to: [3, 3] });
    expect(hm.text).toMatch(/surface y from 63 to 65/);
    expect(hm.text).toMatch(/stone_bricks/);
    expect(hm.text).toMatch(/65 65 65/);
  });
  it('save_schematic writes the region', async () => {
    await call(client, 'build', hut);
    const r = await call(client, 'save_schematic', { from: [1, 64, 1], to: [3, 65, 3], path: 'saved' });
    expect(r.isError).toBe(false);
    expect(existsSync(path.join(schematicDir, 'saved.schem'))).toBe(true);
    const info = await call(client, 'schematic_info', { path: 'saved' });
    expect(JSON.parse(info.text).palette['minecraft:stone_bricks']).toBe(16);
  });
  it('undo restores snapshots newest first and list_snapshots shows them', async () => {
    await call(client, 'build', { ...hut, label: 'first' });
    await call(client, 'build', { ...hut, origin: [10, 64, 10], label: 'second' });
    const list = await call(client, 'list_snapshots');
    expect(JSON.parse(list.text).map((s: { label: string }) => s.label)).toEqual(['second', 'first']);
    const u = await call(client, 'undo');
    expect(u.text).toMatch(/Restored 1 snapshot/);
    expect(u.text).toMatch(/second/);
    expect(bridge.world.get(10, 64, 10)?.isAir).toBe(true);
    expect(bridge.world.get(1, 64, 1)?.toCommand()).toBe('stone_bricks');
    await call(client, 'undo', { steps: 5 });
    expect(bridge.world.get(1, 64, 1)?.isAir).toBe(true);
    const none = await call(client, 'undo');
    expect(none.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/tools/read-tools.test.ts`
Expected: FAIL, unknown tools

- [ ] **Step 3: Implement read-tools.ts**

`src/tools/read-tools.ts`:
```ts
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { VoxelSet, box, boxExpand, boxVolume, type Box } from '../voxel/voxels.js';
import { Vec3Schema, Vec2Schema, RotationSchema, MirrorSchema, WorldSchema } from '../voxel/schemas.js';
import { buildSpecShape, BuildSpecSchema, buildSpecToVoxels } from '../voxel/spec.js';
import { shapeShape, ShapeSpecSchema, shapeToVoxels } from '../voxel/shapes.js';
import { stepsFromDegrees } from '../voxel/rotate.js';
import { clipboardFromVoxels, clipboardVoxelsAt } from '../schematic/clipboard.js';
import { loadClipboard, saveClipboard, resolveSchematicPath } from '../schematic/index.js';
import { resolveWorld } from '../world/dimension.js';
import { validateSet } from '../blocks/registry.js';
import { renderAscii } from '../preview/ascii.js';
import { renderHtml } from '../preview/html.js';
import { ok, json, fail, errorMessage } from './result.js';

const KEEP_PREVIEWS = 30;

async function writePreview(ctx: AppContext, html: string): Promise<string> {
  await fs.mkdir(ctx.config.previewDir, { recursive: true });
  const file = path.join(ctx.config.previewDir, `preview-${Date.now().toString(36)}.html`);
  await fs.writeFile(file, html);
  const entries = (await fs.readdir(ctx.config.previewDir)).filter((f) => f.startsWith('preview-')).sort();
  for (const old of entries.slice(0, Math.max(0, entries.length - KEEP_PREVIEWS))) await fs.rm(path.join(ctx.config.previewDir, old), { force: true });
  return file;
}

function clampY(b: Box): Box {
  return { min: [b.min[0], Math.max(b.min[1], -64), b.min[2]], max: [b.max[0], Math.min(b.max[1], 319), b.max[2]] };
}

export function registerReadTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'preview',
    {
      title: 'Preview a build before placing it',
      description:
        'Render a build spec, a shape, or a schematic as ASCII layer slices (returned) and as a self-contained 3D HTML viewer (path returned; send that file to the user). Set context>0 to include the surrounding world blocks so the design is shown in place. Nothing is changed in the world.',
      inputSchema: {
        build: z.object(buildSpecShape).optional(),
        shape: z.object(shapeShape).optional(),
        schematic: z
          .object({ path: z.string(), origin: Vec3Schema, rotation: RotationSchema.default(0), mirror: MirrorSchema.default('none'), use_offset: z.boolean().default(false), ignore_air: z.boolean().default(false) })
          .optional(),
        context: z.number().int().min(0).max(32).default(0).describe('Blocks of surrounding world to include around the build box (needs world read access)'),
        world: WorldSchema.optional(),
        max_layers: z.number().int().min(1).max(64).default(12),
        title: z.string().optional(),
      },
    },
    async (args) => {
      const given = [args.build, args.shape, args.schematic].filter(Boolean).length;
      if (given !== 1) return fail('preview needs exactly one of "build", "shape" or "schematic"');
      try {
        let set: VoxelSet;
        let title = args.title ?? 'Blockwright preview';
        if (args.build) set = buildSpecToVoxels(BuildSpecSchema.parse(args.build));
        else if (args.shape) set = shapeToVoxels(ShapeSpecSchema.parse(args.shape));
        else {
          const s = args.schematic!;
          const clip = await loadClipboard(resolveSchematicPath(s.path, ctx.config.schematicDir));
          set = clipboardVoxelsAt(clip, s.origin, { useOffset: s.use_offset, rotation: stepsFromDegrees(s.rotation), mirror: s.mirror, ignoreAir: s.ignore_air }).voxels;
          if (!args.title) title = `Preview of ${s.path}`;
        }
        const lines: string[] = [];
        const issues = validateSet(set);
        if (issues.length) lines.push('Invalid block states (the server would reject these):', ...issues.map((i) => `  ${i.block}: ${i.message}`), '');
        let context: VoxelSet | undefined;
        if (args.context > 0) {
          if (ctx.bridge.canRead()) {
            const world = resolveWorld(args.world, ctx.config.levelName);
            const around = clampY(boxExpand(set.bounds()!, args.context));
            context = (await ctx.bridge.read(around, world)).voxels;
          } else lines.push('(context requested but world reads are unavailable; showing the build alone)', '');
        }
        lines.push(renderAscii(set, { maxLayers: args.max_layers }).text);
        const file = await writePreview(ctx, renderHtml(set, { title, context }));
        lines.push('', `HTML preview written to ${file} — send this file to the user (it opens offline; drag to pan, wheel to zoom, slider to peel layers).`);
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(`preview failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'read_region',
    {
      title: 'Read blocks from the world',
      description: 'Block counts for a box, plus ASCII layer slices when the box is small (≤4096 blocks) or full=true. Use after building to verify the result.',
      inputSchema: { from: Vec3Schema, to: Vec3Schema, world: WorldSchema.optional(), full: z.boolean().default(false), max_layers: z.number().int().min(1).max(64).default(12) },
    },
    async (args) => {
      try {
        const b = box(args.from, args.to);
        const world = resolveWorld(args.world, ctx.config.levelName);
        const r = await ctx.bridge.read(b, world);
        const lines: string[] = [];
        if (r.missingChunks) lines.push(`${r.missingChunks} chunk(s) in this box are not generated yet; their blocks are omitted.`);
        if (r.blockEntities.length) lines.push(`Block entities: ${r.blockEntities.slice(0, 20).map((be) => `${be.id.replace('minecraft:', '')}@(${be.pos.join(',')})`).join(', ')}${r.blockEntities.length > 20 ? ' …' : ''}`);
        if (args.full || boxVolume(b) <= 4096) lines.push(renderAscii(r.voxels, { maxLayers: args.max_layers }).text);
        else {
          const counts = [...r.voxels.counts().entries()].sort((x, y) => y[1] - x[1]);
          lines.push(`Box (${b.min.join(', ')}) to (${b.max.join(', ')}), ${boxVolume(b)} blocks. Counts: ${counts.map(([k, n]) => `${k.replace('minecraft:', '')} (${n})`).join(', ')}`);
          lines.push('Pass full=true for layer slices of a box this large.');
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(`read_region failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'get_block',
    { title: 'Read one block', description: 'The block state at a position.', inputSchema: { pos: Vec3Schema, world: WorldSchema.optional() } },
    async (args) => {
      try {
        const world = resolveWorld(args.world, ctx.config.levelName);
        const r = await ctx.bridge.read({ min: args.pos, max: args.pos }, world);
        const s = r.voxels.get(args.pos[0], args.pos[1], args.pos[2]);
        if (!s) return fail(`chunk at ${args.pos.join(', ')} is not generated`);
        const be = r.blockEntities[0];
        return ok(s.toString() + (be ? ` (block entity ${be.id})` : ''));
      } catch (e) {
        return fail(`get_block failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'get_heightmap',
    {
      title: 'Surface heightmap',
      description: 'Surface y and surface block for an x/z rectangle, as a sampled grid (rows = z north→south, columns = x west→east). The site-scouting tool: find flat ground and the y to build at (surface y + 1).',
      inputSchema: {
        from: Vec2Schema.describe('[x, z]'),
        to: Vec2Schema.describe('[x, z]'),
        world: WorldSchema.optional(),
        sample: z.number().int().min(1).optional().describe('Print every Nth column/row; default keeps the grid within 48×48'),
      },
    },
    async (args) => {
      try {
        const world = resolveWorld(args.world, ctx.config.levelName);
        const minX = Math.min(args.from[0], args.to[0]);
        const maxX = Math.max(args.from[0], args.to[0]);
        const minZ = Math.min(args.from[1], args.to[1]);
        const maxZ = Math.max(args.from[1], args.to[1]);
        const r = await ctx.bridge.heightmap(minX, minZ, maxX, maxZ, world);
        const step = args.sample ?? Math.max(1, Math.ceil(Math.max(maxX - minX + 1, maxZ - minZ + 1) / 48));
        const all = r.heights.flat().filter((h): h is number => h !== null);
        if (!all.length) return fail('no generated chunks in that rectangle');
        const lo = Math.min(...all);
        const hi = Math.max(...all);
        const mean = all.reduce((a, b) => a + b, 0) / all.length;
        const hist = new Map<string, number>();
        for (const row of r.surface) for (const s of row) if (s) hist.set(s, (hist.get(s) ?? 0) + 1);
        const lines = [
          `Heightmap x ${minX}..${maxX}, z ${minZ}..${maxZ} (${world.label}): surface y from ${lo} to ${hi}, mean ${mean.toFixed(1)}. Build on top at y=${hi + 1} for level ground, or terraform first.`,
          `Surface blocks: ${[...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`).join(', ')}`,
        ];
        if (r.missingChunks) lines.push(`${r.missingChunks} chunk(s) not generated (shown as --).`);
        lines.push(`Grid every ${step} block(s); rows z=${minZ}.. downwards, columns x=${minX}.. rightwards:`);
        for (let zi = 0; zi < r.heights.length; zi += step) {
          const row: string[] = [];
          for (let xi = 0; xi < r.heights[zi].length; xi += step) {
            const h = r.heights[zi][xi];
            row.push(h === null ? '--' : String(h));
          }
          lines.push(`  z=${String(minZ + zi).padStart(6)} | ${row.join(' ')}`);
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(`get_heightmap failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'save_schematic',
    {
      title: 'Save a world region to a schematic file',
      description: 'Copy a box from the world into a .schem (Sponge v3) or .nbt (structure) file, block entities included.',
      inputSchema: { from: Vec3Schema, to: Vec3Schema, path: z.string(), format: z.enum(['sponge', 'structure']).optional(), world: WorldSchema.optional() },
    },
    async (args) => {
      try {
        const b = box(args.from, args.to);
        const world = resolveWorld(args.world, ctx.config.levelName);
        const r = await ctx.bridge.read(b, world);
        const clip = clipboardFromVoxels(r.voxels, ctx.config.dataVersion, r.blockEntities);
        const saved = await saveClipboard(clip, resolveSchematicPath(args.path, ctx.config.schematicDir, true), args.format);
        return ok(`Saved ${saved.format} schematic ${saved.path}: size ${clip.size.join('x')}, ${clip.voxels.nonAirCount()} non-air blocks, ${clip.blockEntities.length} block entities.`);
      } catch (e) {
        return fail(`save_schematic failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'list_snapshots',
    { title: 'List snapshots', description: 'Snapshots taken before writes, newest first, with ids for undo.', inputSchema: {} },
    async () => {
      try {
        return json(await ctx.bridge.listSnapshots());
      } catch (e) {
        return fail(`list_snapshots failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo recent writes',
      description: 'Restore the newest snapshot(s) taken before writes (or a specific id from list_snapshots). Each restored snapshot is removed from the list.',
      inputSchema: { steps: z.number().int().min(1).max(20).default(1), id: z.string().optional() },
    },
    async (args) => {
      try {
        const targets = args.id ? [args.id] : (await ctx.bridge.listSnapshots()).slice(0, args.steps).map((s) => s.id);
        if (!targets.length) return fail('No snapshots available to undo.');
        const lines: string[] = [];
        for (const id of targets) {
          const { record } = await ctx.bridge.restore(id);
          lines.push(`  ${record.id}${record.label ? ` "${record.label}"` : ''}: (${record.box.min.join(', ')}) to (${record.box.max.join(', ')}) in ${record.world}, taken ${record.createdAt}`);
        }
        return ok([`Restored ${targets.length} snapshot(s):`, ...lines].join('\n'));
      } catch (e) {
        return fail(`undo failed: ${errorMessage(e)}`);
      }
    },
  );
}
```

- [ ] **Step 4: Register in server.ts**

In `src/server.ts` add:
```ts
import { registerReadTools } from './tools/read-tools.js';
// inside createServer, after registerBuildTools(server, ctx):
  registerReadTools(server, ctx);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/tools`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/tools/read-tools.ts test/tools/read-tools.test.ts
git commit -m "feat(mcp): preview, read_region, get_block, get_heightmap, save_schematic, undo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: Prompt, resource, entry point, README

**Goal:** The `build-workflow` prompt and palette guide resource, the real `src/index.ts` that starts the stdio server, a stdio smoke test, the README, and an example Claude Code config.

**Files:**
- Create: `src/tools/prompts.ts`, `.mcp.example.json`
- Modify: `src/server.ts`, `src/index.ts`, `README.md`, `.gitignore`
- Test: `test/stdio.test.ts`

**Acceptance Criteria:**
- [ ] `listPrompts` includes `build-workflow`; `listResources` includes `blockwright://guide/palettes` and reading it returns text
- [ ] Spawning `src/index.ts` over stdio with only `BLOCKWRIGHT_RCON_PASSWORD` set lists 16 tools, and `server_info` returns a tool error mentioning the RCON connection (no server is running)
- [ ] `node dist/index.js --version` still prints the version
- [ ] README documents quick start, every env var, every tool, safety notes and the Matsuri example

**Verify:** `npm run build && npm test` → all passed, and `node dist/index.js --version` → `blockwright 0.1.0`

**Steps:**

- [ ] **Step 1: Write the failing tests**

`test/stdio.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

describe('stdio server', () => {
  it('starts, lists tools, prompts and resources, and reports RCON errors as tool errors', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/index.ts'],
      env: { ...process.env, BLOCKWRIGHT_RCON_PASSWORD: 'x', BLOCKWRIGHT_RCON_PORT: '1' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(
        ['build', 'fill', 'get_block', 'get_heightmap', 'get_players', 'list_snapshots', 'paste_schematic', 'place_shape', 'preview', 'read_region', 'run_command', 'save_schematic', 'schematic_info', 'schematic_write', 'server_info', 'undo'].sort(),
      );
      expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain('build-workflow');
      const resources = (await client.listResources()).resources.map((r) => r.uri);
      expect(resources).toContain('blockwright://guide/palettes');
      const guide = await client.readResource({ uri: 'blockwright://guide/palettes' });
      expect(JSON.stringify(guide.contents)).toMatch(/stone_bricks/);
      const r = (await client.callTool({ name: 'server_info', arguments: {} })) as CallToolResult;
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/RCON connect/);
    } finally {
      await client.close();
    }
  }, 30000);
});
```

- [ ] **Step 2: Run to see failure**

Run: `npx vitest run test/stdio.test.ts`
Expected: FAIL (the entry exits with code 1 / no prompts)

- [ ] **Step 3: Implement prompts.ts**

`src/tools/prompts.ts`:
```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';

export const PALETTE_GUIDE = `# Blockwright palette and proportion guide

## Proportions
- Doors need 2 blocks of height; comfortable rooms are 3-4 blocks high inside, 5+ for halls.
- Walls read best at 5-9 blocks wide per bay; break long walls with pillars every 4-6 blocks.
- Roofs: stairs at a 1:1 slope, overhang 1 block past the wall. Use slabs at the ridge.
- Windows: 1x2 with a slab sill or fence below reads as a real window.

## Palettes (mix 60/30/10)
- Medieval: stone_bricks + cobblestone + oak_planks/oak_log frames, dark_oak_stairs roof, glass_pane windows.
- Japanese: dark_oak_planks/logs, white_concrete or quartz walls, deepslate_tile_stairs or dark_prismarine roofs, lanterns, red_concrete torii.
- Modern: white_concrete + smooth_quartz + gray_concrete accents, glass (not panes), stripped_oak_log warmth.
- Desert: sandstone + cut_sandstone + smooth_sandstone, terracotta accents, birch or acacia wood.
- Nordic: spruce_planks/logs, cobblestone base, stone_brick_stairs roof, dark_oak trim.
- Nether: blackstone + polished_blackstone_bricks, crimson_planks, soul_lantern, gilded_blackstone accents.

## Texturing
- Never leave a 4x4 patch of one block; mix 2-3 similar blocks (stone_bricks + cracked_stone_bricks + mossy_stone_bricks).
- Depth: push windows in one block, pull pillars out one block.
- Lighting: lanterns (hanging=true under overhangs), sea_lantern behind glass, never bare torches on finished builds.

## Block-state cheatsheet
- Stairs: facing = direction the *full-height* side faces away from; half=top for upside-down.
- Logs: axis=x/y/z. Slabs: type=top|bottom|double. Doors: half=lower|upper, hinge=left|right, facing.
- Fences/walls/panes connect automatically on the server; you do not need to set north/east/south/west.
- Lanterns: hanging=true|false. Torches on walls are wall_torch[facing=…].
`;

export function registerPrompts(server: McpServer, ctx: AppContext): void {
  server.registerPrompt(
    'build-workflow',
    {
      title: 'Build workflow',
      description: 'Step-by-step workflow for building something on the server safely: scout, preview, dry run, build, verify, undo.',
      argsSchema: { goal: z.string().optional().describe('What to build and roughly where') },
    },
    ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Build the following on the Minecraft server: ${goal ?? '(ask the user what to build)'}.

Follow this workflow with the blockwright tools:
1. server_info, then get_players to see where people are. Never build inside another player's base without being asked.
2. get_heightmap over the candidate site to find flat ground and the surface y. Build at surface y + 1, or terraform with fill first.
3. Read the resource blockwright://guide/palettes and choose a palette and proportions.
4. Write a build spec (ASCII layers) or use place_shape. Call preview with context=6 and send the HTML file to the user. Adjust until it looks right.
5. Call build with dry_run=true, check the block count and box, then build for real. Big builds: split into named steps (label each).
6. read_region over the build box to verify; fix mistakes with small build calls; use undo if a step went wrong.
7. Report what was built, the coordinates, and how to undo it.

Level name: ${ctx.config.levelName}. World reads ${ctx.bridge.canRead() ? 'are available' : 'are NOT available (no BLOCKWRIGHT_SERVER_DIR); skip steps that read the world and warn the user that undo is unavailable'}.`,
          },
        },
      ],
    }),
  );

  server.registerResource('palette-guide', 'blockwright://guide/palettes', { title: 'Palette and proportion guide', description: 'Block palettes per style, proportions, texturing and block-state cheatsheet', mimeType: 'text/markdown' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: PALETTE_GUIDE }],
  }));
}
```

In `src/server.ts` add:
```ts
import { registerPrompts } from './tools/prompts.js';
// inside createServer, after registerReadTools(server, ctx):
  registerPrompts(server, ctx);
```

- [ ] **Step 4: Replace src/index.ts**

`src/index.ts`:
```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { RconClient } from './rcon/client.js';
import { RconBridge } from './bridge/rcon-bridge.js';
import { createServer } from './server.js';
import { NAME, VERSION } from './version.js';

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`${NAME} ${VERSION}`);
    return;
  }
  const config = await loadConfig();
  const rcon = new RconClient({ host: config.rcon.host, port: config.rcon.port, password: config.rcon.password });
  const bridge = new RconBridge({ rcon, config });
  const server = createServer({ config, bridge });
  await server.connect(new StdioServerTransport());
  console.error(`${NAME} ${VERSION} ready: RCON ${config.rcon.host}:${config.rcon.port}, world reads ${bridge.canRead() ? 'enabled' : 'disabled'}, level "${config.levelName}"`);
  const shutdown = async (): Promise<void> => {
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  console.error(`${NAME}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
```

The RCON connection is lazy: the first tool call connects, so the server starts even while Minecraft is down and tool calls return the connection error.

- [ ] **Step 5: Example config, gitignore, README**

`.mcp.example.json` (copy to `.mcp.json`, which is gitignored, and adjust paths):
```json
{
  "mcpServers": {
    "blockwright": {
      "command": "node",
      "args": ["/home/thathunky/repos/blockwright/dist/index.js"],
      "env": {
        "BLOCKWRIGHT_SERVER_DIR": "/home/thathunky/games/servers/matsuri",
        "BLOCKWRIGHT_PREVIEW_DIR": "/home/thathunky/repos/blockwright/.blockwright-previews"
      }
    }
  }
}
```

Append to `.gitignore`:
```
.mcp.json
```

`README.md`:
```markdown
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

Then ask: *"Scout a flat spot near me and build a small stone cottage. Preview first."*

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BLOCKWRIGHT_SERVER_DIR` | — | Server folder. Enables reading `server.properties`, `level.dat`, region files, WorldEdit's schematic folder, and the structure-template path used for big pastes and snapshots |
| `BLOCKWRIGHT_RCON_HOST` | `127.0.0.1` | |
| `BLOCKWRIGHT_RCON_PORT` | from `server.properties`, else `25575` | |
| `BLOCKWRIGHT_RCON_PASSWORD` | from `server.properties` | Required one way or the other |
| `BLOCKWRIGHT_WORLD` | `level-name`, else `world` | Overworld folder name |
| `BLOCKWRIGHT_BOUNDS` | — | `x1,y1,z1,x2,y2,z2`; writes outside this box are refused |
| `BLOCKWRIGHT_FILL_LIMIT` | `32768` | Blocks per `fill`, match `commandModificationBlockLimit` if you changed it |
| `BLOCKWRIGHT_STRUCTURE_THRESHOLD` | `400` | Above this many commands, a build is placed as structure templates instead |
| `BLOCKWRIGHT_TEMPLATE_MAX` | `48` | Template tile size |
| `BLOCKWRIGHT_SCHEMATIC_DIR` | `plugins/WorldEdit/schematics` if present, else cwd | Where relative schematic paths resolve |
| `BLOCKWRIGHT_PREVIEW_DIR` | `~/.cache/blockwright/previews` | Where preview HTML files go |
| `BLOCKWRIGHT_DATA_VERSION`, `BLOCKWRIGHT_MC_VERSION` | from `level.dat` | Override when there is no server folder |
| `BLOCKWRIGHT_ALLOW_ADMIN` | unset | Lets `run_command` run stop/op/ban/whitelist/kick/reload |
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
```

- [ ] **Step 6: Build and run all tests**

Run: `npm run build && npm test && node dist/index.js --version`
Expected: all tests pass, then `blockwright 0.1.0`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: stdio entry point, build-workflow prompt, palette guide, README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 18: Live verification on Matsuri and the demo build

**Goal:** Run the whole loop against the real server at the demo plot (heightmap → preview in place → dry run → build → read back → undo → read back), then leave a small demo build for the user to see in BlueMap.

**Files:**
- Create: `scripts/integration.ts`, `.mcp.json` (local, gitignored)
- Modify: `docs/superpowers/specs/2026-09-08-blockwright-design.md` only if a measured fact contradicts it

**Acceptance Criteria:**
- [ ] `npm run integration` exits 0 and prints `INTEGRATION OK`
- [ ] The heightmap step reports surface y=63 at (-147, 181) (grass) and the cube is built at y 64..68
- [ ] After `undo`, `read_region` shows zero `stone_bricks` in the cube box and `short_grass` back at (-147, 64, 181)
- [ ] The demo torii stands at the plot afterwards and is visible in BlueMap

**Verify:** `npm run integration` → last line `INTEGRATION OK`

**Steps:**

- [ ] **Step 1: Local Claude Code config**

```bash
cp .mcp.example.json .mcp.json
```
(`.mcp.json` is gitignored; it points at `/home/thathunky/games/servers/matsuri`, whose `server.properties` holds the RCON password, so no secret enters the repo.)

- [ ] **Step 2: Write the integration script**

`scripts/integration.ts`:
```ts
/* Live test against a real server. Run: BLOCKWRIGHT_INTEGRATION=1 BLOCKWRIGHT_SERVER_DIR=/path/to/server npx tsx scripts/integration.ts */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

if (process.env.BLOCKWRIGHT_INTEGRATION !== '1') {
  console.log('set BLOCKWRIGHT_INTEGRATION=1 to run against a real server');
  process.exit(0);
}
const serverDir = process.env.BLOCKWRIGHT_SERVER_DIR ?? '/home/thathunky/games/servers/matsuri';
const X = Number(process.env.BW_PLOT_X ?? -147);
const Z = Number(process.env.BW_PLOT_Z ?? 181);

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: { ...process.env, BLOCKWRIGHT_SERVER_DIR: serverDir }, stderr: 'inherit' });
const client = new Client({ name: 'integration', version: '0.0.0' });

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`\n== ${name} ${JSON.stringify(args).slice(0, 120)}\n${text.slice(0, 1500)}`);
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

await client.connect(transport);
try {
  const info = JSON.parse(await call('server_info'));
  expect(info.canRead === true, 'world reads must be available (BLOCKWRIGHT_SERVER_DIR)');

  const hm = await call('get_heightmap', { from: [X - 3, Z - 3], to: [X + 8, Z + 8] });
  const surface = Number(/surface y from (\d+)/.exec(hm)![1]);
  expect(surface >= 60 && surface <= 70, `surface y ${surface} looks wrong for the plot`);
  const y = Number(/Build on top at y=(\d+)/.exec(hm)![1]);

  const cube = { origin: [X, y, Z], palette: { '#': 'stone_bricks', '.': 'air' }, layers: [{ y: 0, rows: ['#####', '#####', '#####', '#####', '#####'] }, { y: [1, 3], rows: ['#####', '#...#', '#...#', '#...#', '#####'] }, { y: 4, rows: ['#####', '#####', '#####', '#####', '#####'] }] };
  const preview = await call('preview', { build: cube, context: 4, title: 'Integration cube' });
  expect(/HTML preview written to/.test(preview), 'preview must write HTML');

  const dry = await call('build', { ...cube, dry_run: true });
  expect(/DRY RUN/.test(dry) && /125 blocks/.test(dry), 'dry run must report 125 blocks');

  const built = await call('build', { ...cube, label: 'integration cube' });
  expect(/Snapshot \w+ taken/.test(built), 'build must take a snapshot');
  expect(!/failed/.test(built), 'no command may fail');

  const after = await call('read_region', { from: [X, y, Z], to: [X + 4, y + 4, Z + 4] });
  expect(/stone_bricks \(98\)/.test(after), 'cube must have 98 stone bricks');
  expect(/air \(27\)/.test(after), 'cube must have 27 air inside');

  const undone = await call('undo');
  expect(/Restored 1 snapshot/.test(undone), 'undo must restore one snapshot');

  const restored = await call('read_region', { from: [X, y, Z], to: [X + 4, y + 4, Z + 4] });
  expect(!/stone_bricks/.test(restored), 'no stone bricks may remain after undo');
  const block = await call('get_block', { pos: [X, y, Z] });
  console.log('block at the corner after undo:', block);

  console.log('\nINTEGRATION OK');
} finally {
  await client.close();
}
```

- [ ] **Step 3: Run it**

Run: `npm run build && npm run integration`
Expected: each tool's output printed, ending with `INTEGRATION OK`. If `place template` reports `There is no template with ID`, check that the file landed in `world/generated/blockwright/structure/` (the path is verified for 26.2; older servers may use `structures`, in which case add the fallback to `generatedDir()` and note it in the spec).

- [ ] **Step 4: Demo build**

Start Claude Code in `~/repos/blockwright` (so `.mcp.json` is picked up), and ask it to build the demo through the tools, or run the same calls from a scratch script. The demo spec, a small torii gate with two lanterns at the plot:

```json
{
  "origin": [-147, 64, 181],
  "palette": { "R": "red_concrete", "B": "black_concrete", "L": "lantern[hanging=true]", "S": "polished_deepslate", "s": "polished_deepslate_slab[type=bottom]" },
  "layers": [
    { "y": 0, "rows": ["S       S", "         ", "         ", "S       S"] },
    { "y": [1, 4], "rows": ["R       R", "         ", "         ", "R       R"] },
    { "y": 5, "rows": ["RRRRRRRRR", "         ", "         ", "RRRRRRRRR"] },
    { "y": 6, "rows": ["R       R", "         ", "         ", "R       R"] },
    { "y": 7, "rows": ["BBBBBBBBB", "         ", "         ", "BBBBBBBBB"] },
    { "y": 8, "rows": ["sBBBBBBBs", "         ", "         ", "sBBBBBBBs"] }
  ],
  "blocks": [ { "pos": [2, 4, 0], "block": "lantern[hanging=true]" }, { "pos": [6, 4, 0], "block": "lantern[hanging=true]" }, { "pos": [2, 4, 3], "block": "lantern[hanging=true]" }, { "pos": [6, 4, 3], "block": "lantern[hanging=true]" } ],
  "label": "demo torii"
}
```

Preview it with `context: 6`, send the HTML to the user, then build it. Leave it in place. Tell the user the coordinates and that `undo` (or `list_snapshots` + `undo` with the id) removes it.

- [ ] **Step 5: Commit**

```bash
git add scripts/integration.ts
git commit -m "test: live integration script against a real server

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 19: Publish to GitHub

**Goal:** The repository is public at `ThatHunky/blockwright` with the full history pushed.

**Files:** none new

**Acceptance Criteria:**
- [ ] `gh repo view ThatHunky/blockwright --json visibility` reports `PUBLIC`
- [ ] `git status` is clean and `origin/main` matches local `main`
- [ ] `npx -y github:ThatHunky/blockwright --version` prints `blockwright 0.1.0` from a fresh directory

**Verify:** `cd /tmp && npx -y github:ThatHunky/blockwright --version` → `blockwright 0.1.0`

**Steps:**

- [ ] **Step 1: Create and push**

```bash
cd ~/repos/blockwright
gh repo create ThatHunky/blockwright --public --source=. --remote=origin --push \
  --description "MCP server that builds structures on a live Minecraft server over RCON: preview, build, read back, undo. No client mod, no bot."
gh repo edit ThatHunky/blockwright --add-topic minecraft --add-topic mcp --add-topic model-context-protocol --add-topic rcon --add-topic schematic --add-topic paper
```

- [ ] **Step 2: Verify the npx path**

```bash
cd /tmp && npx -y github:ThatHunky/blockwright --version
```
Expected: `blockwright 0.1.0` (npm clones, runs `prepare` → `tsc`, then executes the bin).

- [ ] **Step 3: Report**

Tell the user the repo URL, the demo coordinates, and how to wire the server into Claude Code (`.mcp.example.json`).

---

## Phase 2 (separate plan)

The Paper plugin and `PluginBridge` follow the HTTP contract in the spec ("Paper plugin (Tier 2)") and get their own plan once Phase 1 ships. Nothing in Phase 1 needs changing for it: `Bridge` is the seam, `index.ts` picks the bridge, and every tool already goes through it.

## Self-review notes

- Spec coverage: every tool in the spec's table is implemented (Tasks 14-16); `list_snapshots` is an addition beyond the spec so `undo` by id is usable. Compiler, forceload, structure path, region reads, snapshots, previews with context, prompts, resource, config, safety denylist, bounds and README are all covered. The plugin tier is deliberately out of scope here.
- Known simplification: the command path ignores block entities (sign text, chest contents) when pasting; the structure path places them. The spec lists authoring tile-entity contents as a non-goal, and snapshots/restores carry them through, so nothing is lost.
- Type consistency checked across tasks: `Bridge.applyCommands(commands, box, blocks, opts)`, `ApplyOptions.label`, `Clipboard.source`, `readHeightmap` returning `chunks`, `resolveSchematicPath(input, dir, forWrite)`.
