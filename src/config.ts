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
  // Fields are trimmed before parsing; an empty field (trailing/doubled comma, or
  // whitespace-only) becomes NaN rather than Number('') === 0, so it fails the
  // integer check below instead of silently zeroing out an edge of the fence.
  const fields = text.split(',').map((s) => s.trim());
  const nums = fields.map((s) => (s === '' ? NaN : Number(s)));
  if (fields.length !== 6 || nums.some((n) => !Number.isInteger(n))) {
    throw new Error(`BLOCKWRIGHT_BOUNDS must be "x1,y1,z1,x2,y2,z2", got "${text}"`);
  }
  return box([nums[0], nums[1], nums[2]], [nums[3], nums[4], nums[5]]);
}

export async function readLevelVersion(levelDat: string): Promise<{ dataVersion: number; name: string } | undefined> {
  // A missing world/level.dat is normal (e.g. the world hasn't been generated yet) and
  // stays quiet. A *present* but unreadable/corrupt file is unusual and worth a warning,
  // since it silently changes which DataVersion blockwright assumes for this world.
  if (!existsSync(levelDat)) return undefined;
  try {
    const root = (await parseNbt(await fs.readFile(levelDat))).value as CompoundValue;
    const data = compound(root, 'Data');
    if (!data) throw new Error('missing Data compound');
    const version = compound(data, 'Version');
    return { dataVersion: num(data, 'DataVersion', DEFAULT_DATA_VERSION), name: version ? str(version, 'Name', DEFAULT_MC_VERSION) : DEFAULT_MC_VERSION };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`blockwright: warning: ${levelDat} could not be read (${reason}); falling back to default DataVersion\n`);
    return undefined;
  }
}

function intEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${key} must be an integer, got "${v}"`);
  return n;
}

/** Same integer validation as intEnv, but for a value sourced from server.properties, whose
 * default (rcon.port) is computed before intEnv runs and must not silently become NaN. */
function intProp(props: Record<string, string>, key: string, def: number, propsPath: string | undefined): number {
  const v = props[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${propsPath ?? 'server.properties'}: ${key} must be an integer, got "${v}"`);
  return n;
}

/**
 * rcon.port's default comes from server.properties rather than a plain number, and that
 * default must only be computed (and validated) when the env var doesn't already win —
 * otherwise a malformed value in an unrelated, overridden file would break env overrides too.
 */
function rconPort(env: NodeJS.ProcessEnv, props: Record<string, string>, propsPath: string | undefined): number {
  const v = env.BLOCKWRIGHT_RCON_PORT;
  if (v !== undefined && v !== '') return intEnv(env, 'BLOCKWRIGHT_RCON_PORT', 0);
  return intProp(props, 'rcon.port', 25575, propsPath);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let serverDir: string | undefined;
  let props: Record<string, string> = {};
  let propsPath: string | undefined;
  if (env.BLOCKWRIGHT_SERVER_DIR) {
    serverDir = path.resolve(env.BLOCKWRIGHT_SERVER_DIR);
    if (!existsSync(serverDir)) throw new Error(`BLOCKWRIGHT_SERVER_DIR does not exist: ${serverDir}`);
    propsPath = path.join(serverDir, 'server.properties');
    if (existsSync(propsPath)) props = parseProperties(await fs.readFile(propsPath, 'utf8'));
    else propsPath = undefined;
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
    rcon: { host: env.BLOCKWRIGHT_RCON_HOST ?? '127.0.0.1', port: rconPort(env, props, propsPath), password },
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
