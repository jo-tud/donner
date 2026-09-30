// PDF → text.
//
// Uses poppler's `pdftotext` when it is installed (best quality; `index.pdftotext: "auto"`).
// Otherwise falls back to a built-in extractor for machine-generated PDFs (invoices, letters):
// Flate/ASCII85/ASCIIHex/LZW streams, object streams, simple fonts and ToUnicode CMaps.
// Scanned PDFs have no text layer and yield nothing (no OCR).

import { spawn, spawnSync } from "node:child_process";
import { inflateSync, constants as zc } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pdftotextAvailable;
const PDFTOTEXT_MEMORY_KB = 1024 * 1024;

export function hasPdftotext() {
  if (pdftotextAvailable === undefined) {
    if (process.env.DONNER_NO_PDFTOTEXT) return (pdftotextAvailable = false);
    try {
      const r = spawnSync("pdftotext", ["-v"], { stdio: "ignore", timeout: 5000, shell: false });
      pdftotextAvailable = !r.error;
    } catch {
      pdftotextAvailable = false;
    }
  }
  return pdftotextAvailable;
}

function runPdftotext(buf, { timeoutMs = 30000, maxChars = 200000 } = {}) {
  // pdftotext needs a seekable file; use a private temp dir that is always removed.
  const dir = mkdtempSync(join(tmpdir(), "donner-pdf-"));
  const file = join(dir, "in.pdf");
  writeFileSync(file, buf, { mode: 0o600 });
  return new Promise((resolve) => {
    // Native parser on untrusted input: private temp file, page cap, address-space limit,
    // hard timeout, output cap.
    const args = ["-q", "-enc", "UTF-8", "-nopgbrk", "-l", "500", file, "-"];
    const opts = { stdio: ["ignore", "pipe", "ignore"], shell: false };
    const child =
      process.platform === "win32"
        ? spawn("pdftotext", args, opts)
        : spawn("/bin/sh", ["-c", 'ulimit -v "$1" 2>/dev/null; shift; exec "$@"', "sh", String(PDFTOTEXT_MEMORY_KB), "pdftotext", ...args], opts);
    const chunks = [];
    let size = 0;
    const limit = maxChars * 4;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else child.kill("SIGKILL");
    });
    const done = (text) => {
      clearTimeout(timer);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      resolve(text);
    };
    child.on("error", () => done(null));
    child.on("close", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function pdfToText(buf, opts = {}) {
  if (opts.usePdftotext && hasPdftotext()) {
    const t = await runPdftotext(buf, opts);
    if (t !== null && t.trim()) return { text: t, engine: "pdftotext" };
  }
  return { text: builtinPdfText(buf, opts.maxChars), engine: "builtin" };
}

// ─── Built-in extractor ──────────────────────────────────────────────

const WIN_ANSI_80 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

function winAnsi(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes.charCodeAt(i);
    s += b >= 0x80 && b < 0xa0 ? String.fromCharCode(WIN_ANSI_80[b - 0x80] || 0x20) : String.fromCharCode(b);
  }
  return s;
}

function hexToBytes(hex) {
  const h = hex.replace(/[^0-9a-fA-F]/g, "");
  let s = "";
  for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt((h[i] || "0") + (h[i + 1] || "0"), 16));
  return s;
}

function utf16beHex(hex) {
  const bytes = hexToBytes(hex);
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  return s;
}

const MAX_CMAP_ENTRIES = 200000;

/** Sections between `begin` and `end` markers, found with indexOf (linear). */
function sections(text, begin, end) {
  const out = [];
  let i = 0;
  while (out.length < 10000) {
    const a = text.indexOf(begin, i);
    if (a < 0) break;
    const b = text.indexOf(end, a + begin.length);
    if (b < 0) break;
    out.push(text.slice(a + begin.length, b));
    i = b + end.length;
  }
  return out;
}

