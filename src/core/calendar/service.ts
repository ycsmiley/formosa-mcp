import { calendarDay, coveredYears } from './index.js';
const firstYear = Math.min(...coveredYears), lastYear = Math.max(...coveredYears);
export const calendarCoverage = `${firstYear === lastYear ? firstYear : `${firstYear}–${lastYear}`}（民國${firstYear === lastYear ? firstYear - 1911 : `${firstYear - 1911}–${lastYear - 1911}`}年）`;
const source = '資料來源：行政院人事行政總處「中華民國政府行政機關辦公日曆表」https://data.gov.tw/dataset/14718；臺灣證券交易所市場開休市日期 https://www.twse.com.tw/zh/trading/holiday.html';
const reminder = '颱風等天然災害停班停課不在此日曆內，請查 work_school_closure 工具或人事總處 https://www.dgpa.gov.tw/typh/daily/nds.html 。民間企業是否放假依各公司規定。';
const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
export function createCalendarService(clock = () => new Date()) {
  return { async query(q: { date?: string; end_date?: string }) {
    const start = q.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(clock()), end = q.end_date ?? start;
    const error = (message: string) => ({ text: `${message} 涵蓋範圍：${calendarCoverage}，${Math.min(...coveredYears)}-01-01 至 ${Math.max(...coveredYears)}-12-31。 ${source}`, isError: true });
    if (!valid(start) || !valid(end) || !calendarDay(start).covered || !calendarDay(end).covered) return error('日期無效或超出日曆涵蓋範圍，請使用 YYYY-MM-DD。');
    const length = (Date.parse(end) - Date.parse(start)) / 86400000;
    if (length < 0 || length > 62) return error('結束日期不可早於開始日期，且最多距開始日期 62 天。');
    const days = Array.from({ length: length + 1 }, (_, i) => calendarDay(new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10))).filter(d => d.covered);
    const format = (d: typeof days[number]) => {
      const office = d.office === 'workday' ? '上班（一般上班日）' : d.office === 'makeup_workday' ? '上班（補行上班日）' : d.office === 'weekend' ? '放假（週末）' : `放假（${d.note || '國定假日或補假'}）`;
      const market = d.market.open ? `開市${d.market.name ? `（${d.market.name}）` : ''}` : `休市（${d.market.name ? `證交所：${d.market.name}` : '週末'}）`;
      return `${d.date}（星期${'日一二三四五六'[d.weekday]}）\n行政機關：${office}\n股市：${market}`;
    };
    const shown = q.end_date === undefined ? days : days.filter(d => d.note || d.office === 'makeup_workday' || d.weekday !== 0 && d.weekday !== 6 && (!d.market.open || d.market.name));
    const details = [...new Map(days.map(d => [d.date.slice(0, 4), d])).values()].map(d => `人事總處 ${Number(d.date.slice(0, 4)) - 1911} 年辦公日曆表（${d.sources.published} 公布）；證交所 ${Number(d.date.slice(0, 4)) - 1911} 年開休市日期（${d.sources.fetched} 取得）`).join('；');
    return { text: [...(q.end_date === undefined ? [] : [`${start} 至 ${end}`, ...(shown.length ? shown.map(d => format(d).replaceAll('\n', '；')) : ['此期間沒有國定假日、補班或股市休市日（週末除外）。']), `放假日數（含週末）：${days.filter(d => d.office === 'holiday' || d.office === 'weekend').length} 天`]), ...(q.end_date === undefined ? shown.map(format) : []), source, `資料日期：${details}`, reminder].join('\n'), isError: false };
  } };
}
