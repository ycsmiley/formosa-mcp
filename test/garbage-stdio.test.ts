import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, expect, it } from 'vitest';
import { collectGarbage, directoryStore } from '../scripts/publish-garbage.js';
import { normalize, type City } from '../src/core/garbage/normalize.js';

beforeAll(() => { if (!existsSync('dist/stdio.js')) throw new Error('先跑 npm run build'); });

it('serves collected fixture schedules through stdio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'garbage-'));
  const cities: City[] = ['ntpc', 'taipei', 'taichung', 'tainan', 'kaohsiung'];
  const names = ['新北', '臺北', '臺中', '臺南', '高雄'];
  const fixture = (city: City) => readFileSync(`test/fixtures/garbage/real/${city}.${city === 'ntpc' || city === 'taipei' ? 'csv' : 'json'}`, 'utf8');
  const now = new Date('2026-10-30T00:00:00Z');
  const minimum = Object.fromEntries(cities.map(city => [city, 1])) as Record<City, number>;
  const client = new Client({ name: 'garbage-stdio-test', version: '1' });
  try {
    expect(await collectGarbage(directoryStore(dir), { cities, minimum, fetch: async city => fixture(city), delay: async () => {}, now: () => now })).toBe(0);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/stdio.js'], env: { ...process.env as Record<string, string>, FORMOSA_GARBAGE_DIR: dir } }));
    expect((await client.listTools()).tools.map(t => t.name)).toContain('garbage_schedule');
    for (const [i, city] of cities.entries()) {
      const stop = normalize(city, fixture(city), now)[0];
      const result = await client.callTool({ name: 'garbage_schedule', arguments: { city: names[i], district: stop.district, keyword: stop.name } });
      expect(JSON.stringify(result.content)).toContain(stop.name);
    }
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

it('refreshes the Kaohsiung cache at Taipei midnight while retaining other cities', async () => {
  const { vi } = await import('vitest');
  const { localGarbageStore } = await import('../src/garbage/store.js');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T15:59:00Z'));
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const city = String(url).includes('kcg.gov.tw') ? 'kaohsiung' : 'ntpc';
    return new Response(readFileSync(`test/fixtures/garbage/real/${city}.${city === 'ntpc' ? 'csv' : 'json'}`, 'utf8'));
  });
  try {
    const store = localGarbageStore();
    await store.index('kaohsiung'); await store.index('ntpc');
    vi.setSystemTime(new Date('2026-10-30T16:01:00Z'));
    await store.index('kaohsiung'); await store.index('ntpc');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally { fetchMock.mockRestore(); vi.useRealTimers(); }
});
