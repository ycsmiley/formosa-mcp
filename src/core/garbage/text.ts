export const norm = (s: string) => s.trim().replaceAll('台', '臺').replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10));
