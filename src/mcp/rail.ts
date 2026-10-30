import { z } from 'zod';
import { createRailService, type RailResult } from '../core/rail/service.js';
import type { Toolset } from './toolsets.js';
export const railKeyGuide = `鐵路工具需要你自己的 TDX 金鑰（免費）。

申請：到 https://tdx.transportdata.tw 註冊免費會員（審核後）→ 會員中心「API 金鑰」取得 Client Id／Client Secret。免費會員有每月呼叫次數上限。

Claude Desktop（claude_desktop_config.json）或 Cursor（.cursor/mcp.json 或 ~/.cursor/mcp.json）加入 env，然後重新啟動：
{
  "mcpServers": {
    "formosa": {
      "command": "npx",
      "args": ["-y", "formosa-mcp", "--toolsets=invoice,stock,rail"],
      "env": {
        "TDX_CLIENT_ID": "你的 Client Id",
        "TDX_CLIENT_SECRET": "你的 Client Secret"
      }
    }
  }
}

不想申請金鑰：發票與台股現在就能免金鑰使用（不需啟用 rail）；免金鑰的公開網址即將推出。

金鑰只放在本機設定，不要貼到對話裡。`;
const result = ({ text, isError }: RailResult) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
export const rail: Toolset = {
  name: 'rail', description: '高鐵／臺鐵時刻與臺鐵即時資訊 Taiwan THSR/TRA timetables and TRA live status',
  register(server, ctx) {
    const id = ctx.env?.TDX_CLIENT_ID?.trim(), secret = ctx.env?.TDX_CLIENT_SECRET?.trim();
    const service = ctx.railService ?? (id && secret ? createRailService({ credentials: { clientId: id, clientSecret: secret }, http: ctx.railHttp ?? ((url, init) => fetch(url, init)), clock: ctx.clock }) : undefined);
    const schema = { origin: z.string().max(50), destination: z.string().max(50), date: z.string().optional(), time: z.string().optional().describe('時間 HH:mm；24:00–29:59 表示營運日隔日凌晨') };
    for (const [tool, railway, description] of [
      ['thsr_timetable', 'THSR', '查高鐵某日起迄站時刻；站名或代碼，日期預設臺北今天，時間 HH:mm；24:00–29:59 表示營運日隔日凌晨。THSR OD timetable; optional date and departure time.'],
      ['tra_timetable', 'TRA', '查臺鐵某日起迄站時刻與車種；站名或代碼，日期預設臺北今天，時間 HH:mm；24:00–29:59 表示營運日隔日凌晨。TRA OD timetable with train types.'],
    ] as const) server.registerTool(tool, { description, inputSchema: schema }, async args => result(service ? await service.timetable(railway, args) : { text: railKeyGuide }));
    server.registerTool('tra_live', {
      description: '查臺鐵車次目前位置與誤點，或車站即時看板；train_no、station 恰填一項。TRA live train position/delay or station board; provide exactly one argument.',
      inputSchema: { train_no: z.string().optional(), station: z.string().max(50).optional() },
    }, async args => result(service ? await service.live(args) : { text: railKeyGuide }));
  },
};
