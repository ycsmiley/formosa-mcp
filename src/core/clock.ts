export type Clock = () => Date;
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', hourCycle: 'h23',
});
export function taipeiParts(date: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour };
}
