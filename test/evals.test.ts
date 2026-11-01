import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { checks } from '../scripts/eval-live.js';
import { createServer } from '../src/mcp/server.js';

it('validates eval schema, unique ids, and registered tool names', async () => {
  const schema = z.array(z.object({
    id: z.string().regex(/^(invoice|stock|rail|garbage|outage)-\d{3}$/),
    question: z.string().min(1),
    toolset: z.enum(['invoice', 'stock', 'rail', 'garbage', 'outage']),
    expected_tool: z.string().min(1),
    expected_args: z.object({ query: z.string().optional(), number: z.string().optional(), period: z.string().optional(), origin: z.string().optional(), destination: z.string().optional(), date: z.string().optional(), time: z.string().optional(), train_no: z.string().optional(), station: z.string().optional(), city: z.string().optional(), district: z.string().optional(), keyword: z.string().optional(), weekday: z.string().optional(), type: z.enum(['water', 'power', 'all']).optional(), start_date: z.string().optional(), end_date: z.string().optional() }).strict(),
    expected_key_facts: z.array(z.string().min(1)).min(1),
    notes: z.string().min(1),
    daily_ci: z.boolean(),
    expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Invalid date').optional(),
    requires_key: z.enum(['TDX']).nullable(),
  }).strict()).length(38);
  const questions = schema.parse(JSON.parse(readFileSync(new URL('../evals/taiwan-questions.json', import.meta.url), 'utf8')));
  expect(new Set(questions.map(q => q.id)).size).toBe(questions.length);
  expect(Object.fromEntries(questions.filter(q => q.expires).map(q => [q.id, q.expires]))).toEqual({
    'invoice-008': '2026-11-25', 'invoice-011': '2027-07-01', 'invoice-012': '2027-07-01', 'invoice-013': '2027-03-25',
  });
  for (const [toolset, count] of [['invoice', 13], ['stock', 13], ['rail', 4], ['garbage', 4], ['outage', 4]] as const) expect(questions.filter(q => q.toolset === toolset)).toHaveLength(count);
  const daily = questions.filter(q => q.daily_ci);
  expect(daily.length).toBeGreaterThanOrEqual(8);
  expect(daily.length).toBeLessThanOrEqual(10);
  for (const q of questions) {
    expect(q.requires_key).toBe(q.toolset === 'rail' ? 'TDX' : null);
    if (q.daily_ci) { expect(['invoice', 'stock']).toContain(q.toolset); expect(checks[q.id]).toBeDefined(); }
  }
  const server = createServer({ toolsets: ['invoice', 'stock', 'rail', 'garbage', 'outage'] });
  const client = new Client({ name: 'eval-schema-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const question of questions) {
      expect(names).toContain(question.expected_tool);
      if (question.toolset === 'garbage' && question.expected_key_facts.includes('目前尚未支援')) {
        const result = await client.callTool({ name: question.expected_tool, arguments: question.expected_args });
        for (const fact of question.expected_key_facts) expect(JSON.stringify(result.content)).toContain(fact);
      }
      if (question.expected_tool === 'invoice_check') expect(question.expected_args.number).toBeTypeOf('string');
      else expect(question.expected_args.number).toBeUndefined();
    }
  } finally {
    await client.close();
    await server.close();
  }
});

it('keeps all implemented toolsets within the MVP limit of 10 tools', async () => {
  const server = createServer({ toolsets: ['invoice', 'stock', 'rail', 'garbage', 'outage'] });
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

it('keeps the daily workflow restricted and pinned', () => {
  const workflow = readFileSync(new URL('../.github/workflows/daily-eval.yml', import.meta.url), 'utf8');
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)];
  expect(uses.length).toBeGreaterThan(0);
  for (const match of uses) expect(match[1]).toMatch(/@[0-9a-f]{40}$/);
  expect(workflow).toContain('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 22\n          cache: npm');
  expect(workflow).toMatch(/persist-credentials:\s*false/);
  expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  const timeout = workflow.match(/timeout-minutes:\s*(\d+)/);
  expect(timeout).not.toBeNull();
  expect(Number(timeout![1])).toBeLessThanOrEqual(5);
  expect(workflow).not.toContain('secrets.');
  expect(workflow).toContain('npm run eval:live');
});
