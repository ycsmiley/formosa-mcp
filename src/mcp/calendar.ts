import { z } from 'zod';
import { calendarCoverage, createCalendarService } from '../core/calendar/service.js';
import type { Toolset } from './toolsets.js';
export const calendar: Toolset = {
  name: 'calendar', description: '辦公日曆與股市休市日 Office calendar & market holidays',
  register(server, ctx) {
    const service = createCalendarService(ctx.clock);
    server.registerTool('taiwan_calendar', { description: `查詢 ${calendarCoverage}行政機關上班／放假／補班及股市開休市；不包含颱風停班停課。`, inputSchema: {
      date: z.string().optional().describe('日期 YYYY-MM-DD，預設臺北時間今天'), end_date: z.string().optional().describe('迄日 YYYY-MM-DD，最多距起日 62 天'),
    } }, async args => { const result = await service.query(args); return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }; });
  },
};
