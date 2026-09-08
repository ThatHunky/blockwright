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
