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
