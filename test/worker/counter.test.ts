import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hitCounter, ipShard, rateLimitKey } from '../../src/worker/counter.js';
import type { Env } from '../../src/worker/index.js';

const ns = (env as unknown as Env).MCP_RATE_LIMIT;
const counter = () => ns.get(ns.idFromName(crypto.randomUUID()));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1250);
});
afterEach(() => vi.useRealTimers());

it.each([
  ['::1', '0:0:0:0::/64'],
  ['::', '0:0:0:0::/64'],
  ['2001:db8::1', '2001:db8:0:0::/64'],
  ['2001:0DB8:0:0:abcd::', '2001:db8:0:0::/64'],
  ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
  ['fe80::1%eth0', 'fe80:0:0:0::/64'],
  ['[2001:db8::1]', '2001:db8:0:0::/64'],
  [' [fe80::1%eth0] ', 'fe80:0:0:0::/64'],
  ['203.0.113.7', '203.0.113.7'],
  [' 203.0.113.7 ', '203.0.113.7'],
  ['001.2.3.4', '1.2.3.4'],
  ['0.0.0.0', '0.0.0.0'],
  ['255.255.255.255', '255.255.255.255'],
  ['::ffff:1.2.3.4', '1.2.3.4'],
  ['::FFFF:1.2.3.4', '1.2.3.4'],
  ['0:0:0:0:0:ffff:1.2.3.4', '1.2.3.4'],
  ['::ffff:001.2.3.4', '1.2.3.4'],
  ['::ffff:192.0.2.1', '192.0.2.1'],
  ['::ffff:c000:201', '192.0.2.1'],
  ['0:0:0:0:0:FFFF:C000:0201', '192.0.2.1'],
])('normalizes rate-limit IP %s to %s', (ip, key) => {
  expect(rateLimitKey(ip)).toBe(key);
});

it.each([
  '', '   ', 'not-an-ip', '1.2.3', '1.2.3.256', '1::2::3', '2001:db8:::1',
  '12345::', 'g::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', ':', ':::',
  '::ffff:1.2.3.999', '1.2.3.4.5', '0001.2.3.4', '-1.2.3.4', '1.2.3.4x',
  '::1.2.3.4', '::ffff:0:1.2.3.4', '1:0:0:0:0:ffff:1.2.3.4',
  '1:2:3:4:5:6:7:8::', '[2001:db8::1', '2001:db8::1]', '::1\n%eth0',
])('uses the unknown bucket for invalid IP %j', ip => {
  expect(rateLimitKey(ip)).toBe('unknown');
});

it('never throws for missing, very long, or unexpected runtime input', () => {
  for (const ip of [null, undefined, 'a'.repeat(100_000), ':'.repeat(100_000), 123, {}, { trim() { throw new Error('bad input'); } }]) {
    expect(() => rateLimitKey(ip as string | null | undefined)).not.toThrow();
    expect(rateLimitKey(ip as string | null | undefined)).toBe('unknown');
  }
});

it('honors the limit and rejected hits do not consume counts', async () => {
  const stub = counter();
  expect(await stub.hit('key', 2, 1000)).toEqual({ allowed: true, count: 1, retryAfter: 0 });
  expect(await stub.hit('key', 2, 1000)).toEqual({ allowed: true, count: 2, retryAfter: 0 });
  for (let i = 0; i < 3; i++) {
    expect(await stub.hit('key', 2, 1000)).toEqual({ allowed: false, count: 2, retryAfter: 1 });
  }
  expect(await stub.hit('key', 3, 1000)).toEqual({ allowed: true, count: 3, retryAfter: 0 });
});

