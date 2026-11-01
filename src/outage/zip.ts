import { inflateRawSync } from 'node:zlib';
// Only the numbered data CSVs are decoded; manifest/schema files are ignored.
export function readZip(bytes: Uint8Array): Map<string, string> {
  try {
    const b = Buffer.from(bytes); let eocd = b.length - 22;
    for (; eocd >= Math.max(0, b.length - 65557); eocd--) if (b.readUInt32LE(eocd) === 0x06054b50 && eocd + 22 + b.readUInt16LE(eocd + 20) === b.length) break;
    if (eocd < Math.max(0, b.length - 65557) || b.readUInt16LE(eocd + 4) || b.readUInt16LE(eocd + 6) || b.readUInt16LE(eocd + 8) !== b.readUInt16LE(eocd + 10)) throw Error();
    const count = b.readUInt16LE(eocd + 10), end = b.readUInt32LE(eocd + 16) + b.readUInt32LE(eocd + 12);
    let p = b.readUInt32LE(eocd + 16), total = 0; const files = new Map<string, string>();
    if (end !== eocd || count === 0xffff) throw Error();
    for (let i = 0; i < count; i++) {
      if (p + 46 > end || b.readUInt32LE(p) !== 0x02014b50) throw Error();
      const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), size = b.readUInt32LE(p + 20), length = b.readUInt32LE(p + 24), nameLength = b.readUInt16LE(p + 28), offset = b.readUInt32LE(p + 42);
      const name = b.subarray(p + 46, p + 46 + nameLength).toString('utf8');
      p += 46 + nameLength + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
      if (p > end) throw Error();
      if (!/^\d{3}\.csv$/.test(name)) continue;
      total += length;
      if (flags & 1 || ![0, 8].includes(method) || length > 32 * 1024 * 1024 || total > 64 * 1024 * 1024 || offset + 30 > end || b.readUInt32LE(offset) !== 0x04034b50 || b.readUInt16LE(offset + 8) !== method || files.has(name)) throw Error();
      const start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
      if (start + size > b.readUInt32LE(eocd + 16)) throw Error();
      const compressed = b.subarray(start, start + size), data = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, length) }) : compressed;
      if (data.length !== length || crc32(data) !== crc) throw Error();
      files.set(name, new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data));
    }
    if (p !== end || !files.size) throw Error();
    return files;
  } catch { throw Error('台電 ZIP 資料損壞或格式不支援'); }
}
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
