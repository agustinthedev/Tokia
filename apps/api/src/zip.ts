import { promises as fsp } from 'node:fs';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function timeDate(): { time: number; date: number } {
  const date = new Date();
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

export async function createZip(files: Array<{ name: string; path: string }>): Promise<Buffer> {
  const chunks: Buffer[] = []; const central: Buffer[] = []; let offset = 0; const timestamp = timeDate();
  for (const file of files) {
    const data = await fsp.readFile(file.path); const name = Buffer.from(file.name.replaceAll('\\', '/'), 'utf8'); const crc = crc32(data);
    const header = Buffer.alloc(30 + name.length); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6); header.writeUInt16LE(0, 8); header.writeUInt16LE(timestamp.time, 10); header.writeUInt16LE(timestamp.date, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28); name.copy(header, 30);
    chunks.push(header, data);
    const entry = Buffer.alloc(46 + name.length); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0, 8); entry.writeUInt16LE(0, 10); entry.writeUInt16LE(timestamp.time, 12); entry.writeUInt16LE(timestamp.date, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt16LE(0, 30); entry.writeUInt16LE(0, 32); entry.writeUInt16LE(0, 34); entry.writeUInt16LE(0, 36); entry.writeUInt32LE(0, 38); entry.writeUInt32LE(offset, 42); name.copy(entry, 46); central.push(entry); offset += header.length + data.length;
  }
  const centralOffset = offset; const centralData = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralData, end]);
}

