import minecraftData from 'minecraft-data';
import type { BlockState, VoxelSet } from '../voxel/voxels.js';

/** Newest pc version shipped by minecraft-data at plan time. 26.2 adds no block renames that matter for validation. */
export const REGISTRY_MC_VERSION = '26.1';

type Registry = ReturnType<typeof minecraftData>;
let cached: Registry | undefined;
function registry(): Registry {
  cached ??= minecraftData(REGISTRY_MC_VERSION);
  return cached;
}

export interface ValidationIssue {
  block: string;
  message: string;
}

export function validateState(state: BlockState): ValidationIssue | undefined {
  if (!state.name.startsWith('minecraft:')) return undefined;
  const short = state.shortName;
  const def = registry().blocksByName[short];
  if (!def) return { block: state.toString(), message: `unknown block "${short}"${hint(short)}` };
  const props = def.states ?? [];
  for (const [k, v] of Object.entries(state.props)) {
    const p = props.find((s) => s.name === k);
    if (!p) return { block: state.toString(), message: `block "${short}" has no property "${k}" (has: ${props.map((s) => s.name).join(', ') || 'none'})` };
    if (p.type === 'bool' && v !== 'true' && v !== 'false') return { block: state.toString(), message: `property "${k}" of "${short}" must be true or false` };
    if ((p.type === 'enum' || p.type === 'direction') && p.values && !p.values.map(String).includes(v))
      return { block: state.toString(), message: `property "${k}" of "${short}" must be one of ${p.values.join(', ')}` };
    if (p.type === 'int') {
      if (!/^-?\d+$/.test(v)) return { block: state.toString(), message: `property "${k}" of "${short}" must be an integer` };
      if (p.values && !p.values.map(String).includes(v)) {
        const nums = p.values.map(Number);
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        return { block: state.toString(), message: `property "${k}" of "${short}" must be between ${lo} and ${hi} (got ${v})` };
      }
    }
  }
  return undefined;
}

function hint(name: string): string {
  const s = suggestBlocks(name);
  const did = s.length ? `did you mean ${s.slice(0, 3).join(', ')}? ` : '';
  return ` (${did}if this is a newer block not yet in the bundled registry, pass allow_unknown_blocks: true)`;
}

/** One issue per distinct invalid state. */
export function validateSet(set: VoxelSet): ValidationIssue[] {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const [, s] of set.entries()) {
    const k = s.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    const issue = validateState(s);
    if (issue) issues.push(issue);
  }
  return issues;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Closest block names by edit distance, then substring matches. */
export function suggestBlocks(name: string, limit = 5): string[] {
  const names = Object.keys(registry().blocksByName);
  const scored = names.map((n) => ({ n, d: editDistance(name, n) })).filter((x) => x.d <= Math.max(2, Math.floor(name.length / 3)));
  scored.sort((a, b) => a.d - b.d || a.n.localeCompare(b.n));
  const out = scored.map((x) => x.n);
  for (const n of names) if (out.length < limit && !out.includes(n) && n.includes(name)) out.push(n);
  return out.slice(0, limit);
}
