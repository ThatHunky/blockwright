/* Live test against a real Minecraft server.
   Run: BLOCKWRIGHT_INTEGRATION=1 BLOCKWRIGHT_SERVER_DIR=/path/to/server npm run integration */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

if (process.env.BLOCKWRIGHT_INTEGRATION !== '1') {
  console.log('Set BLOCKWRIGHT_INTEGRATION=1 to run this against a real server.');
  process.exit(0);
}
const serverDir = process.env.BLOCKWRIGHT_SERVER_DIR ?? '/home/thathunky/games/servers/matsuri';
const X = Number(process.env.BW_PLOT_X ?? -147);
const Z = Number(process.env.BW_PLOT_Z ?? 181);

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, BLOCKWRIGHT_SERVER_DIR: serverDir } as Record<string, string>,
  stderr: 'inherit',
});
const client = new Client({ name: 'blockwright-integration', version: '0.0.0' });

async function call(name: string, args: Record<string, unknown> = {}, quiet = false): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 110)}`);
  console.log(quiet ? text.split('\n').slice(0, 6).join('\n') : text.slice(0, 1800));
  if (r.isError) throw new Error(`${name} returned an error`);
  return text;
}
function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

await client.connect(transport);
try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(tools.length === 19, `19 tools listed (got ${tools.length})`);

  const info = JSON.parse(await call('server_info', {}, true));
  check(info.canRead === true, 'world reads are available');
  check(info.tier === 1, 'running on the RCON tier');
  console.log(`  server: MC ${info.mcVersion}, DataVersion ${info.dataVersion}, ${info.playersOnline} online`);

  const hm = await call('get_heightmap', { from: [X - 2, Z - 2], to: [X + 7, Z + 7] });
  const surface = Number(/surface y from (\d+)/.exec(hm)![1]);
  const y = Number(/y=(\d+)/.exec(hm.match(/Build on top at y=\d+/)![0])![1]);
  check(surface >= 55 && surface <= 80, `surface y ${surface} is plausible`);

  const cube = {
    origin: [X, y, Z],
    palette: { '#': 'stone_bricks', '.': 'air' },
    layers: [
      { y: 0, rows: ['#####', '#####', '#####', '#####', '#####'] },
      { y: [1, 3], rows: ['#####', '#...#', '#...#', '#...#', '#####'] },
      { y: 4, rows: ['#####', '#####', '#####', '#####', '#####'] },
    ],
  };

  const prev = await call('preview', { build: cube, context: 3, title: 'Integration cube' }, true);
  check(/HTML preview written to/.test(prev), 'preview wrote an HTML file');

  const dry = await call('build', { ...cube, dry_run: true }, true);
  check(/DRY RUN/.test(dry), 'dry run did not write');
  check(/125 blocks/.test(dry), 'dry run counted 125 blocks');

  const built = await call('build', { ...cube, label: 'integration cube' });
  check(/Snapshot \w+ taken/.test(built), 'a snapshot was taken before writing');
  check(!/command\(s\) failed/.test(built), 'no command failed');

  const after = await call('read_region', { from: [X, y, Z], to: [X + 4, y + 4, Z + 4] }, true);
  check(/stone_bricks \(98\)/.test(after), 'read back 98 stone bricks');
  check(/air \(27\)/.test(after), 'read back 27 air blocks inside');

  const undone = await call('undo');
  check(/Restored 1 snapshot/.test(undone), 'undo restored the snapshot');

  const restored = await call('read_region', { from: [X, y, Z], to: [X + 4, y + 4, Z + 4] }, true);
  check(!/stone_bricks/.test(restored), 'no stone bricks remain after undo');

  // Terrain tools are exercised as dry runs only: they read the real world and compile a real
  // write, which is the part worth testing against a live server, without reshaping anyone's
  // ground to prove it.
  const terra = await call(
    'terraform',
    { from: [X - 20, surface - 20, Z - 20], to: [X + 24, surface + 16, Z + 24], keep_from: [X, Z], keep_to: [X + 4, Z + 4], keep_y: surface + 1, dry_run: true },
    true,
  );
  check(/Target ground height/.test(terra), 'terraform planned a height field from the real surface');
  check(/DRY RUN/.test(terra), 'terraform dry run did not write');

  const scat = await call(
    'scatter',
    { from: [X - 8, surface - 8, Z - 8], to: [X + 8, surface + 8, Z + 8], palette: [{ block: 'short_grass' }, { block: 'poppy' }], density: 0.2, dry_run: true },
    true,
  );
  check(/DRY RUN|nothing placed/.test(scat), 'scatter dry run did not write');

  console.log('\nINTEGRATION OK');
} finally {
  await client.close();
}