it('strictly limits a concurrent burst of 125 hits', async () => {
  const stub = counter();
  const results = await Promise.all(Array.from({ length: 125 }, () => stub.hit('key', 30, 60_000)));
  expect(results.filter(result => result.allowed).map(result => result.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  const rejected = results.filter(result => !result.allowed);
  expect(rejected).toHaveLength(95);
  expect(rejected.every(result => result.count === 30)).toBe(true);
});

it('resets at the aligned window boundary and rejected hits do not extend it', async () => {
  const stub = counter();
  expect(await stub.hit('key', 1, 1000)).toMatchObject({ allowed: true, count: 1 });
  vi.setSystemTime(1999);
  expect(await stub.hit('key', 1, 1000)).toEqual({ allowed: false, count: 1, retryAfter: 1 });
  vi.setSystemTime(2000);
  expect(await stub.hit('key', 1, 1000)).toEqual({ allowed: true, count: 1, retryAfter: 0 });
});

it('rounds Retry-After up to whole seconds', async () => {
  const stub = counter();
  await stub.hit('key', 1, 60_000);
  expect(await stub.hit('key', 1, 60_000)).toEqual({ allowed: false, count: 1, retryAfter: 59 });
  vi.setSystemTime(59_999);
  expect(await stub.hit('key', 1, 60_000)).toEqual({ allowed: false, count: 1, retryAfter: 1 });
});

it('clears old keys from memory when the window changes', async () => {
  const stub = counter();
  await stub.hit('expired-a', 2, 1000);
  await stub.hit('expired-b', 2, 1000);
  const memoryKeys = () => runInDurableObject(stub, instance =>
    [...(instance as unknown as { counts: Map<string, number> }).counts.keys()].sort());
  expect(await memoryKeys()).toEqual(['expired-a', 'expired-b']);
  vi.setSystemTime(2000);
  await stub.hit('current', 2, 1000);
  expect(await memoryKeys()).toEqual(['current']);
  await stub.hit('also-current', 2, 1000);
  expect(await memoryKeys()).toEqual(['also-current', 'current']);
  await stub.hit('current', 2, 1000);
  expect(await memoryKeys()).toEqual(['also-current', 'current']);
  vi.setSystemTime(3000);
  await stub.hit('next-window', 2, 1000);
  expect(await memoryKeys()).toEqual(['next-window']);
});

it('uses no storage for allowed, rejected, or new-window hits', async () => {
  const stub = counter();
  const databaseSize = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.databaseSize);
  const expectNoStorage = () => runInDurableObject(stub, async (_instance, ctx) => {
    expect(ctx.storage.sql.databaseSize).toBe(databaseSize);
    expect((await ctx.storage.list()).size).toBe(0);
    expect(await ctx.storage.getAlarm()).toBeNull();
  });
  await expectNoStorage();
  await stub.hit('key', 1, 1000);
  await expectNoStorage();
  await stub.hit('key', 1, 1000);
  await expectNoStorage();
  vi.setSystemTime(2000);
  await stub.hit('key', 1, 1000);
  await expectNoStorage();
});

it.each([0, -1, 1.5, NaN, Infinity, -Infinity].flatMap(value => [[value, 1000], [1, value]]))(
  'rejects invalid limit %s or windowMs %s', async (limit, windowMs) => {
    await runInDurableObject(counter(), async instance => {
      await expect(instance.hit('key', limit, windowMs)).rejects.toThrow('positive integers');
    });
  },
);

it.each(['', null, undefined, 123, {}])('rejects invalid key %j', async key => {
  await runInDurableObject(counter(), async instance => {
    await expect(instance.hit(key as string, 1, 1000)).rejects.toThrow('non-empty string');
  });
});

it('keeps distinct keys in one shard independent through hitCounter', async () => {
  const shard = crypto.randomUUID();
  expect(await hitCounter(ns, shard, 'first', 1, 1000)).toMatchObject({ allowed: true, count: 1 });
  expect(await hitCounter(ns, shard, 'first', 1, 1000)).toMatchObject({ allowed: false, count: 1 });
  expect(await hitCounter(ns, shard, 'second', 1, 1000)).toMatchObject({ allowed: true, count: 1 });
  expect(await hitCounter(ns, shard, 'second', 1, 1000)).toMatchObject({ allowed: false, count: 1 });
});

it('keeps the same key independent across distinct shards through hitCounter', async () => {
  const shard = crypto.randomUUID();
  expect(await hitCounter(ns, shard, 'key', 1, 1000)).toMatchObject({ allowed: true, count: 1 });
  expect(await hitCounter(ns, shard, 'key', 1, 1000)).toMatchObject({ allowed: false, count: 1 });
  expect(await hitCounter(ns, `${shard}-other`, 'key', 1, 1000)).toMatchObject({ allowed: true, count: 1 });
});

it('deterministically spreads IPs across the default 16 shards', () => {
  const shards = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const ip = `192.0.2.${i}`;
    const shard = ipShard(ip);
    expect(ipShard(ip)).toBe(shard);
    expect(shard).toMatch(/^mcp-ip-([0-9]|1[0-5])$/);
    shards.add(shard);
  }
  expect(shards.size).toBeGreaterThan(1);
});

it('uses the supplied shard count', () => {
  expect(ipShard('2001:db8::1', 1)).toBe('mcp-ip-0');
  for (let i = 0; i < 100; i++) {
    expect(ipShard(`192.0.2.${i}`, 3)).toMatch(/^mcp-ip-[0-2]$/);
  }
});
