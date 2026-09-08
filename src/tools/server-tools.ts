import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { describeConfig } from '../config.js';
import { BlockState, VoxelSet, box, boxVolume, formatVec } from '../voxel/voxels.js';
import { Vec3Schema } from '../voxel/schemas.js';
import { splitBox, prefixDimension } from '../voxel/compile.js';
import { ok, json, fail, errorMessage, formatApplyResult } from './result.js';
import { writeOptionsShape, applyOptionsFrom, validationError } from './common.js';

// Administrative command names, checked against the first token of a command once it has
// been fully normalised (namespace stripped, `execute ... run` peeled away). Auditable at a
// glance: if it isn't in this set, it isn't refused as "administrative".
const DENIED_COMMANDS = new Set([
  'stop',
  'restart',
  'op',
  'deop',
  'ban',
  'ban-ip',
  'banlist',
  'pardon',
  'pardon-ip',
  'whitelist',
  'kick',
  'save-off',
  'reload',
  'rl',
]);

/** A command string must never contain these — they let one line of input smuggle a second command. */
function hasControlChars(command: string): boolean {
  return /[\n\r\0]/.test(command);
}

/**
 * Reduce a raw command to a normalised form suitable for token comparison: leading
 * whitespace/slashes stripped (in any interleaving, e.g. "/ /stop" or "//stop"), internal
 * whitespace (including unicode whitespace) collapsed to single spaces, a stray trailing
 * slash removed, and lowercased.
 */
function normalizeCommand(command: string): string {
  return command
    .replace(/^[\s/]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Repeatedly strip a leading `execute ... run ` clause, so nested execute chains
 * (`execute as @a run execute as @b run stop`) reduce to the command actually run.
 * Only unwraps when the command's first token is literally "execute" and a standalone
 * "run" token follows, so a command that merely mentions "run" as an argument elsewhere
 * (and isn't an execute chain to begin with) is left untouched.
 */
function peelExecuteRun(command: string): string {
  let rest = command;
  for (;;) {
    const tokens = rest.split(' ');
    if (tokens[0] !== 'execute') return rest;
    const runIndex = tokens.indexOf('run');
    if (runIndex === -1) return rest;
    rest = tokens.slice(runIndex + 1).join(' ');
  }
}

/** Strip every leading `namespace:` segment (minecraft:, bukkit:, paper:, ... repeated) from a token. */
function stripNamespacePrefixes(token: string): string {
  let t = token;
  for (;;) {
    const m = /^[a-z0-9_.-]+:(.+)$/.exec(t);
    if (!m) return t;
    t = m[1];
  }
}

export function isDenied(command: string): boolean {
  if (hasControlChars(command)) return true;
  const normalized = normalizeCommand(command);
  if (normalized === '') return false;
  const reduced = peelExecuteRun(normalized);
  const firstToken = reduced.split(' ')[0] ?? '';
  if (firstToken === '') return false;
  const bare = stripNamespacePrefixes(firstToken);
  return DENIED_COMMANDS.has(bare);
}

// Minecraft block-state grammar, mirrored from BlockState.parse so replace_filter gets the
// same treatment as block: a bare name, optionally namespaced, with optional [prop=value,...]
// state brackets, or the same shape prefixed with "#" for a block tag (e.g. "#minecraft:logs").
const REPLACE_FILTER_NAME_RE = /^[a-z0-9_.-]+(?::[a-z0-9_./-]+)?$/;
const REPLACE_FILTER_STATE_RE = /^([^[\]]+)(?:\[(.*)])?$/;
const REPLACE_FILTER_PROP_KEY_RE = /^[a-z0-9_]+$/;
const REPLACE_FILTER_PROP_VALUE_RE = /^(?:[a-z0-9_]+|-?[0-9]+)$/;

/** Returns an error message if `text` isn't a valid replace_filter (block state or #tag), otherwise undefined. */
export function validateReplaceFilter(text: string): string | undefined {
  if (/\s/.test(text)) return `invalid replace_filter "${text}": must not contain whitespace`;
  const isTag = text.startsWith('#');
  const body = isTag ? text.slice(1) : text;
  if (body === '') return `invalid replace_filter "${text}": empty`;
  const m = REPLACE_FILTER_STATE_RE.exec(body.toLowerCase());
  if (!m || !REPLACE_FILTER_NAME_RE.test(m[1])) return `invalid replace_filter "${text}": expected a block state or a #tag`;
  if (m[2] !== undefined && m[2].trim() !== '') {
    for (const pair of m[2].split(',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0 || eq === pair.length - 1) return `invalid replace_filter "${text}": bad property "${pair}"`;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (!REPLACE_FILTER_PROP_KEY_RE.test(k) || !REPLACE_FILTER_PROP_VALUE_RE.test(v)) return `invalid replace_filter "${text}": bad property "${pair}"`;
    }
  }
  return undefined;
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
      if (hasControlChars(command)) return fail(`refused: "${command}" contains a newline, carriage return, or null character, which is never valid in a single console command.`);
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
      if (args.replace_filter !== undefined) {
        const err = validateReplaceFilter(args.replace_filter);
        if (err) return fail(err);
      }
      try {
        const b = box(args.from, args.to);
        const opts = applyOptionsFrom(args, ctx);
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
