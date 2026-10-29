import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hitCounter, ipShard } from '../../src/worker/counter.js';
import type { Env } from '../../src/worker/index.js';

const ns = (env as unknown as Env).MCP_RATE_LIMIT;
const counter = () => ns.get(ns.idFromName(crypto.randomUUID()));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1250);
});
afterEach(() => vi.useRealTimers());

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

it('prunes expired rows only on the first hit of each window per object instance', async () => {
  const stub = counter();
  await stub.hit('expired-a', 2, 1000);
  await stub.hit('expired-b', 2, 1000);
  const storedKeys = () => runInDurableObject(stub, (_instance, ctx) =>
    ctx.storage.sql.exec<{ key: string }>('SELECT key FROM counters ORDER BY key').toArray().map(row => row.key));
  expect(await storedKeys()).toEqual(['expired-a', 'expired-b']);
  vi.setSystemTime(2000);
  await stub.hit('current', 2, 1000);
  expect(await storedKeys()).toEqual(['current']);
  await runInDurableObject(stub, (_instance, ctx) => {
    ctx.storage.sql.exec('INSERT INTO counters (key, start, count) VALUES (?, ?, ?)', 'late-expired', 1000, 1);
  });
  await stub.hit('also-current', 2, 1000);
  expect(await storedKeys()).toEqual(['also-current', 'current', 'late-expired']);
  await stub.hit('current', 2, 1000);
  expect(await storedKeys()).toEqual(['also-current', 'current', 'late-expired']);
  vi.setSystemTime(3000);
  await stub.hit('next-window', 2, 1000);
  expect(await storedKeys()).toEqual(['next-window']);
});

it('never sets an alarm for allowed, rejected, or new-window hits', async () => {
  const stub = counter();
  const expectNoAlarm = () => runInDurableObject(stub, async (_instance, ctx) => {
    expect(await ctx.storage.getAlarm()).toBeNull();
  });
  await expectNoAlarm();
  await stub.hit('key', 1, 1000);
  await expectNoAlarm();
  await stub.hit('key', 1, 1000);
  await expectNoAlarm();
  vi.setSystemTime(2000);
  await stub.hit('key', 1, 1000);
  await expectNoAlarm();
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
