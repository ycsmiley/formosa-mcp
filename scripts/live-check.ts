import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'formosa-live-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: [fileURLToPath(new URL('../dist/stdio.js', import.meta.url)), '--toolsets=invoice,stock'],
});

async function call(name: string, args: Record<string, string> = {}) {
  console.log(`=== ${name} ${JSON.stringify(args)}`);
  const result = await client.callTool({ name, arguments: args });
  const texts: string[] = [];
  for (const item of result.content as { type: string; text?: string }[]) {
    if (item.type === 'text' && typeof item.text === 'string') {
      console.log(item.text);
      texts.push(item.text);
    }
  }
  if (result.isError) throw new Error(`${name} returned isError`);
  return texts.join('\n');
}

try {
  await client.connect(transport);
  console.log('=== listTools');
  const { tools } = await client.listTools();
  for (const tool of tools) console.log(tool.name);
  const numbers = await call('invoice_get_winning_numbers');
  const firstLine = /^頭獎：([^\r\n]*)/m.exec(numbers)?.[1];
  const first = firstLine?.match(/\b\d{8}\b/g);
  const special = /^特別獎：(\d{8})/m.exec(numbers)?.[1];
  const grand = /^特獎：(\d{8})/m.exec(numbers)?.[1];
  if (!first?.length || !special || !grand) throw new Error('Cannot parse winning numbers');
  await call('invoice_check', { number: first[0] });
  const extra = /^增開六獎：([^\r\n]*)/m.exec(numbers)?.[1].match(/\b\d{3}\b/g) ?? [];
  const tails = new Set([...first.map(number => number.slice(-3)), ...extra]);
  let losing: string | undefined;
  for (let candidate = 0; candidate < 100_000_000; candidate++) {
    const number = String(candidate).padStart(8, '0');
    if (!tails.has(number.slice(-3)) && number !== special && number !== grand) {
      losing = number;
      break;
    }
  }
  if (!losing) throw new Error('Cannot generate a losing number');
  await call('invoice_check', { number: losing });
  await call('invoice_check', { number: first[0].slice(-3) });
  // Expected to say 尚未開獎 before 2026-11-25; later runs show the live result.
  await call('invoice_get_winning_numbers', { period: '115年9-10月' });
  for (const query of ['2330', '台積電', '國泰', '6488', '不存在的股票zz']) await call('stock_quote', { query });
  await call('stock_dividends');
  await call('stock_dividends', { query: '2330' });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
