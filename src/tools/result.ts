import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApplyResult } from '../bridge/types.js';

export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function formatApplyResult(r: ApplyResult, what: string): string {
  const box = r.box ? `(${r.box.min.join(', ')}) to (${r.box.max.join(', ')})` : 'n/a';
  const lines: string[] = [];
  if (r.dryRun) {
    lines.push(`DRY RUN — nothing was changed. ${what}: ${r.blocks} blocks in ${r.commands} command(s), box ${box}.`);
    if (r.sample.length) lines.push('First commands:', ...r.sample.map((s) => `  ${s}`));
    return lines.join('\n');
  }
  lines.push(`${what}: ${r.blocks} blocks via ${r.method} in ${r.commands} command(s), box ${box}, ${r.elapsedMs} ms.`);
  if (r.snapshotId) lines.push(`Snapshot ${r.snapshotId} taken; call undo to revert.`);
  else lines.push('No snapshot taken (world reads unavailable or snapshot=false); undo is not possible for this change.');
  if (r.failed) lines.push(`${r.failed} command(s) failed:`, ...r.errors.map((e) => `  ${e}`));
  else if (r.errors.length) lines.push('Warnings:', ...r.errors.map((e) => `  ${e}`));
  return lines.join('\n');
}
