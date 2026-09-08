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
        [
          'server_info',
          'get_players',
          'run_command',
          'fill',
          'build',
          'place_shape',
          'paste_schematic',
          'schematic_info',
          'schematic_write',
          'preview',
          'read_region',
          'get_block',
          'get_heightmap',
          'save_schematic',
          'list_snapshots',
          'undo',
        ].sort(),
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