function parseCMap(text) {
  const map = new Map();
  let codeLen = 1;
  for (const block of sections(text, "beginbfchar", "endbfchar").map((b) => [null, b])) {
    if (map.size > MAX_CMAP_ENTRIES) break;
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1], 16), utf16beHex(m[2]));
      codeLen = Math.max(codeLen, m[1].length / 2);
    }
  }
  for (const block of sections(text, "beginbfrange", "endbfrange").map((b) => [null, b])) {
    if (map.size > MAX_CMAP_ENTRIES) break;
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g;
    for (const m of block[1].matchAll(re)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 65535, lo + Math.max(0, MAX_CMAP_ENTRIES - map.size));
      codeLen = Math.max(codeLen, m[1].length / 2);
      if (m[3] !== undefined) {
        const base = utf16beHex(m[3]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      } else {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16beHex(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      }
    }
  }
  return { map, codeLen };
}

function decodeWithCMap(bytes, cmap) {
  let s = "";
  const n = cmap.codeLen;
  for (let i = 0; i + n - 1 < bytes.length; i += n) {
    let code = 0;
    for (let k = 0; k < n; k++) code = (code << 8) | bytes.charCodeAt(i + k);
    const u = cmap.map.get(code);
    s += u !== undefined ? u : n === 1 ? winAnsi(bytes[i]) : "";
  }
  return s;
}

function readLiteral(s, i) {
  // s[i] === "("
  let depth = 1;
  let out = "";
  i++;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n === "b") out += "\b";
      else if (n === "f") out += "\f";
      else if (n === "\r" || n === "\n") {
        if (n === "\r" && s[i + 2] === "\n") i++;
      } else if (/[0-7]/.test(n)) {
        let oct = n;
        if (/[0-7]/.test(s[i + 2])) oct += s[++i + 1];
        if (/[0-7]/.test(s[i + 2])) oct += s[++i + 1];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else out += n ?? "";
      i += 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) break;
    }
    out += c;
    i++;
  }
  return { value: out, end: i + 1 };
}

