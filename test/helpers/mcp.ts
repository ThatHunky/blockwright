import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type AppContext } from '../../src/server.js';

export async function connect(ctx: AppContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(ctx);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean; images: Array<{ mimeType: string; bytes: Buffer }> }> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  const images = r.content
    .filter((c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image')
    .map((c) => ({ mimeType: c.mimeType, bytes: Buffer.from(c.data, 'base64') }));
  return { text, isError: r.isError === true, images };
}
