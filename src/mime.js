// Raw RFC 822 → normalised document for the index.

import PostalMime from "postal-mime";
import { htmlToText } from "./html.js";
import { sanitizeText, cleanMid, parseMidList } from "./text.js";
import { extractAttachmentText } from "./attachments.js";

function flattenAddresses(list) {
  const out = [];
  for (const a of list || []) {
    if (!a) continue;
    if (a.group) out.push(...flattenAddresses(a.group));
    else out.push({ name: sanitizeText(decodeLooseWords(a.name || "")).text.trim().slice(0, 300), addr: sanitizeText(String(a.address || "")).text.trim().toLowerCase().slice(0, 320) });
    if (out.length >= 500) break;
  }
  return out;
}

function header(email, key) {
  return email.headers.find((h) => h.key === key)?.value;
}

/** Remove RFC 5322 comments "( … )" (nesting-aware, linear). */
function stripComments(s) {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      if (!depth) out += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"' && !depth) quoted = !quoted;
    if (!quoted) {
      if (c === "(") {
        depth++;
        continue;
      }
      if (c === ")" && depth) {
        depth--;
        continue;
      }
    }
    if (!depth) out += c;
  }
  return out;
}

function splitOutsideQuotes(s, sep) {
  const parts = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && q) {
      cur += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') q = !q;
    if (c === sep && !q) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * SPF/DKIM/DMARC results from Authentication-Results (RFC 8601).
 *
 * Only a header written in transit counts: it must be the topmost Authentication-Results
 * *and* have a Received header below it (a header the sender put into the original message
 * sits below all Received headers). Comments are ignored, and only "method=result" at the
 * start of each result clause is read, so sender-controlled strings echoed in comments or
 * properties cannot fake a "pass".
 */
/** "mx02.mail.example" → "mail.example" (good enough to tell a provider's own hosts apart). */
function baseDomain(host) {
  const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

/**
 * Index of the Received header where the message entered the provider `dom`, starting below
 * header `idx`. Internal hops ("from a.mail.example (a.mail.example [ip]) by b.mail.example") are
 * skipped; the reverse-DNS name in parentheses must belong to the provider too, because the
 * HELO name before it is chosen by the sender. Anything unrecognised counts as the entry.
 */
function entryHop(hs, idx, dom) {
  for (let j = idx + 1; j < hs.length; j++) {
    if (hs[j].key !== "received") continue;
    const v = String(hs[j].value).slice(0, 2000);
    const m = v.match(/^\s*from\s+([a-z0-9.-]+)\s+\(([a-z0-9.-]+)\s+\[[0-9a-f.:]+\]\)/i);
    const internal = m && [m[1], m[2]].every((h) => h.toLowerCase() === dom || h.toLowerCase().endsWith("." + dom));
    if (!internal) return j;
  }
  return hs.length;
}

export function parseAuthResults(email, trustedAuthservIds = []) {
  const hs = email.headers || [];
  const idx = hs.findIndex((h) => h.key === "authentication-results");
  const out = {};
  // The receiving provider's results: the topmost Authentication-Results header that was added
  // in transit (a Received header below it), plus the further headers of the same provider
  // down to the hop where the message entered it. Some providers write one header per method
  // and on different internal hops. Headers below the entry hop may come from the
  // sender and are never read.
  const recv = idx >= 0 ? hs.findIndex((h, i) => i > idx && h.key === "received") : -1;
  if (recv > idx) {
    const first = splitOutsideQuotes(stripComments(String(hs[idx].value).slice(0, 8192)), ";");
    const topId = first[0].trim().split(/\s+/)[0].toLowerCase();
    // Optional pinning: only trust results written by the user's own receiving servers.
    const trusted = !trustedAuthservIds.length || trustedAuthservIds.some((t) => topId === t.toLowerCase() || topId.endsWith("." + t.toLowerCase()));
    if (!trusted) return null;
    const dom = baseDomain(topId);
    const end = entryHop(hs, idx, dom);
    for (let i = idx; i < end; i++) {
      if (hs[i].key !== "authentication-results") continue;
      const all = i === idx ? first : splitOutsideQuotes(stripComments(String(hs[i].value).slice(0, 8192)), ";");
      const id = all[0].trim().split(/\s+/)[0].toLowerCase();
      if (id !== topId && baseDomain(id) !== dom) continue;
      for (const clause of all.slice(1)) {
        const m = clause.trim().match(/^([a-z][a-z0-9-]*)\s*=\s*([a-z]+)/i);
        if (!m) continue;
        const method = m[1].toLowerCase();
        const result = m[2].toLowerCase();
        if (!["spf", "dkim", "dmarc", "arc"].includes(method)) continue;
        // One valid DKIM signature is enough; other methods: the topmost result counts.
        if (!(method in out) || (method === "dkim" && result === "pass")) out[method] = result;
      }
    }
  }
  if (!out.spf) {
    const ri = hs.findIndex((h) => h.key === "received-spf");
    if (ri >= 0 && hs.slice(ri + 1).some((h) => h.key === "received")) {
      const m = String(hs[ri].value).match(/^\s*([a-z]+)/i);
      if (m) out.spf = m[1].toLowerCase();
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Choose the body text. HTML wins when present because that is what Thunderbird shows by
 * default: an agent should read what the user sees, not a divergent text/plain part.
 */
export function chooseBody(text, html) {
  let hiddenRemoved = false;
  let body = "";
  if (html && html.trim()) {
    const r = htmlToText(html);
    hiddenRemoved = r.hiddenRemoved;
    body = r.text;
  }
  if (!body.trim() && text) body = text;
  const s = sanitizeText(body);
  return { body: s.text.replace(/\r\n?/g, "\n"), hiddenRemoved: hiddenRemoved || s.removed };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CP1252 = new TextDecoder("windows-1252");

/**
 * Raw 8-bit bytes in headers (old mailers, some newsletters) are not valid UTF-8 most of the
 * time; they are Windows-1252/Latin-1. Re-encode such header lines as UTF-8 so they do not
 * turn into "\uFFFD". Lines that are valid UTF-8 stay untouched.
 */
export function fixHeaderBytes(buf) {
  const limit = Math.min(buf.length, 256 * 1024);
  let end = -1;
  for (let i = 0; i < limit - 1; i++) {
    if (buf[i] === 0x0a && (buf[i + 1] === 0x0a || (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a))) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) end = limit;
  let high = false;
  for (let i = 0; i < end; i++) {
    if (buf[i] >= 0x80) {
      high = true;
      break;
    }
  }
  if (!high) return buf;
  const out = [];
  let start = 0;
  let changed = false;
  for (let i = 0; i <= end; i++) {
    if (i === end || buf[i] === 0x0a) {
      const line = buf.subarray(start, i === end ? end : i + 1);
      let fixed = line;
      if (line.some((b) => b >= 0x80)) {
        try {
          UTF8.decode(line);
        } catch {
          fixed = Buffer.from(CP1252.decode(line), "utf8");
          changed = true;
        }
      }
      out.push(fixed);
      start = i + 1;
    }
  }
  if (!changed) return buf;
  out.push(buf.subarray(end));
  return Buffer.concat(out);
}

const LOOSE_WORD = /=\?([A-Za-z0-9_.:-]{1,40})(?:\*[A-Za-z-]{1,20})?\?([QqBb])\?([^\r\n]*?)\?=/g;

function charsetDecoder(label) {
  try {
    return new TextDecoder(label.toLowerCase() === "unknown-8bit" ? "windows-1252" : label);
  } catch {
    return CP1252;
  }
}

/**
 * Decode encoded words that the MIME parser left as they were (spaces or "?" inside, words
 * in quoted display names, unknown charsets). Only called when "=?" survives parsing.
 */
export function decodeLooseWords(s) {
  if (!s || !s.includes("=?")) return s;
  // Bounded input: the lazy match below is quadratic on pathological strings.
  if (s.length > 4000) return s;
  // Whitespace between two encoded words is not part of the text (RFC 2047 §6.2).
  return s
    .replace(/(\?=)\s+(?==\?[^?\s]+\?[QqBb]\?)/g, "$1")
    .replace(LOOSE_WORD, (all, charset, enc, text) => {
      try {
        let bytes;
        if (enc.toUpperCase() === "B") bytes = Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
        else {
          const arr = [];
          const t = text.replace(/_/g, " ");
          for (let i = 0; i < t.length; i++) {
            if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
              arr.push(parseInt(t.slice(i + 1, i + 3), 16));
              i += 2;
            } else arr.push(...Buffer.from(t[i], "utf8"));
          }
          bytes = Buffer.from(arr);
        }
        return charsetDecoder(charset).decode(bytes);
      } catch {
        return all;
      }
    });
}

/**
 * @param {Buffer} buf raw message
 * @param {{attachments?: boolean, maxAttachmentBytes?: number, maxAttachmentTextChars?: number, depth?: number}} opts
 */
export async function parseRawMessage(buf, opts = {}) {
  const { attachments: withAttachments = true, maxAttachmentBytes, maxAttachmentTextChars, pdftotext = false, trustedAuthservIds = [], depth = 0 } = opts;
  const email = await PostalMime.parse(fixHeaderBytes(buf), {
    attachmentEncoding: "arraybuffer",
    maxNestingDepth: 50,
    maxRfc822NestingDepth: 3,
  });
  const from = flattenAddresses(email.from ? [email.from] : [])[0] || { name: "", addr: "" };
  const { body, hiddenRemoved } = chooseBody(email.text, email.html);

  const refs = parseMidList(email.references);
  const inReplyTo = parseMidList(email.inReplyTo);
  const listId = header(email, "list-id");

  const atts = [];
  let idx = 0;
  for (const a of email.attachments || []) {
    // Inline images referenced from the HTML are decoration, not attachments.
    if (a.related && /^image\//.test(a.mimeType)) continue;
    idx++;
    const content = Buffer.from(a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : a.content || []);
    const entry = {
      idx,
      filename: sanitizeText(decodeLooseWords(a.filename || "")).text || null,
      contentType: a.mimeType,
      size: content.length,
      text: "",
      state: "skipped",
    };
    if (withAttachments) {
      const r = await extractAttachmentText(
        { filename: a.filename, mimeType: a.mimeType, content },
        {
          maxChars: maxAttachmentTextChars,
          maxBytes: maxAttachmentBytes,
          pdftotext,
          parseEml: depth < 1 ? (b) => emlToText(b, { ...opts, depth: depth + 1 }) : undefined,
        }
      );
      entry.text = r.text;
      entry.state = r.state;
      if (r.events?.length) entry.events = r.events;
    }
    atts.push(entry);
  }

  return {
    mid: cleanMid(email.messageId),
    subject: sanitizeText(decodeLooseWords(email.subject || "")).text,
    date: email.date && !Number.isNaN(Date.parse(email.date)) ? Date.parse(email.date) : null,
    from,
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    bcc: flattenAddresses(email.bcc),
    replyTo: flattenAddresses(email.replyTo),
    inReplyTo,
    references: refs,
    listId: listId ? cleanMid(listId.slice(0, 500).match(/<([^<>]+)>/)?.[1] || listId.slice(0, 500)) : null,
    auth: parseAuthResults(email, trustedAuthservIds),
    body,
    hiddenRemoved,
    attachments: atts,
  };
}

async function emlToText(buf, opts) {
  const m = await parseRawMessage(buf, { ...opts, attachments: false });
  const who = m.from.name ? `${m.from.name} <${m.from.addr}>` : m.from.addr;
  return [`From: ${who}`, `Subject: ${m.subject}`, "", m.body].join("\n");
}
