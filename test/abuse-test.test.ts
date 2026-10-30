import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../scripts/abuse-test.mjs';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('guards monitoring with step outputs and pins Node 22 in the updated workflows', async () => {
  const workflow = await readFile('.github/workflows/abuse-test.yml', 'utf8');
  expect(workflow.match(/- id: monitor/g)).toHaveLength(2);
  expect(workflow.match(/if: steps.monitor.outputs.enabled == 'true'/g)).toHaveLength(2);
  expect(workflow.match(/\[ -n "\$CLOUDFLARE_API_TOKEN" \] && \[ -n "\$CLOUDFLARE_ACCOUNT_ID" \] && \[ -n "\$SNAPSHOTS_KV_ID" \]/g)).toHaveLength(2);
  expect(workflow.match(/echo "enabled=true" >> "\$GITHUB_OUTPUT"/g)).toHaveLength(2);
  expect(workflow).toContain('monitor: ${{ steps.usage.outputs.monitor }}');
  expect(workflow).toContain("needs.before.outputs.monitor == 'true'");
  expect(workflow).not.toContain('if: ${{ env.');
  expect(workflow).not.toContain('secrets.CLOUDFLARE_ACCOUNT_ID');
  expect(workflow.match(/CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars.CLOUDFLARE_ACCOUNT_ID \}\}/g)).toHaveLength(4);
  for (const name of ['abuse-test', 'rail-snapshot', 'ci']) {
    const text = await readFile(`.github/workflows/${name}.yml`, 'utf8');
    const actions = [...text.matchAll(/uses: actions\/setup-node@(\S+) # (\S+)\n        with:\n(?:          #.*\n)?          node-version: (\d+)/g)];
    expect(actions).toHaveLength(name === 'abuse-test' ? 4 : 1);
    for (const match of actions) expect(match.slice(1)).toEqual(['949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7.1.0', '22']);
  }
});
async function run(args: string[], env = {}) {
  const output: string[] = [], errors: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((text: string | Uint8Array) => { output.push(String(text)); return true; });
  const stderr = vi.spyOn(console, 'error').mockImplementation(text => { errors.push(String(text)); });
  try { return { code: await main(args, env), stdout: output.join(''), stderr: errors.join('\n') }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

it('shows help without fetching and rejects missing/invalid arguments', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect((await run(['--help'])).code).toBe(0);
  for (const args of [[], ['--url'], ['--bogus'], ['--url', 'file:///tmp/mcp'], ['--url', 'http://localhost/mcp', '--requests', '0'], ['--url', 'http://localhost/mcp', '--concurrency', 'NaN']]) {
    expect((await run(args)).code).toBe(1);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('mixes stateless calls, rotates IPs and parses JSON/SSE successes and fallback reasons', async () => {
  const calls: { method: string; params: { name: string; arguments: Record<string, string> }; ip: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const rpc = JSON.parse(init.body as string);
    const headers = new Headers(init.headers);
    calls.push({ method: rpc.method, params: rpc.params, ip: headers.get('CF-Connecting-IP')! });
    expect(headers.get('accept')).toBe('application/json, text/event-stream');
    expect(init.redirect).toBe('error');
    const text = rpc.params.name.endsWith('_timetable') ? '時刻表資料：更新'
      : rpc.params.arguments.train_no ? '目前查詢人數較多（每分鐘上限）\n即時誤點暫時無法提供，可帶自己的 TDX 金鑰查即時資料'
        : '臺鐵即時看板\n即時資料剛剛取得';
    const reply = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text }] } });
    return new Response(rpc.id % 2 === 0 ? `event: message\r\ndata: ${reply}\r\n\r\n` : reply);
  }));
  const dir = await mkdtemp(join(tmpdir(), 'rail-abuse-'));
  try {
    const out = join(dir, 'summary.json');
    const result = await run(['--url', 'http://localhost/mcp', '--requests', '50', '--concurrency', '8', '--fake-ip', '--ips', '3', '--out', out], { REQUESTS: '1', CONCURRENCY: '1', IPS: '1' });
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({ requests: 50, concurrency: 8, httpStatuses: { 200: 50 }, toolReplies: 50, liveOk: 20, fallbackReplies: 10, timetableReplies: 20, isError: 0, failed: false });
    expect(summary.fallbackByReason).toEqual({ '目前查詢人數較多（每分鐘上限）': 10 });
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(summary);
    expect(new Set(calls.map(call => call.ip)).size).toBe(3);
    expect(calls.every(call => call.method === 'tools/call')).toBe(true);
    expect(new Set(calls.filter(call => call.params.arguments.station).map(call => call.params.arguments.station)).size).toBe(20);
    expect(new Set(calls.filter(call => call.params.arguments.train_no).map(call => call.params.arguments.train_no)).size).toBe(4);
    expect(calls.filter(call => call.params.name.endsWith('_timetable')).every(call => /^\d{4}-\d{2}-\d{2}$/.test(call.params.arguments.date))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('fails on 5xx, live tool errors, leaked JSON/undefined and malformed HTTP-200 replies', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { id } = JSON.parse(init.body as string);
    if (id === 5) return new Response('unavailable', { status: 503 });
    if (id === 4) return new Response('malformed');
    return Response.json({ jsonrpc: '2.0', id, result: { isError: id === 3, content: [{ type: 'text', text: id === 1 ? '{"leak":true}' : id === 2 ? 'undefined' : 'error' }] } });
  }));
  const result = await run(['--url', 'http://localhost/mcp', '--requests', '5', '--concurrency', '1']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ http5xx: 1, isError: 1, traLiveHttp200IsError: 1, rawJsonReplies: 1, undefinedReplies: 1, invalidReplies: 1, failed: true });
});

it('allows HTTP throttling and checks exact sliding mock windows including token calls', async () => {
  let overCap = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/__stats')) {
      const times = overCap ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 60_000];
      return Response.json({ calls: [...times.map((t, i) => ({ t, kind: i === 0 ? 'token' : 'tra-live-train' })), { t: 2, kind: 'stats' }] });
    }
    return new Response('請求太頻繁，請稍後再試。', { status: 429 });
  }));
  const args = ['--url', 'http://localhost/mcp', '--requests', '1', '--mock-stats', 'http://localhost/__stats'];
  const allowed = await run(args);
  expect(allowed.code, allowed.stderr).toBe(0);
  expect(JSON.parse(allowed.stdout)).toMatchObject({ httpStatuses: { 429: 1 }, upstream: { totalCalls: 5, tokenCalls: 1, maxCallsIn60s: 4 }, failed: false });
  overCap = true;
  const denied = await run(args);
  expect(denied.code).toBe(1);
  expect(JSON.parse(denied.stdout).upstream.maxCallsIn60s).toBe(5);
});

it('uses environment equivalents and reports transport failures', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const result = await run([], { URL: 'http://localhost/mcp', REQUESTS: '2', CONCURRENCY: '1', LABEL: 'env-test', FAKE_IP: '1', IPS: '2' });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ requests: 2, concurrency: 1, label: 'env-test', transportErrors: 2, failed: true });
});
