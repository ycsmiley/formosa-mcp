import { expect, it, vi } from 'vitest';
import { collectDisaster, quietDelayMs, reason, type Options, type Store } from '../src/core/disaster/collect.js';
import { decodeIndex, decodeAlerts, indexKey, shardKey, official, feedUrls } from '../src/core/disaster/model.js';
import { none, json, atom, wind, reservoir, at, index, state } from './disaster-fixtures.js';
function setup() {
  let clock = Date.parse(at); const values = new Map<string, string>(), calls: { url: string; start: number; end: number }[] = [], writes: { key: string; ttl?: number }[] = [];
  const store: Store = { get: async k => values.get(k) ?? null, put: async (key, value, ttl) => { values.set(key, value); writes.push({ key, ttl }); } };
  const fetchText = vi.fn(async (url: string) => { const start = clock; clock += 25; calls.push({ url, start, end: clock }); return { status: 200, text: url === official.dgpa ? none : url === feedUrls[0] ? json : url === feedUrls[1] ? atom : url.includes('CWA') ? wind : reservoir }; });
  const options: Options = { writer: 'gha', store, fetchText, now: () => new Date(clock), sleep: async ms => { clock += ms; }, maxCaps: 20 };
  const read = () => decodeIndex(values.get(indexKey(options.writer))!);
  return { values, writes, store, calls, fetchText, options, read, advance: (ms: number) => { clock += ms; } };
}
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
  s.fetchText.mockImplementation(async url => url === feedUrls[0] ? { status: 200, text: JSON.stringify({ ...JSON.parse(json), entry: [] }) } : original(url));
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
it.each([25, 26])('GHA skips fresh Worker source at age %i minutes but always writes heartbeat', async age => {
  const s = setup(); s.options.peerIndex = async () => index({ dgpa: state({ lastSuccessAt: new Date(Date.parse(at) - age * 60000).toISOString() }), ncdr: state({ lastSuccessAt: new Date(Date.parse(at) - age * 60000).toISOString() }) });
  await collectDisaster(s.options);
  if (age === 25) { expect(s.fetchText).not.toHaveBeenCalled(); expect(s.read().sources.dgpa).toEqual({ ok: false, skipped: true }); }
  else expect(s.fetchText).toHaveBeenCalled();
  expect(s.writes.at(-1)?.key).toBe(indexKey('gha'));
});
it('retains own previous fields when skipped and fetches if peer cannot be decoded', async () => {
  const s = setup(); await collectDisaster(s.options); const old = s.read().sources;
  s.options.peerIndex = async () => index({ dgpa: state(), ncdr: state() }); s.fetchText.mockClear(); await collectDisaster(s.options);
  expect(s.read().sources.dgpa).toEqual({ ...old.dgpa, skipped: true }); expect(s.fetchText).not.toHaveBeenCalled();
  s.options.peerIndex = async () => { throw Error('bad peer'); }; await collectDisaster(s.options); expect(s.fetchText).toHaveBeenCalled();
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
  s.advance(10 * 60000); await collectDisaster(s.options); expect(s.writes.map(w => w.key)).toEqual([indexKey('worker')]); expect(s.read().heartbeatAt).not.toBe(first.heartbeatAt);
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
  s.fetchText.mockImplementation(async url => ({ status: 200, text: url === official.dgpa ? none.replace('2026/11/02 08:58:16', s.options.now!().toISOString().slice(0, 19).replace('T', ' ').replaceAll('-', '/')) : JSON.stringify({ ...JSON.parse(json), updated: s.options.now!().toISOString(), entry: [] }) }));
  await collectDisaster(s.options); const first = s.read(); s.writes.length = 0; s.advance(60000); await collectDisaster(s.options);
  expect(s.writes).toHaveLength(1); expect(s.read().sources.dgpa!.sha).toBe(first.sources.dgpa!.sha); expect(s.read().sources.ncdr!.sha).toBe(first.sources.ncdr!.sha);
  expect(s.read().sources.dgpa!.sourceUpdatedAt).not.toBe(first.sources.dgpa!.sourceUpdatedAt);
  s.advance(3 * 86400000 + 1); s.writes.length = 0; await collectDisaster(s.options);
  expect(s.writes.filter(w => w.ttl === 8 * 86400)).toHaveLength(2); expect(s.writes.at(-1)!.key).toBe(indexKey('gha'));
});
it('redacts configured secret from persisted source errors and treats stale feeds as failures', async () => {
  const s = setup(), original = s.fetchText.getMockImplementation()!; s.options.token = 'existing-kv-token';
  s.fetchText.mockImplementation(async url => { if (url === official.dgpa) throw Error('existing-kv-token https://private.example'); return original(url); });
  await collectDisaster(s.options); expect(s.read().sources.dgpa!.reason).toBe('[redacted] [url]');
  const old = s.read().sources.ncdr!; s.advance(91 * 60000); await collectDisaster(s.options);
  expect(s.read().sources.ncdr).toMatchObject({ ok: false, sha: old.sha, lastSuccessAt: old.lastSuccessAt }); expect(s.read().sources.ncdr!.reason).toContain('90 分鐘');
});
it('anchors Worker heartbeat to run start so a slow response does not delay it to the third run', async () => {
  const s = setup(), original = s.fetchText.getMockImplementation()!; s.options.writer = 'worker'; s.options.maxCaps = 0;
  s.fetchText.mockImplementation(async url => { if (url === feedUrls[0]) s.advance(75000); return original(url); });
  await collectDisaster(s.options); expect(s.read().heartbeatAt).toBe(new Date(at).toISOString());
  s.advance(Date.parse(at) + 20 * 60000 - s.options.now!().getTime()); s.fetchText.mockImplementation(original); s.writes.length = 0;
  await collectDisaster(s.options); expect(s.writes.map(w => w.key)).toEqual([indexKey('worker')]);
});
it.each(['dgpa', 'ncdr'] as const)('collects only %s, preserves excluded source state and writes index last', async source => {
  const s = setup(); s.options.maxCaps = 0; await collectDisaster(s.options);
  const other = source === 'dgpa' ? 'ncdr' : 'dgpa', old = s.read().sources[other];
  s.options.only = [source]; s.fetchText.mockClear(); s.writes.length = 0;
  await collectDisaster(s.options);
  expect(s.fetchText.mock.calls.map(([u]) => u)).toEqual([source === 'dgpa' ? official.dgpa : feedUrls[0]]);
  expect(s.read().sources[other]).toEqual(old); expect(s.writes.map(w => w.key)).toEqual([indexKey('gha')]);
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
