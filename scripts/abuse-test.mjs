#!/usr/bin/env node
// Node 22+, no dependencies. CF-Connecting-IP simulation is for local dev only.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const help = `Usage: node scripts/abuse-test.mjs --url <MCP endpoint> [options]
  --requests N     Total requests (default 120; env REQUESTS)
  --concurrency C  Parallel requests (default 8; env CONCURRENCY)
  --label name     Summary label (env LABEL)
  --fake-ip        Rotate synthetic CF-Connecting-IP headers (env FAKE_IP=1)
  --ips K          Synthetic IP count, 1–65536 (default 20; env IPS)
  --mock-stats URL GET local mock {calls:[{t,kind}]} (env MOCK_STATS)
  --out file       Also write the summary as JSON (env OUT)
  --help           Show this help without making requests
URL may also be supplied via env URL. CLI options override environment values.
Cloudflare overwrites CF-Connecting-IP in production; --fake-ip is only meaningful
against local wrangler dev. Separate workflow runners provide real egress IPs.
Mock statistics cover the mock's entire lifetime, including snapshot bootstrap.
`;

function positive(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return Number(value);
}
function endpoint(value, name, local = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} requires an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${name} requires HTTP(S), without credentials or a fragment`);
  }
  if (local && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${name} must be loopback`);
  return url.href;
}
function options(args, env) {
  if (args.includes('--help')) { process.stdout.write(help); return; }
  const opts = {
    url: env.URL, requests: env.REQUESTS ?? '120', concurrency: env.CONCURRENCY ?? '8',
    label: env.LABEL ?? 'abuse-test', 'fake-ip': env.FAKE_IP === '1', ips: env.IPS ?? '20',
    'mock-stats': env.MOCK_STATS, out: env.OUT,
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !Object.hasOwn(opts, key)) throw new Error(`Unknown option: ${args[i]}`);
    if (key === 'fake-ip') { opts[key] = true; continue; }
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${args[i]} requires a value`);
    opts[key] = args[++i];
  }
  if (!opts.url) throw new Error('--url is required (or set URL)');
  opts.url = endpoint(opts.url, '--url');
  opts.requests = positive(opts.requests, '--requests');
  opts.concurrency = positive(opts.concurrency, '--concurrency');
  opts.ips = positive(opts.ips, '--ips', 65536);
  if (opts['mock-stats']) opts['mock-stats'] = endpoint(opts['mock-stats'], '--mock-stats', true);
  return opts;
}

