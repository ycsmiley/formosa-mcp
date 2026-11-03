import { expect, it, vi } from 'vitest';
import { collectDisaster, quietDelayMs, reason, type Options, type Store } from '../src/core/disaster/collect.js';
import { decodeIndex, decodeAlerts, decodeShard, indexKey, shardKey, official, feedUrls } from '../src/core/disaster/model.js';
import { parseDgpa } from '../src/core/disaster/parse.js';
import { createDisasterService } from '../src/core/disaster/service.js';
import { none, json, atom, wind, reservoir, at, index, state, emptyJson, emptyAtom } from './disaster-fixtures.js';
function setup() {
  let clock = Date.parse(at); const values = new Map<string, string>(), calls: { url: string; start: number; end: number }[] = [], writes: { key: string; ttl?: number }[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (key, value, ttl) => { values.set(key, value); writes.push({ key, ttl }); } };
  const fetchText = vi.fn(async (url: string) => { const start = clock; clock += 25; calls.push({ url, start, end: clock }); return { status: 200, text: url === official.dgpa ? none : url === feedUrls[0] ? json : url === feedUrls[1] ? atom : url.includes('CWA') ? wind : reservoir }; });
  const options: Options = { writer: 'gha', store, fetchText, now: () => new Date(clock), sleep: async ms => { clock += ms; }, maxCaps: 20 };
  const read = () => decodeIndex(values.get(indexKey(options.writer))!);
  const alertsText = async () => (await createDisasterService({ indexes: async () => ({ worker: null, gha: null, [options.writer]: read() }), shard: async (source, sha) => decodeShard(values.get(shardKey(source, sha))!, source) }, options.now).alerts({ city: '臺北市' })).text;
  return { values, writes, store, calls, fetchText, options, read, alertsText, advance: (ms: number) => { clock += ms; } };
}
it.each(['{broken', '{}', ''])('rebuilds a corrupt own index and publishes fresh shards (%s)', async raw => {
  const s = setup(); s.options.warn = vi.fn(); s.values.set(indexKey(s.options.writer), raw);
  const result = await collectDisaster(s.options), rebuilt = s.read();
  expect(s.options.warn).toHaveBeenCalledOnce(); expect(s.fetchText).toHaveBeenCalledWith(official.dgpa);
  expect(result.previous.sources).toEqual({}); expect(result.exitCode).toBe(0);
  expect(rebuilt).toMatchObject({ writer: s.options.writer, heartbeatAt: new Date(at).toISOString(), sources: { dgpa: { ok: true }, ncdr: { ok: true } } });
  expect(s.writes.map(w => w.key)).toEqual([shardKey('dgpa', rebuilt.sources.dgpa!.sha!), shardKey('ncdr', rebuilt.sources.ncdr!.sha!), indexKey(s.options.writer)]);
});
it('rejects a valid own index belonging to the other writer before fetching or writing', async () => {
  const s = setup(); s.options.warn = vi.fn(); s.values.set(indexKey(s.options.writer), JSON.stringify(index({})));
  await expect(collectDisaster(s.options)).rejects.toThrow('災防索引寫入者不符');
  expect(s.fetchText).not.toHaveBeenCalled(); expect(s.writes).toEqual([]); expect(s.options.warn).not.toHaveBeenCalled();
});
it('keeps good DGPA sha, timestamps and lines after empty or failed responses', async () => {
  const s = setup(); await collectDisaster(s.options); const old = s.read().sources.dgpa!;
  for (const [i, text] of ['', '<html>maintenance</html>'].entries()) {
    s.fetchText.mockResolvedValue({ status: 200, text }); s.writes.length = 0;
    const result = await collectDisaster(s.options), failed = s.read().sources.dgpa!;
    expect(failed).toMatchObject({ ...old, ok: false, skipped: false, closed: false, fetchedAt: failed.fetchedAt });
    expect(failed.reason).toBeTruthy(); expect(result.exitCode).toBe(i === 0 ? 1 : 0); expect(s.writes.filter(w => w.key.startsWith('disaster:v1:'))).toEqual([]);
  }
});
it('distinguishes valid zero alerts, errors and a closed source without replacing last good shard', async () => {
  const s = setup(); const original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? { status: 200, text: emptyJson() } : url === feedUrls[1] ? { status: 200, text: emptyAtom() } : original(url));
  await collectDisaster(s.options); const old = s.read().sources.ncdr!;
  expect(old).toMatchObject({ ok: true, count: 0 }); expect(s.values.get(shardKey('ncdr', old.sha!))).toBe('[]');
  for (const status of [429, 503]) {
    s.fetchText.mockImplementation(async url => url === official.dgpa ? original(url) : { status, text: '{"Warning":"限制存取間隔時間為3秒"}' });
    await collectDisaster(s.options); expect(s.read().sources.ncdr).toMatchObject({ ok: false, sha: old.sha, lastSuccessAt: old.lastSuccessAt, count: 0, closed: false });
  }
  s.writes.length = 0; s.fetchText.mockImplementation(async url => url === official.dgpa ? original(url) : { status: 200, text: '<WarningMessage><Warning>請先登入會員。</Warning></WarningMessage>' });
  expect((await collectDisaster(s.options)).exitCode).toBe(1); expect(s.read().sources.ncdr).toMatchObject({ ok: false, closed: true, sha: old.sha });
  expect(s.writes.some(w => w.key.startsWith('disaster:v1:ncdr:'))).toBe(false);
  s.advance(2 * 86400000); expect((await collectDisaster(s.options)).exitCode).toBe(0);
});
it('uses Atom fallback even when only the primary requires login', async () => {
  const s = setup(), original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? { status: 200, text: '請先登入會員。' } : original(url));
  await collectDisaster(s.options); expect(s.read().sources.ncdr?.ok).toBe(true); expect(s.fetchText.mock.calls.some(([u]) => u === feedUrls[1])).toBe(true);
});
it('fetches only ids lacking CAP detail and gives CAP expiry priority', async () => {
  const s = setup(), feed = JSON.parse(json); feed.entry.splice(1, 1); const original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? { status: 200, text: JSON.stringify(feed) } : original(url));
  await collectDisaster(s.options); const alerts = decodeAlerts(s.values.get(shardKey('ncdr', s.read().sources.ncdr!.sha!))!);
  expect(alerts.every(e => e.detail)).toBe(true); expect(alerts[1].expires).toBe('2026-11-02T11:18:40+08:00');
  s.fetchText.mockClear(); await collectDisaster(s.options); expect(s.fetchText.mock.calls.map(([u]) => u)).toEqual([official.dgpa, feedUrls[0]]);
});
it('retries missing details, enforces maxCaps and does not fetch unsafe or oversized CAPs', async () => {
  const s = setup(); s.options.maxCaps = 1; await collectDisaster(s.options);
  expect(s.fetchText.mock.calls.filter(([u]) => u.endsWith('.cap'))).toHaveLength(1);
  s.fetchText.mockClear(); await collectDisaster(s.options); expect(s.fetchText.mock.calls.filter(([u]) => u.endsWith('.cap'))).toHaveLength(1);
  const unsafe = JSON.parse(json); unsafe.entry = [{ ...unsafe.entry[0], link: { '@href': 'https://evil.example/a.cap' } }];
  const original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? { status: 200, text: JSON.stringify(unsafe) } : original(url));
  s.fetchText.mockClear(); await collectDisaster(s.options); expect(s.fetchText.mock.calls.some(([u]) => u.includes('evil'))).toBe(false);
  const big = setup(), originalBig = big.fetchText.getMockImplementation()!;
  big.fetchText.mockImplementation(async url => url.endsWith('.cap') ? { status: 200, text: wind + ' '.repeat(256 * 1024) } : originalBig(url));
  await collectDisaster(big.options); expect(decodeAlerts(big.values.get(shardKey('ncdr', big.read().sources.ncdr!.sha!))!).every(e => !e.detail)).toBe(true);
});
it('spaces every NCDR request after the preceding response, including fallback, and honors deadline', async () => {
  const s = setup(), original = s.fetchText.getMockImplementation()!; s.options.ncdrDeadlineMs = 7000;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? (s.advance(500), { status: 429, text: '{}' }) : original(url));
  await collectDisaster(s.options);
  const requests = s.calls.filter(c => c.url.startsWith(official.ncdr));
  expect(requests.length).toBe(2); // Atom + one CAP; primary is deliberately not recorded by original.
  expect(requests[1].start - requests[0].end).toBeGreaterThanOrEqual(3100);
  expect(requests.every(c => c.start - Date.parse(at) <= 7000)).toBe(true);
  const t = setup(); await collectDisaster(t.options); const ncdr = t.calls.filter(c => c.url.startsWith(official.ncdr));
  for (let i = 1; i < ncdr.length; i++) expect(ncdr[i].start - ncdr[i - 1].end).toBeGreaterThanOrEqual(3100);
});
it.each([24 + 59 / 60, 25, 26])('GHA skips only before 25 minutes (%i)', async age => {
  const s = setup(); const { updatedAt: _, ...dgpa } = parseDgpa(none); s.values.set(shardKey('dgpa', 'a'.repeat(12)), JSON.stringify(dgpa)); s.values.set(shardKey('ncdr', 'a'.repeat(12)), '[]');
  s.options.peerIndex = async () => index({ dgpa: state({ lastSuccessAt: new Date(Date.parse(at) - age * 60000).toISOString() }), ncdr: state({ lastSuccessAt: new Date(Date.parse(at) - age * 60000).toISOString() }) });
  await collectDisaster(s.options);
  if (age < 25) { expect(s.fetchText).not.toHaveBeenCalled(); expect(s.read().sources.dgpa).toEqual({ ok: false, skipped: true }); }
  else expect(s.fetchText).toHaveBeenCalled();
  expect(s.writes.at(-1)?.key).toBe(indexKey('gha'));
});
it('retains own previous fields when skipped and fetches if peer cannot be decoded', async () => {
  const s = setup(); await collectDisaster(s.options); const old = s.read().sources;
  s.options.peerIndex = async () => index(old); s.fetchText.mockClear(); await collectDisaster(s.options);
  expect(s.read().sources.dgpa).toEqual({ ...old.dgpa, skipped: true }); expect(s.fetchText).not.toHaveBeenCalled();
  s.options.peerIndex = async () => decodeIndex('{broken'); await collectDisaster(s.options); expect(s.fetchText).toHaveBeenCalled();
});
it.each([['00:04:29.999', 0], ['00:04:30.000', 150000], ['00:05:00.000', 120000], ['00:06:59.999', 1], ['00:07:00.000', 0], ['00:14:30.000', 150000], ['00:59:59.000', 0]])('quietDelayMs %s', (value, expected) => { expect(quietDelayMs(new Date(`2026-11-02T${value}Z`))).toBe(expected); });
it('waits out the quiet window before requests and applies deadline after sleeping', async () => {
  const s = setup(); s.advance(Date.parse('2026-11-02T01:24:30Z') - Date.parse(at)); s.options.quietWindow = true;
  const original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? (s.calls.push({ url, start: s.options.now!().getTime(), end: s.options.now!().getTime() }), { status: 200, text: JSON.stringify({ ...JSON.parse(json), updated: s.options.now!().toISOString(), entry: [] }) }) : original(url));
  await collectDisaster(s.options); expect(new Date(s.calls.find(c => c.url === feedUrls[0])!.start).getUTCMinutes()).toBe(27);
});
it('throttles unchanged Worker indexes, writes changed states immediately and renews immutable shards after 3d', async () => {
  const s = setup(); s.options.writer = 'worker'; s.options.maxCaps = 0;
  await collectDisaster(s.options); expect(s.writes).toHaveLength(3); expect(s.writes[0].ttl).toBe(8 * 86400); const first = s.read();
  s.writes.length = 0; s.advance(10 * 60000); await collectDisaster(s.options); expect(s.writes).toEqual([]);
  s.advance(45 * 60000); await collectDisaster(s.options); expect(s.writes.map(w => w.key)).toEqual([indexKey('worker')]); expect(s.read().heartbeatAt).not.toBe(first.heartbeatAt);
  const original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === official.dgpa ? { status: 503, text: '' } : original(url));
  s.writes.length = 0; await collectDisaster(s.options); expect(s.writes.map(w => w.key)).toEqual([indexKey('worker')]);
  s.fetchText.mockImplementation(original); s.advance(3 * 86400000 + 1); s.writes.length = 0; await collectDisaster(s.options);
  expect(s.read().sources.dgpa?.sha).toBe(first.sources.dgpa?.sha); expect(s.read().sources.dgpa?.writtenAt).not.toBe(first.sources.dgpa?.writtenAt); expect(s.writes[0].ttl).toBe(8 * 86400);
});
it('keeps previous shard on publication failure, reports index write failure, redacts URLs and tokens', async () => {
  const s = setup(); await collectDisaster(s.options); const old = s.read().sources.dgpa!;
  s.fetchText.mockResolvedValue({ status: 200, text: none.replace('無停班停課訊息。', '無停班停課訊息。') });
  const put = s.store.put; s.store.put = async (key, value, ttl) => { if (key.startsWith('disaster:v1:dgpa:')) throw Error('Bearer secret https://example.com/token'); return put(key, value, ttl); };
  s.advance(4 * 86400000); const result = await collectDisaster(s.options); expect(result.exitCode).toBe(1); expect(s.read().sources.dgpa).toMatchObject({ sha: old.sha, lastSuccessAt: old.lastSuccessAt });
  expect(s.read().sources.dgpa?.reason).not.toMatch(/secret|example/);
  s.store.put = async () => { throw Error('index failure'); }; expect((await collectDisaster(s.options)).exitCode).toBe(1);
  expect(reason('https://example.com/?token=secret Bearer abc key=xyz ' + 'x'.repeat(500))).not.toMatch(/example|secret|abc|xyz/); expect(reason('x'.repeat(500))).toHaveLength(200);
});
it('keeps changing source timestamps out of content hashes and renews both stable shards after 3 days', async () => {
  const s = setup(); s.options.maxCaps = 0;
  s.fetchText.mockImplementation(async url => ({ status: 200, text: url === official.dgpa ? none.replace('2026/11/02 08:58:16', s.options.now!().toISOString().slice(0, 19).replace('T', ' ').replaceAll('-', '/')) : url === feedUrls[0] ? emptyJson(s.options.now!().toISOString()) : emptyAtom(s.options.now!().toISOString()) }));
  await collectDisaster(s.options); const first = s.read(); s.writes.length = 0; s.advance(60000); await collectDisaster(s.options);
  expect(s.writes).toHaveLength(0); expect(s.read().sources.dgpa!.sha).toBe(first.sources.dgpa!.sha); expect(s.read().sources.ncdr!.sha).toBe(first.sources.ncdr!.sha);
  expect(s.read().sources.dgpa!.sourceUpdatedAt).toBe(first.sources.dgpa!.sourceUpdatedAt);
  s.advance(3 * 86400000 + 1); s.writes.length = 0; await collectDisaster(s.options);
  expect(s.writes.filter(w => w.ttl === 8 * 86400)).toHaveLength(2); expect(s.writes.at(-1)!.key).toBe(indexKey('gha'));
});
it('redacts configured secret from persisted source errors and treats stale feeds as failures', async () => {
  const s = setup(), original = s.fetchText.getMockImplementation()!; s.options.token = 'existing-kv-token';
  s.fetchText.mockImplementation(async url => { if (url === official.dgpa) throw Error('existing-kv-token https://private.example'); return original(url); });
  await collectDisaster(s.options); expect(s.read().sources.dgpa!.reason).toBe('[redacted] [url]');
  const old = s.read().sources.ncdr!; s.advance(25 * 3600000); await collectDisaster(s.options);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, sha: old.sha, lastSuccessAt: old.lastSuccessAt }); expect(s.read().sources.ncdr!.reason).toContain('24 小時');
});
it('anchors Worker heartbeat to run start even after a slow response', async () => {
  const s = setup(), original = s.fetchText.getMockImplementation()!; s.options.writer = 'worker'; s.options.maxCaps = 0;
  s.fetchText.mockImplementation(async url => { if (url === feedUrls[0]) s.advance(75000); return original(url); });
  await collectDisaster(s.options); expect(s.read().heartbeatAt).toBe(new Date(at).toISOString());
  s.advance(Date.parse(at) + 55 * 60000 - s.options.now!().getTime()); s.fetchText.mockImplementation(original); s.writes.length = 0;
  await collectDisaster(s.options); expect(s.writes.map(w => w.key)).toEqual([indexKey('worker')]);
});
it.each(['dgpa', 'ncdr'] as const)('collects only %s, preserves excluded source state and writes index last', async source => {
  const s = setup(); s.options.maxCaps = 0; await collectDisaster(s.options);
  const other = source === 'dgpa' ? 'ncdr' : 'dgpa', old = s.read().sources[other];
  s.options.only = [source]; s.fetchText.mockClear(); s.writes.length = 0;
  await collectDisaster(s.options);
  expect(s.fetchText.mock.calls.map(([u]) => u)).toEqual([source === 'dgpa' ? official.dgpa : feedUrls[0]]);
  expect(s.read().sources[other]).toEqual(old); expect(s.writes).toEqual([]);
  const previous = s.read(); s.options.writer = 'worker'; s.values.set(indexKey('worker'), JSON.stringify({ ...previous, writer: 'worker', heartbeatAt: s.options.now!().toISOString() }));
  s.writes.length = 0; const result = await collectDisaster(s.options);
  expect(result.writes).toBe(0); expect(result.index.sources[other]).toEqual(old);
});
it('rotates a two-CAP budget across six pending entries in three ten-minute runs while keeping feed order', async () => {
  const s = setup(), feed = JSON.parse(json), attempted: string[] = [];
  const entries = Array.from({ length: 6 }, (_, i) => ({ ...feed.entry[0], id: `pending-${i}`, link: { '@href': `${official.ncdr}${i}.cap` } }));
  s.options.only = ['ncdr']; s.options.maxCaps = 2;
  // Align the first run's offset to zero so the first two consistently fail.
  s.advance(Math.ceil(Date.parse(at) / 1800000) * 1800000 - Date.parse(at));
  s.fetchText.mockImplementation(async url => {
    if (url === feedUrls[0]) return { status: 200, text: JSON.stringify({ ...feed, updated: s.options.now!().toISOString(), entry: entries }) };
    attempted.push(url);
    if (url === entries[0].link['@href'] || url === entries[1].link['@href']) throw Error('CAP unavailable');
    return { status: 200, text: wind.replace(/<identifier>[^<]+<\/identifier>/, `<identifier>${entries.find(e => e.link['@href'] === url)!.id}</identifier>`) };
  });
  for (let run = 0; run < 3; run++) {
    if (run) s.advance(10 * 60000);
    await collectDisaster(s.options);
    expect(decodeAlerts(s.values.get(shardKey('ncdr', s.read().sources.ncdr!.sha!))!).map(e => e.id)).toEqual(entries.map(e => e.id));
    expect(attempted).toHaveLength((run + 1) * 2);
  }
  expect(new Set(attempted)).toEqual(new Set(entries.map(e => e.link['@href'])));
});

