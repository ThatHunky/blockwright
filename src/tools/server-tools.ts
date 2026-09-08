import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { describeConfig } from '../config.js';
import { BlockState, VoxelSet, box, boxVolume, formatVec } from '../voxel/voxels.js';
import { Vec3Schema } from '../voxel/schemas.js';
import { splitBox, prefixDimension } from '../voxel/compile.js';
import { ok, json, fail, errorMessage, formatApplyResult } from './result.js';
import { writeOptionsShape, applyOptionsFrom, validationError } from './common.js';

// Administrative command names, checked (namespace stripped) against every position in a
// normalised command where a command name could start — see commandStartIndices below.
// Auditable at a glance: if it isn't in this set (or DENIED_SUBCOMMANDS below), it isn't
// refused as "administrative".
//
// IMPORTANT: this is a safety net against an AI agent making a destructive mistake, not a
// security boundary against a determined attacker — an attacker with the ability to choose
// `run_command`'s argument can reach RCON in plenty of other ways this file cannot stop.
// Setting BLOCKWRIGHT_ALLOW_ADMIN=1 disables this entire check.
const DENIED_COMMANDS = new Set([
  // --- vanilla / Bukkit server administration ---
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

  // --- permission plugins (LuckPerms + the older PermissionsEx-family aliases some admins
  // still run): blocked entirely, not just their "grant" subcommands. The whole point of
  // catching `op` above is defeated if a model can instead run
  // `lp user <name> permission set minecraft.command.op true` and reach the same operator
  // capability without ever calling `op`. These plugins' mutating power is spread across many
  // different subcommand trees (permission set/unset, parent add/remove, meta set, group and
  // track edits, ...) and their few read-only subcommands (e.g. "lp user X info") are not
  // worth the risk of mis-parsing that grammar — the same trap that made the old
  // execute-parsing bug possible. A build assistant has no legitimate reason to touch
  // permissions at all, so the whole command is refused.
  'lp',
  'luckperms',
  'pex',
  'perm',
  'perms',
  'permission',
  'permissions',

  // --- HuskClaims: only its admin/bypass/mass-delete commands, which have no analogue to a
  // "read-only subcommand" — see DENIED_SUBCOMMANDS below for why /region is handled
  // differently. `/claim`, `/trust`, `/unclaim`, etc. only ever act on the invoker's own
  // claim and stay allowed.
  'adminclaim', // toggles admin-claim creation mode (bypasses normal claim ownership)
  'ignoreclaims', // toggles ignoring claim protections/trust entirely
  'unclaimall', // mass-deletes all of a player's claims
  'abandonallclaims', // alias of unclaimall
  'huskclaims', // plugin admin command, including `huskclaims reload`

  // WorldEdit is deliberately NOT covered here: its commands operate on the invoking
  // player's position/selection, so run from the console (no player) they are already
  // inert, making them a low-priority target for this list.
]);

