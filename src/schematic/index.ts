import { promises as fs, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseNbt, writeNbtGz, type NbtRoot, type CompoundValue } from '../nbt/nbt.js';
import type { Clipboard } from './clipboard.js';
import { readSponge, writeSponge3 } from './sponge.js';
import { readStructure, writeStructure } from './structure.js';

export type ClipboardFormat = 'sponge' | 'structure';

export function detectFormat(root: NbtRoot): ClipboardFormat | undefined {
  const v = root.value as CompoundValue;
  if (v.Schematic || (v.Version && (v.Palette || v.BlockData))) return 'sponge';
  if (v.size && v.blocks) return 'structure';
  return undefined;
}

export async function loadClipboard(filePath: string): Promise<Clipboard> {
  const root = await parseNbt(await fs.readFile(filePath));
  const format = detectFormat(root);
  if (!format) throw new Error(`${filePath}: not a Sponge schematic or vanilla structure`);
  return format === 'sponge' ? readSponge(root) : readStructure(root);
}

export function formatForPath(p: string, explicit?: ClipboardFormat): ClipboardFormat {
  return explicit ?? (p.toLowerCase().endsWith('.nbt') ? 'structure' : 'sponge');
}

export async function saveClipboard(
  clip: Clipboard,
  filePath: string,
  format?: ClipboardFormat,
): Promise<{ path: string; format: ClipboardFormat }> {
  const f = formatForPath(filePath, format);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, writeNbtGz(f === 'structure' ? writeStructure(clip) : writeSponge3(clip)));
  return { path: filePath, format: f };
}

const READ_EXTS = ['.schem', '.nbt', '.schematic'];

/**
 * Resolves the real (symlink-free) path of the longest existing ancestor of `p`, then
 * reappends the non-existent tail. This lets us compare "where does this path actually
 * point" for containment checks even when the final file doesn't exist yet (writes), while
 * still catching a symlinked intermediate directory that would otherwise escape unnoticed.
 */
function resolveRealish(p: string): string {
  let dir = p;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root without finding an existing ancestor
    tail.unshift(path.basename(dir));
    dir = parent;
  }
  const real = existsSync(dir) ? realpathSync(dir) : dir;
  return tail.length ? path.join(real, ...tail) : real;
}

/**
 * Absolute path for a user-supplied schematic name. For reads, probes known extensions.
 *
 * Absolute input paths are a deliberate feature and are returned as-is (aside from
 * extension probing). Relative input must stay inside `schematicDir` — this is enforced
 * against the *real* (symlink-resolved) path, and via path.relative rather than a string
 * prefix check, so a sibling directory that merely shares a name prefix (e.g.
 * "schematics-other" next to "schematics") is not mistaken for being contained.
 */
export function resolveSchematicPath(input: string, schematicDir: string, forWrite = false): string {
  const absolute = path.isAbsolute(input);
  let p = absolute ? input : path.join(schematicDir, input);
  if (path.extname(p) === '') {
    if (forWrite) {
      p = `${p}.schem`;
    } else {
      for (const ext of READ_EXTS) {
        if (existsSync(p + ext)) {
          p = p + ext;
          break;
        }
      }
    }
  }
  if (!absolute) {
    const resolvedDir = existsSync(schematicDir) ? realpathSync(schematicDir) : path.resolve(schematicDir);
    const resolvedPath = resolveRealish(p);
    const rel = path.relative(resolvedDir, resolvedPath);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`schematic path "${input}" escapes schematic directory "${schematicDir}"`);
    }
  }
  return p;
}
