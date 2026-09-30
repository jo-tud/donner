// Text extraction from attachments. Everything here processes untrusted input, so each
// extractor is bounded in time and memory and failures are recorded, never thrown.

import { htmlToText } from "./html.js";
import { pdfToText } from "./pdf.js";
import { readZipFiles } from "./zip.js";
import { decodeEntities } from "./entities.js";
import { sanitizeText } from "./text.js";

const TEXT_TYPES = /^(?:text\/(?:plain|csv|markdown|x-markdown|tab-separated-values|x-log|x-csv|rtf)|application\/(?:json|xml|csv|x-yaml|yaml))$/;
const EXT_TEXT = /\.(?:txt|csv|tsv|md|markdown|json|xml|yaml|yml|log|ini|conf)$/i;

export function kindOf(filename, mimeType) {
  const name = String(filename || "").toLowerCase();
  const mt = String(mimeType || "").toLowerCase();
  if (mt === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx") || mt === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (name.endsWith(".xlsx") || mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (name.endsWith(".pptx") || mt === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (/\.(?:odt|ods|odp)$/.test(name) || mt.startsWith("application/vnd.oasis.opendocument.")) return "odf";
  if (mt === "text/calendar" || name.endsWith(".ics")) return "ics";
  if (mt === "text/vcard" || mt === "text/x-vcard" || name.endsWith(".vcf")) return "vcf";
  if (mt === "text/html" || /\.html?$/.test(name)) return "html";
  if (mt === "message/rfc822" || name.endsWith(".eml")) return "eml";
  if (TEXT_TYPES.test(mt) || EXT_TEXT.test(name)) return "text";
  return null;
}

export function decodeTextBuffer(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

function xmlText(xml, { paragraph = /<\/(?:w:p|a:p|text:p|text:h|row)>/g, tab = /<(?:w:tab|text:tab)\s*\/>/g } = {}) {
  return decodeEntities(
    xml
      .replace(paragraph, "\n")
      .replace(tab, "\t")
      .replace(/<(?:w:br|text:line-break)\s*\/>/g, "\n")
      .replace(/<\/(?:c|table:table-cell)>/g, "\t")
      .replace(/<[^>]+>/g, "")
  );
}

function officeText(kind, buf) {
  if (kind === "docx") {
    const files = readZipFiles(buf, (n) => /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n));
    return files.map((f) => xmlText(f.data.toString("utf8"))).join("\n");
  }
  if (kind === "pptx") {
    const files = readZipFiles(buf, (n) => /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(n));
    files.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    return files.map((f) => xmlText(f.data.toString("utf8"))).join("\n\n");
  }
  if (kind === "xlsx") {
    const files = readZipFiles(buf, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    const shared = [];
    const ss = files.find((f) => f.name === "xl/sharedStrings.xml");
    if (ss) {
      for (const si of ss.data.toString("utf8").matchAll(/<si>([^]*?)<\/si>/g)) {
        shared.push(decodeEntities(si[1].replace(/<[^>]+>/g, "")));
      }
    }
    const rows = [];
    for (const f of files.filter((x) => x.name.startsWith("xl/worksheets/"))) {
      for (const row of f.data.toString("utf8").matchAll(/<row\b[^>]*>([^]*?)<\/row>/g)) {
        const cells = [];
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([^]*?)<\/c>)/g)) {
          const attrs = c[1];
          const inner = c[2] || "";
          const v = inner.match(/<v>([^]*?)<\/v>/)?.[1];
          const inline = inner.match(/<is>([^]*?)<\/is>/)?.[1];
          if (/t="s"/.test(attrs) && v !== undefined) cells.push(shared[Number(v)] ?? "");
          else if (inline !== undefined) cells.push(decodeEntities(inline.replace(/<[^>]+>/g, "")));
          else if (v !== undefined) cells.push(decodeEntities(v));
        }
        if (cells.some((x) => x !== "")) rows.push(cells.join("\t"));
      }
    }
    return rows.join("\n");
  }
  if (kind === "odf") {
    const files = readZipFiles(buf, (n) => n === "content.xml");
    return files.map((f) => xmlText(f.data.toString("utf8"))).join("\n");
  }
  return "";
}

