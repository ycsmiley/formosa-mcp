import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { unavailable, type RailHttp } from '../src/core/rail/client.js';

const env = { TDX_CLIENT_ID: 'id-SENTINEL', TDX_CLIENT_SECRET: 'secret-SENTINEL-9f2c' };
const bearer = 'bearer-SENTINEL-7a3d';
const sensitive = [env.TDX_CLIENT_ID, env.TDX_CLIENT_SECRET, bearer];
const tools = [
  { name: 'thsr_timetable', arguments: { origin: '臺北', destination: '高雄', date: '2026-10-28', time: '00:00' } },
  { name: 'tra_timetable', arguments: { origin: '臺北', destination: '高雄', date: '2026-10-28', time: '00:00' } },
  { name: 'tra_live', arguments: { train_no: '123' } },
] as const;
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in secret-handling tests'));
});
afterEach(async () => {
  try {
    await Promise.all(connections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }));
  } finally { vi.restoreAllMocks(); }
});

it.each(['token-throw', 'token-500', 'data-throw'] as const)('keeps secrets out of whole MCP replies and console calls: %s', async mode => {
  const consoles = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
  ];
  const log = vi.fn();
  const http = vi.fn<RailHttp>(async (url, init) => {
    if (url.endsWith('/token')) {
      if (mode === 'token-throw') throw new Error(`Token request failed: ${env.TDX_CLIENT_SECRET}; body=${init.body}`);
      if (mode === 'token-500') return { status: 500, json: async () => ({ message: env.TDX_CLIENT_SECRET, client_id: env.TDX_CLIENT_ID }) };
      return { status: 200, json: async () => ({ access_token: bearer, token_type: 'Bearer', expires_in: 3600 }) };
    }
    throw new Error(`Data request failed: ${init.headers?.authorization}`);
  });

  // A fresh server per tool makes every case exercise its own failing request.
  for (const tool of tools) {
    http.mockClear();
    const server = createServer({ toolsets: ['rail'], env, railHttp: http, log,
      clock: () => new Date('2026-10-27T16:30:00Z') });
    const client = new Client({ name: 'secret-handling-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    connections.push({ client, server });
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool(tool);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: unavailable }]);
    const serialized = JSON.stringify(result);
    for (const value of sensitive) expect(serialized.includes(value)).toBe(false);
    expect(http.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1);
    expect(http.mock.calls.filter(([url]) => !url.endsWith('/token'))).toHaveLength(mode === 'data-throw' ? 1 : 0);
    for (const [url, init] of http.mock.calls) {
      for (const value of sensitive) expect(url.includes(value)).toBe(false);
      if (url.endsWith('/token')) {
        expect(init.method).toBe('POST');
        expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
          grant_type: 'client_credentials', client_id: env.TDX_CLIENT_ID, client_secret: env.TDX_CLIENT_SECRET,
        });
      } else expect(init.headers?.authorization).toBe(`Bearer ${bearer}`);
    }
  }
  for (const spy of [...consoles, log]) {
    // Include Error.message/stack as JSON.stringify(Error) alone would hide them.
    const serialized = JSON.stringify(spy.mock.calls, (_key, value) => value instanceof Error
      ? { message: value.message, stack: value.stack } : value);
    for (const value of sensitive) expect(serialized.includes(value)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  }
});
