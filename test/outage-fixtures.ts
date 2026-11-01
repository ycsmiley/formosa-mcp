import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/outage/zip.js';
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/outage/${name}`, import.meta.url), 'utf8');
export const powerCsv = (expanded = false) => { const [header, ...rows] = fixture('taipower.csv').trim().split('\n'); return '\uFEFF' + [header, ...(expanded ? Array.from({ length: 105 }, (_, i) => rows[i % rows.length]) : rows)].join('\r\n'); };
// ZIP central directory offsets, sizes and CRCs are populated without external tools.
export function zip(entries: [string, string, number?][] = [['101.csv', powerCsv(true), 8]]): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, text, method = 8] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(text), compressed = method === 8 ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8); header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed); central.push(directory, filename); offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