function icsUnescape(v) {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function icsDate(line) {
  // DTSTART:20260201T090000Z | DTSTART;TZID=Europe/Berlin:20260201T090000 | DTSTART;VALUE=DATE:20260201
  const v = line.slice(line.lastIndexOf(":") + 1).trim();
  return icsDateValue(v);
}

function icsDateValue(v) {
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", sec = "0"] = m.slice(1, 7).map((x) => x ?? undefined);
  if (m[7]) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  // Floating or TZID times: interpret as local time (good enough for "which day").
  return new Date(+y, +mo - 1, +d, +h, +mi, +sec).getTime();
}

const FOREVER = 8.64e15;

/** Last start of a recurring event: UNTIL, or COUNT × interval, or open-ended. */
function recurrenceEnd(start, rrule) {
  if (!rrule || !start) return start ?? null;
  const p = Object.fromEntries(rrule.split(";").map((kv) => kv.split("=").map((x) => x.trim().toUpperCase())));
  if (p.UNTIL) return icsDateValue(p.UNTIL) ?? FOREVER;
  if (p.COUNT) {
    const step = { SECONDLY: 1e3, MINUTELY: 60e3, HOURLY: 3600e3, DAILY: 86400e3, WEEKLY: 7 * 86400e3, MONTHLY: 31 * 86400e3, YEARLY: 366 * 86400e3 }[p.FREQ] || 86400e3;
    return start + Math.min(Number(p.COUNT) || 1, 100000) * (Number(p.INTERVAL) || 1) * step;
  }
  return FOREVER;
}

const ICS_FREQ = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" };

export function describeRrule(rrule) {
  const p = Object.fromEntries(rrule.split(";").map((kv) => kv.split("=").map((x) => x.trim().toUpperCase())));
  const every = Number(p.INTERVAL) > 1 ? `every ${p.INTERVAL} ${String(p.FREQ || "").toLowerCase().replace(/ly$/, "").replace(/dai$/, "day")}s` : ICS_FREQ[p.FREQ] || String(p.FREQ || "").toLowerCase();
  const parts = [every];
  if (p.BYDAY) parts.push(`on ${p.BYDAY}`);
  if (p.UNTIL) parts.push(`until ${String(p.UNTIL).slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}`);
  if (p.COUNT) parts.push(`${p.COUNT} times`);
  return parts.filter(Boolean).join(" ");
}

function fmtIcs(ms) {
  if (ms === null || ms === undefined) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Calendar data (VEVENT) of an ICS file: [{start, end, lastStart, summary, location,
 * organizer, method, status, rrule, uid}]. VTIMEZONE and VALARM blocks are ignored.
 */
export function parseIcsEvents(s) {
  const lines = String(s).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let method = null;
  let cur = null;
  let nested = 0; // VALARM etc. inside a VEVENT
  for (const l of lines) {
    const begin = l.match(/^BEGIN:([A-Z-]+)/i)?.[1]?.toUpperCase();
    const end = l.match(/^END:([A-Z-]+)/i)?.[1]?.toUpperCase();
    if (begin === "VEVENT" && !cur) {
      cur = { description: "" };
      nested = 0;
      continue;
    }
    if (cur && begin) {
      nested++;
      continue;
    }
    if (cur && end === "VEVENT" && nested === 0) {
      events.push(cur);
      cur = null;
      if (events.length >= 50) break;
      continue;
    }
    if (cur && end) {
      nested = Math.max(0, nested - 1);
      continue;
    }
    const key = l.match(/^([A-Z-]+)[;:]/i)?.[1]?.toUpperCase();
    if (!cur) {
      if (key === "METHOD") method = l.slice(l.indexOf(":") + 1).trim().toUpperCase().slice(0, 20);
      continue;
    }
    if (nested) continue;
    const val = () => icsUnescape(l.slice(l.indexOf(":") + 1)).replace(/\s+/g, " ").trim().slice(0, 500);
    if (key === "DTSTART") cur.start = icsDate(l);
    else if (key === "DTEND") cur.end = icsDate(l);
    else if (key === "SUMMARY") cur.summary = val();
    else if (key === "LOCATION") cur.location = val();
    else if (key === "STATUS") cur.status = val().toUpperCase().slice(0, 20);
    else if (key === "RRULE") cur.rrule = l.slice(l.indexOf(":") + 1).trim().slice(0, 300);
    else if (key === "UID") cur.uid = val().slice(0, 300);
    else if (key === "SEQUENCE") cur.sequence = Number.parseInt(val(), 10) || 0;
    else if (key === "RECURRENCE-ID") cur.recurrenceId = String(icsDate(l) ?? val()).slice(0, 40);
    else if (key === "DESCRIPTION") cur.description = icsUnescape(l.slice(l.indexOf(":") + 1)).slice(0, 5000);
    else if (key === "ORGANIZER") cur.organizer = ((l.match(/CN="?([^";:]+)"?/)?.[1] || "") + " " + val().replace(/^mailto:/i, "")).trim();
    else if (key === "ATTENDEE") {
      const who = ((l.match(/CN="?([^";:]+)"?/)?.[1] || "") + " " + val().replace(/^mailto:/i, "")).trim();
      (cur.attendees ||= []).length < 100 && cur.attendees.push(who);
    }
  }
  return events.map((e) => ({
    start: e.start ?? null,
    end: e.end ?? null,
    lastStart: recurrenceEnd(e.start ?? null, e.rrule),
    summary: e.summary || null,
    location: e.location || null,
    organizer: e.organizer || null,
    method,
    status: e.status || null,
    rrule: e.rrule || null,
    uid: e.uid || null,
    sequence: e.sequence ?? null,
    recurrenceId: e.recurrenceId ?? null,
    description: e.description || "",
    attendees: e.attendees || [],
  }));
}

/** Searchable text of an ICS file: the events only (no time zone definitions, no alarms). */
function icsText(events) {
  return events
    .map((e) => {
      const lines = [];
      const state = e.method === "CANCEL" || e.status === "CANCELLED" ? "CANCELLED: " : "";
      if (e.summary) lines.push(`${state}${e.summary}`);
      if (e.start) lines.push(`When: ${fmtIcs(e.start)}${e.end ? ` – ${fmtIcs(e.end)}` : ""}${e.rrule ? ` (${describeRrule(e.rrule)})` : ""}`);
      if (e.location) lines.push(`Where: ${e.location}`);
      if (e.organizer) lines.push(`Organizer: ${e.organizer}`);
      if (e.attendees.length) lines.push(`Attendees: ${e.attendees.join(", ")}`);
      if (e.description) lines.push(e.description);
      return lines.join("\n");
    })
    .join("\n\n");
}

function vcfText(s) {
  return s
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((l) => /^(FN|N|EMAIL|TEL|ORG|TITLE|ADR|NOTE)[;:]/.test(l))
    .map((l) => l.slice(l.indexOf(":") + 1).replace(/;+/g, " ").trim())
    .join("\n");
}

/**
 * @param {{filename?: string, mimeType?: string, content: Buffer}} att
 * @param {{maxChars?: number, maxBytes?: number, parseEml?: (buf: Buffer) => Promise<string>}} opts
 * @returns {Promise<{text: string, state: string, engine?: string}>}
 */
export async function extractAttachmentText(att, { maxChars = 200000, maxBytes = 20 * 1024 * 1024, parseEml, pdftotext = false } = {}) {
  const kind = kindOf(att.filename, att.mimeType);
  if (!kind) return { text: "", state: "unsupported" };
  const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content || []);
  if (buf.length > maxBytes) return { text: "", state: "too_large" };
  try {
    let text = "";
    let engine;
    let events;
    switch (kind) {
      case "pdf": {
        const r = await pdfToText(buf, { maxChars, usePdftotext: pdftotext });
        text = r.text;
        engine = r.engine;
        break;
      }
      case "docx":
      case "xlsx":
      case "pptx":
      case "odf":
        text = officeText(kind, buf);
        break;
      case "ics": {
        const all = parseIcsEvents(decodeTextBuffer(buf));
        text = icsText(all);
        events = all.map(({ description, attendees, ...e }) => e);
        break;
      }
      case "vcf":
        text = vcfText(decodeTextBuffer(buf));
        break;
      case "html":
        text = htmlToText(decodeTextBuffer(buf)).text;
        break;
      case "eml":
        text = parseEml ? await parseEml(buf) : "";
        break;
      default:
        text = decodeTextBuffer(buf);
    }
    text = sanitizeText(text).text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return { text: "", state: kind === "pdf" ? "no_text" : "empty", engine, events };
    if (text.length > maxChars) return { text: text.slice(0, maxChars), state: "truncated", engine, events };
    return { text, state: "extracted", engine, events };
  } catch (err) {
    return { text: "", state: "error", error: String(err.message || err).slice(0, 200) };
  }
}