function extractFromContent(content, fontCMaps, fallbackCMap) {
  const out = [];
  const operands = [];
  let font = null;
  let lastY = null;
  const decode = (bytes) => {
    const cm = (font && fontCMaps.get(font)) || null;
    if (cm) return decodeWithCMap(bytes, cm);
    if (fallbackCMap && fallbackCMap.codeLen === 2 && bytes.length % 2 === 0 && bytes.length > 0 && /[\x00-\x08]/.test(bytes)) {
      return decodeWithCMap(bytes, fallbackCMap);
    }
    return winAnsi(bytes);
  };
  let i = 0;
  const s = content;
  while (i < s.length) {
    if (operands.length > 100000) operands.length = 0;
    const c = s[i];
    if (c === "%") {
      while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
      continue;
    }
    if (c === "(") {
      const r = readLiteral(s, i);
      operands.push({ str: r.value });
      i = r.end;
      continue;
    }
    if (c === "<" && s[i + 1] !== "<") {
      const end = s.indexOf(">", i);
      if (end < 0) break;
      operands.push({ str: hexToBytes(s.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (c === "[") {
      operands.push({ arrayStart: true });
      i++;
      continue;
    }
    if (c === "]") {
      let k = operands.length - 1;
      while (k >= 0 && !operands[k].arrayStart) k--;
      const arr = operands.slice(k + 1);
      operands.length = Math.max(0, k);
      operands.push({ arr });
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // number, name or operator
    let j = i;
    while (j < s.length && !/[\s()<>\[\]\/%]/.test(s[j])) j++;
    if (j === i) j = i + 1;
    let tok = s.slice(i, j);
    if (c === "/") {
      j = i + 1;
      while (j < s.length && !/[\s()<>\[\]\/%{}]/.test(s[j])) j++;
      tok = s.slice(i, j);
      operands.push({ name: tok.slice(1) });
      i = j;
      continue;
    }
    i = j;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(tok)) {
      operands.push({ num: parseFloat(tok) });
      continue;
    }
    switch (tok) {
      case "Tf":
        font = operands.find((o) => o.name)?.name ?? font;
        break;
      case "Tj":
      case "'":
      case '"': {
        const str = operands.filter((o) => o.str !== undefined).pop();
        if (tok !== "Tj") out.push("\n");
        if (str) out.push(decode(str.str));
        break;
      }
      case "TJ": {
        const arr = operands.find((o) => o.arr)?.arr || [];
        for (const el of arr) {
          if (el.str !== undefined) out.push(decode(el.str));
          else if (el.num !== undefined && el.num < -180) out.push(" ");
        }
        break;
      }
      case "Td":
      case "TD": {
        const nums = operands.filter((o) => o.num !== undefined);
        const ty = nums.length >= 2 ? nums[nums.length - 1].num : 0;
        const tx = nums.length >= 2 ? nums[nums.length - 2].num : 0;
        if (Math.abs(ty) > 0.5) out.push("\n");
        else if (tx > 1) out.push(" ");
        break;
      }
      case "Tm": {
        const nums = operands.filter((o) => o.num !== undefined);
        const y = nums.length >= 6 ? nums[5].num : null;
        if (y !== null && lastY !== null && Math.abs(y - lastY) > 0.5) out.push("\n");
        else out.push(" ");
        lastY = y;
        break;
      }
      case "T*":
        out.push("\n");
        break;
      case "ET":
        out.push(" ");
        break;
      default:
        break;
    }
    operands.length = 0;
  }
  return out.join("");
}

function plausible(text) {
  if (!text) return false;
  const sample = text.slice(0, 5000);
  const good = sample.match(/[\p{L}\p{N}\s.,;:!?€$%&()\-+/'"@#*]/gu)?.length || 0;
  return good / sample.length > 0.85;
}

function ascii85Decode(str) {
  const out = [];
  let group = [];
  const s = str.replace(/^\s*<~/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "~") break;
    if (c <= " ") continue;
    if (c === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const v = c.charCodeAt(0) - 33;
    if (v < 0 || v > 84) continue;
    group.push(v);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const k = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...bytes.slice(0, k - 1));
  }
  return Buffer.from(out).toString("latin1");
}

function asciiHexDecode(str) {
  const h = str.replace(/>.*$/s, "").replace(/[^0-9a-fA-F]/g, "");
  return Buffer.from(h.length % 2 ? h + "0" : h, "hex").toString("latin1");
}

/** PDF LZWDecode (EarlyChange 1), bounded by maxOut. */
function lzwDecode(str, maxOut) {
  const input = Buffer.from(str, "latin1");
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push(null, null); // 256 clear, 257 EOD
  };
  reset();
  let bits = 9;
  let buf = 0;
  let nbits = 0;
  let prev = null;
  let outLen = 0;
  for (let i = 0; i < input.length; i++) {
    buf = (buf << 8) | input[i];
    nbits += 8;
    while (nbits >= bits) {
      const code = (buf >>> (nbits - bits)) & ((1 << bits) - 1);
      nbits -= bits;
      buf &= (1 << nbits) - 1;
      if (code === 256) {
        reset();
        bits = 9;
        prev = null;
        continue;
      }
      if (code === 257) return Buffer.from(out).toString("latin1");
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else return Buffer.from(out).toString("latin1");
      for (const b of entry) out.push(b);
      outLen += entry.length;
      if (outLen > maxOut) return Buffer.from(out).toString("latin1");
      if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + 1 >= 1 << bits && bits < 12) bits++;
    }
  }
  return Buffer.from(out).toString("latin1");
}

/** Apply a stream's filter chain; null when a filter is unsupported (images, predictors). */
function decodeStream(dict, raw, budget) {
  const filterSpec = dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/)?.[1] || "";
  const filters = [...filterSpec.matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]);
  let data = raw;
  for (const f of filters) {
    if (f === "FlateDecode" || f === "Fl") {
      if (/\/Predictor\s+(?:1[0-5]|[2-9])/.test(dict)) return null;
      try {
        data = inflateSync(Buffer.from(data, "latin1"), { maxOutputLength: Math.max(1, Math.min(budget, 16 * 1024 * 1024)), finishFlush: zc.Z_SYNC_FLUSH }).toString("latin1");
      } catch {
        return null;
      }
    } else if (f === "ASCII85Decode" || f === "A85") data = ascii85Decode(data);
    else if (f === "ASCIIHexDecode" || f === "AHx") data = asciiHexDecode(data);
    else if (f === "LZWDecode" || f === "LZW") {
      if (/\/Predictor\s+(?:1[0-5]|[2-9])/.test(dict)) return null;
      data = lzwDecode(data, Math.min(budget, 16 * 1024 * 1024));
    } else return null; // DCT, JBIG2, CCITT, Crypt, …: not text
  }
  return data;
}

export function builtinPdfText(buf, maxChars = 200000) {
  const s = buf.toString("latin1");
  if (!s.startsWith("%PDF")) return "";
  const objects = new Map(); // objnum -> {dict, data}
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  let budget = 64 * 1024 * 1024; // max decompressed bytes
  const objStreams = [];
  while ((m = objRe.exec(s)) !== null) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endobj", start);
    if (end < 0) break;
    const body = s.slice(start, end);
    objRe.lastIndex = end + 6;
    const si = body.search(/\bstream\r?\n/);
    if (si < 0) {
      objects.set(Number(m[1]), { dict: body, data: null });
      continue;
    }
    const dict = body.slice(0, si);
    let dataStart = si + 6;
    if (body[dataStart] === "\r") dataStart++;
    if (body[dataStart] === "\n") dataStart++;
    let dataEnd = body.lastIndexOf("endstream");
    if (dataEnd < 0) dataEnd = body.length;
    let raw = body.slice(dataStart, dataEnd);
    // Prefer the declared /Length; otherwise drop exactly one end-of-line before "endstream"
    // (compressed data may itself end in CR/LF bytes).
    const len = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    if (len && Number(len[1]) <= raw.length) raw = raw.slice(0, Number(len[1]));
    else raw = raw.replace(/\r?\n$|\r$/, "");
    if (/\/Subtype\s*\/Image|\/FontFile|\/Length1|\/Type\s*\/XRef/.test(dict)) {
      objects.set(Number(m[1]), { dict, data: null });
      continue;
    }
    const data = decodeStream(dict, raw, budget);
    if (data) budget -= data.length;
    objects.set(Number(m[1]), { dict, data });
    if (data && /\/Type\s*\/ObjStm/.test(dict)) objStreams.push({ dict, data });
    if (budget <= 0) break;
  }
  // Objects packed into object streams (PDF 1.5+): fonts and resources often live here.
  for (const os of objStreams) {
    const n = Number(os.dict.match(/\/N\s+(\d+)/)?.[1] || 0);
    const first = Number(os.dict.match(/\/First\s+(\d+)/)?.[1] || 0);
    const header = os.data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < Math.min(n, 100000) && 2 * k + 1 < header.length; k++) {
      const num = header[2 * k];
      const off = first + header[2 * k + 1];
      const next = 2 * k + 3 < header.length ? first + header[2 * k + 3] : os.data.length;
      if (!objects.has(num)) objects.set(num, { dict: os.data.slice(off, next), data: null });
    }
  }

  // ToUnicode CMaps, by object number
  const cmaps = new Map();
  let fallbackCMap = null;
  for (const [num, o] of objects) {
    if (o.data && o.data.includes("begincmap")) {
      const cm = parseCMap(o.data);
      cmaps.set(num, cm);
      if (!fallbackCMap || cm.map.size > fallbackCMap.map.size) fallbackCMap = cm;
    }
  }
  // Font resource names -> CMap, via "/F1 12 0 R" entries and font objects' /ToUnicode.
  const fontCMaps = new Map();
  for (const [, o] of objects) {
    let fontDict = o.dict.match(/\/Font\s*<<([^]*?)>>/)?.[1];
    if (!fontDict) {
      // "/Font 12 0 R": the font dictionary is a separate object.
      const ref = o.dict.match(/\/Font\s+(\d+)\s+\d+\s+R/);
      fontDict = ref ? objects.get(Number(ref[1]))?.dict : null;
    }
    if (!fontDict) continue;
    for (const fm of fontDict.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const fontObj = objects.get(Number(fm[2]));
      const tu = fontObj?.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
      if (tu && cmaps.has(Number(tu[1]))) fontCMaps.set(fm[1], cmaps.get(Number(tu[1])));
    }
  }

  const parts = [];
  let total = 0;
  for (const [, o] of objects) {
    if (!o.data || o.data.includes("begincmap")) continue;
    if (!/\bBT\b/.test(o.data) || !/T[jJ]\b/.test(o.data)) continue;
    const t = extractFromContent(o.data, fontCMaps, fallbackCMap);
    // Judge each content stream on its own: one stream in an unmappable font (a logo, a
    // barcode) must not discard the readable text of the rest of the document.
    if (t.trim() && plausible(t)) {
      parts.push(t);
      total += t.length;
      if (total > maxChars) break;
    }
  }
  const text = parts
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, maxChars);
}
