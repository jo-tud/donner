// Minimal, bounded ZIP reader (for .docx/.xlsx/.pptx/.odt text extraction).
// Only "stored" and "deflate" entries are supported; everything is size-capped so a
// hostile attachment cannot exhaust memory (zip bombs).

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export function listZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("not a zip file");
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count && n < 5000; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) throw new Error("zip: bad central directory");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, size, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buf, entry, maxBytes = 20 * 1024 * 1024) {
  const off = entry.localOff;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOC_SIG) throw new Error("zip: bad local header");
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data.subarray(0, Math.min(data.length, maxBytes));
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new Error(`zip: unsupported compression method ${entry.method}`);
}

/** Read the entries whose names match `filter`, within a total byte budget. */
export function readZipFiles(buf, filter, { maxTotal = 50 * 1024 * 1024 } = {}) {
  const out = [];
  let total = 0;
  for (const e of listZip(buf)) {
    if (!filter(e.name)) continue;
    const remaining = maxTotal - total;
    if (remaining <= 0) break;
    let data;
    try {
      data = readZipEntry(buf, e, remaining);
    } catch (err) {
      if (err.code === "ERR_BUFFER_TOO_LARGE") break;
      throw err;
    }
    total += data.length;
    out.push({ name: e.name, data });
  }
  return out;
}
