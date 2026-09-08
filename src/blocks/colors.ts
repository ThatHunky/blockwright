import type { BlockState } from '../voxel/voxels.js';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

type Rgb = [number, number, number];

const TABLE: Record<string, Rgb> = {
  stone: [125, 125, 125], cobblestone: [110, 110, 110], stone_bricks: [122, 122, 122], mossy_cobblestone: [95, 110, 85],
  mossy_stone_bricks: [105, 118, 95], smooth_stone: [160, 160, 160], andesite: [136, 136, 136], diorite: [188, 188, 188],
  granite: [150, 105, 90], deepslate: [80, 80, 82], cobbled_deepslate: [77, 77, 80], deepslate_bricks: [70, 70, 72],
  deepslate_tiles: [60, 60, 62], tuff: [110, 112, 100], calcite: [223, 224, 220], dripstone_block: [134, 107, 92],
  dirt: [134, 96, 67], coarse_dirt: [119, 85, 59], rooted_dirt: [144, 103, 76], grass_block: [95, 159, 53], podzol: [92, 63, 24],
  mud: [60, 57, 60], mud_bricks: [137, 103, 79], mycelium: [111, 99, 105], farmland: [110, 78, 52], dirt_path: [148, 121, 65],
  sand: [219, 207, 163], red_sand: [190, 102, 33], sandstone: [216, 203, 155], smooth_sandstone: [220, 208, 160],
  cut_sandstone: [214, 200, 150], red_sandstone: [186, 99, 30], gravel: [131, 127, 126], clay: [160, 166, 179],
  terracotta: [152, 94, 67], bricks: [150, 97, 83], nether_bricks: [44, 22, 26], red_nether_bricks: [110, 20, 20],
  netherrack: [111, 54, 52], soul_sand: [81, 62, 50], soul_soil: [75, 57, 46], basalt: [80, 81, 86], smooth_basalt: [72, 72, 78],
  blackstone: [42, 36, 41], polished_blackstone: [53, 48, 56], polished_blackstone_bricks: [48, 43, 50], obsidian: [15, 10, 24],
  crying_obsidian: [32, 10, 60], end_stone: [219, 222, 158], end_stone_bricks: [218, 224, 162], purpur_block: [169, 125, 169],
  quartz_block: [235, 229, 222], smooth_quartz: [236, 230, 223], quartz_bricks: [233, 227, 219], prismarine: [99, 156, 151],
  prismarine_bricks: [99, 171, 158], dark_prismarine: [51, 91, 75], sea_lantern: [172, 199, 190], glowstone: [171, 131, 84],
  shroomlight: [240, 146, 70], magma_block: [140, 60, 30], bedrock: [85, 85, 85], water: [63, 118, 228], lava: [207, 92, 21],
  ice: [145, 183, 253], packed_ice: [141, 180, 250], blue_ice: [116, 167, 253], snow: [249, 254, 254], snow_block: [249, 254, 254],
  powder_snow: [248, 253, 253], oak_planks: [162, 130, 78], spruce_planks: [114, 84, 48], birch_planks: [192, 175, 121],
  jungle_planks: [160, 115, 80], acacia_planks: [168, 90, 50], dark_oak_planks: [66, 43, 20], mangrove_planks: [117, 54, 48],
  cherry_planks: [227, 178, 172], bamboo_planks: [193, 173, 80], crimson_planks: [101, 48, 70], warped_planks: [43, 104, 99],
  pale_oak_planks: [227, 220, 210], oak_log: [109, 85, 50], spruce_log: [58, 37, 16], birch_log: [216, 215, 210],
  jungle_log: [85, 67, 25], acacia_log: [103, 96, 86], dark_oak_log: [52, 40, 24], mangrove_log: [83, 66, 41], cherry_log: [54, 33, 44],
  stripped_oak_log: [177, 144, 86], stripped_spruce_log: [116, 89, 52], stripped_birch_log: [196, 176, 118],
  stripped_dark_oak_log: [72, 56, 36], oak_leaves: [72, 128, 40], spruce_leaves: [50, 84, 50], birch_leaves: [100, 140, 70],
  jungle_leaves: [60, 130, 40], acacia_leaves: [90, 130, 50], dark_oak_leaves: [50, 100, 30], mangrove_leaves: [70, 115, 40],
  cherry_leaves: [235, 160, 190], azalea_leaves: [90, 130, 60], iron_block: [220, 220, 220], gold_block: [246, 208, 61],
  diamond_block: [98, 219, 214], emerald_block: [42, 203, 87], netherite_block: [66, 61, 63], copper_block: [192, 107, 79],
  exposed_copper: [161, 125, 103], weathered_copper: [108, 153, 110], oxidized_copper: [82, 162, 132], lapis_block: [30, 67, 140],
  redstone_block: [170, 24, 6], coal_block: [16, 15, 15], amethyst_block: [133, 97, 191], hay_block: [166, 136, 38],
  bookshelf: [117, 94, 58], crafting_table: [123, 90, 54], furnace: [110, 110, 110], chest: [160, 115, 55], barrel: [125, 95, 55],
  lantern: [230, 170, 90], soul_lantern: [110, 190, 200], torch: [255, 210, 120], campfire: [120, 80, 40], glass: [200, 235, 245],
  tinted_glass: [40, 35, 45], glass_pane: [200, 235, 245], pumpkin: [198, 118, 24], carved_pumpkin: [198, 118, 24],
  jack_o_lantern: [220, 140, 30], melon: [110, 160, 40], cactus: [80, 130, 40], bamboo: [95, 140, 40], moss_block: [89, 109, 45],
  moss_carpet: [89, 109, 45], sponge: [195, 192, 74], honey_block: [251, 185, 52], slime_block: [140, 210, 100], air: [0, 0, 0],
  cave_air: [0, 0, 0], void_air: [0, 0, 0], barrier: [255, 0, 0], structure_void: [0, 0, 0],
};

