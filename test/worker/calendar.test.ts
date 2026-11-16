import { env, createExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import worker, { type Env } from '../../src/worker/index.js';
it('serves the bundled calendar without KV or fetch', async () => {
  const get = vi.fn(), put = vi.fn(), del = vi.fn(), fetch = vi.spyOn(globalThis, 'fetch');
  const bindings = { ...env, SNAPSHOTS: { get, put, delete: del } } as unknown as Env;
  try {
    const response = await worker.fetch(new Request('http://localhost/mcp', { method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': '192.0.2.42' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'taiwan_calendar', arguments: { date: '2026-02-12' } } }) }), bindings, createExecutionContext());
    expect(response.status).toBe(200); expect(await response.text()).toContain('市場無交易');
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
