import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';

type Question = { id: string; question: string; expected_tool: string; expected_args: Record<string, string>; expected_key_facts: string[]; daily_ci: boolean; expires?: string };
type Reply = { text: string; isError?: boolean };
type Check = string | RegExp;
const datePattern = /資料日期：(\d{3})年(\d{2})月(\d{2})日/;
const close = /收盤 [\d,]+\.\d{2}/;
export const checks: Record<string, Check[]> = {
  'invoice-001': [/特別獎：\d{8}/, /特獎：\d{8}/, /頭獎：\d{8}/, '資料來源'],
  'invoice-002': ['領獎期間'], 'invoice-003': ['頭獎', '20 萬元'], 'invoice-005': ['沒中'],
  'invoice-011': ['領獎期間'], 'invoice-012': ['頭獎', '20 萬元'],
  'stock-001': ['台積電（2330）｜上市', datePattern, close, '盤後資料'],
  'stock-003': ['環球晶（6488）｜上櫃', datePattern, close],
  'stock-011': ['環球晶（6488）｜上櫃', datePattern, close, /本益比 ([\d,.]+|—|-)/],
  'stock-013': ['找不到', '請輸入股票代號'],
};
// Ignore whitespace and colons; facts otherwise remain contiguous and exact.
export const normalizeFact = (text: string) => text.replace(/[\s:：]/g, '');
export const matchesFact = (text: string, fact: string) => normalizeFact(text).includes(normalizeFact(fact));
export function parseRocDate(text: string): Date | null {
  const match = text.match(datePattern); if (!match) return null;
  const year = Number(match[1]) + 1911, month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}
export function isStale(date: Date, today: Date): boolean {
  return (today.getTime() - date.getTime()) / 86400000 > 10;
}
function taipeiToday(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}
export async function runChecks(questions: Question[], callTool: (q: Question, signal: AbortSignal) => Promise<Reply>, log: (line: string) => void = console.log, today = taipeiToday()) {
  const daily = questions.filter(q => q.daily_ci), failures: string[] = [];
  for (const q of daily) {
    let reply: Reply | undefined;
    try {
      if (q.expires) {
        const days = (Date.parse(q.expires) - today.getTime()) / 86400000;
        if (days < 0) throw new Error(`題目已過期（expires ${q.expires}），請更新題目`);
        if (days <= 30) log(`警告：題目 ${q.id} 將於 ${q.expires} 過期，請準備更新`);
      }
      if (!checks[q.id]) throw new Error('未定義檢查');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        reply = await Promise.race([callTool(q, controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('呼叫逾時（30 秒）')); controller.abort(); }, 30000); })]);
      } finally { clearTimeout(timer); }
      if (reply.isError) throw new Error('工具回傳錯誤');
      if (!reply.text.trim() || !/[\u3400-\u9fff]/.test(reply.text)) throw new Error('回覆為空或不含中文');
      for (const fact of q.expected_key_facts) if (!matchesFact(reply.text, fact)) throw new Error(`缺少事實：${fact}`);
      for (const check of checks[q.id]) if (typeof check === 'string' ? !matchesFact(reply.text, check) : !check.test(reply.text)) throw new Error(`未通過檢查：${check}`);
      if (['stock-001', 'stock-003', 'stock-011'].includes(q.id)) {
        const date = parseRocDate(reply.text);
        if (!date || isStale(date, today)) throw new Error('資料日期無效或超過 10 天');
      }
      log(`✅ ${q.id} ${q.question}`);
    } catch (error) {
      failures.push(q.id);
      log(`❌ ${q.id} ${q.question}：${error instanceof Error ? error.message : String(error)}`);
      if (reply) log(`回覆：${reply.text.slice(0, 300)}`);
    }
  }
  const summary = `每日即時檢查：${daily.length} 題通過 ${daily.length - failures.length} 題，失敗 ${failures.length} 題${failures.length ? `（${failures.join('、')}）` : ''}`;
  log(summary);
  return { failures, summary };
}
async function main() {
  const questions: Question[] = JSON.parse(readFileSync(new URL('../evals/taiwan-questions.json', import.meta.url), 'utf8'));
  const server = createServer({ toolsets: ['invoice', 'stock'] });
  const client = new Client({ name: 'daily-eval', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const result = await runChecks(questions, async (q, signal) => {
      const response = await client.callTool({ name: q.expected_tool, arguments: q.expected_args }, undefined, { signal });
      const content = Array.isArray(response.content) ? response.content : [];
      return { text: content.map(item => typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string' ? item.text : '').join('\n'), isError: response.isError === true };
    });
    if (result.failures.length) process.exitCode = 1;
  } finally { await client.close(); await server.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0));
