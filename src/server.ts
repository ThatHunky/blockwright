import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { Bridge } from './bridge/types.js';
import { VERSION } from './version.js';
import { registerServerTools } from './tools/server-tools.js';
import { registerBuildTools } from './tools/build-tools.js';
import { registerReadTools } from './tools/read-tools.js';
import { registerTerrainTools } from './tools/terrain-tools.js';
import { registerPrompts } from './tools/prompts.js';

export interface AppContext {
  config: Config;
  bridge: Bridge;
}

const INSTRUCTIONS = `blockwright builds structures on a live Minecraft server over RCON.
Workflow: server_info → get_players (where people are) → get_heightmap (scout the site) → preview (check the design, send the HTML to the user) → build/place_shape/paste_schematic with dry_run=true → the same with dry_run=false → read_region to verify → undo if wrong.
Ground: never level a site with fill. terraform mode=blend ramps the terrain from the building pad out to untouched terrain at the box border (no seam, no terraces, walkable); mode=smooth softens rough ground, mode=hill raises a landform. Then scatter for plants and boulders — it only ever places on solid ground with air above.
Coordinates: x east, y up, z south. Build specs: rows run north→south (z), characters west→east (x). Every write snapshots first when world access is available.`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: 'blockwright', version: VERSION }, { instructions: INSTRUCTIONS });
  registerServerTools(server, ctx);
  registerBuildTools(server, ctx);
  registerReadTools(server, ctx);
  registerTerrainTools(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
