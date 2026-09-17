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
2. get_heightmap over the candidate site to find flat ground and the surface y. Build at surface y + 1.
2b. If the ground is not flat, do NOT level it with fill. Call terraform mode=blend with the box 12-20 blocks wider than the footprint on every side, keep_from/keep_to as the footprint and keep_y as the floor level: it levels the pad and ramps the terrain out to untouched ground with no seam. dry_run=true first and read the target height grid.
3. Read the resource blockwright://guide/palettes and choose a palette and proportions.
4. Write a build spec (ASCII layers) or use place_shape. Call preview with context=6 and send the HTML file to the user. Adjust until it looks right.
5. Call build with dry_run=true, check the block count and box, then build for real. Big builds: split into named steps (label each).
6. read_region over the build box to verify the blocks, then render it from two opposite isometric corners and look. A top-down view and a block count both hide vertical mistakes; the picture is what shows a gappy deck, a railing in the wrong place, a floating tree or a path cut into a trench. Fix with small build calls; use undo if a step went wrong.
6b. Check the ground by the numbers, which a picture cannot show: walk every path, stair, bridge and doorway approach (it lists each step over 0.6, drop over 3, blocked headroom, water and obstacle with coordinates), profile a road with width>0 to see whether it sits in a trench, and slope over anything terraformed to find lips and cliffs. Fix and re-check until walk reports no problems.
7. Dress the ground with scatter (grass, flowers, the odd boulder) so the site does not read as a bare pad. It only places on solid ground with air above, so nothing can float.
8. render once more at the end and send the user an image. Never call a build finished on a view you have not actually looked at.
8. Report what was built, the coordinates, and how to undo it.

Level name: ${ctx.config.levelName}. World reads ${ctx.bridge.canRead() ? 'are available' : 'are NOT available (no BLOCKWRIGHT_SERVER_DIR); skip steps that read the world and warn the user that undo is unavailable'}.`,
          },
        },
      ],
    }),
  );

  server.registerResource(
    'palette-guide',
    'blockwright://guide/palettes',
    { title: 'Palette and proportion guide', description: 'Block palettes per style, proportions, texturing and block-state cheatsheet', mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: PALETTE_GUIDE }],
    }),
  );
}
