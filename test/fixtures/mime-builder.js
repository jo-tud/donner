// Builders for synthetic test mail: RFC 822 messages, PDFs, ZIP-based office files, ICS.
// Deliberately independent from donner's own parsers so tests cross-check them.

import { deflateRawSync, deflateSync, crc32 } from "node:zlib";

// ─── Header encoding ────────────────────────────────────────────────

export function encodeWord(s, charset = "UTF-8", mode = "B") {
  if (!/[^\x20-\x7e]/.test(s)) return s;
  if (mode === "Q") {
    const bytes = charset.toUpperCase() === "ISO-8859-1" ? Buffer.from(s, "latin1") : Buffer.from(s, "utf8");
    let q = "";
    for (const b of bytes) {
      if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) q += String.fromCharCode(b);
      else if (b === 0x20) q += "_";
      else q += "=" + b.toString(16).toUpperCase().padStart(2, "0");
    }
    return `=?${charset}?Q?${q}?=`;
  }
  return `=?${charset}?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export function addr({ name, email }, mode = "B") {
  if (!name) return `<${email}>`;
  const n = /[^\x20-\x7e]/.test(name) ? encodeWord(name, "UTF-8", mode) : /[,;"<>@]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name;
  return `${n} <${email}>`;
}

export function rfc2822Date(ms) {
  const d = new Date(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

// ─── Body encodings ─────────────────────────────────────────────────

export function qpEncode(buf) {
  let out = "";
  let line = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    let enc;
    if (b === 0x0a) {
      out += line + "\r\n";
      line = "";
      continue;
    }
    if (b === 0x0d) continue;
    if ((b >= 33 && b <= 126 && b !== 61) || b === 32) enc = String.fromCharCode(b);
    else enc = "=" + b.toString(16).toUpperCase().padStart(2, "0");
    if (line.length + enc.length > 75) {
      out += line + "=\r\n";
      line = "";
    }
    line += enc;
  }
  return out + line;
}

function b64Lines(buf) {
  return buf.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/**
 * Build an RFC 822 message.
 * spec: {from, to[], cc[], subject, date, messageId, inReplyTo, references[], text, html,
 *        textCharset, textEncoding, subjectEncoding, headers:{}, attachments:[{filename, contentType, content(Buffer), disposition, messageRfc822}]}
 */
export function buildMessage(spec) {
  const H = [];
  const push = (k, v) => v !== undefined && v !== null && v !== "" && H.push(`${k}: ${v}`);
  // headersTop: object, or [[name, value], …] when a header repeats (Authentication-Results).
  for (const [k, v] of Array.isArray(spec.headersTop) ? spec.headersTop : Object.entries(spec.headersTop || {})) push(k, v);
  push("From", addr(spec.from, spec.addrMode));
  if (spec.to?.length) push("To", spec.to.map((a) => addr(a, spec.addrMode)).join(", "));
  if (spec.cc?.length) push("Cc", spec.cc.map((a) => addr(a, spec.addrMode)).join(", "));
  push("Subject", encodeWord(spec.subject || "", spec.subjectCharset || "UTF-8", spec.subjectEncoding || "B"));
  push("Date", rfc2822Date(spec.date));
  if (spec.messageId) push("Message-ID", `<${spec.messageId}>`);
  if (spec.inReplyTo) push("In-Reply-To", `<${spec.inReplyTo}>`);
  if (spec.references?.length) push("References", spec.references.map((r) => `<${r}>`).join("\r\n "));
  for (const [k, v] of Object.entries(spec.headers || {})) push(k, v);
  push("MIME-Version", "1.0");

  const textPart = spec.text !== undefined && spec.text !== null ? leaf("text/plain", spec.text, spec.textCharset, spec.textEncoding) : null;
  const htmlPart = spec.html ? leaf("text/html", spec.html, spec.htmlCharset, spec.htmlEncoding) : null;
  let bodyPart;
  if (textPart && htmlPart) bodyPart = multipart("alternative", [textPart, htmlPart]);
  else bodyPart = textPart || htmlPart || leaf("text/plain", "");

  const atts = (spec.attachments || []).map((a) => {
    if (a.messageRfc822) {
      return {
        headers: [`Content-Type: message/rfc822; name="${a.filename || "forwarded.eml"}"`, `Content-Disposition: attachment; filename="${a.filename || "forwarded.eml"}"`],
        body: a.content.toString("latin1"),
      };
    }
    const fname = /[^\x20-\x7e]/.test(a.filename) ? `filename*=UTF-8''${encodeURIComponent(a.filename)}` : `filename="${a.filename}"`;
    return {
      headers: [
        `Content-Type: ${a.contentType}; name="${encodeWord(a.filename)}"`,
        `Content-Disposition: ${a.disposition || "attachment"}; ${fname}`,
        "Content-Transfer-Encoding: base64",
        ...(a.contentId ? [`Content-ID: <${a.contentId}>`] : []),
      ],
      body: b64Lines(a.content),
    };
  });
  const top = atts.length ? multipart("mixed", [bodyPart, ...atts]) : bodyPart;
  const out = H.join("\r\n") + "\r\n" + top.headers.join("\r\n") + "\r\n\r\n" + top.body + "\r\n";
  return Buffer.from(out, "latin1");
}

let boundaryCounter = 0;
function multipart(sub, parts) {
  const b = `----=_donner_test_${sub}_${++boundaryCounter}`;
  const body = parts.map((p) => `--${b}\r\n${p.headers.join("\r\n")}\r\n\r\n${p.body}`).join("\r\n") + `\r\n--${b}--`;
  return { headers: [`Content-Type: multipart/${sub}; boundary="${b}"`], body };
}

function leaf(type, text, charset = "UTF-8", encoding = "quoted-printable") {
  const bytes = /^iso-8859-1$|^windows-1252$/i.test(charset) ? Buffer.from(text, "latin1") : Buffer.from(text, "utf8");
  let body;
  if (encoding === "base64") body = b64Lines(bytes);
  else if (encoding === "8bit") body = bytes.toString("latin1").replace(/\r?\n/g, "\r\n");
  else body = qpEncode(bytes);
  return { headers: [`Content-Type: ${type}; charset=${charset}`, `Content-Transfer-Encoding: ${encoding}`], body };
}

// ─── PDF ────────────────────────────────────────────────────────────

function pdfEscape(s) {
  // WinAnsiEncoding: Latin-1 plus the euro sign at 0x80.
  return s.replace(/[\\()]/g, "\\$&").replace(/€/g, "\\200");
}

function ascii85Encode(buf) {
  let out = "";
  for (let i = 0; i < buf.length; i += 4) {
    const chunk = [buf[i], buf[i + 1] ?? 0, buf[i + 2] ?? 0, buf[i + 3] ?? 0];
    const k = Math.min(4, buf.length - i);
    let n = ((chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3]) >>> 0;
    if (n === 0 && k === 4) {
      out += "z";
      continue;
    }
    const d = [];
    for (let j = 0; j < 5; j++) {
      d.unshift(String.fromCharCode((n % 85) + 33));
      n = Math.floor(n / 85);
    }
    out += d.slice(0, k + 1).join("");
  }
  return Buffer.from(out.replace(/(.{72})/g, "$1\n") + "~>", "latin1");
}

/** PDF LZWEncode with EarlyChange 1 (clear code first, EOD last). */
export function lzwEncode(buf) {
  const bytes = [];
  let acc = 0;
  let nacc = 0;
  let size;
  let dict;
  const width = () => (size >= 2048 ? 12 : size >= 1024 ? 11 : size >= 512 ? 10 : 9);
  const write = (code) => {
    const w = width();
    acc = (acc << w) | code;
    nacc += w;
    while (nacc >= 8) {
      bytes.push((acc >>> (nacc - 8)) & 255);
      nacc -= 8;
      acc &= (1 << nacc) - 1;
    }
  };
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    size = 258;
  };
  size = 258;
  write(256);
  reset();
  let w = "";
  for (const b of buf) {
    const c = String.fromCharCode(b);
    if (dict.has(w + c)) {
      w += c;
      continue;
    }
    write(dict.get(w));
    dict.set(w + c, size++);
    w = c;
    if (size >= 4000) {
      write(256);
      reset();
    }
  }
  if (w) write(dict.get(w));
  write(257);
  if (nacc > 0) bytes.push((acc << (8 - nacc)) & 255);
  return Buffer.from(bytes);
}

function encodeWith(filter, data) {
  if (filter === "FlateDecode") return deflateSync(data);
  if (filter === "ASCII85Decode") return ascii85Encode(data);
  if (filter === "ASCIIHexDecode") return Buffer.from(data.toString("hex").replace(/(.{64})/g, "$1\n") + ">", "latin1");
  if (filter === "LZWDecode") return lzwEncode(data);
  throw new Error(`unknown filter ${filter}`);
}

/**
 * A simple one-page PDF with Helvetica/WinAnsi text lines.
 * @param {string[]} lines
 * @param {{compress?: boolean, filters?: string[], objectStream?: boolean}} opts
 *   filters: decode chain as written in /Filter (default ["FlateDecode"]);
 *   objectStream: put the font and the font resource dictionary into a compressed /ObjStm
 *   and reference them indirectly (PDF 1.5 style, e.g. LibreOffice).
 */
export function buildPdf(lines, { compress = true, filters, objectStream = false } = {}) {
  const content = ["BT", "/F1 11 Tf", "50 780 Td", "14 TL"];
  for (const l of lines) content.push(`(${pdfEscape(l)}) Tj T*`);
  content.push("ET");
  let stream = Buffer.from(content.join("\n"), "latin1");
  const chain = filters || (compress ? ["FlateDecode"] : []);
  for (const f of [...chain].reverse()) stream = encodeWith(f, stream);
  const filter = chain.length ? ` /Filter [${chain.map((f) => "/" + f).join(" ")}]` : "";
  const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  const streams = new Map([[5, { dict: `/Length ${stream.length}${filter}`, data: stream }]]);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font ${objectStream ? "6 0 R" : "<< /F1 4 0 R >>"} >> /Contents 5 0 R >>`,
    objectStream ? null : font,
    null,
  ];
  if (objectStream) {
    const members = [
      [4, font],
      [6, "<< /F1 4 0 R >>"],
    ];
    let body = "";
    const header = [];
    for (const [num, o] of members) {
      header.push(`${num} ${body.length}`);
      body += o + "\n";
    }
    const head = header.join(" ") + "\n";
    const data = deflateSync(Buffer.from(head + body, "latin1"));
    objs.push(null, null); // 6 lives in the object stream; 7 is the object stream
    objs[5] = undefined;
    streams.set(7, { dict: `/Type /ObjStm /N ${members.length} /First ${head.length} /Length ${data.length} /Filter /FlateDecode`, data });
  }
  const chunks = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let pos = chunks[0].length;
  objs.forEach((o, i) => {
    const num = i + 1;
    let buf;
    if (o === undefined || (o === null && !streams.has(num))) {
      offsets.push(null);
      return;
    }
    if (o === null) {
      const st = streams.get(num);
      buf = Buffer.concat([Buffer.from(`${num} 0 obj\n<< ${st.dict} >>\nstream\n`, "latin1"), st.data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    } else {
      buf = Buffer.from(`${num} 0 obj\n${o}\nendobj\n`, "latin1");
    }
    offsets.push(pos);
    chunks.push(buf);
    pos += buf.length;
  });
  const xref = ["xref", `0 ${objs.length + 1}`, "0000000000 65535 f "].concat(
    offsets.map((o) => (o === null ? "0000000000 65535 f " : `${String(o).padStart(10, "0")} 00000 n `)),
  );
  chunks.push(Buffer.from(xref.join("\n") + `\ntrailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

// ─── ZIP (office documents) ─────────────────────────────────────────

export function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x0800, 6);
    loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc >>> 0, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    locals.push(loc, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildDocx(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`).join("");
  return buildZip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

export function buildXlsx(rows) {
  const shared = [];
  const idx = (s) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const sheetRows = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((c) => (typeof c === "number" ? `<c><v>${c}</v></c>` : `<c t="s"><v>${idx(String(c))}</v></c>`)).join("")}</row>`)
    .join("");
  return buildZip({
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst>${shared.map((s) => `<si><t>${xmlEsc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}

export function buildIcs({ summary, start, end, location, organizer, description, method = "REQUEST", status, rrule, uid, sequence }) {
  const f = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return Buffer.from(
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `METHOD:${method}`,
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "BEGIN:STANDARD",
      "DTSTART:18930401T000000",
      "TZNAME:CET",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      ...(uid ? [`UID:${uid}`] : []),
      ...(sequence !== undefined ? [`SEQUENCE:${sequence}`] : []),
      `SUMMARY:${summary}`,
      `DTSTART:${f(start)}`,
      `DTEND:${f(end)}`,
      ...(status ? [`STATUS:${status}`] : []),
      ...(rrule ? [`RRULE:${rrule}`] : []),
      `LOCATION:${location}`,
      `ORGANIZER;CN=${organizer.name}:mailto:${organizer.email}`,
      `DESCRIPTION:${description.replace(/\n/g, "\\n")}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
    "utf8"
  );
}
