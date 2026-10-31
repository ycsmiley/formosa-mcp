import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, expect, it } from 'vitest';
import { collectGarbage, directoryStore } from '../scripts/publish-garbage.js';
import { normalize, type City } from '../src/core/garbage/normalize.js';

beforeAll(() => { if (!existsSync('dist/stdio.js')) execSync('npm run build', { stdio: 'inherit' }); }, 180000);

it('serves collected fixture schedules through stdio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'garbage-'));
  const cities: City[] = ['ntpc', 'taipei', 'taichung'];
  const names = ['新北', '臺北', '臺中'];
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
    for (const city of ['台南', '高雄']) {
      const result = await client.callTool({ name: 'garbage_schedule', arguments: { city, district: '東區', keyword: '崇學路', weekday: '今天' } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain('目前尚未支援');
    }
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