it.each(['missing', 'null', 'array', 'cancel'])('retains last-good on unverified zero JSON entries (%s)', async kind => {
  const s = setup(); await collectDisaster(s.options); const old = s.read().sources.ncdr!;
  const feed = JSON.parse(json);
  if (kind === 'missing') delete feed.entry;
  else feed.entry = kind === 'null' ? null : kind === 'array' ? [] : feed.entry.map((e: object) => ({ ...e, msgType: 'Cancel' }));
  const original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? { status: 200, text: JSON.stringify(feed) } : url === feedUrls[1] ? { status: 503, text: '' } : original(url));
  s.writes.length = 0; await collectDisaster(s.options);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, sha: old.sha, lastSuccessAt: old.lastSuccessAt, reason: 'NCDR 回傳 0 筆告警，無法確認為有效空清單' });
  expect(s.writes.some(w => w.key.startsWith('disaster:v1:ncdr:'))).toBe(false);
});
it.each(['disagree', 'json-invalid', 'atom-invalid', 'atom-only'])('does not publish unverified empty formats (%s)', async kind => {
  const s = setup(); await collectDisaster(s.options); const old = s.read().sources.ncdr!;
  s.options.only = ['ncdr']; s.writes.length = 0;
  s.fetchText.mockImplementation(async url => ({ status: 200, text: url === feedUrls[0] ? kind === 'json-invalid' ? emptyJson().replace('"name":"NCDR"', '"name":"unknown"') : kind === 'atom-only' ? '{}' : emptyJson() : kind === 'disagree' ? atom : kind === 'atom-invalid' ? '<feed/>' : emptyAtom() }));
  await collectDisaster(s.options);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, sha: old.sha, lastSuccessAt: old.lastSuccessAt });
  expect(s.writes.some(w => w.ttl)).toBe(false);
});
it('publishes a verified dual-format empty feed and respects the response-to-request gap', async () => {
  const s = setup(); s.options.only = ['ncdr'];
  s.fetchText.mockImplementation(async url => { const start = s.options.now!().getTime(); s.advance(10); s.calls.push({ url, start, end: s.options.now!().getTime() }); return { status: 200, text: url === feedUrls[0] ? emptyJson() : emptyAtom(new Date(Date.parse(at) + 3 * 60000).toISOString()) }; });
  await collectDisaster(s.options);
  expect(s.read().sources.ncdr).toMatchObject({ ok: true, count: 0, empty: true });
  expect(s.values.get(shardKey('ncdr', s.read().sources.ncdr!.sha!))).toBe('[]');
  expect(s.calls[1].start - s.calls[0].end).toBe(3100);
  expect(s.read().sources.ncdr!.sourceUpdatedAt).toBe(at);
  const { createDisasterService } = await import('../src/core/disaster/service.js');
  const service = createDisasterService({ indexes: async () => ({ worker: null, gha: s.read() }), shard: async () => [] }, s.options.now);
  expect((await service.alerts({ city: '臺北市' })).text).toContain('目前沒有臺北市生效中的告警');
});
it('propagates per-CAP login walls and reports the unsupported notice', async () => {
  const s = setup(), original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url.endsWith('.cap') ? { status: 200, text: '請先登入會員。' } : original(url));
  await collectDisaster(s.options);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, closed: true });
  const { createDisasterService } = await import('../src/core/disaster/service.js');
  const service = createDisasterService({ indexes: async () => ({ worker: null, gha: s.read() }), shard: async () => null }, s.options.now);
  expect((await service.alerts({ city: '臺北市' })).text).toContain('disaster_alerts 尚未支援');
});
it('refetches retained CAP detail when older shards lack a completeness marker', async () => {
  const s = setup(); await collectDisaster(s.options);
  const key = shardKey('ncdr', s.read().sources.ncdr!.sha!), old = decodeAlerts(s.values.get(key)!);
  for (const item of old) delete item.complete;
  s.values.set(key, JSON.stringify(old)); s.fetchText.mockClear(); await collectDisaster(s.options);
  expect(s.fetchText.mock.calls.some(([url]) => url.endsWith('.cap'))).toBe(true);
});
it('marks failed CAP summaries and unrecognized detailed geography incomplete end to end', async () => {
  for (const mode of ['failure', 'unknown']) {
    const s = setup(); s.options.only = ['ncdr']; const feed = JSON.parse(json); feed.entry = [feed.entry[0]];
    s.fetchText.mockImplementation(async url => {
      if (url === feedUrls[0]) return { status: 200, text: JSON.stringify(feed) };
      if (mode === 'failure') throw Error('CAP failure');
      return { status: 200, text: wind.replace(/<area>[\s\S]*<\/area>/, '<area><areaDesc>未知海域</areaDesc></area>') };
    });
    await collectDisaster(s.options);
    const items = decodeAlerts(s.values.get(shardKey('ncdr', s.read().sources.ncdr!.sha!))!);
    expect(items[0]).toMatchObject({ detail: mode === 'unknown', complete: false });
    const { createDisasterService } = await import('../src/core/disaster/service.js');
    const text = (await createDisasterService({ indexes: async () => ({ worker: null, gha: s.read() }), shard: async () => items }, s.options.now).alerts({ city: '臺北市' })).text;
    expect(text).toContain('無法確認是否涵蓋本縣市'); expect(text).not.toContain('目前沒有');
  }
});
it('rejects own source regressions without a shard write and skips peer-newer source revisions', async () => {
  const s = setup(); s.options.only = ['ncdr']; s.options.maxCaps = 0; await collectDisaster(s.options);
  const old = s.read().sources.ncdr!; s.writes.length = 0;
  s.fetchText.mockResolvedValue({ status: 200, text: json.replace('2026-11-02T09:11:00+08:00', '2026-11-02T09:10:00+08:00') });
  await collectDisaster(s.options);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, sha: old.sha, lastSuccessAt: old.lastSuccessAt, reason: '來源更新時間倒退' });
  expect(s.writes.some(w => w.ttl)).toBe(false);
  s.fetchText.mockResolvedValue({ status: 200, text: json });
  s.options.peerIndex = async () => index({ ncdr: state({ sourceUpdatedAt: '2026-11-02T09:12:00+08:00', lastSuccessAt: '2026-11-02T08:00:00+08:00' }) });
  s.writes.length = 0; await collectDisaster(s.options);
  expect(s.read().sources.ncdr).toMatchObject({ sha: old.sha, skipped: true, reason: '對方已有較新來源版本' });
  expect(s.writes.some(w => w.ttl)).toBe(false);
});
it.each(['failed', 'closed', 'missing-shard', 'stale-source', 'future-source', 'future-success'])('GHA fetches when Worker evidence is %s', async mode => {
  const s = setup(); s.options.only = ['dgpa']; const peer = state();
  if (mode === 'failed') peer.ok = false;
  if (mode === 'closed') { peer.ok = false; peer.closed = true; }
  if (mode === 'stale-source') peer.sourceUpdatedAt = new Date(Date.parse(at) - 91 * 60000).toISOString();
  if (mode === 'future-source') peer.sourceUpdatedAt = new Date(Date.parse(at) + 10 * 60000).toISOString();
  if (mode === 'future-success') peer.lastSuccessAt = new Date(Date.parse(at) + 1000).toISOString();
  if (mode !== 'missing-shard') s.values.set(shardKey('dgpa', peer.sha!), '{}');
  s.options.peerIndex = async () => index({ dgpa: peer });
  await collectDisaster(s.options); expect(s.fetchText).toHaveBeenCalledWith(official.dgpa);
});
it.each(['worker', 'gha'] as const)('writes nothing for unchanged %s content and heartbeats only at 55 minutes', async writer => {
  const s = setup(); s.options.writer = writer; s.options.maxCaps = 0;
  await collectDisaster(s.options); s.writes.length = 0;
  await collectDisaster(s.options); expect(s.writes).toEqual([]);
  s.advance(Date.parse(at) + 50 * 60000 - s.options.now!().getTime()); await collectDisaster(s.options); expect(s.writes).toEqual([]);
  s.advance(Date.parse(at) + 55 * 60000 - s.options.now!().getTime()); await collectDisaster(s.options); expect(s.writes.map(w => w.key)).toEqual([indexKey(writer)]);
});
it('does not heartbeat GHA while all sources remain skipped, and checks each shard once', async () => {
  const s = setup(); s.options.only = ['dgpa']; const { updatedAt: _, ...dgpa } = parseDgpa(none); s.values.set(shardKey('dgpa', 'a'.repeat(12)), JSON.stringify(dgpa));
  s.options.peerIndex = async () => index({ dgpa: state({ lastSuccessAt: s.options.now!().toISOString(), sourceUpdatedAt: s.options.now!().toISOString() }) });
  await collectDisaster(s.options); s.writes.length = 0; s.advance(60 * 60000);
  const get = vi.spyOn(s.store, 'get'); await collectDisaster(s.options);
  expect(s.writes).toEqual([]); expect(get.mock.calls.filter(([key]) => key.startsWith('disaster:v1:'))).toHaveLength(1);
});
it.each([0, -3.5])('defers an exhausted bucket without writes, then refills enough for a heartbeat (%s tokens)', async tokens => {
  const s = setup(); s.options.only = ['dgpa']; s.options.budget = { perHour: 3, burst: 2 }; s.options.warn = vi.fn();
  await collectDisaster(s.options); expect(s.read().budget?.tokens).toBe(0);
  const old = s.values.get(indexKey('gha')); s.writes.length = 0; s.advance(55 * 60000);
  s.values.set(indexKey('gha'), JSON.stringify({ ...s.read(), budget: { tokens, at: s.options.now!().toISOString() } }));
  const exhausted = s.values.get(indexKey('gha'));
  await collectDisaster(s.options); expect(s.writes).toEqual([]); expect(s.values.get(indexKey('gha'))).toBe(exhausted); expect(s.options.warn).toHaveBeenCalled();
  s.advance((1 - tokens) / 3 * 3600000); await collectDisaster(s.options);
  expect(s.writes.map(w => w.key)).toEqual([indexKey('gha')]); expect(s.read().sources.dgpa!.ok).toBe(true); expect(s.values.get(indexKey('gha'))).not.toBe(old);
  expect(s.read().budget!.tokens).toBeLessThan(0.001);
});
it('prioritizes DGPA shard and index when tokens cannot also publish NCDR', async () => {
  const s = setup(); s.options.maxCaps = 0; s.options.budget = { perHour: 3, burst: 9 }; s.options.warn = vi.fn();
  await collectDisaster(s.options); const previous = s.read();
  s.values.set(indexKey('gha'), JSON.stringify({ ...previous, budget: { tokens: 2, at: s.options.now!().toISOString() } }));
  const original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === official.dgpa ? { status: 200, text: none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, '<tr><td headers="city_Name">臺北市</td><td>今天停止上班、停止上課。</td></tr>') } : url === feedUrls[0] ? { status: 200, text: json.replace('東北風增強', '東北風再次增強') } : original(url));
  s.writes.length = 0; await collectDisaster(s.options);
  expect(s.writes).toHaveLength(2); expect(s.writes[0].key).toMatch(/^disaster:v1:dgpa:/); expect(s.writes[1].key).toBe(indexKey('gha'));
  expect(s.read().sources.ncdr).toEqual(previous.sources.ncdr); expect(s.read().sources.dgpa!.sha).not.toBe(previous.sources.dgpa!.sha);
});
it.each(['gha', 'worker'] as const)('records an NCDR fetch failure even when the budget bucket is empty (never answers 沒有)', async writer => {
  const s = setup(); s.options.writer = writer; s.options.only = ['ncdr']; s.options.warn = vi.fn();
  s.fetchText.mockImplementation(async url => ({ status: 200, text: url === feedUrls[0] ? emptyJson() : emptyAtom() }));
  await collectDisaster(s.options);
  s.values.set(indexKey(writer), JSON.stringify({ ...s.read(), budget: { tokens: 0, at: s.options.now!().toISOString() } }));
  s.options.budget = writer === 'worker' ? { perHour: 3, burst: 9 } : { perHour: 1.5, burst: 6 };
  s.advance(10 * 60000); s.writes.length = 0; s.fetchText.mockRejectedValue(Error('timeout'));
  const result = await collectDisaster(s.options);
  expect(result.writes).toBe(1); expect(s.writes.map(w => w.key)).toEqual([indexKey(writer)]);
  expect(s.read().sources.ncdr!.ok).toBe(false); expect(s.read().budget!.tokens).toBeGreaterThanOrEqual(-1); expect(s.read().budget!.tokens).toBeLessThan(0);
  expect(await s.alertsText()).not.toContain('沒有');
});
it('records NCDR login-required (closed) when DGPA has budget priority', async () => {
  const s = setup(); s.options.maxCaps = 0; s.options.budget = { perHour: 3, burst: 9 }; s.options.warn = vi.fn();
  await collectDisaster(s.options); const previous = s.read();
  s.values.set(indexKey('gha'), JSON.stringify({ ...previous, budget: { tokens: 2, at: s.options.now!().toISOString() } }));
  s.fetchText.mockImplementation(async url => ({ status: 200, text: url === official.dgpa ? none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, '<tr><td headers="city_Name">臺北市</td><td>今天停止上班、停止上課。</td></tr>') : '請先登入會員' }));
  s.writes.length = 0; const result = await collectDisaster(s.options);
  expect(result.writes).toBe(2); expect(s.writes[0].key).toMatch(/^disaster:v1:dgpa:/);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, closed: true, sha: previous.sources.ncdr!.sha });
  expect(s.read().sources.dgpa!.sha).not.toBe(previous.sources.dgpa!.sha); expect(s.read().budget!.tokens).toBeGreaterThanOrEqual(0);
});
it('records an NCDR fetch failure when DGPA has budget priority (never answers 沒有)', async () => {
  const s = setup(); s.options.maxCaps = 0; s.options.budget = { perHour: 3, burst: 9 }; s.options.warn = vi.fn();
  await collectDisaster(s.options); const previous = s.read();
  s.values.set(indexKey('gha'), JSON.stringify({ ...previous, budget: { tokens: 2, at: s.options.now!().toISOString() } }));
  s.fetchText.mockImplementation(async url => {
    if (url === official.dgpa) return { status: 200, text: none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, '<tr><td headers="city_Name">臺北市</td><td>今天停止上班、停止上課。</td></tr>') };
    throw Error('timeout');
  });
  s.writes.length = 0; const result = await collectDisaster(s.options);
  expect(result.writes).toBe(2); expect(s.writes[0].key).toMatch(/^disaster:v1:dgpa:/); expect(s.writes[1].key).toBe(indexKey('gha'));
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, closed: false, sha: previous.sources.ncdr!.sha }); expect(s.read().sources.ncdr!.reason).toBeTruthy();
  expect(s.read().sources.dgpa!.sha).not.toBe(previous.sources.dgpa!.sha); expect(s.read().budget!.tokens).toBeGreaterThanOrEqual(0);
  expect(await s.alertsText()).not.toContain('沒有');
});
it('bounds failure overdrafts, records failure-to-closed transitions and reports exhausted overdrafts', async () => {
  const s = setup(); s.options.only = ['ncdr']; s.options.budget = { perHour: 0, burst: 6 }; s.options.warn = vi.fn();
  s.values.set(indexKey('gha'), JSON.stringify({ ...index({ ncdr: { ok: false, closed: false, fetchedAt: at } }, 'gha'), budget: { tokens: 0, at } }));
  s.fetchText.mockResolvedValue({ status: 200, text: '請先登入會員' });
  await collectDisaster(s.options); expect(s.read().sources.ncdr).toMatchObject({ ok: false, closed: true }); expect(s.read().budget!.tokens).toBe(-1);
  // An inconsistent stored success with an exhausted overdraft must fail visibly.
  for (const tokens of [-1, -3.5]) {
    s.values.set(indexKey('gha'), JSON.stringify({ ...s.read(), sources: { ncdr: state({ empty: true }) }, budget: { tokens, at } }));
    s.writes.length = 0;
    expect((await collectDisaster(s.options)).exitCode).toBe(1); expect(s.writes).toEqual([]); expect(s.read().budget!.tokens).toBe(tokens);
    expect(s.options.warn).toHaveBeenCalledWith('disaster failure state cannot be recorded: KV overdraft exhausted');
  }
});
it.each([
  ['does not regress the index when a slow older response finishes after a newer run (same writer)', false],
  ['keeps the later fetch when sourceUpdatedAt ties across concurrent runs', true],
] as const)('%s', async (_, tie) => {
  const s = setup(); s.options.only = ['ncdr']; s.options.maxCaps = 0; s.advance(2 * 3600000);
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  const body = (updated: string, summary: string) => JSON.stringify({ ...JSON.parse(json), updated, entry: [{ ...JSON.parse(json).entry[0], summary }] });
  const newer = '2026-11-02T03:00:00Z', put = s.store.put;
  if (tie) {
    let first = true;
    s.store.put = async (key, value, ttl) => { if (first && key.startsWith('disaster:v1:ncdr:')) { first = false; reached(); await hold; } await put(key, value, ttl); };
  }
  const slow = collectDisaster({ ...s.options, fetchText: async () => { if (!tie) { reached(); await hold; } return { status: 200, text: body(tie ? newer : '2026-11-02T02:00:00Z', '較早公告') }; } });
  await waiting; s.advance(60000);
  s.fetchText.mockResolvedValue({ status: 200, text: body(newer, '較新公告') });
  const fast = await collectDisaster(s.options), published = s.read();
  release(); const result = await slow;
  expect(s.read().sources.ncdr!.sourceUpdatedAt).toBe(newer); expect(s.read().sources.ncdr!.sha).toBe(fast.index.sources.ncdr!.sha);
  // The superseded shard attempt still requires an index publication for accounting.
  expect(result.index).toEqual(published); expect(s.writes.filter(w => w.key === indexKey('gha'))).toHaveLength(2);
});
it.each([
  ['keeps a later NCDR failure attempt over a concurrent newer success (never answers 沒有)', false],
  ['keeps the concurrent success shard when a later failure ties on sourceUpdatedAt', true],
] as const)('%s', async (_, tie) => {
  const s = setup(); s.options.only = ['ncdr']; s.options.maxCaps = 0;
  await collectDisaster(s.options); const previous = s.read(); s.advance(2 * 3600000);
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  const slow = collectDisaster({ ...s.options, fetchText: async () => { reached(); await hold; throw Error('slow NCDR timeout'); } });
  await waiting; s.advance(60000);
  const newer = tie ? previous.sources.ncdr!.sourceUpdatedAt! : '2026-11-02T03:00:00Z';
  s.fetchText.mockImplementation(async url => ({ status: 200, text: url === feedUrls[0] ? emptyJson(newer) : emptyAtom(newer) }));
  await collectDisaster(s.options); const published = s.read().sources.ncdr!;
  expect(published.sourceUpdatedAt).toBe(newer); expect(published.ok).toBe(true);
  expect(published.sha).not.toBe(previous.sources.ncdr!.sha);
  s.advance(60000); release(); const result = await slow;
  expect(result.previous).toEqual(previous);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, reason: 'slow NCDR timeout', sha: published.sha, sourceUpdatedAt: newer, lastSuccessAt: published.lastSuccessAt, count: 0, empty: true });
  expect(Date.parse(s.read().sources.ncdr!.fetchedAt!)).toBeGreaterThan(Date.parse(published.fetchedAt!));
  expect(await s.alertsText()).not.toContain('沒有');
});
it('records a slow unchanged failure after a concurrent recovery (never answers 沒有)', async () => {
  const s = setup(); s.options.only = ['ncdr']; s.options.maxCaps = 0; s.options.warn = vi.fn();
  await collectDisaster(s.options);
  s.fetchText.mockRejectedValue(Error('slow NCDR timeout'));
  await collectDisaster(s.options);
  s.writes.length = 0;
  expect((await collectDisaster(s.options)).writes).toBe(0); expect(s.writes).toEqual([]);
  s.options.budget = { perHour: 0, burst: 2 };
  s.values.set(indexKey('gha'), JSON.stringify({ ...s.read(), budget: { tokens: 2, at: s.options.now!().toISOString() } }));
  const previous = s.read();
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  const slow = collectDisaster({ ...s.options, fetchText: async () => { reached(); await hold; throw Error('slow NCDR timeout'); } });
  await waiting; s.advance(60000);
  const newer = s.options.now!().toISOString();
  s.fetchText.mockImplementation(async url => ({ status: 200, text: url === feedUrls[0] ? emptyJson(newer) : emptyAtom(newer) }));
  await collectDisaster(s.options); const published = s.read().sources.ncdr!;
  expect(published.ok).toBe(true); expect(published.sha).not.toBe(previous.sources.ncdr!.sha);
  expect(s.read().budget!.tokens).toBe(0); expect(await s.alertsText()).toContain('沒有');
  s.advance(60000); s.writes.length = 0; release(); const result = await slow;
  expect(result.previous).toEqual(previous); expect(result.writes).toBe(1);
  expect(s.writes.map(w => w.key)).toEqual([indexKey('gha')]);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, reason: 'slow NCDR timeout', fetchedAt: s.options.now!().toISOString(), sha: published.sha, sourceUpdatedAt: newer, lastSuccessAt: published.lastSuccessAt, count: 0, empty: true });
  expect(Date.parse(s.read().sources.ncdr!.fetchedAt!)).toBeGreaterThan(Date.parse(published.fetchedAt!));
  expect(s.read().budget!.tokens).toBe(-1); expect(await s.alertsText()).not.toContain('沒有');
});
it('persists the budget charge for shards written before a concurrent newer index', async () => {
  const s = setup(); s.options.only = ['ncdr']; s.options.maxCaps = 0;
  await collectDisaster(s.options); s.advance(2 * 3600000);
  s.options.budget = { perHour: 0, burst: 2 };
  s.values.set(indexKey('gha'), JSON.stringify({ ...s.read(), budget: { tokens: 2, at: s.options.now!().toISOString() } }));
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  const body = (updated: string, summary: string) => JSON.stringify({ ...JSON.parse(json), updated, entry: [{ ...JSON.parse(json).entry[0], summary }] });
  const put = s.store.put; let first = true;
  s.store.put = async (key, value, ttl) => {
    await put(key, value, ttl);
    if (first && key.startsWith('disaster:v1:ncdr:')) { first = false; reached(); await hold; }
  };
  const slow = collectDisaster({ ...s.options, fetchText: async () => ({ status: 200, text: body('2026-11-02T02:00:00Z', '較早公告') }) });
  await waiting; s.advance(60000);
  s.fetchText.mockResolvedValue({ status: 200, text: body('2026-11-02T03:00:00Z', '較新公告') });
  const fast = await collectDisaster(s.options);
  expect(fast.index.budget!.tokens).toBe(0);
  release(); const result = await slow;
  expect(s.read().sources.ncdr).toEqual(fast.index.sources.ncdr);
  expect(s.read().budget!.tokens).toBeLessThan(fast.index.budget!.tokens);
  expect(s.read().budget!.tokens).toBe(-1); expect(result.writes).toBe(2);
});
it.each(['success', 'failure', 'closed'])('rechecks the budget before shards and applies shortfall rules for %s', async outcome => {
  const s = setup(); s.options.only = ['ncdr']; s.options.maxCaps = 0; s.options.warn = vi.fn();
  await collectDisaster(s.options); s.options.budget = { perHour: 0, burst: 2 };
  s.values.set(indexKey('gha'), JSON.stringify({ ...s.read(), budget: { tokens: 2, at: s.options.now!().toISOString() } }));
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  const slow = collectDisaster({ ...s.options, fetchText: async () => {
    reached(); await hold;
    if (outcome === 'failure') throw Error('timeout');
    return { status: 200, text: outcome === 'closed' ? '請先登入會員' : json.replace('東北風增強', '東北風再次增強') };
  } });
  await waiting; s.advance(1000); s.writes.length = 0;
  s.values.set(indexKey('gha'), JSON.stringify({ ...s.read(), budget: { tokens: 0, at: s.options.now!().toISOString() } }));
  release(); await slow;
  expect(s.writes.map(w => w.key)).toEqual(outcome === 'success' ? [] : [indexKey('gha')]);
  expect(s.read().budget!.tokens).toBe(outcome === 'success' ? 0 : -1);
  expect(s.read().sources.ncdr!.ok).toBe(outcome === 'success');
  if (outcome === 'closed') expect(s.read().sources.ncdr!.closed).toBe(true);
});
it('merges concurrent source publications and charges the later stored budget', async () => {
  const s = setup(); s.options.maxCaps = 0; await collectDisaster(s.options);
  s.options.budget = { perHour: 0, burst: 6 };
  s.values.set(indexKey('gha'), JSON.stringify({ ...s.read(), budget: { tokens: 6, at: s.options.now!().toISOString() } }));
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  const put = s.store.put;
  s.store.put = async (key, value, ttl) => { if (key.startsWith('disaster:v1:dgpa:')) { reached(); await hold; } await put(key, value, ttl); };
  s.advance(1000);
  const slow = collectDisaster({ ...s.options, only: ['dgpa'], fetchText: async () => ({ status: 200, text: none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, '<tr><td headers="city_Name">臺北市</td><td>今天停止上班、停止上課。</td></tr>') }) });
  await waiting; s.advance(1000);
  s.fetchText.mockResolvedValue({ status: 200, text: json.replace('東北風增強', '東北風再次增強') });
  const fast = await collectDisaster({ ...s.options, only: ['ncdr'] });
  expect(fast.index.budget!.tokens).toBe(4);
  release(); const result = await slow;
  expect(s.read().sources.ncdr).toEqual(fast.index.sources.ncdr); expect(s.read().sources.dgpa!.sha).not.toBe(fast.index.sources.dgpa!.sha);
  expect(s.read().budget).toEqual({ tokens: 2, at: fast.index.budget!.at }); expect(result.index).toEqual(s.read());
});
it('does not lose a newer pre-shard index when the final re-read returns a stale replica', async () => {
  const s = setup(); s.options.maxCaps = 0; await collectDisaster(s.options);
  s.options.budget = { perHour: 0, burst: 9 };
  const previous = { ...s.read(), budget: { tokens: 9, at: s.options.now!().toISOString() } };
  s.advance(60000);
  s.values.set(indexKey('gha'), JSON.stringify(previous));
  s.fetchText.mockResolvedValue({ status: 200, text: json.replace('東北風增強', '東北風再次增強') });
  await collectDisaster({ ...s.options, only: ['ncdr'] });
  const newer = s.read();
  s.advance(-60000);
  const get = s.store.get; let reads = 0;
  s.store.get = async key => key === indexKey('gha') ? JSON.stringify(++reads === 2 ? newer : previous) : get(key);
  const result = await collectDisaster({ ...s.options, only: ['dgpa'], fetchText: async () => ({ status: 200, text: none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, '<tr><td headers="city_Name">臺北市</td><td>今天停止上班、停止上課。</td></tr>') }) });
  expect(reads).toBe(3);
  expect(result.previous).toEqual(previous); expect(result.writes).toBe(2);
  expect(s.read().sources.ncdr).toEqual(newer.sources.ncdr);
  expect(s.read().sources.dgpa!.sha).not.toBe(previous.sources.dgpa!.sha);
  expect(s.read().heartbeatAt).toBe(newer.heartbeatAt);
  expect(s.read().budget).toEqual({ tokens: 5, at: newer.budget!.at });
  expect(result.index).toEqual(s.read());
});
it.each(['missing', 'corrupt', 'error'])('publishes when the final index re-read is %s', async mode => {
  const s = setup(); s.options.only = ['dgpa']; let reads = 0;
  s.store.get = async () => { if (++reads === 1 || mode === 'missing') return null; if (mode === 'error') throw Error('unavailable'); return '{broken'; };
  expect((await collectDisaster(s.options)).writes).toBe(2); expect(s.read().sources.dgpa!.ok).toBe(true);
});
it('GHA does not skip when the Worker shard is corrupt or its count mismatches', async () => {
  for (const source of ['dgpa', 'ncdr'] as const) for (const corrupt of [true, false]) {
    const s = setup(); s.options.only = [source]; s.options.maxCaps = 0;
    const { updatedAt: _, ...dgpa } = parseDgpa(none), peer = state({ count: corrupt ? 0 : 1 });
    s.values.set(shardKey(source, peer.sha!), corrupt ? '{broken' : JSON.stringify(source === 'ncdr' ? [] : dgpa));
    s.options.peerIndex = async () => index({ [source]: peer });
    await collectDisaster(s.options); expect(s.fetchText).toHaveBeenCalledWith(source === 'dgpa' ? official.dgpa : feedUrls[0]);
    expect(s.read().sources[source]!.ok).toBe(true); expect(s.read().sources[source]!.skipped).not.toBe(true);
  }
});
it.each([['worker', 3, 9, 82], ['gha', 1.5, 6, 43]] as const)('bounds %s publications across 24 hours of changing content and failures', async (writer, perHour, burst, ceiling) => {
  const s = setup(); s.options.writer = writer; s.options.maxCaps = 0; s.options.budget = { perHour, burst }; s.options.warn = () => {};
  s.fetchText.mockImplementation(async url => {
    const stamp = s.options.now!().toISOString();
    return { status: 200, text: url === official.dgpa ? none.replace(/<TR><TD headers='city_Name'[\s\S]*?<\/TR>/, `<tr><td headers="city_Name">臺北市</td><td>公告 ${stamp}</td></tr>`) : JSON.stringify({ ...JSON.parse(json), updated: stamp, entry: [{ ...JSON.parse(json).entry[0], summary: `臺北市公告 ${stamp}` }] }) };
  });
  for (let run = 0; run < 144; run++) { if (run) s.advance(10 * 60000); await collectDisaster(s.options); }
  s.fetchText.mockRejectedValue(Error('timeout')); await collectDisaster(s.options);
  expect(s.writes.length).toBeLessThanOrEqual(ceiling); expect(s.writes.length).toBeGreaterThan(ceiling - 4);
  expect(s.read().budget!.tokens).toBeGreaterThanOrEqual(-1);
});

