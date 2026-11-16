import { readFile, mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generate, parseCsv } from '../scripts/update-calendar.js';
import { calendarDay, interpretDay, isTradingDay } from '../src/core/calendar/index.js';
import { createServer } from '../src/mcp/server.js';
const inputDir = 'test/fixtures/calendar';
it('regenerates bundled data byte for byte and rejects corrupted CSV before producing output', async () => {
  const options = { years: [115, 116], inputDir, fetched: '2026-11-16' };
  expect(await generate(options)).toBe(await readFile('src/core/calendar/data.ts', 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'calendar-')); await cp(inputDir, dir, { recursive: true });
  const csv = await readFile(join(dir, 'dgpa-115.csv'), 'utf8'); await writeFile(join(dir, 'dgpa-115.csv'), csv.replace('20260101,四,2', '20260101,四,9'));
  const before = await readFile('src/core/calendar/data.ts', 'utf8');
  await expect(generate({ ...options, inputDir: dir })).rejects.toThrow(/放假代碼/);
  expect(await readFile('src/core/calendar/data.ts', 'utf8')).toBe(before);
});
it('parses a synthetic weekend makeup workday', async () => {
  const csv = await readFile(`${inputDir}/dgpa-115.csv`, 'utf8');
  const parsed = parseCsv(csv.replace('20260103,六,2', '20260103,六,0'), 2026);
  expect(interpretDay('2026-01-03', { ...parsed, entries: [], source: { title: '', url: '', published: '', twse: '', fetched: '' } })).toMatchObject({ office: 'makeup_workday', market: { open: false } });
});
it.each([
  ['2026-01-02', 'workday', true, '國曆新年開始交易日'], ['2026-02-12', 'workday', false, '市場無交易，僅辦理結算交割作業'],
  ['2026-02-16', 'holiday', false, '農曆除夕'], ['2026-02-21', 'weekend', false, ''], ['2027-04-30', 'holiday', false, '補假'],
] as const)('interprets %s', (date, office, open, text) => {
  const day = calendarDay(date); expect(day).toMatchObject({ covered: true, office, market: { open } }); expect(JSON.stringify(day)).toContain(text); expect(isTradingDay(date)).toBe(open);
});
it.each(['2025-12-31', '2028-01-01'])('does not cover %s', date => { expect(calendarDay(date).covered).toBe(false); expect(isTradingDay(date)).toBeUndefined(); });
it('serves single days, ranges and errors through MCP', async () => {
  const server = createServer({ toolsets: ['calendar'], clock: () => new Date('2026-02-12T00:00:00Z') });
  const client = new Client({ name: 'calendar-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(a); await client.connect(b);
    const one = await client.callTool({ name: 'taiwan_calendar', arguments: {} }); expect(JSON.stringify(one.content)).toContain('行政機關：上班'); expect(JSON.stringify(one.content)).toContain('市場無交易');
    const range = await client.callTool({ name: 'taiwan_calendar', arguments: { date: '2026-02-12', end_date: '2026-02-16' } }); expect(JSON.stringify(range.content)).toContain('放假日數'); expect(JSON.stringify(range.content)).toContain('農曆除夕');
    const bad = await client.callTool({ name: 'taiwan_calendar', arguments: { date: '2028-01-01' } }); expect(bad.isError).toBe(true); expect(JSON.stringify(bad.content)).toContain('2027-12-31');
  } finally { await client.close(); await server.close(); }
});
