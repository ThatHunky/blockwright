import { promises as fs, existsSync } from 'node:fs';
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

/** Absolute path for a user-supplied schematic name. For reads, probes known extensions. */
export function resolveSchematicPath(input: string, schematicDir: string, forWrite = false): string {
  const p = path.isAbsolute(input) ? input : path.join(schematicDir, input);
  if (path.extname(p) === '') {
    if (forWrite) return `${p}.schem`;
    for (const ext of READ_EXTS) if (existsSync(p + ext)) return p + ext;
  }
  return p;
}
