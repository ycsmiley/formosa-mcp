import { z } from 'zod';
import { createRailService, type RailResult } from '../core/rail/service.js';
import type { Toolset } from './toolsets.js';
const missingKey = '需要 TDX 會員 API 金鑰：請至 https://tdx.transportdata.tw/register 註冊（審核後），於會員中心 → API金鑰取得 Client Id／Secret，設定 TDX_CLIENT_ID 和 TDX_CLIENT_SECRET 後重新啟動。例如：formosa-mcp --toolsets rail';
const result = ({ text, isError }: RailResult) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
export const rail: Toolset = {
  name: 'rail', description: '高鐵／臺鐵時刻與臺鐵即時資訊 Taiwan THSR/TRA timetables and TRA live status',
  register(server, ctx) {
    const id = ctx.env?.TDX_CLIENT_ID, secret = ctx.env?.TDX_CLIENT_SECRET;
    const service = id && secret ? createRailService({ credentials: { clientId: id, clientSecret: secret }, http: ctx.railHttp ?? ((url, init) => fetch(url, init)), clock: ctx.clock }) : undefined;
    const schema = { origin: z.string().max(50), destination: z.string().max(50), date: z.string().optional(), time: z.string().optional().describe('時間 HH:mm；24:00–29:59 表示營運日隔日凌晨') };
    for (const [tool, railway, description] of [
      ['thsr_timetable', 'THSR', '查高鐵某日起迄站時刻；站名或代碼，日期預設臺北今天，時間 HH:mm；24:00–29:59 表示營運日隔日凌晨。THSR OD timetable; optional date and departure time.'],
      ['tra_timetable', 'TRA', '查臺鐵某日起迄站時刻與車種；站名或代碼，日期預設臺北今天，時間 HH:mm；24:00–29:59 表示營運日隔日凌晨。TRA OD timetable with train types.'],
    ] as const) server.registerTool(tool, { description, inputSchema: schema }, async args => result(service ? await service.timetable(railway, args) : { text: missingKey, isError: true }));
    server.registerTool('tra_live', {
      description: '查臺鐵車次目前位置與誤點，或車站即時看板；train_no、station 恰填一項。TRA live train position/delay or station board; provide exactly one argument.',
      inputSchema: { train_no: z.string().optional(), station: z.string().max(50).optional() },
    }, async args => result(service ? await service.live(args) : { text: missingKey, isError: true }));
  },
};