it('publishes quiet three-hour dual-format feeds as healthy and lets service confirm absence', async () => {
  const s = setup(), quiet = new Date(Date.parse(at) - 3 * 3600000).toISOString(); s.options.only = ['ncdr'];
  s.fetchText.mockImplementation(async url => ({ status: 200, text: url === feedUrls[0] ? emptyJson(quiet) : emptyAtom(quiet) }));
  expect((await collectDisaster(s.options)).exitCode).toBe(0);
  expect(s.read().sources.ncdr).toMatchObject({ ok: true, sourceUpdatedAt: quiet, empty: true });
  const { createDisasterService } = await import('../src/core/disaster/service.js');
  const service = createDisasterService({ indexes: async () => ({ worker: null, gha: s.read() }), shard: async () => [] }, s.options.now);
  expect((await service.alerts({ city: '臺北市' })).text).toContain('目前沒有臺北市');
});
it.each([3, 25])('GHA applies a 24-hour NCDR source limit, not 90 minutes (%i hours)', async hours => {
  const s = setup(); s.options.only = ['ncdr'];
  const peer = state({ sourceUpdatedAt: new Date(Date.parse(at) - hours * 3600000).toISOString() });
  s.values.set(shardKey('ncdr', peer.sha!), '[]'); s.options.peerIndex = async () => index({ ncdr: peer });
  await collectDisaster(s.options);
  expect(s.fetchText.mock.calls.length === 0).toBe(hours === 3);
});
it('leaves only ten seconds of NCDR request budget after a 50-second cron delay', async () => {
  const s = setup(); s.options.only = ['ncdr']; s.options.writer = 'worker';
  s.options.scheduledAt = Date.parse(at) - 50000; s.options.ncdrDeadlineMs = 60000;
  const feed = JSON.parse(json); feed.entry = Array.from({ length: 10 }, (_, i) => ({ ...feed.entry[0], id: `late-${i}`, link: { '@href': `${official.ncdr}${i}.cap` } }));
  s.fetchText.mockImplementation(async url => {
    const start = s.options.now!().getTime(); s.advance(25); s.calls.push({ url, start, end: s.options.now!().getTime() });
    return { status: 200, text: url === feedUrls[0] ? JSON.stringify(feed) : wind.replace(/<identifier>[^<]+<\/identifier>/, `<identifier>${feed.entry.find((e: any) => e.link['@href'] === url)!.id}</identifier>`) };
  });
  await collectDisaster(s.options);
  expect(s.calls).toHaveLength(4); // feed + three CAPs at ~3.1, 6.2 and 9.3 seconds
  expect(s.calls.every(c => c.start - Date.parse(at) < 10000)).toBe(true);
});
it('anchors the x7:00 request guard to the scheduled cycle even when execution starts later', async () => {
  const s = setup(); s.options.only = ['ncdr']; s.options.scheduledAt = Date.parse(at); s.options.ncdrDeadlineMs = 20 * 60000;
  s.advance(10 * 60000); await collectDisaster(s.options);
  expect(s.fetchText).not.toHaveBeenCalled(); expect(s.read().sources.ncdr!.ok).toBe(false);
});
it('refetches pre-geocode CAP shards and preserves retained detail when summaries change', async () => {
  const s = setup(); s.options.only = ['ncdr'];
  const feed = JSON.parse(json); feed.entry.splice(1, 1); const body = JSON.stringify(feed);
  const fetch = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? { status: 200, text: body } : fetch(url));
  await collectDisaster(s.options);
  const key = shardKey('ncdr', s.read().sources.ncdr!.sha!), items = decodeAlerts(s.values.get(key)!);
  for (const item of items) delete item.areaCounties;
  const legacy = s.read(); legacy.sources.ncdr!.sha = 'b'.repeat(12);
  s.values.set(shardKey('ncdr', legacy.sources.ncdr!.sha!), JSON.stringify(items));
  s.values.set(indexKey(s.options.writer), JSON.stringify(legacy));
  s.fetchText.mockClear(); await collectDisaster(s.options);
  expect(s.fetchText.mock.calls.some(([url]) => url.endsWith('.cap'))).toBe(true);
  const before = decodeAlerts(s.values.get(shardKey('ncdr', s.read().sources.ncdr!.sha!))!).filter(e => e.detail);
  const original = s.fetchText.getMockImplementation()!;
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? { status: 200, text: body.replace('東北風增強', '臺北市新北市桃園市') } : original(url));
  s.fetchText.mockClear(); await collectDisaster(s.options);
  const after = decodeAlerts(s.values.get(shardKey('ncdr', s.read().sources.ncdr!.sha!))!).filter(e => e.detail);
  expect(after).toEqual(before); expect(s.fetchText.mock.calls.some(([url]) => url.endsWith('.cap'))).toBe(false);
});
