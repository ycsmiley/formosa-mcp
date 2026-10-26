import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';

it('validates eval schema, unique ids, and registered tool names', async () => {
  const schema = z.array(z.object({
    id: z.string().regex(/^invoice-\d{3}$/),
    question: z.string().min(1),
    toolset: z.literal('invoice'),
    expected_tool: z.string().min(1),
    expected_args: z.object({ number: z.string().optional(), period: z.string().optional() }).strict(),
    expected_key_facts: z.array(z.string().min(1)).min(1),
    notes: z.string().min(1),
  }).strict()).length(10);
  const questions = schema.parse(JSON.parse(readFileSync(new URL('../evals/taiwan-questions.json', import.meta.url), 'utf8')));
  expect(new Set(questions.map(q => q.id)).size).toBe(questions.length);
  const server = createServer();
  const client = new Client({ name: 'eval-schema-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const question of questions) {
      expect(names).toContain(question.expected_tool);
      if (question.expected_tool === 'invoice_check') expect(question.expected_args.number).toBeTypeOf('string');
      else expect(question.expected_args.number).toBeUndefined();
    }
  } finally {
    await client.close();
    await server.close();
  }
});

it('keeps all implemented toolsets within the MVP limit of 10 tools', async () => {
  const server = createServer();
  const client = new Client({ name: 'tool-count-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    expect((await client.listTools()).tools.length).toBeLessThanOrEqual(10);
  } finally {
    await client.close();
    await server.close();
  }
});

it('rejects unknown toolsets and lists valid values', () => {
  expect(() => createServer({ toolsets: ['missing'] })).toThrow(/有效工具集：invoice/);
});