// Commands where only specific destructive subcommands are blocked, because — unlike the
// commands in DENIED_COMMANDS above — the bare command name also has legitimate read-only or
// self-scoped uses (info, list, claiming your own area, ...) that a build assistant might
// reasonably want, so refusing the whole command would over-block. The keys are top-level
// command names (post namespace-stripping); the values are the destructive subcommand name
// AND all of its documented aliases (so `/rg del` is caught as readily as `/region delete`).
const DENIED_SUBCOMMANDS = new Map<string, Set<string>>([
  // WorldGuard region deletion. `/region` and its `/rg` alias otherwise expose plenty of
  // harmless subcommands (info, list, flag, select, claim, ...) that stay allowed.
  ['region', new Set(['remove', 'rem', 'delete', 'del'])],
  ['rg', new Set(['remove', 'rem', 'delete', 'del'])],
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
 * Positions in `tokens` where a command name could start: index 0, and — only when the
 * command is an `execute` invocation, since `run` has no special meaning outside execute's
 * grammar — the position immediately after every standalone "run" token found anywhere in
 * the command.
 *
 * This deliberately does not try to identify *the* `run` that is execute's grammatical
 * separator. `execute`'s own arguments (a scoreboard objective, a fake-player/selector name
 * for `store`/`as`/`at`/..., etc.) are free-form and can themselves be the literal word
 * "run", so `tokens.indexOf('run')` finds whichever "run" comes first textually, which need
 * not be the separator at all — that was the bug: `execute store result score run objRun
 * run stop` has "run" as a fake-player name before the real separator, so indexOf('run')
 * stops at the wrong one and lets `stop` through unnoticed. Scanning every occurrence of
 * "run" and treating what immediately follows each one as a candidate command closes that
 * hole without parsing execute's grammar: for the command above the candidates are "objrun"
 * (harmless, and not actually a command) and "stop" (denied).
 *
 * Trade-off, chosen deliberately: this can flag a token that isn't really a command, when a
 * denied name is used as an execute argument value immediately before a literal "run" —
 * e.g. a scoreboard objective literally named "stop": `execute store result score run stop
 * run tp @s 0 0 0` really only runs a harmless `tp`, but gets refused because "stop" sits
 * right before the true separator. That's accepted: this list is a safety net against an AI
 * making a destructive mistake, not a security boundary (see the comment on DENIED_COMMANDS
 * above), naming a scoreboard objective after an administrative verb is a contrived edge
 * case, and the alternative — parsing enough of execute's grammar to always find the *true*
 * separator — reintroduces exactly the class of bug this function exists to fix.
 *
 * We deliberately do NOT deny whenever a denied token appears *anywhere* in the command
 * (i.e. not just right after a "run"): that would refuse ordinary chat like `say stop` or
 * `say please reload the schematic`, which trades a real, common false positive against a
 * threat that doesn't exist outside of execute's `run` keyword.
 */
function commandStartIndices(tokens: string[]): number[] {
  const starts = [0];
  if (tokens[0] === 'execute') {
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === 'run' && i + 1 < tokens.length) starts.push(i + 1);
    }
  }
  return starts;
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
  const tokens = normalized.split(' ');
  for (const i of commandStartIndices(tokens)) {
    const name = stripNamespacePrefixes(tokens[i] ?? '');
    if (name === '') continue;
    if (DENIED_COMMANDS.has(name)) return true;
    const deniedSubs = DENIED_SUBCOMMANDS.get(name);
    if (deniedSubs === undefined) continue;
    const sub = tokens[i + 1];
    if (sub !== undefined && deniedSubs.has(stripNamespacePrefixes(sub))) return true;
  }
  return false;
}

// Minecraft block-state grammar, mirrored from BlockState.parse so replace_filter gets the
// same treatment as block: a bare name, optionally namespaced, with optional [prop=value,...]
// state brackets, or the same shape prefixed with "#" for a block tag (e.g. "#minecraft:logs").
const REPLACE_FILTER_NAME_RE = /^[a-z0-9_.-]+(?::[a-z0-9_./-]+)?$/;
const REPLACE_FILTER_STATE_RE = /^([^[\]]+)(?:\[(.*)])?$/;
const REPLACE_FILTER_PROP_KEY_RE = /^[a-z0-9_]+$/;
const REPLACE_FILTER_PROP_VALUE_RE = /^(?:[a-z0-9_]+|-?[0-9]+)$/;

// Rejects ASCII control characters (0x00-0x1F and 0x7F), including the embedded null byte
// that \s alone doesn't catch: \s matches tab/newline/CR/FF/VT but not NUL or the other C0
// controls, so a filter like "dirt\0stop" previously slipped past the whitespace check.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/** Returns an error message if `text` isn't a valid replace_filter (block state or #tag), otherwise undefined. */
export function validateReplaceFilter(text: string): string | undefined {
  if (CONTROL_CHAR_RE.test(text)) return `invalid replace_filter "${text}": must not contain control characters`;
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