const stations = ['臺北', '板橋', '桃園', '新竹', '臺中', '彰化', '嘉義', '臺南', '高雄', '屏東', '花蓮', '臺東', '宜蘭', '基隆', '松山', '南港', '中壢', '苗栗', '斗六', '新營'];
const trains = ['2037', '128', '1232', '4193'];
function callAt(i, date) {
  const round = Math.floor(i / 5), slot = i % 5;
  if (slot < 2) return { name: 'tra_live', arguments: { station: stations[(round * 2 + slot) % stations.length] } };
  if (slot === 2) return { name: 'tra_live', arguments: { train_no: trains[round % trains.length] } };
  return { name: slot === 3 ? 'tra_timetable' : 'thsr_timetable', arguments: { origin: '臺北', destination: slot === 3 ? '高雄' : '左營', date } };
}
function rpcReply(body, id) {
  const trimmed = body.trimStart();
  const messages = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? [JSON.parse(body)]
    : body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
      .filter(line => line && line !== '[DONE]').map(line => JSON.parse(line));
  const reply = messages.find(message => message?.id === id && (message.result !== undefined || message.error !== undefined));
  if (!reply) throw new Error('Missing JSON-RPC reply');
  return reply;
}
function max60s(calls) {
  const times = calls.map(call => typeof call.t === 'number' ? call.t : Date.parse(call.t)).sort((a, b) => a - b);
  if (times.some(t => !Number.isFinite(t))) throw new Error('Mock statistics contain an invalid timestamp');
  let left = 0, max = 0;
  for (let right = 0; right < times.length; right++) {
    while (times[left] <= times[right] - 60_000) left++;
    max = Math.max(max, right - left + 1);
  }
  return max;
}
async function run(opts) {
  if (opts['fake-ip']) console.error('Synthetic CF-Connecting-IP headers: local dev only; Cloudflare overwrites them in production.');
  const started = performance.now();
  const summary = {
    label: opts.label, requests: opts.requests, concurrency: opts.concurrency, elapsedMs: 0,
    httpStatuses: {}, toolReplies: 0, isError: 0, traLiveHttp200IsError: 0,
    fallbackReplies: 0, fallbackByReason: {}, liveOk: 0, timetableReplies: 0,
    rawJsonReplies: 0, undefinedReplies: 0, http5xx: 0, transportErrors: 0, invalidReplies: 0,
  };
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let next = 0;
  function inspect(text) {
    if (text.includes('{"')) summary.rawJsonReplies++;
    if (text.includes('undefined')) summary.undefinedReplies++;
  }
  async function send(i) {
    const params = callAt(i, date), id = i + 1;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (opts['fake-ip']) {
      const ip = i % opts.ips;
      headers['CF-Connecting-IP'] = `198.18.${Math.floor(ip / 256)}.${ip % 256}`;
    }
    let response, body;
    try {
      response = await fetch(opts.url, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }),
      });
      summary.httpStatuses[response.status] = (summary.httpStatuses[response.status] ?? 0) + 1;
      if (response.status >= 500) summary.http5xx++;
      body = await response.text();
    } catch { summary.transportErrors++; return; }
    if (response.status !== 200) {
      // Inspect plain-text HTTP errors too, without treating JSON envelopes as leaks.
      if (!/^[\s]*[\[{]/.test(body)) inspect(body);
      return;
    }
    try {
      const reply = rpcReply(body, id);
      if (reply.error || !Array.isArray(reply.result?.content)) throw new Error('Invalid tool reply');
      const result = reply.result;
      summary.toolReplies++;
      if (result.isError === true) {
        summary.isError++;
        if (params.name === 'tra_live') summary.traLiveHttp200IsError++;
      }
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      inspect(text);
      if (text.includes('即時誤點暫時無法提供')) {
        summary.fallbackReplies++;
        const lines = text.split(/\r?\n/), index = lines.findIndex(line => line.includes('即時誤點暫時無法提供'));
        const reason = lines[index - 1]?.trim() || '未提供原因';
        summary.fallbackByReason[reason] = (summary.fallbackByReason[reason] ?? 0) + 1;
      }
      if (/^即時資料(?:剛剛取得|約 \d+ 分鐘前取得)/m.test(text)) summary.liveOk++;
      if (params.name.endsWith('_timetable')) summary.timetableReplies++;
    } catch { inspect(body); summary.invalidReplies++; }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, opts.requests) }, async () => {
    while (next < opts.requests) await send(next++);
  }));
  summary.elapsedMs = Math.round(performance.now() - started);
  if (opts['mock-stats']) {
    const response = await fetch(opts['mock-stats'], { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Mock statistics HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.calls) || data.calls.some(call => !call || typeof call.kind !== 'string')) throw new Error('Invalid mock statistics');
    const calls = data.calls.filter(call => call.kind !== 'stats');
    summary.upstream = { totalCalls: calls.length, tokenCalls: calls.filter(call => call.kind === 'token').length, maxCallsIn60s: max60s(calls) };
  }
  summary.failed = summary.http5xx > 0 || summary.rawJsonReplies > 0 || summary.undefinedReplies > 0
    || summary.traLiveHttp200IsError > 0 || (summary.upstream?.maxCallsIn60s ?? 0) > 4
    || summary.transportErrors > 0 || summary.invalidReplies > 0;
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  process.stdout.write(json);
  if (opts.out) await writeFile(opts.out, json);
  return summary.failed ? 1 : 0;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  try { const opts = options(args, env); return opts ? await run(opts) : 0; }
  catch (error) { console.error(`abuse-test: ${error.message}`); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
