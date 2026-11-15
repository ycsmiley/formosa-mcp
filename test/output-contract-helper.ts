import { beforeAll, describe, expect, it } from 'vitest';
import { cases, snapshotReaders, staleCases, STALE_WARNING_EXEMPT, upstreamColumns, upstreamObjects } from './output-contract-fixtures.js';
// Attribution labels actually printed by these tools: invoice/stock/garbage/NCDR
// use 資料來源, DGPA/outages use 來源, and rail uses the required TDX credit.
// Require a value on the same line; the mere word 資料來源 is insufficient.
export const sourcePattern = /(?:資料來源|(?:^|\n)來源)[ \t]*[：:][ \t]*\S+|資料介接「交通部TDX平臺」/u;
// Meaningful data dates: full Gregorian/ROC dates on a data-labelled line, the
// lottery's explicitly labelled draw period, operating dates, or dated dividend
// rows. A query's date range / "today onwards" heading is not a data timestamp.
// 資料更新 labels snapshot content changes; 資料取得 labels live acquisition.
// Do not accept stock codes, HH:mm alone, 未提供, or any digit.
const isoDay = /(?<!\d)(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)/u;
const rocDay = /(?<!\d)\d{3}年(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日/u;
const drawPeriod = /(?:統一發票中獎號碼｜|【)\d{3}年(?:01-02|03-04|05-06|07-08|09-10|11-12)月/u;
export const hasDataTime = (text: string) => drawPeriod.test(text) || text.split('\n').some(line =>
  /資料日期|資料時間|資料更新|更新時間|抓取時間|資料取得|時刻表資料|開獎日|營運日|生效|最後更新|^-\s*\d{3}年/u.test(line)
  && (isoDay.test(line) || rocDay.test(line)));
function keys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(keys);
  return [...Object.keys(value), ...Object.values(value).flatMap(keys)];
}
// All actual machine-style fixture keys/CSV columns, plus distinctive raw Chinese
// columns. Common Chinese labels such as 請求號數 are intentionally formatted by
// outage tools; those labels alone are not evidence of a leaked upstream object.
export const deniedKeys = [...new Set([...upstreamObjects.flatMap(keys), ...upstreamColumns])]
  .filter(key => /^[A-Za-z][A-Za-z0-9_]*$/.test(key) || ['第一次停電時間', '第二次停電時間', '停電範圍', '工作概述', '營業區處'].includes(key));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rawKey = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${deniedKeys.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'u');
export function rawJsonViolations(text: string): string[] {
  const problems: string[] = [];
  // (a) Whole output must not parse as an object/array (including null).
  try { const value = JSON.parse(text.trim()); if (typeof value === 'object') problems.push('whole JSON object/array'); } catch { /* formatted text */ }
  // (b) Reject embedded object/array shapes, including pretty printed JSON and
  // numeric/string arrays. A prose prefix or a Markdown fence cannot hide JSON.
  if (/\{\s*"|"\s*:|\[\s*(?:\{|\[|"|-?\d|true\b|false\b|null\b)/u.test(text)) problems.push('embedded JSON literal');
  // (c) Unicode token boundaries prevent short keys (e.g. time/name) matching
  // inside Chinese prose or longer identifiers. Match field names case exactly.
  const key = text.match(rawKey)?.[0]; if (key) problems.push(`raw upstream key: ${key}`);
  return problems;
}
export type Reply = { isError?: boolean; content?: unknown };
export function textOf(reply: Reply) {
  expect(reply.isError, 'fixture must exercise a successful reply').not.toBe(true);
  expect(Array.isArray(reply.content), 'MCP content').toBe(true);
  const text = (reply.content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  expect(text.trim(), 'nonempty formatted output').not.toBe('');
  return text;
}
export interface Harness { listTools(): Promise<string[]>; call(name: string, args: Record<string, unknown>, stale?: boolean): Promise<Reply> }
export function assertStaleCoverage(readers: string[], warningCases: string[], exemptions: string[], registered: string[]) {
  for (const name of readers) {
    expect(registered, `unregistered snapshot reader ${name}`).toContain(name);
    expect(warningCases.includes(name) || exemptions.includes(name), `snapshot reader ${name} needs a stale fixture or named exemption`).toBe(true);
  }
  for (const name of exemptions) {
    expect(registered, `obsolete stale exemption ${name}`).toContain(name);
    expect(warningCases, `${name} has both a stale fixture and an exemption`).not.toContain(name);
  }
  // Exact reverse audit rejects orphan exemptions/cases and omitted readers.
  expect([...warningCases, ...exemptions].sort()).toEqual([...new Set(readers)].sort());
}
export function contractSuite(side: keyof typeof snapshotReaders, harness: Harness) {
  describe(`${side} registered output contract`, () => {
    let registered: string[];
    const replies = new Map<string, string>();
    beforeAll(async () => {
      registered = await harness.listTools();
      for (const name of registered) {
        // Explicit failing assertion names any new registration lacking a case.
        expect(Object.hasOwn(cases, name), `registered tool ${name} has no fixture case`).toBe(true);
        replies.set(name, textOf(await harness.call(name, cases[name])));
      }
    });
    it('enumerates every registration and rejects obsolete fixture entries', () => {
      expect(registered.length).toBeGreaterThan(0);
      for (const name of Object.keys(cases)) expect(registered, `obsolete fixture case ${name}`).toContain(name);
    });
    for (const name of Object.keys(cases)) {
      it(`${name}: source attribution`, () => expect(replies.get(name), `${name} missing data source`).toMatch(sourcePattern));
      it(`${name}: meaningful data time`, () => expect(hasDataTime(replies.get(name)!), `${name} missing data time\n${replies.get(name)}`).toBe(true));
      it(`${name}: no upstream JSON`, () => expect(rawJsonViolations(replies.get(name)!), `${name} raw upstream JSON`).toEqual([]));
    }
    it('enumerates snapshot readers and requires a stale case or named exemption for each', () => {
      for (const name of snapshotReaders[side]) {
        expect(registered, `unregistered snapshot reader ${name}`).toContain(name);
      }
      // Every current Worker registration reads snapshots. An added tool must
      // update this inventory and explicitly choose a warning case or exemption.
      if (side === 'worker') expect([...snapshotReaders.worker].sort()).toEqual([...registered].sort());
      assertStaleCoverage(Object.values(snapshotReaders).flat(), Object.keys(staleCases), STALE_WARNING_EXEMPT, registered);
    });
    for (const name of snapshotReaders[side]) it(`${name}: stale snapshot ${STALE_WARNING_EXEMPT.includes(name) ? 'source/time contract' : 'warning'}`, async () => {
      const fixture = staleCases[name];
      // tra_live must exercise the persisted timetable fallback, not the gateway.
      const args = name === 'tra_live' ? { train_no: '149' } : fixture?.args ?? cases[name];
      const text = textOf(await harness.call(name, args, true));
      expect.soft(text, `${name} stale output missing source`).toMatch(sourcePattern);
      expect.soft(hasDataTime(text), `${name} stale output missing time\n${text}`).toBe(true);
      expect.soft(rawJsonViolations(text), `${name} stale output raw JSON`).toEqual([]);
      if (STALE_WARNING_EXEMPT.includes(name)) expect(fixture, `${name} cannot also have a warning case`).toBeUndefined();
      else {
        expect(fixture, `${name} missing stale case`).toBeDefined();
        expect(text, `${name} missing staleness warning`).toMatch(fixture.warning);
      }
    });
  });
}
