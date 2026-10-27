import { pluginClient } from './plugin-client.js';
const { client, transport } = pluginClient();
try {
  await client.connect(transport);
  console.log('Tools:', (await client.listTools()).tools.map(tool => tool.name).join(', '));
  for (const [name, args] of [['invoice_get_winning_numbers', {}], ['stock_quote', { query: '2330' }]] as const) {
    const result = await client.callTool({ name, arguments: args });
    console.log(`\n${name}:`);
    for (const item of result.content as { type: string; text?: string }[]) if (item.type === 'text') console.log(item.text);
    if (result.isError) throw new Error(`${name} returned an error`);
  }
} finally { await client.close(); await transport.close(); }
