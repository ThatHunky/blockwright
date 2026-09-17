import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { Bridge } from './bridge/types.js';
import { VERSION } from './version.js';
import { registerServerTools } from './tools/server-tools.js';
import { registerBuildTools } from './tools/build-tools.js';
import { registerReadTools } from './tools/read-tools.js';
import { registerTerrainTools } from './tools/terrain-tools.js';
import { registerRenderTools } from './tools/render-tools.js';
import { registerSurveyTools } from './tools/survey-tools.js';
import { registerPrompts } from './tools/prompts.js';

export interface AppContext {
  config: Config;
  bridge: Bridge;
}

const INSTRUCTIONS = `blockwright builds structures on a live Minecraft server over RCON.
Workflow: server_info → get_players (where people are) → get_heightmap (scout the site) → preview (check the design, send the HTML to the user) → build/place_shape/paste_schematic with dry_run=true → the same with dry_run=false → render to look at the result → walk/profile/slope to check the ground and every path by the numbers → undo if wrong.
Looking: render draws the real world as a picture and hands it back inline. Use it before calling anything finished, from at least two opposite isometric corners — a heightmap and a top-down view hide every vertical mistake there is (a deck with gaps, a railing in the wrong place, a road sunk in a trench, a floating tree). read_region counts blocks; render is what shows whether it looks right.
Checking: a picture cannot show a 1-block lip, a half-buried step or a leaf in someone's face. Before calling a path, road, stair, bridge or reshaped slope finished, run walk along it (every step ≤ 0.6 up, no drop over 3, headroom clear — it lists each problem with coordinates), profile for its grade and cross-section (width>0 shows a road sunk in a trench), and slope over the area for cliffs and terraces. Fix what they report, then check again.
Ground: never level a site with fill. terraform mode=blend ramps the terrain from the building pad out to untouched terrain at the box border (no seam, no terraces, walkable); mode=smooth softens rough ground, mode=hill raises a landform. Then scatter for plants and boulders — it only ever places on solid ground with air above.
Coordinates: x east, y up, z south. Build specs: rows run north→south (z), characters west→east (x). Every write snapshots first when world access is available.`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: 'blockwright', version: VERSION }, { instructions: INSTRUCTIONS });
  registerServerTools(server, ctx);
  registerBuildTools(server, ctx);
  registerReadTools(server, ctx);
  registerTerrainTools(server, ctx);
  registerRenderTools(server, ctx);
  registerSurveyTools(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
