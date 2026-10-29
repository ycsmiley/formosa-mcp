import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hitCounter } from '../../src/worker/counter.js';
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
  expect(await stub.hit(2, 1000)).toEqual({ allowed: true, count: 1, retryAfter: 0 });
  expect(await stub.hit(2, 1000)).toEqual({ allowed: true, count: 2, retryAfter: 0 });
  for (let i = 0; i < 3; i++) {
    expect(await stub.hit(2, 1000)).toEqual({ allowed: false, count: 2, retryAfter: 1 });
  }
  expect(await stub.hit(3, 1000)).toEqual({ allowed: true, count: 3, retryAfter: 0 });
});

it('strictly limits a concurrent burst of 125 hits', async () => {
  const stub = counter();
  const results = await Promise.all(Array.from({ length: 125 }, () => stub.hit(30, 60_000)));
  expect(results.filter(result => result.allowed).map(result => result.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  const rejected = results.filter(result => !result.allowed);
  expect(rejected).toHaveLength(95);
  expect(rejected.every(result => result.count === 30)).toBe(true);
});

it('resets at the aligned window boundary and rejected hits do not extend it', async () => {
  const stub = counter();
  expect(await stub.hit(1, 1000)).toMatchObject({ allowed: true, count: 1 });
  vi.setSystemTime(1999);
  expect(await stub.hit(1, 1000)).toEqual({ allowed: false, count: 1, retryAfter: 1 });
  vi.setSystemTime(2000);
  expect(await stub.hit(1, 1000)).toEqual({ allowed: true, count: 1, retryAfter: 0 });
});

it('rounds Retry-After up to whole seconds', async () => {
  const stub = counter();
  await stub.hit(1, 60_000);
  expect(await stub.hit(1, 60_000)).toEqual({ allowed: false, count: 1, retryAfter: 59 });
  vi.setSystemTime(59_999);
  expect(await stub.hit(1, 60_000)).toEqual({ allowed: false, count: 1, retryAfter: 1 });
});

it.each([0, -1, 1.5, NaN, Infinity, -Infinity].flatMap(value => [[value, 1000], [1, value]]))(
  'rejects invalid limit %s or windowMs %s', async (limit, windowMs) => {
    await expect(counter().hit(limit, windowMs)).rejects.toThrow('positive integers');
  },
);

it('keeps distinct names independent through hitCounter', async () => {
  const name = crypto.randomUUID();
  expect(await hitCounter(ns, name, 1, 1000)).toMatchObject({ allowed: true, count: 1 });
  expect(await hitCounter(ns, name, 1, 1000)).toMatchObject({ allowed: false, count: 1 });
  expect(await hitCounter(ns, `${name}-other`, 1, 1000)).toMatchObject({ allowed: true, count: 1 });
});