const COLOR_WORDS: Record<string, Rgb> = {
  white: [233, 236, 236], light_gray: [142, 142, 134], gray: [62, 68, 71], black: [20, 21, 25], brown: [114, 71, 40],
  red: [160, 39, 34], orange: [240, 118, 19], yellow: [248, 197, 39], lime: [112, 185, 25], green: [84, 109, 27],
  cyan: [21, 137, 145], light_blue: [58, 175, 217], blue: [53, 57, 157], purple: [121, 42, 172], magenta: [189, 68, 179],
  pink: [237, 141, 172],
};

const MATERIALS: Array<[RegExp, string]> = [
  [/^(stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_(?!leaves|log|wood)/, '$2_planks'],
  [/_leaves$/, 'oak_leaves'], [/_(log|wood)$/, 'oak_log'], [/deepslate/, 'deepslate'], [/blackstone/, 'blackstone'],
  [/nether_brick/, 'nether_bricks'], [/end_stone/, 'end_stone'], [/purpur/, 'purpur_block'], [/quartz/, 'quartz_block'],
  [/prismarine/, 'prismarine'], [/sandstone/, 'sandstone'], [/red_sand/, 'red_sand'], [/sand/, 'sand'], [/cobble/, 'cobblestone'],
  [/stone_brick/, 'stone_bricks'], [/brick/, 'bricks'], [/andesite/, 'andesite'], [/diorite/, 'diorite'], [/granite/, 'granite'],
  [/tuff/, 'tuff'], [/copper/, 'copper_block'], [/iron/, 'iron_block'], [/gold/, 'gold_block'], [/diamond/, 'diamond_block'],
  [/emerald/, 'emerald_block'], [/amethyst/, 'amethyst_block'], [/glass/, 'glass'], [/ice/, 'ice'], [/snow/, 'snow'],
  [/water|kelp|seagrass/, 'water'], [/lava|magma/, 'lava'], [/grass|fern|vine|moss|bush|leaf|sapling|azalea|lichen/, 'oak_leaves'],
  [/dirt|mud|soil/, 'dirt'], [/stone|calcite|dripstone/, 'stone'], [/lantern|torch|candle|glow/, 'lantern'],
  [/flower|tulip|poppy|dandelion|orchid|allium|petals|rose/, 'pink_petals_placeholder'],
];

function hashColor(name: string): Rgb {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const hue = h % 360;
  const s = 0.45;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbFor(short: string): Rgb {
  if (TABLE[short]) return TABLE[short];
  for (const word of Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length)) {
    if (short === word || short.startsWith(`${word}_`)) return COLOR_WORDS[word];
  }
  for (const [re, target] of MATERIALS) {
    const m = re.exec(short);
    if (!m) continue;
    if (target === 'pink_petals_placeholder') return [230, 120, 150];
    const key = target.replace('$2', m[2] ?? '');
    if (TABLE[key]) return TABLE[key];
  }
  return hashColor(short);
}

export function blockColor(state: BlockState): Rgba {
  const short = state.shortName;
  const [r, g, b] = state.name.startsWith('minecraft:') ? rgbFor(short) : hashColor(state.name);
  let a = 1;
  if (state.isAir || short === 'structure_void') a = 0;
  else if (/glass|ice$|water|barrier|pane|tinted/.test(short)) a = 0.55;
  return { r, g, b, a };
}

export function cssColor(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}
