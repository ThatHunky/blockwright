import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { renderHtml } from '../../src/preview/html.js';

const st = (s: string) => BlockState.parse(s);

describe('renderHtml', () => {
  it('embeds voxels, palette and controls without external resources', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('stone'));
    v.set(1, 0, 0, st('oak_planks'));
    const ctx = new VoxelSet();
    ctx.set(0, -1, 0, st('grass_block'));
    const html = renderHtml(v, { title: 'Test hut', context: ctx });
    expect(html).toContain('<title>Test hut</title>');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('"minecraft:stone"');
    expect(html).toContain('"minecraft:oak_planks"');
    expect(html).toContain('"context":[[0,-1,0,');
    expect(html).toContain('id="rotate"');
    expect(html).toContain('id="zoom"');
    expect(html).toContain('id="layer"');
    expect(html).toContain('id="context"');
    expect(html).toContain('<canvas');
  });

  it('never turns a malicious block name/property into executable markup', () => {
    // BlockState.parse now rejects this at the grammar level, but the constructor itself
    // performs no validation (e.g. schematic/NBT round-trips call it directly), so a
    // hostile block state can still reach the renderer. This proves the renderer defends
    // itself independently of upstream input validation.
    const evil = new BlockState('stone', { foo: '<img src=x onerror=alert(1)>' });
    const v = new VoxelSet();
    v.set(0, 0, 0, evil);
    const html = renderHtml(v, { title: 'XSS check' });

    // The old vulnerable sink must be gone entirely.
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('outerHTML');
    expect(html).not.toContain('document.write');

    // The payload's `<` must never survive as a literal `<` anywhere in the document. The
    // only place the payload text appears is inside the JSON blob embedded in <script>,
    // where every `<` has been rewritten to the escape sequence for U+003C (so it can't
    // break out of the script element or be parsed back into a tag). No literal `<img`
    // tag is ever emitted.
    expect(html).not.toContain('<img');
    expect(html).toContain('\\u003cimg');
    // The rest of the payload text is present (inert, inside a JS string literal) but
    // never as markup.
    expect(html).toContain('onerror=alert(1)');
  });
});
