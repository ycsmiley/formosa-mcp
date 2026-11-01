export const norm = (s: string) => s.trim().replaceAll('台', '臺').replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10));
export const stripZeroWidth = (s: string) => s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
export const validKeyword = (value: string) => [...value].length >= 2 && !/["\\]/.test(value) && !/^[\p{N}]+$/u.test(value) && !/^[\p{P}\p{S}\s]+$/u.test(value);
